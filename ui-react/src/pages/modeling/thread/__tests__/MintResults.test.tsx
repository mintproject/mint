/**
 * Tests for MintResults — results browsing step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils/render';
import { MintResults } from '../MintResults';
import { EnsembleManagerError } from '@/lib/ensemble-manager';
import { setMintConfig } from '@/test/utils/mint-config';
import type { ThreadExecutionData, ModelExecutionsMap } from '@/graphql/generated/execution';

// ─── Mock data ────────────────────────────────────────────────────────────────

const mockModel = {
  id: 'model-1',
  name: 'HydroModel',
  input_parameters: [{ id: 'param-1', name: 'threshold', type: 'float', default: '5' }],
  input_files: [],
  output_files: [{ id: 'out-1', name: 'discharge_output', variables: ['streamflow'] }],
};

const mockThreadDataNotSubmitted: ThreadExecutionData = {
  id: 'thread-1',
  models: { 'model-1': mockModel },
  model_ensembles: {
    'model-1': { id: 'ens-1', bindings: { 'param-1': ['5', '10'] } },
  },
  execution_summary: {
    'model-1': {
      total_runs: 2,
      submitted_runs: 0,
      failed_runs: 0,
      successful_runs: 0,
      // Not submitted yet
    },
  },
  data: {},
};

const mockThreadDataSubmitted: ThreadExecutionData = {
  id: 'thread-1',
  models: { 'model-1': mockModel },
  model_ensembles: {
    'model-1': { id: 'ens-1', bindings: { 'param-1': ['5', '10'] } },
  },
  execution_summary: {
    'model-1': {
      total_runs: 2,
      submitted_runs: 2,
      failed_runs: 0,
      successful_runs: 2,
      submitted_for_execution: true,
      submission_time: '2024-01-01T00:00:00Z',
    },
  },
  data: {},
  response_variables: ['streamflow'],
};

const emptyExecutions: ModelExecutionsMap = {};
const loadingExecutions: ModelExecutionsMap = {
  'model-1': { executions: [], loading: true },
};
const executionsWithResults: ModelExecutionsMap = {
  'model-1': {
    loading: false,
    executions: [
      {
        id: 'exec-1',
        modelid: 'model-1',
        status: 'SUCCESS',
        bindings: { 'param-1': '5' },
        results: {
          'out-1': {
            id: 'out-1',
            name: 'discharge.nc',
            url: 'https://example.com/discharge.nc',
          },
        },
      },
    ],
  },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MintResults', () => {
  it('shows guard when runs are not submitted', () => {
    renderWithProviders(
      <MintResults
        threadData={mockThreadDataNotSubmitted}
        executions={emptyExecutions}
        canWrite
        ingestionApiAvailable={false}
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
      />,
    );
    // Not submitted yet guard
    expect(screen.getByText(/please setup and run some models first/i)).toBeInTheDocument();
  });

  it('renders results heading when runs are submitted', () => {
    renderWithProviders(
      <MintResults
        threadData={mockThreadDataSubmitted}
        executions={emptyExecutions}
        canWrite
        ingestionApiAvailable={false}
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
      />,
    );
    expect(screen.getByText(/Results/)).toBeInTheDocument();
  });

  it('renders the model name', () => {
    renderWithProviders(
      <MintResults
        threadData={mockThreadDataSubmitted}
        executions={emptyExecutions}
        canWrite
        ingestionApiAvailable={false}
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
      />,
    );
    expect(screen.getByText('HydroModel')).toBeInTheDocument();
  });

  it('renders the scalar answer from a unified run when file results are empty', () => {
    renderWithProviders(
      <MintResults
        threadData={mockThreadDataSubmitted}
        executions={emptyExecutions}
        unifiedRuns={{
          'model-1': {
            run_id: 'ue-1',
            status: 'completed',
            output_handoff: {
              result: { schema_version: 1, status: 'ok', value: 49.7, unit: 'cfs' },
            },
          },
        }}
        canWrite
        ingestionApiAvailable={false}
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
      />,
    );

    expect(screen.getByTestId('run-answer-card')).toHaveTextContent('49.7');
    expect(screen.getByTestId('run-answer-card')).toHaveTextContent('cfs');
  });

  it('shows loading spinner when executions are loading', () => {
    renderWithProviders(
      <MintResults
        threadData={mockThreadDataSubmitted}
        executions={loadingExecutions}
        canWrite
        ingestionApiAvailable={false}
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
      />,
    );
    const spinners = document.querySelectorAll('.animate-spin');
    expect(spinners.length).toBeGreaterThan(0);
  });

  it('renders the results table when executions have results', () => {
    renderWithProviders(
      <MintResults
        threadData={mockThreadDataSubmitted}
        executions={executionsWithResults}
        canWrite
        ingestionApiAvailable={false}
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
      />,
    );
    expect(screen.getByTestId('results-table-model-1')).toBeInTheDocument();
  });

  it('renders output file links in the results table', () => {
    renderWithProviders(
      <MintResults
        threadData={mockThreadDataSubmitted}
        executions={executionsWithResults}
        canWrite
        ingestionApiAvailable={false}
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
      />,
    );
    const link = screen.getByRole('link', { name: 'discharge.nc' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', 'https://example.com/discharge.nc');
  });

  it('shows the Continue button', () => {
    renderWithProviders(
      <MintResults
        threadData={mockThreadDataSubmitted}
        executions={emptyExecutions}
        canWrite
        ingestionApiAvailable={false}
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
      />,
    );
    expect(screen.getByTestId('results-continue-btn')).toBeInTheDocument();
  });

  it('calls onContinue when Continue is clicked', () => {
    const onContinue = vi.fn();
    renderWithProviders(
      <MintResults
        threadData={mockThreadDataSubmitted}
        executions={emptyExecutions}
        canWrite
        ingestionApiAvailable={false}
        onContinue={onContinue}
        onFetchRuns={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('results-continue-btn'));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('shows fetch results button when runs are finished', () => {
    const threadDataFinished: ThreadExecutionData = {
      ...mockThreadDataSubmitted,
      execution_summary: {
        'model-1': {
          total_runs: 2,
          submitted_runs: 2,
          failed_runs: 0,
          successful_runs: 2,
          submitted_for_execution: true,
          submission_time: '2024-01-01T00:00:00Z',
        },
      },
    };
    renderWithProviders(
      <MintResults
        threadData={threadDataFinished}
        executions={{ 'model-1': { executions: [], loading: false } }}
        canWrite
        ingestionApiAvailable={false}
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onPublishResults={vi.fn()}
      />,
    );
    expect(screen.getByTestId('fetch-results-model-1')).toBeInTheDocument();
  });

  // ── #110: the button used to make no request, and a failure said nothing ──

  const threadDataFinished: ThreadExecutionData = {
    ...mockThreadDataSubmitted,
    execution_summary: {
      'model-1': {
        total_runs: 2,
        submitted_runs: 2,
        failed_runs: 0,
        successful_runs: 2,
        submitted_for_execution: true,
        submission_time: '2024-01-01T00:00:00Z',
      },
    },
  };

  function renderFinished(
    onPublishResults?: () => Promise<void>,
    onFetchRuns: (modelId: string, page: number, pageSize: number) => void = vi.fn(),
  ) {
    return renderWithProviders(
      <MintResults
        threadData={threadDataFinished}
        executions={{ 'model-1': { executions: [], loading: false } }}
        canWrite
        ingestionApiAvailable={false}
        onContinue={vi.fn()}
        onFetchRuns={onFetchRuns}
        onPublishResults={onPublishResults}
      />,
    );
  }

  it('calls onPublishResults when Fetch results is clicked', async () => {
    const onPublishResults = vi.fn().mockResolvedValue(undefined);
    renderFinished(onPublishResults);

    fireEvent.click(screen.getByTestId('fetch-results-model-1'));

    await waitFor(() => expect(onPublishResults).toHaveBeenCalledWith('model-1'));
  });

  // The server writes the execution_result rows; this table renders the
  // executions the parent holds. Without a reload after publishing, a
  // successful fetch still reads "No results available" (#110).
  it('reloads the executions after a successful publish', async () => {
    const onFetchRuns = vi.fn();
    renderFinished(vi.fn().mockResolvedValue(undefined), onFetchRuns);

    // The mount effect loads page 1 once; the publish must load it again.
    await waitFor(() => expect(onFetchRuns).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('fetch-results-model-1'));

    await waitFor(() => expect(onFetchRuns).toHaveBeenCalledTimes(2));
    expect(onFetchRuns).toHaveBeenLastCalledWith('model-1', 1, expect.any(Number));
  });

  it('does not reload the executions when publishing fails', async () => {
    const onFetchRuns = vi.fn();
    renderFinished(vi.fn().mockRejectedValue(new Error('boom')), onFetchRuns);

    await waitFor(() => expect(onFetchRuns).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('fetch-results-model-1'));

    expect(await screen.findByTestId('publish-error-model-1')).toBeInTheDocument();
    expect(onFetchRuns).toHaveBeenCalledTimes(1);
  });

  it('shows the failure instead of dropping it', async () => {
    const onPublishResults = vi
      .fn()
      .mockRejectedValue(
        new Error('Ensemble manager returned 400: No executions found to publish'),
      );
    renderFinished(onPublishResults);

    fireEvent.click(screen.getByTestId('fetch-results-model-1'));

    expect(await screen.findByTestId('publish-error-model-1')).toHaveTextContent(
      'No executions found to publish',
    );
  });

  // 422 NO_OUTPUTS_DECLARED is not an error to read and dismiss. A Tapis
  // application declares no output file type, so the model configuration
  // reaches its first run with none, and the repair is a promotion (#267).
  it('offers the promote action when the configuration declares no output', async () => {
    const onPromoteOutputs = vi.fn();
    renderWithProviders(
      <MintResults
        threadData={threadDataFinished}
        executions={{ 'model-1': { executions: [], loading: false } }}
        canWrite
        ingestionApiAvailable={false}
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onPublishResults={vi
          .fn()
          .mockRejectedValue(
            new EnsembleManagerError(
              422,
              'Ensemble manager returned 422: no outputs',
              'NO_OUTPUTS_DECLARED',
            ),
          )}
        onPromoteOutputs={onPromoteOutputs}
      />,
    );

    fireEvent.click(screen.getByTestId('fetch-results-model-1'));

    expect(await screen.findByTestId('publish-error-model-1')).toHaveTextContent(
      /declares no output/i,
    );
    fireEvent.click(screen.getByTestId('promote-outputs-model-1'));
    expect(onPromoteOutputs).toHaveBeenCalled();
  });

  it('shows any other failure as the server wrote it', async () => {
    renderFinished(
      vi
        .fn()
        .mockRejectedValue(new EnsembleManagerError(403, 'Ensemble manager returned 403: nope')),
    );

    fireEvent.click(screen.getByTestId('fetch-results-model-1'));

    expect(await screen.findByTestId('publish-error-model-1')).toHaveTextContent(
      'Ensemble manager returned 403: nope',
    );
    expect(screen.queryByTestId('promote-outputs-model-1')).not.toBeInTheDocument();
  });

  it('shows ingestion button when ingestion API is available and runs are finished', () => {
    const threadDataFinished: ThreadExecutionData = {
      ...mockThreadDataSubmitted,
      execution_summary: {
        'model-1': {
          total_runs: 2,
          submitted_runs: 2,
          failed_runs: 0,
          successful_runs: 2,
          submitted_for_execution: true,
        },
      },
    };
    renderWithProviders(
      <MintResults
        threadData={threadDataFinished}
        executions={{ 'model-1': { executions: [], loading: false } }}
        canWrite
        ingestionApiAvailable
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onIngestResults={vi.fn()}
      />,
    );
    expect(screen.getByTestId('ingest-results-model-1')).toBeInTheDocument();
  });
});

// ─── tapis:// results ─────────────────────────────────────────────────────────

const FILE_URL = 'tapis://cloud.data/home/u/out/summary.md';
const FOLDER_URL = 'tapis://cloud.data/home/u/out';

function executionsWithResultUrl(url: string): ModelExecutionsMap {
  return {
    'model-1': {
      loading: false,
      executions: [
        {
          id: 'exec-1',
          modelid: 'model-1',
          status: 'SUCCESS',
          bindings: { 'param-1': '5' },
          results: { 'out-1': { id: 'out-1', name: 'summary', url } },
        },
      ],
    },
  };
}

function renderResults(url: string) {
  return renderWithProviders(
    <MintResults
      threadData={mockThreadDataSubmitted}
      executions={executionsWithResultUrl(url)}
      canWrite
      ingestionApiAvailable={false}
      onContinue={vi.fn()}
      onFetchRuns={vi.fn()}
    />,
  );
}

describe('MintResults tapis:// results', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const listing = (kind: 'file' | 'folder', url: string) => ({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        files: [
          {
            name: 'summary.md',
            path: 'home/u/out/summary.md',
            size: 12,
            url: 'tapis://cloud.data/home/u/out/summary.md',
          },
        ],
        results: [{ name: 'summary', url, kind }],
      }),
  });

  beforeEach(() => {
    setMintConfig({ ENSEMBLE_MANAGER_API: 'http://ensemble' });
    localStorage.setItem('mint.access_token', 'user-token');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('renders Download for a file result, never a tapis: link', async () => {
    fetchMock.mockResolvedValue(listing('file', FILE_URL));
    renderResults(FILE_URL);

    expect(await screen.findByTestId('download-file')).toBeInTheDocument();
    expect(document.querySelector('a[href^="tapis:"]')).toBeNull();
    expect(screen.getByTestId('copy-location')).toBeInTheDocument();
  });

  it('downloads through the Ensemble Manager with the user token and saves a blob', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/files/content')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'Content-Disposition': 'attachment; filename="summary.md"' }),
          blob: () => Promise.resolve(new Blob(['hi'])),
        };
      }
      return listing('file', FILE_URL);
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderResults(FILE_URL);

    fireEvent.click(await screen.findByTestId('download-file'));

    await waitFor(() => expect(click).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/files/content'))!;
    expect(String(call[0])).toContain('http://ensemble/executions/exec-1/files/content?');
    expect(String(call[0])).toContain('systemId=cloud.data');
    expect(String(call[0])).toContain('path=home%2Fu%2Fout%2Fsummary.md');
    expect((call[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer user-token' });
    expect(URL.createObjectURL).toHaveBeenCalled();
    click.mockRestore();
  });

  it('shows a readable message when Tapis refuses the file', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/files/content')
        ? { ok: false, status: 403, json: () => Promise.resolve({ message: 'raw' }) }
        : listing('file', FILE_URL),
    );
    renderResults(FILE_URL);

    fireEvent.click(await screen.findByTestId('download-file'));

    expect(await screen.findByTestId('download-file-error')).toHaveTextContent(
      'Your account cannot read this file in Tapis storage.',
    );
  });

  it('renders Open folder for a folder result and opens the files dialog', async () => {
    fetchMock.mockResolvedValue(listing('folder', FOLDER_URL));
    renderResults(FOLDER_URL);

    fireEvent.click(await screen.findByTestId('open-folder'));

    expect(await screen.findByTestId('execution-files-dialog')).toBeInTheDocument();
    expect(await screen.findByTestId('download-home/u/out/summary.md')).toBeInTheDocument();
  });

  it('shows a javascript: URL as plain text', () => {
    renderResults('javascript:alert(1)');

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByTestId('result-text')).toHaveTextContent('summary');
  });

  it('keeps an https URL as a link that opens safely in a new tab', () => {
    renderResults('https://example.com/a.nc');

    const link = screen.getByRole('link', { name: 'summary' });
    expect(link).toHaveAttribute('href', 'https://example.com/a.nc');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
  });
});

// ─── input bindings ───────────────────────────────────────────────────────────

describe('MintResults input cell', () => {
  const flowModel = {
    ...mockModel,
    input_files: [{ id: 'in-1', name: 'Documents' }],
  };
  const flowThread: ThreadExecutionData = {
    ...mockThreadDataSubmitted,
    models: { 'model-1': flowModel as never },
  };

  function renderWith(binding: unknown) {
    const executions: ModelExecutionsMap = {
      'model-1': {
        loading: false,
        executions: [
          {
            id: 'exec-1',
            modelid: 'model-1',
            status: 'SUCCESS',
            bindings: { 'in-1': binding },
            results: { 'out-1': { id: 'out-1', name: 'discharge.nc', url: 'https://x/d.nc' } },
          },
        ],
      },
    };
    return renderWithProviders(
      <MintResults
        threadData={flowThread}
        executions={executions}
        canWrite
        ingestionApiAvailable={false}
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
      />,
    );
  }

  it('shows a collection as a file count that lists the names and links', () => {
    renderWith([
      { id: 'r1', name: 'a.csv', url: 'https://x/a.csv' },
      { id: 'r2', name: 'b.csv', url: 'https://x/b.csv' },
      { id: 'r3', name: 'c.csv', url: 'https://x/c.csv' },
    ]);
    expect(screen.getByText('3 files')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'b.csv' })).toHaveAttribute('href', 'https://x/b.csv');
  });

  it('still links a single file input', () => {
    renderWith({ id: 'r1', name: 'a.csv', url: 'https://x/a.csv' });
    expect(screen.getByRole('link', { name: 'a.csv' })).toBeInTheDocument();
    expect(screen.queryByTestId('collection-binding')).not.toBeInTheDocument();
  });

  it('shows a dash when nothing was recorded for the input', () => {
    renderWith(undefined);
    expect(screen.queryByTestId('collection-binding')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'a.csv' })).not.toBeInTheDocument();
  });
});
