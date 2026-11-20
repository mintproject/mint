import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '@/test/utils/render';
import type { Thread } from '@/graphql/generated/modeling';
import type { ModelEnsembleMap, ThreadModel } from '@/graphql/generated/execution';

vi.mock('@/components/datasets/DatasetSpatialMap', () => ({
  DatasetSpatialMap: () => <div data-testid="dataset-spatial-map" />,
}));

import { DatasetsStep } from '../DatasetsStep';
import { loadDatasetResources } from '@/lib/data-catalog';
import { COLLECTION_FILE_CAP } from '@/lib/thread-datasets';

vi.mock('@/lib/data-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/data-catalog')>()),
  loadDatasetResources: vi.fn(),
}));

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: 'success', datasets: [] }),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const thread = {
  __typename: 'thread',
  id: 't1',
  name: 'Flood',
  task_id: 'task1',
  start_date: '2000-01-01',
  end_date: '2026-01-01',
  region_id: 'texas',
  driving_variable_id: null,
  response_variable_id: null,
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
    { id: 'inFiles', name: 'Corpus', variables: ['sv-doc'], isOptional: false },
    { id: 'inOne', name: 'Config', variables: ['sv-cfg'], isOptional: false },
  ],
  output_files: [],
  input_parameters: [],
};

const ensembles: ModelEnsembleMap = {
  cfgF: { id: 'tm-1', bindings: { inFiles: ['s1'], inOne: ['s2'] } },
};
const persistedData = {
  s1: {
    id: 's1',
    name: 'Corpus',
    dataset: { id: 'ds-1', name: 'Docs' },
    selected_resources: 0,
    resources: [],
  },
  s2: {
    id: 's2',
    name: 'Config',
    dataset: { id: 'ds-2', name: 'Cfg' },
    selected_resources: 0,
    resources: [],
  },
};

function files(n: number, url = (i: number) => `https://x/f${i}.txt`) {
  return Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `f${i}.txt`, url: url(i) }));
}

function renderStep(models: Record<string, ThreadModel> = { cfgF: flow }) {
  return renderWithProviders(
    <DatasetsStep
      thread={thread}
      models={models}
      ensembles={ensembles}
      persistedData={persistedData}
      onUpdated={vi.fn()}
      onContinue={vi.fn()}
      onBack={vi.fn()}
    />,
  );
}

describe('DatasetsStep collection input', () => {
  it('labels only the collection input, with its explanation', async () => {
    vi.mocked(loadDatasetResources).mockResolvedValue(files(3));
    renderStep();
    expect(await screen.findAllByText('Takes a collection')).toHaveLength(1);
    expect(
      screen.getAllByText(
        /All the files you select are read together as one input\. This is one run\./,
      ),
    ).toHaveLength(1);
    expect(await screen.findByTestId('collection-count')).toHaveTextContent(
      '3 files, read together',
    );
  });

  it('shows no label when the flow has no collection input', async () => {
    renderStep({ cfgF: { ...flow, collectionInputs: [] } });
    await screen.findByText('Sensemaking flow');
    expect(screen.queryByText('Takes a collection')).not.toBeInTheDocument();
    expect(loadDatasetResources).not.toHaveBeenCalled();
  });

  it('selects all the files in one action', async () => {
    vi.mocked(loadDatasetResources).mockResolvedValue(files(40));
    renderStep();
    await screen.findByTestId('collection-count');
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByTestId('collection-count')).toHaveTextContent('0 files, read together');
    await userEvent.click(screen.getByRole('button', { name: 'Select all 40 files' }));
    expect(screen.getByTestId('collection-count')).toHaveTextContent('40 files, read together');
  });

  it('caps the selection at 500 files and says so', async () => {
    vi.mocked(loadDatasetResources).mockResolvedValue(files(COLLECTION_FILE_CAP + 20));
    renderStep();
    expect(await screen.findByTestId('collection-count')).toHaveTextContent(
      '500 files, read together',
    );
    expect(screen.getByRole('status')).toHaveTextContent('At most 500 files');
    expect(screen.getByRole('button', { name: 'Select all 500 files' })).toBeInTheDocument();
  });

  it('shows a file that cannot be gathered as disabled, with the reason', async () => {
    vi.mocked(loadDatasetResources).mockResolvedValue([
      ...files(2),
      { id: 'bad', name: 'plain.txt', url: 'http://x/plain.txt' },
    ]);
    renderStep();
    await screen.findByTestId('collection-count');
    expect(screen.getByRole('checkbox', { name: 'plain.txt' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'plain.txt' })).not.toBeChecked();
    expect(
      screen.getByText(/cannot be gathered \(only https and Tapis storage locations\)/),
    ).toBeInTheDocument();
    expect(screen.getByTestId('collection-count')).toHaveTextContent('2 files, read together');
  });
});
