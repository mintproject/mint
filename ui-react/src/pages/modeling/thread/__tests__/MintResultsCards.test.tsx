/**
 * The Results step's cards: one collapsible card per model, each output as its
 * own block with an inline preview, and a plain account of a run that has not
 * finished.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/utils/render';
import { setMintConfig } from '@/test/utils/mint-config';
import { MintResults } from '../MintResults';
import type {
  Execution,
  ExecutionSummary,
  ModelExecutionsMap,
  ThreadExecutionData,
} from '@/graphql/generated/execution';
import { EnsembleManagerError, type UnifiedRunSnapshot } from '@/lib/ensemble-manager';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const REPORT = 'tapis://cloud.data/home/u/out/report.md';
const TABLE = 'tapis://cloud.data/home/u/out/scores.csv';
const LEXICON = 'tapis://cloud.data/home/u/out/lexicon.json';

const model = {
  id: 'm1',
  name: 'Sensemaking',
  input_parameters: [
    { id: 'p-depth', name: 'flood_depth', type: 'float', default: '10' },
    { id: 'p-mode', name: 'match_mode', type: 'string', default: 'longest' },
  ],
  input_files: [{ id: 'in-1', name: 'Documents' }],
  output_files: [
    { id: 'o-report', name: 'report', format: 'Markdown' },
    { id: 'o-table', name: 'scores' },
    { id: 'o-lexicon', name: 'lexicon' },
  ],
};

function thread(over: Partial<ExecutionSummary> = {}): ThreadExecutionData {
  return {
    id: 'thread-1',
    models: { m1: model } as never,
    model_ensembles: {
      m1: { id: 'ens-1', bindings: { 'p-depth': ['10'], 'p-mode': ['longest'] } },
    },
    execution_summary: {
      m1: {
        total_runs: 1,
        submitted_runs: 1,
        successful_runs: 1,
        failed_runs: 0,
        submitted_for_execution: true,
        submission_time: '2024-01-01T00:00:00Z',
        ...over,
      },
    },
    data: {},
  };
}

const run = (id: string, over: Partial<Execution> = {}): Execution => ({
  id,
  modelid: 'm1',
  status: 'SUCCESS',
  bindings: { 'in-1': { id: 'r1', name: 'a.txt', url: 'https://x/a.txt' }, 'p-mode': 'shortest' },
  results: {
    'o-report': { id: 'o-report', name: 'report.md', url: REPORT },
    'o-table': { id: 'o-table', name: 'scores.csv', url: TABLE },
    'o-lexicon': { id: 'o-lexicon', name: 'lexicon.json', url: LEXICON },
  },
  ...over,
});

const oneRun: ModelExecutionsMap = { m1: { loading: false, executions: [run('exec-1')] } };

/** A listing of the run's files; the size of each is what a preview reads to decide to open. */
const listingOf = (sizes: Record<string, number>) => ({
  ok: true,
  status: 200,
  json: () =>
    Promise.resolve({
      files: Object.entries(sizes).map(([url, size]) => ({ name: 'x', path: 'p', url, size })),
      results: [REPORT, TABLE, LEXICON].map((url) => ({ name: 'x', url, kind: 'file' })),
    }),
});
const listing = listingOf({ [REPORT]: 500, [TABLE]: 2000, [LEXICON]: 100 });

/** A response whose body is read as a stream, `chunk` bytes at a time, as the route sends it. */
let lastCancel: ReturnType<typeof vi.fn>;
const content = (text: string, chunk = 64 * 1024) => {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  lastCancel = vi.fn().mockResolvedValue(undefined);
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: {
      getReader: () => ({
        read: async () => {
          if (at >= bytes.length) return { done: true, value: undefined };
          const value = bytes.slice(at, at + chunk);
          at += chunk;
          return { done: false, value };
        },
        cancel: lastCancel,
      }),
    },
    blob: () => Promise.resolve(new Blob([bytes])),
  };
};

const csv = ['id,score', ...Array.from({ length: 14 }, (_, i) => `row${i + 1},${i}`)].join('\n');

