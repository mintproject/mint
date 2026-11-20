import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor } from '@/test/utils/render';
import type { Thread } from '@/graphql/generated/modeling';
import type { ModelEnsembleMap, ThreadModel } from '@/graphql/generated/execution';
import { setMintConfig } from '@/test/utils/mint-config';

vi.mock('@/components/datasets/DatasetSpatialMap', () => ({
  DatasetSpatialMap: () => <div data-testid="dataset-spatial-map" />,
}));
vi.mock('@/lib/data-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/data-catalog')>()),
  loadDatasetResources: vi.fn().mockResolvedValue([]),
}));
const updateThreadData = vi.fn().mockResolvedValue({});
vi.mock('@/graphql/generated/modeling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/graphql/generated/modeling')>()),
  useUpdateThreadDataMutation: () => [updateThreadData],
}));

import { DatasetsStep } from '../DatasetsStep';

const CKAN = 'https://ckan.example.org';

const thread = {
  __typename: 'thread',
  id: 't1',
  name: 'Flood',
  task_id: 'task1',
  start_date: '2000-01-01',
  end_date: '2026-01-01',
  region_id: 'texas',
  events: [],
  permissions: [{ __typename: 'thread_permission', user_id: 'testuser', read: true, write: true }],
  thread_models: [],
} as unknown as Thread;

const flow: ThreadModel = {
  id: 'cfgF',
  name: 'Sensemaking flow',
  isFlow: true,
  collectionInputs: ['inFiles'],
  input_files: [
    {
      id: 'inFiles',
      name: 'Corpus',
      variables: ['sv-doc'],
      isOptional: false,
      format: 'directory',
    },
    { id: 'inOne', name: 'Config', variables: ['sv-cfg'], isOptional: false, format: 'json' },
  ],
  output_files: [],
  input_parameters: [],
};
const model: ThreadModel = {
  id: 'cfgM',
  name: 'A model',
  input_files: [
    { id: 'm1', name: 'Rain', variables: ['sv-rain'], isOptional: false, format: 'csv' },
  ],
  output_files: [],
  input_parameters: [],
};
const ensembles: ModelEnsembleMap = {
  cfgF: { id: 'tm-1', bindings: {} },
  cfgM: { id: 'tm-2', bindings: {} },
};

let created: Array<Record<string, unknown>> = [];
let orgs: Array<{ id: string; name: string; title: string }> = [];
let resourceCount = 0;
class FakeXhr {
  upload = { onprogress: null as null | ((e: { loaded: number }) => void) };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  status = 200;
  responseText = '';
  open() {}
  setRequestHeader() {}
  send() {
    resourceCount += 1;
    const n = resourceCount;
    this.responseText = JSON.stringify({
      success: true,
      result: { id: `r${n}`, url: `${CKAN}/f${n}` },
    });
    queueMicrotask(() => this.onload?.());
  }
}

function renderStep(models: Record<string, ThreadModel>) {
  return renderWithProviders(
    <DatasetsStep
      thread={thread}
      models={models}
      ensembles={ensembles}
      persistedData={{}}
      onUpdated={vi.fn()}
      onContinue={vi.fn()}
      onBack={vi.fn()}
    />,
  );
}

beforeEach(() => {
  created = [];
  resourceCount = 0;
  orgs = [{ id: 'org-1', name: 'a', title: 'A org' }];
  localStorage.setItem('mint.access_token', 'USER-TOKEN');
  setMintConfig({ AUTH_PROVIDER: 'tapis', DATA_CATALOG_API: CKAN });
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('organization_list_for_user')) {
        return { ok: true, status: 200, json: async () => ({ success: true, result: orgs }) };
      }
      if (u.includes('package_create')) {
        created.push(JSON.parse(String(init?.body)));
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ success: true, result: { id: 'pkg-1', name: 'dynamo-upload-x' } }),
        };
      }
      if (u.includes('package_show')) {
        const rows = Array.from({ length: resourceCount }, (_, i) => ({
          id: `r${i + 1}`,
          url: `${CKAN}/f${i + 1}`,
          mint_standard_variables: created.length ? 'sv-doc,sv-cfg,sv-rain' : '',
        }));
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: { id: 'pkg-1', resources: rows } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ result: 'success', datasets: [] }) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
});

