import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setMintConfig } from '@/test/utils/mint-config';
import { renderWithProviders } from '@/test/utils/render';

import { DatasetUploadPage } from '../DatasetUploadPage';

const CKAN = 'https://ckan.example.org';

// The picker itself is covered elsewhere; here it just chooses a variable.
vi.mock('@/components/autocomplete/StandardVariableCombobox', () => ({
  StandardVariableCombobox: ({
    onChange,
  }: {
    onChange: (v: { id: string; label: string; description: string | null }) => void;
  }) => (
    <button
      type="button"
      onClick={() => onChange({ id: 'sv-1', label: 'precipitation_flux', description: null })}
    >
      pick variable
    </button>
  ),
}));

const tree = {
  modelcatalog_software: [
    {
      id: 's1',
      label: 'Soft',
      versions: [
        {
          id: 'v1',
          label: 'V',
          configurations: [
            {
              id: 'flow-1',
              label: 'Rain flow',
              flow: { configuration_id: 'flow-1' },
              regions: [],
              outputs: [],
              child_configurations: [],
              inputs: [
                {
                  input: {
                    id: 'in-1',
                    label: 'Rain',
                    has_format: 'csv',
                    presentations: [
                      {
                        presentation: {
                          id: 'p1',
                          standard_variable: { id: 'sv-1', label: 'precipitation_flux' },
                        },
                      },
                    ],
                  },
                },
              ],
            },
            {
              id: 'model-1',
              label: 'Rain model',
              flow: null,
              regions: [],
              outputs: [],
              child_configurations: [],
              inputs: [
                {
                  input: {
                    id: 'in-2',
                    label: 'Rain grid',
                    has_format: 'tif',
                    presentations: [
                      {
                        presentation: {
                          id: 'p1',
                          standard_variable: { id: 'sv-1', label: 'precipitation_flux' },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

vi.mock('@/graphql/generated/modeling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/graphql/generated/modeling')>()),
  useGetModelTreeWithRegionsQuery: () => ({ data: tree, loading: false }),
}));
vi.mock('@/graphql/generated/graphql', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/graphql/generated/graphql')>()),
  useListRegionCategoriesQuery: () => ({ data: { region_category: [] } }),
  useListRegionsByCategoryQuery: () => ({ data: { region: [] } }),
}));

interface Sent {
  form: FormData;
}
let sent: Sent[] = [];
let calls: string[] = [];
let createStatus = 200;
let order: string[] = [];

class FakeXhr {
  upload = { onprogress: null as null | ((e: { loaded: number }) => void) };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  status = 0;
  responseText = '';
  open() {}
  setRequestHeader() {}
  send(form: FormData) {
    sent.push({ form });
    order.push('resource_create');
    const n = sent.length;
    queueMicrotask(() => {
      this.status = 200;
      this.responseText = JSON.stringify({
        success: true,
        result: { id: `res-${n}`, url: `${CKAN}/d/${n}` },
      });
      this.onload?.();
    });
  }
}

function json(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

beforeEach(() => {
  sent = [];
  calls = [];
  order = [];
  createStatus = 200;
  localStorage.setItem('mint.access_token', 'SECRET-USER-TOKEN');
  setMintConfig({ AUTH_PROVIDER: 'tapis', DATA_CATALOG_API: CKAN } as never);
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('organization_list_for_user')) {
        return json({ success: true, result: [{ id: 'org-1', name: 'a', title: 'Org A' }] });
      }
      if (u.includes('package_create')) {
        order.push('package_create');
        (calls as string[] & { body?: unknown }).body = JSON.parse(String(init?.body));
        if (createStatus >= 400) {
          return json(
            {
              success: false,
              error: { message: 'Authorization Error: not allowed in this organization' },
            },
            createStatus,
          );
        }
        return json({ success: true, result: { id: 'pkg-1', name: 'dynamo-upload-x' } });
      }
      if (u.includes('package_show')) {
        order.push('package_show');
        return json({
          success: true,
          result: {
            id: 'pkg-1',
            private: true,
            resources: sent.map((_, i) => ({
              id: `res-${i + 1}`,
              url: `${CKAN}/d/${i + 1}`,
              mint_standard_variables: 'precipitation_flux',
            })),
          },
        });
      }
      return json({ success: true, result: [] });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function fill(files: File[]) {
  renderWithProviders(<DatasetUploadPage />);
  await screen.findByRole('option', { name: 'Org A' });
  await userEvent.selectOptions(screen.getByLabelText('Organisation'), 'org-1');
  await userEvent.type(screen.getByLabelText('Title'), 'Rain 2020');
  await userEvent.click(screen.getByText('pick variable'));
  fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2020-01-01' } });
  fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2020-12-31' } });
  await userEvent.upload(screen.getByLabelText('Choose files to upload'), files);
}

const csv = (name: string) => new File(['a,b'], name);

describe('DatasetUploadPage', () => {
  it('validates the required fields and sends nothing', async () => {
    renderWithProviders(<DatasetUploadPage />);
    await screen.findByRole('option', { name: 'Org A' });
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Choose at least one file.');
    expect(alert).toHaveTextContent('Enter a title.');
    expect(alert).toHaveTextContent('Choose a standard variable.');
    expect(alert).toHaveTextContent('Enter a start and an end date.');
    expect(sent).toHaveLength(0);
    expect(calls.some((c) => c.includes('package_create'))).toBe(false);
  });

  it('is private by default', async () => {
    renderWithProviders(<DatasetUploadPage />);
    expect(screen.getByLabelText('Make public')).not.toBeChecked();
    expect(screen.getByText(/can only read public files/)).toBeInTheDocument();
  });

  it('puts the one standard variable on every file of a collection', async () => {
    await fill([csv('a.csv'), csv('b.csv'), csv('c.csv')]);
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await screen.findByTestId('upload-success');
    expect(sent).toHaveLength(3);
    for (const s of sent) {
      expect(s.form.get('mint_standard_variables')).toBe('precipitation_flux');
      expect(s.form.get('format')).toBe('CSV');
    }
    const body = (calls as string[] & { body?: Record<string, unknown> }).body!;
    expect(body['private']).toBe(true);
    expect(body['title']).toBe('Rain 2020');
    expect(body['temporal_coverage_start']).toBe('2020-01-01');
    expect(body['temporal_coverage_end']).toBe('2020-12-31');
  });

  it('uploads a single file and shows the name, state and links', async () => {
    await fill([csv('only.csv')]);
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await screen.findByTestId('upload-success');
    expect(sent).toHaveLength(1);
    expect(screen.getByText('dynamo-upload-x')).toBeInTheDocument();
    expect(screen.getByTestId('upload-state')).toHaveTextContent('Private');
    expect(screen.getByRole('link', { name: 'Use in a thread' })).toHaveAttribute(
      'href',
      '/modeling/problem-statements',
    );
    expect(screen.getByRole('link', { name: /dataset page/ })).toHaveAttribute(
      'href',
      '/datasets/browse/dynamo-upload-x',
    );
    expect(document.body.textContent).not.toContain('SECRET-USER-TOKEN');
  });

  it('reads the dataset back before it shows success', async () => {
    await fill([csv('only.csv')]);
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await screen.findByTestId('upload-success');
    expect(order).toEqual(['package_create', 'resource_create', 'package_show']);
  });

  it('lists the flows and models that take the variable, with the format fit', async () => {
    renderWithProviders(<DatasetUploadPage />);
    await userEvent.click(screen.getByText('pick variable'));
    const panel = screen.getByTestId('who-can-use');
    expect(panel).toHaveTextContent('Rain flow');
    expect(panel).toHaveTextContent('Rain model');
    await userEvent.upload(screen.getByLabelText('Choose files to upload'), [csv('x.csv')]);
    expect(screen.getByTestId('who-can-use')).toHaveTextContent(/Rain flow.*the format fits/);
    expect(screen.getByTestId('who-can-use')).toHaveTextContent(
      /Rain model.*the format does not fit/,
    );
  });

  it('warns about mixed extensions', async () => {
    renderWithProviders(<DatasetUploadPage />);
    await userEvent.upload(screen.getByLabelText('Choose files to upload'), [
      csv('a.csv'),
      csv('b.json'),
    ]);
    expect(screen.getByTestId('mixed-formats')).toBeInTheDocument();
  });

  it('shows a CKAN refusal plainly', async () => {
    createStatus = 403;
    await fill([csv('only.csv')]);
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /would not make the dataset \(HTTP 403\).*not allowed in this organization/,
      ),
    );
    expect(screen.queryByTestId('upload-success')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('SECRET-USER-TOKEN');
  });
});