function renderResults(props: Partial<React.ComponentProps<typeof MintResults>> = {}) {
  return renderWithProviders(
    <MintResults
      threadData={thread()}
      executions={oneRun}
      canWrite
      ingestionApiAvailable={false}
      onContinue={vi.fn()}
      onFetchRuns={vi.fn()}
      {...props}
    />,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;
const contentCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes('/files/content'));

beforeEach(() => {
  setMintConfig({ ENSEMBLE_MANAGER_API: 'http://ensemble' });
  fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (!u.includes('/files/content')) return listing;
    if (u.includes('report.md')) return content('# Findings\n\nThe **corpus** has two themes.\n');
    if (u.includes('scores.csv')) return content(csv);
    return content('{"a":{"b":1}}');
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

// ─── Output blocks and previews ──────────────────────────────────────────────

describe('a single run with results', () => {
  it('shows each output as its own block with label, type, Download and Copy location', async () => {
    renderResults();
    const blocks = await screen.findAllByTestId('output-block');
    expect(blocks).toHaveLength(3);
    const report = blocks[0]!;
    expect(report).toHaveTextContent('report');
    expect(report).toHaveTextContent('Markdown');
    expect(await within(report).findByTestId('download-file')).toBeInTheDocument();
    expect(within(report).getByTestId('copy-location')).toBeInTheDocument();
    expect(blocks[1]).toHaveTextContent('CSV');
    // One table-free block per output, not one column each.
    expect(screen.queryByTestId('results-table-m1')).not.toBeInTheDocument();
  });

  it('renders the Markdown report inline once it is open', async () => {
    renderResults();
    expect(await screen.findByRole('heading', { name: 'Findings' })).toBeInTheDocument();
    expect(screen.getByText('corpus').tagName).toBe('STRONG');
    const call = contentCalls()[0]!;
    expect(String(call[0])).toContain('path=home%2Fu%2Fout%2Freport.md');
  });

  it('reads a file only when its block is open, and shows CSV as a small table', async () => {
    renderResults();
    await screen.findByRole('heading', { name: 'Findings' });
    // The CSV and JSON blocks are closed: nothing of theirs was fetched yet.
    expect(contentCalls().filter(([u]) => String(u).includes('scores.csv'))).toHaveLength(0);
    expect(contentCalls().filter(([u]) => String(u).includes('lexicon.json'))).toHaveLength(0);

    const toggles = screen.getAllByTestId('preview-toggle');
    expect(toggles[1]).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggles[1]!);
    const table = await screen.findByTestId('preview-csv');
    // Header plus the first rows only, not all fifteen lines.
    expect(within(table).getAllByRole('row').length).toBeLessThanOrEqual(10);
    expect(within(table).getByText('row1')).toBeInTheDocument();
    expect(within(table).queryByText('row14')).not.toBeInTheDocument();
    expect(toggles[1]).toHaveAttribute('aria-expanded', 'true');
  });

  it('pretty-prints JSON when it is opened', async () => {
    renderResults();
    await screen.findByRole('heading', { name: 'Findings' });
    fireEvent.click(screen.getAllByTestId('preview-toggle')[2]!);
    expect(await screen.findByTestId('preview-json')).toHaveTextContent('"b": 1');
  });

  it('closes a preview again', async () => {
    renderResults();
    await screen.findByRole('heading', { name: 'Findings' });
    fireEvent.click(screen.getAllByTestId('preview-toggle')[0]!);
    expect(screen.queryByRole('heading', { name: 'Findings' })).not.toBeInTheDocument();
  });

  it('says the preview is unavailable, with a Download, when the file cannot be read', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/files/content')
        ? { ok: false, status: 500, json: () => Promise.resolve({ message: 'nope' }) }
        : listing,
    );
    renderResults();
    const fallback = await screen.findByTestId('preview-unavailable');
    expect(fallback).toHaveTextContent('Preview unavailable');
    expect(within(fallback).getByRole('button', { name: /download/i })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not open the report by itself when its size is not known or is large', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/files/content')
        ? content('# Findings\n')
        : listingOf({ [REPORT]: 5 * 1024 * 1024 }),
    );
    renderResults();
    const toggles = await screen.findAllByTestId('preview-toggle');
    expect(toggles[0]).toHaveAttribute('aria-expanded', 'false');
    expect(contentCalls()).toHaveLength(0);
    // Asking for it opens it.
    fireEvent.click(toggles[0]!);
    expect(await screen.findByRole('heading', { name: 'Findings' })).toBeInTheDocument();
  });

  it('reads as a stream and cancels at the 200 KB cap, saying only the start is shown', async () => {
    const big = '# Big\n\n' + 'word '.repeat(150_000);
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/files/content')
        ? content(big, 64 * 1024)
        : listingOf({ [REPORT]: 90_000, [TABLE]: 2000, [LEXICON]: 100 }),
    );
    renderResults();
    await screen.findByRole('heading', { name: 'Big' });
    expect(lastCancel).toHaveBeenCalled();
    expect(screen.getByTestId('preview-note')).toHaveTextContent('Only the start of the file');
  });

  it('never previews or fetches a web address, and still offers its Download link', async () => {
    renderResults({
      executions: {
        m1: {
          loading: false,
          executions: [
            run('exec-1', {
              results: {
                'o-report': { id: 'o-report', name: 'report.md', url: 'https://evil.example/r.md' },
              },
            }),
          ],
        },
      },
    });
    const link = await screen.findByTestId('download-link');
    expect(link).toHaveAttribute('href', 'https://evil.example/r.md');
    expect(screen.queryByTestId('preview-toggle')).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.map(([u]) => String(u)).some((u) => u.includes('evil.example')),
    ).toBe(false);
  });

  it('says a CSV was cut short only when it was', async () => {
    renderResults();
    await screen.findByRole('heading', { name: 'Findings' });
    fireEvent.click(screen.getAllByTestId('preview-toggle')[1]!);
    await screen.findByTestId('preview-csv');
    expect(screen.getByTestId('preview-note')).toHaveTextContent('Only the first 9 rows');
  });

  it('shows a short CSV with no caption', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/files/content') ? content('id,score\nr1,1\nr2,2\n') : listing,
    );
    renderResults();
    await screen.findAllByTestId('output-block');
    fireEvent.click(screen.getAllByTestId('preview-toggle')[1]!);
    await screen.findByTestId('preview-csv');
    expect(screen.queryByTestId('preview-note')).not.toBeInTheDocument();
  });

  it('falls back quietly when Tapis refuses the file (403) too', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/files/content')
        ? { ok: false, status: 403, json: () => Promise.resolve({ message: 'raw' }) }
        : listing,
    );
    renderResults();
    expect(await screen.findByTestId('preview-unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps how it was made collapsed, with the inputs and the settings', async () => {
    renderResults();
    await screen.findAllByTestId('output-block');
    const how = screen.getByTestId('how-made-m1') as HTMLDetailsElement;
    expect(how.open).toBe(false);
    expect(within(how).getByRole('link', { name: 'a.txt' })).toBeInTheDocument();
    expect(within(how).getByTestId('results-settings-m1')).toHaveTextContent('match mode');
  });

  it('has no boilerplate sentences and one refresh control', async () => {
    renderResults();
    await screen.findAllByTestId('output-block');
    expect(screen.queryByText(/below are results/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/runs required/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/fetch results/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reload/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /refresh/i })).toHaveLength(1);
  });
});