async function openPanel(index: number) {
  await userEvent.click(screen.getAllByRole('button', { name: 'Upload files' })[index]!);
}

describe('DatasetsStep upload', () => {
  it('offers upload on every input of a flow and of a model, with the catalog notice', async () => {
    renderStep({ cfgF: flow, cfgM: model });
    await screen.findByText('A model');
    expect(screen.getAllByTestId('upload-files')).toHaveLength(3);
    expect(screen.getAllByTestId('upload-catalog-notice')[0]).toHaveTextContent(
      'Your files go into the catalog dataset you choose. Private files can be read only by members of that organisation, and by your own runs.',
    );
    expect(screen.queryByText(/scratch/i)).not.toBeInTheDocument();
  });

  it('keeps a flow upload private unless the box is ticked', async () => {
    renderStep({ cfgF: flow });
    await screen.findByText('Sensemaking flow');
    await openPanel(1); // inputs are sorted: Config, then Corpus
    const box = await screen.findByRole('checkbox', { name: 'Make these files public' });
    expect(box).not.toBeChecked();
    expect(box).toBeEnabled();
    expect(screen.queryByTestId('upload-public-only')).not.toBeInTheDocument();

    await userEvent.selectOptions(await screen.findByLabelText('Organisation'), 'org-1');
    await userEvent.upload(screen.getByTestId('upload-file-input'), [
      new File(['a'], 'one.txt'),
      new File(['b'], 'two.txt'),
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Upload 2 files' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ private: true, owner_org: 'org-1' });
    expect(await screen.findByTestId('collection-count')).toBeInTheDocument();
  });

  it('forces a model upload to be public, and says why', async () => {
    renderStep({ cfgM: model });
    await screen.findByText('A model');
    await openPanel(0);
    const box = await screen.findByRole('checkbox', { name: 'Make these files public' });
    expect(box).toBeChecked();
    expect(box).toBeDisabled();
    expect(screen.getByTestId('upload-public-only')).toHaveTextContent(
      'A model reads its files directly, so uploads for a model must be public. Private uploads are for flows.',
    );
    await userEvent.selectOptions(await screen.findByLabelText('Organisation'), 'org-1');
    await userEvent.upload(screen.getByTestId('upload-file-input'), new File(['a'], 'rain.csv'));
    await userEvent.click(screen.getByRole('button', { name: 'Upload 1 file' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ private: false });
  });

  it('binds a single uploaded file to an ordinary flow input and writes it on Continue', async () => {
    renderStep({ cfgF: flow });
    await screen.findByText('Sensemaking flow');
    await openPanel(0);
    await userEvent.selectOptions(await screen.findByLabelText('Organisation'), 'org-1');
    await userEvent.upload(
      screen.getByTestId('upload-file-input'),
      new File(['{}'], 'config.json'),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Upload 1 file' }));
    await waitFor(() => expect(created).toHaveLength(1));
    await waitFor(() => expect(screen.getByText(/1 of 2 inputs assigned/)).toBeInTheDocument());
  });

  it('refuses a file of the wrong type for the input, naming both, and creates nothing', async () => {
    renderStep({ cfgF: flow });
    await screen.findByText('Sensemaking flow');
    await openPanel(0);
    await userEvent.selectOptions(await screen.findByLabelText('Organisation'), 'org-1');
    await userEvent.upload(screen.getByTestId('upload-file-input'), new File(['x'], 'notes.pdf'));
    await userEvent.click(screen.getByRole('button', { name: 'Upload 1 file' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The input "Config" reads json files, but "notes.pdf" is a .pdf file.',
    );
    expect(created).toEqual([]);
  });

  it('tells a user in no organisation to ask a CKAN admin', async () => {
    orgs = [];
    renderStep({ cfgF: flow });
    await screen.findByText('Sensemaking flow');
    await openPanel(0);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You cannot create datasets in any catalog organisation. Ask a CKAN admin to add you to one.',
    );
  });
});