// ─── Card ────────────────────────────────────────────────────────────────────

describe('the model card', () => {
  it('shows the status in the header and collapses on a click', async () => {
    renderResults();
    const head = screen.getByRole('button', { name: /sensemaking/i });
    expect(head).toHaveTextContent('Completed');
    expect(head).toHaveAttribute('aria-expanded', 'true');
    await screen.findAllByTestId('output-block');
    fireEvent.click(head);
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('output-block')).not.toBeInTheDocument();
  });
});

// ─── Not finished ────────────────────────────────────────────────────────────

describe('a run that has not finished', () => {
  const unfinished = {
    loading: false,
    executions: [run('exec-1', { status: 'RUNNING', results: {} })],
  };
  const failedExecutions = {
    loading: false,
    executions: [run('exec-1', { status: 'FAILURE', results: {} })],
  };

  it('says a paused run waits for the user, with a way to the Runs step', () => {
    const onOpenRuns = vi.fn();
    renderResults({
      threadData: thread({ successful_runs: 0 }),
      executions: { m1: unfinished },
      unifiedRuns: { m1: { run_id: 'ue_1', status: 'awaiting_edit' } },
      onOpenRuns,
    });
    expect(screen.getByTestId('result-paused-m1')).toHaveTextContent('Waiting for your edit');
    expect(screen.queryByText(/no results available/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/1 running/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('open-runs-m1'));
    expect(onOpenRuns).toHaveBeenCalled();
  });

  it('says Running for a run in progress', () => {
    renderResults({ threadData: thread({ successful_runs: 0 }), executions: { m1: unfinished } });
    expect(screen.getByTestId('result-running-m1')).toHaveTextContent('Running');
    expect(screen.queryByTestId('output-block')).not.toBeInTheDocument();
  });

  const failedThread = thread({ successful_runs: 0, failed_runs: 1 });
  const failedRun: UnifiedRunSnapshot = {
    run_id: 'ue_1',
    status: 'failed',
    failure_code: 'MODEL_FAILED',
    error_message: 'job exited with code 2',
  };

  it('gives a failed run its reason and a Restart that sends it and opens the Runs step', async () => {
    const onRestartRuns = vi.fn().mockResolvedValue(undefined);
    const onOpenRuns = vi.fn();
    renderResults({
      threadData: failedThread,
      executions: { m1: failedExecutions },
      unifiedRuns: { m1: failedRun },
      onRestartRuns,
      onOpenRuns,
    });
    expect(screen.getByText('job exited with code 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(onRestartRuns).toHaveBeenCalledWith('m1', { maxMinutes: 60 }));
    await waitFor(() => expect(onOpenRuns).toHaveBeenCalled());
  });

  it('carries the earlier run time into the restart', async () => {
    const onRestartRuns = vi.fn().mockResolvedValue(undefined);
    renderResults({
      threadData: failedThread,
      executions: { m1: failedExecutions },
      unifiedRuns: { m1: { ...failedRun, model_result: { __max_minutes: 180, __queue: 'q' } } },
      onRestartRuns,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    await waitFor(() =>
      expect(onRestartRuns).toHaveBeenCalledWith('m1', { maxMinutes: 180, queue: 'q' }),
    );
  });

  it('disables Restart while it sends and shows a refusal', async () => {
    let fail: (error: Error) => void = () => undefined;
    const onRestartRuns = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    );
    renderResults({
      threadData: failedThread,
      executions: { m1: failedExecutions },
      unifiedRuns: { m1: failedRun },
      onRestartRuns,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(await screen.findByRole('button', { name: /restarting/i })).toBeDisabled();
    fail(new EnsembleManagerError(500, 'refused'));
    expect(await screen.findByTestId('restart-error-m1')).toHaveTextContent('refused');
    expect(screen.getByRole('button', { name: 'Restart' })).toBeEnabled();
  });

  it('shows Restart as in flight when the Runs step started it', () => {
    renderResults({
      threadData: failedThread,
      executions: { m1: failedExecutions },
      unifiedRuns: { m1: failedRun },
      onRestartRuns: vi.fn(),
      restartingModels: { m1: true },
    });
    expect(screen.getByRole('button', { name: /restarting/i })).toBeDisabled();
  });

  it('offers no Restart without permission, or while other runs are still going', () => {
    const view = renderResults({
      threadData: failedThread,
      executions: { m1: failedExecutions },
      unifiedRuns: { m1: failedRun },
    });
    expect(screen.queryByRole('button', { name: /restart/i })).not.toBeInTheDocument();
    view.unmount();
    renderResults({
      threadData: thread({ total_runs: 2, submitted_runs: 2, successful_runs: 0, failed_runs: 1 }),
      executions: {
        m1: {
          loading: false,
          executions: [
            run('exec-1', { status: 'FAILURE', results: {} }),
            run('exec-2', { status: 'RUNNING', results: {} }),
          ],
        },
      },
      unifiedRuns: { m1: failedRun },
      onRestartRuns: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: /restart/i })).not.toBeInTheDocument();
  });
});

// ─── Several runs ────────────────────────────────────────────────────────────

describe('several runs of one model', () => {
  it('keeps one results table, trimmed to the settings that differ', () => {
    const sweep = thread({ total_runs: 2, submitted_runs: 2, successful_runs: 2 });
    renderResults({
      threadData: sweep,
      executions: {
        m1: {
          loading: false,
          executions: [
            run('exec-1', { bindings: { 'p-depth': '1', 'p-mode': 'x' } }),
            run('exec-2', { bindings: { 'p-depth': '2', 'p-mode': 'x' } }),
          ],
        },
      },
    });
    const table = screen.getByTestId('results-table-m1');
    expect(within(table).getByText('flood depth')).toBeInTheDocument();
    expect(within(table).queryByText('match mode')).not.toBeInTheDocument();
    expect(screen.getByTestId('results-same-m1')).toHaveTextContent('match mode x');
    expect(screen.queryByTestId('output-block')).not.toBeInTheDocument();
    expect(screen.queryByText(/Page \d+ of/)).not.toBeInTheDocument();
  });
});
