/**
 * The Runs step's cards: one collapsible card per model, steps shown once, a
 * single run without the ensemble furniture, and Restart for a run that failed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/utils/render';
import { MintRuns } from '../MintRuns';
import type {
  Execution,
  ExecutionSummary,
  ModelExecutionsMap,
  ThreadExecutionData,
} from '@/graphql/generated/execution';
import { EnsembleManagerError, type UnifiedRunSnapshot } from '@/lib/ensemble-manager';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const params = [
  { id: 'p-depth', name: 'flood_depth', type: 'float', default: '10' },
  { id: 'p-mode', name: 'match_mode', type: 'string', default: 'longest' },
];

function model(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Model ${id}`,
    input_parameters: params,
    input_files: [],
    output_files: [{ id: `${id}-out`, name: 'report' }],
    ...extra,
  };
}

function summary(over: Partial<ExecutionSummary> = {}): ExecutionSummary {
  return {
    total_runs: 1,
    submitted_runs: 1,
    successful_runs: 1,
    failed_runs: 0,
    submitted_for_execution: true,
    submission_time: '2024-01-01T00:00:00Z',
    ...over,
  };
}

function thread(
  models: Array<{
    id: string;
    model?: Record<string, unknown>;
    summary?: Partial<ExecutionSummary>;
  }>,
): ThreadExecutionData {
  return {
    id: 'thread-1',
    models: Object.fromEntries(models.map((m) => [m.id, model(m.id, m.model)])) as never,
    model_ensembles: Object.fromEntries(
      models.map((m) => [
        m.id,
        { id: `ens-${m.id}`, bindings: { 'p-depth': ['10'], 'p-mode': ['longest'] } },
      ]),
    ),
    execution_summary: Object.fromEntries(models.map((m) => [m.id, summary(m.summary)])),
    data: {},
  };
}

const execution = (id: string, modelId: string, over: Partial<Execution> = {}): Execution => ({
  id,
  modelid: modelId,
  status: 'SUCCESS',
  run_progress: 1,
  start_time: '2024-01-01T00:00:00Z',
  end_time: '2024-01-01T00:04:00Z',
  bindings: {},
  results: {},
  ...over,
});

const stages = [
  {
    stage_id: 'step-1',
    type: 'flow_step',
    name: 'Ingest corpus',
    depends_on: [],
    status: 'completed',
    provider: 'tapis-workflows',
    provider_ids: { task_id: 'step-1-etl_process' },
  },
  {
    stage_id: 'step-2',
    type: 'flow_step',
    name: 'Embed',
    depends_on: ['step-1'],
    status: 'running',
    provider: 'tapis-workflows',
    provider_ids: { task_id: 'step-2-etl_process' },
  },
];

const flowRun = (over: Partial<UnifiedRunSnapshot> = {}): UnifiedRunSnapshot => ({
  run_id: 'ue_flow-1',
  status: 'adapter_running',
  adapter_stage: 'flow',
  execution_mode: 'workflow_pipeline',
  tapis_workflow: {
    provider: 'tapis-workflows',
    workflow_id: 'wf-1',
    run_id: 'wr-1',
    stage_count: 2,
  },
  workflow_stages: stages,
  ...over,
});

function renderRuns(props: Partial<React.ComponentProps<typeof MintRuns>> = {}) {
  return renderWithProviders(
    <MintRuns
      threadData={thread([{ id: 'm1', summary: { successful_runs: 0 } }])}
      executions={{}}
      canWrite
      canExecute
      ensembleManagerApi="http://ensemble"
      onContinue={vi.fn()}
      onFetchRuns={vi.fn()}
      onSubmitRuns={vi.fn().mockResolvedValue(undefined)}
      {...props}
    />,
  );
}

const header = (name: RegExp | string) => screen.getByRole('button', { name });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));
});
afterEach(() => vi.unstubAllGlobals());

// ─── A single run ────────────────────────────────────────────────────────────

describe('a single run', () => {
  const flowThread = thread([
    {
      id: 'flow-1',
      model: { isFlow: true, input_parameters: [] },
      summary: { successful_runs: 0 },
    },
  ]);
  const flowExecutions: ModelExecutionsMap = {
    'flow-1': {
      loading: false,
      executions: [execution('exec-1', 'flow-1', { status: 'RUNNING' })],
    },
  };

  it('has no counters, run configuration box, pager or run table, and has Log and Files', () => {
    renderRuns({
      threadData: flowThread,
      executions: flowExecutions,
      unifiedRuns: { 'flow-1': flowRun() },
    });
    expect(screen.queryByTestId('run-counters-flow-1')).not.toBeInTheDocument();
    expect(screen.queryByText(/run configuration/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Page \d+ of/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('runs-table-flow-1')).not.toBeInTheDocument();
    expect(screen.queryByText(/technical identifiers/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log' })).toBeInTheDocument();
    expect(screen.getByTestId('view-files-exec-1')).toBeInTheDocument();
  });

  it('shows each step once and keeps task ids under a collapsed Technical details', () => {
    renderRuns({
      threadData: flowThread,
      executions: flowExecutions,
      unifiedRuns: { 'flow-1': flowRun() },
    });
    expect(screen.getAllByTestId(/^flow-node-/)).toHaveLength(2);
    const details = screen.getByTestId('flow-technical-details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText('step-2-etl_process')).toBeInTheDocument();
    expect(screen.queryByText(/^Task step-2/)).not.toBeInTheDocument();
  });

  it('puts the log and files buttons on the card and opens the log', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('log line'),
    });
    renderRuns({
      threadData: flowThread,
      executions: flowExecutions,
      unifiedRuns: { 'flow-1': flowRun() },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Log' }));
    expect(await screen.findByRole('dialog', { name: 'Run log' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('log line')).toBeInTheDocument());
  });

  it('lists the settings used collapsed, those changed from default first', () => {
    renderRuns({
      threadData: thread([{ id: 'm1' }]),
      executions: {
        m1: {
          loading: false,
          executions: [execution('exec-1', 'm1', { bindings: { 'p-mode': 'shortest' } })],
        },
      },
    });
    const used = screen.getByTestId('settings-used-m1') as HTMLDetailsElement;
    expect(used.open).toBe(false);
    expect(used).toHaveTextContent('1 changed from default');
    const terms = within(used)
      .getAllByRole('term')
      .map((t) => t.textContent);
    expect(terms[0]).toContain('match mode');
    expect(terms[1]).toContain('flood depth');
  });
});

// ─── Several runs ────────────────────────────────────────────────────────────

describe('several runs of one model', () => {
  const sweep = thread([
    {
      id: 'm1',
      summary: { total_runs: 3, submitted_runs: 3, successful_runs: 2, failed_runs: 0 },
    },
  ]);
  const rows = (...statuses: string[]): ModelExecutionsMap => ({
    m1: {
      loading: false,
      executions: statuses.map((status, i) =>
        execution(`exec-${i + 1}`, 'm1', { status, bindings: { 'p-depth': String(i) } }),
      ),
    },
  });

  it('shows compact counters and the table, and no pager for one page', () => {
    renderRuns({ threadData: sweep, executions: rows('SUCCESS', 'SUCCESS', 'RUNNING') });
    expect(screen.getByTestId('run-counters-m1')).toHaveTextContent('2 of 3 completed');
    expect(screen.getByTestId('run-counters-m1')).toHaveTextContent('1 running');
    expect(screen.getByTestId('runs-table-m1')).toBeInTheDocument();
    expect(screen.queryByText(/Page \d+ of/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('single-run-m1')).not.toBeInTheDocument();
    expect(screen.queryByText(/run configuration/i)).not.toBeInTheDocument();
    // The table still trims: only what differs between runs is a column.
    const table = screen.getByTestId('runs-table-m1');
    expect(within(table).getByText('flood depth')).toBeInTheDocument();
    expect(within(table).queryByText('match mode')).not.toBeInTheDocument();
    expect(screen.getByTestId('same-for-every-run-m1')).toHaveTextContent('match mode longest');
  });

  it('shows a pager only when there is more than one page', () => {
    renderRuns({
      threadData: thread([
        { id: 'm1', summary: { total_runs: 250, submitted_runs: 250, successful_runs: 0 } },
      ]),
      executions: rows('RUNNING', 'RUNNING'),
    });
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
  });
});

// ─── Cards: collapse, defaults ───────────────────────────────────────────────

describe('collapsible model cards', () => {
  const several = thread([
    { id: 'done', summary: { successful_runs: 1 } },
    { id: 'busy', summary: { successful_runs: 0 } },
    { id: 'broke', summary: { successful_runs: 0, failed_runs: 1 } },
  ]);
  const execs: ModelExecutionsMap = {
    done: { loading: false, executions: [execution('e-done', 'done')] },
    busy: { loading: false, executions: [execution('e-busy', 'busy', { status: 'RUNNING' })] },
    broke: { loading: false, executions: [execution('e-broke', 'broke', { status: 'FAILURE' })] },
  };

  it('opens the ones that need attention and closes a completed one when there are several', () => {
    renderRuns({ threadData: several, executions: execs });
    expect(header(/Model done/)).toHaveAttribute('aria-expanded', 'false');
    expect(header(/Model busy/)).toHaveAttribute('aria-expanded', 'true');
    expect(header(/Model broke/)).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByTestId('view-files-e-done')).not.toBeInTheDocument();
    expect(screen.getByTestId('view-files-e-busy')).toBeInTheDocument();
  });

  it('opens a completed model when it is the only one', () => {
    renderRuns({
      threadData: thread([{ id: 'done', summary: { successful_runs: 1 } }]),
      executions: { done: execs.done! },
    });
    expect(header(/Model done/)).toHaveAttribute('aria-expanded', 'true');
  });

  it('toggles on a click, hides the content, and remembers the choice', () => {
    const view = renderRuns({ threadData: several, executions: execs });
    fireEvent.click(header(/Model done/));
    expect(header(/Model done/)).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('view-files-e-done')).toBeInTheDocument();

    fireEvent.click(header(/Model busy/));
    expect(header(/Model busy/)).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('view-files-e-busy')).not.toBeInTheDocument();

    // A re-render with the same data keeps what the user chose.
    view.rerender(
      <MintRuns
        threadData={several}
        executions={execs}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
      />,
    );
    expect(header(/Model done/)).toHaveAttribute('aria-expanded', 'true');
    expect(header(/Model busy/)).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the status and the time it took in the header', () => {
    renderRuns({ threadData: several, executions: execs });
    expect(header(/Model done/)).toHaveTextContent('Completed');
    expect(header(/Model done/)).toHaveTextContent('took 4 min');
    expect(header(/Model busy/)).toHaveTextContent('Running');
    expect(header(/Model busy/)).toHaveTextContent('Started');
  });
});

// ─── Paused ──────────────────────────────────────────────────────────────────

describe('a run paused for an edit', () => {
  it('shows the edit controls directly under the sentence, before the steps', () => {
    const paused = flowRun({
      status: 'awaiting_edit',
      started_by: 'alice',
      model_child_id: 'exec-1',
      pause: {
        output_key: '1:1',
        file: 'lexicon.json',
        file_location: 'tapis://ls6/scratch/alice/lexicon.json',
        paused_after_step: 1,
        paused_at: null,
      },
    });
    renderRuns({
      threadData: thread([
        { id: 'flow-1', model: { isFlow: true }, summary: { successful_runs: 0 } },
      ]),
      executions: {
        'flow-1': {
          loading: false,
          executions: [execution('exec-1', 'flow-1', { status: 'RUNNING' })],
        },
      },
      unifiedRuns: { 'flow-1': paused },
      currentUsername: 'alice',
      onResumeWorkflow: vi.fn(),
    });
    const panel = screen.getByTestId('flow-run-panel');
    expect(panel.firstElementChild).toBe(screen.getByTestId('flow-paused'));
    expect(screen.getByRole('button', { name: 'Upload the edited file' })).toBeInTheDocument();
    expect(screen.getByTestId('resume-flow')).toBeInTheDocument();
    expect(header(/Model flow-1/)).toHaveAttribute('aria-expanded', 'true');
  });
});

// ─── Restart ─────────────────────────────────────────────────────────────────

describe('restarting a failed run', () => {
  const failedThread = thread([
    { id: 'm1', summary: { successful_runs: 0, failed_runs: 1 } },
    { id: 'm2', summary: { successful_runs: 1 } },
  ]);
  const failedRows: ModelExecutionsMap = {
    m1: { loading: false, executions: [execution('exec-1', 'm1', { status: 'FAILURE' })] },
    m2: { loading: false, executions: [execution('exec-2', 'm2')] },
  };
  const failure = (over: Partial<UnifiedRunSnapshot> = {}): UnifiedRunSnapshot => ({
    run_id: 'ue_m1',
    status: 'failed',
    execution_mode: 'workflow_pipeline',
    failure_code: 'MODEL_FAILED',
    error_message: 'job exited with code 2',
    ...over,
  });

  it('shows the reason and a Restart button on the failed model only', () => {
    renderRuns({
      threadData: failedThread,
      executions: failedRows,
      unifiedRuns: { m1: failure() },
    });
    expect(screen.getByText('Failure: MODEL_FAILED')).toBeInTheDocument();
    expect(screen.getByText('job exited with code 2')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Restart' })).toHaveLength(1);
  });

  it('sends that model again, and only that model', async () => {
    const onSubmitRuns = vi.fn().mockResolvedValue(undefined);
    renderRuns({
      threadData: failedThread,
      executions: failedRows,
      unifiedRuns: { m1: failure() },
      onSubmitRuns,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(onSubmitRuns).toHaveBeenCalledTimes(1));
    expect(onSubmitRuns).toHaveBeenCalledWith('m1', 60);
  });

  it('disables Restart while the send is in flight, so it cannot start twice', async () => {
    let finish: () => void = () => undefined;
    const onSubmitRuns = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    renderRuns({
      threadData: failedThread,
      executions: failedRows,
      unifiedRuns: { m1: failure() },
      onSubmitRuns,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    const pending = await screen.findByRole('button', { name: /restarting/i });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(onSubmitRuns).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restart' })).toBeEnabled());
  });

  it('shows why a restart was refused', async () => {
    renderRuns({
      threadData: failedThread,
      executions: failedRows,
      unifiedRuns: { m1: failure() },
      onSubmitRuns: vi.fn().mockRejectedValue(new EnsembleManagerError(500, 'boom')),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(await screen.findByText('boom')).toBeInTheDocument();
  });

  it('restarts a failed flow too, and not while it is running or without permission', () => {
    const flowThread = thread([
      { id: 'flow-1', model: { isFlow: true }, summary: { successful_runs: 0, failed_runs: 1 } },
    ]);
    const flowFailed = flowRun({ status: 'failed', failure_code: 'FLOW_FAILED' });
    const view = renderRuns({ threadData: flowThread, unifiedRuns: { 'flow-1': flowFailed } });
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument();
    view.unmount();

    renderRuns({ threadData: flowThread, unifiedRuns: { 'flow-1': flowFailed }, canWrite: false });
    expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument();
  });

  it('offers no Restart on a run that is still running', () => {
    renderRuns({
      threadData: thread([{ id: 'm1', summary: { successful_runs: 0 } }]),
      executions: {
        m1: { loading: false, executions: [execution('exec-1', 'm1', { status: 'RUNNING' })] },
      },
    });
    expect(screen.queryByRole('button', { name: /restart/i })).not.toBeInTheDocument();
  });

  const sweepThread = thread([
    { id: 'm1', summary: { total_runs: 3, submitted_runs: 3, successful_runs: 1, failed_runs: 2 } },
  ]);
  const sweepRows = (...statuses: string[]): ModelExecutionsMap => ({
    m1: {
      loading: false,
      executions: statuses.map((status, i) =>
        execution(`exec-${i + 1}`, 'm1', { status, bindings: { 'p-depth': String(i + 1) } }),
      ),
    },
  });

  it('has no per-row Restart in a table of runs; one model-level button asks to confirm first', async () => {
    const onSubmitRuns = vi.fn().mockResolvedValue(undefined);
    renderRuns({
      threadData: sweepThread,
      executions: sweepRows('FAILURE', 'SUCCESS', 'FAILURE'),
      onSubmitRuns,
    });
    expect(screen.queryByTestId(/^restart-run-exec-/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restart all 3 runs' }));
    // Nothing is sent until the person confirms, and the card says what is sent.
    expect(onSubmitRuns).not.toHaveBeenCalled();
    expect(screen.getByTestId('restart-confirm-m1')).toHaveTextContent(
      'sends all 3 runs again, including the 1 that succeeded',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSubmitRuns).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Restart all 3 runs' }));
    fireEvent.click(screen.getByTestId('restart-confirm-yes-m1'));
    await waitFor(() => expect(onSubmitRuns).toHaveBeenCalledWith('m1', 60));
  });

  it('offers no Restart while a sibling run is still running, even though one failed', () => {
    renderRuns({
      threadData: thread([
        {
          id: 'm1',
          summary: { total_runs: 3, submitted_runs: 3, successful_runs: 0, failed_runs: 1 },
        },
      ]),
      executions: sweepRows('FAILURE', 'RUNNING', 'SUCCESS'),
      unifiedRuns: { m1: failure() },
    });
    expect(screen.queryByRole('button', { name: /restart/i })).not.toBeInTheDocument();
    expect(
      screen.getByText(/restart is offered when the others have finished/i),
    ).toBeInTheDocument();
  });

  it('carries the earlier run time and queue, and lets the time be changed', async () => {
    const onRestartRuns = vi.fn().mockResolvedValue(undefined);
    renderRuns({
      threadData: failedThread,
      executions: failedRows,
      unifiedRuns: { m1: failure({ model_result: { __max_minutes: 240, __queue: 'skx-dev' } }) },
      onRestartRuns,
    });
    const minutes = screen.getByTestId('restart-minutes-m1');
    expect(minutes).toHaveValue(240);
    fireEvent.change(minutes, { target: { value: '300' } });
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    await waitFor(() =>
      expect(onRestartRuns).toHaveBeenCalledWith('m1', { maxMinutes: 300, queue: 'skx-dev' }),
    );
  });

  it('shows the default time that will be used when the earlier one was not kept', () => {
    renderRuns({
      threadData: failedThread,
      executions: failedRows,
      unifiedRuns: { m1: failure() },
    });
    expect(screen.getByTestId('restart-minutes-m1')).toHaveValue(60);
    expect(screen.getByText(/earlier run's time was not kept/i)).toBeInTheDocument();
  });

  describe('publishing', () => {
    const publisher = {
      transform_spec_id: 'spec-1',
      name: 'Publish',
      catalog_tokens: ['ckan', 'stac'],
      parameters: [],
      can_publish: { ok: true, reason: null },
    };
    const planWithPublish = `em_${btoa(JSON.stringify({ publish: ['ckan', 'stac'] }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}.sig`;

    beforeEach(() => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => ({
        ok: true,
        json: async () =>
          String(url).includes('/plans/publishers') ? { publishers: [publisher] } : {},
      }));
    });

    it('pre-selects what the earlier run published and sends it again', async () => {
      const onRestartRuns = vi.fn().mockResolvedValue(undefined);
      renderRuns({
        threadData: failedThread,
        executions: failedRows,
        unifiedRuns: { m1: failure({ plan_id: planWithPublish }) },
        onRestartRuns,
      });
      expect(await screen.findByTestId('publish-catalog-m1')).toBeInTheDocument();
      expect(screen.getByTestId('publish-toggle-m1')).toBeChecked();
      fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
      await waitFor(() => expect(onRestartRuns).toHaveBeenCalled());
      expect(onRestartRuns.mock.calls[0]?.[1]).toMatchObject({
        publish: { tokens: ['ckan', 'stac'] },
      });
    });

    it('sends no publish when the earlier run published nothing and none is chosen', async () => {
      const onRestartRuns = vi.fn().mockResolvedValue(undefined);
      renderRuns({
        threadData: failedThread,
        executions: failedRows,
        unifiedRuns: { m1: failure() },
        onRestartRuns,
      });
      expect(await screen.findByTestId('publish-toggle-m1')).not.toBeChecked();
      fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
      await waitFor(() => expect(onRestartRuns).toHaveBeenCalled());
      expect(onRestartRuns.mock.calls[0]?.[1]).not.toHaveProperty('publish');
    });
  });

  it('shows Restart as in flight when a send from the other step is running', () => {
    renderRuns({
      threadData: failedThread,
      executions: failedRows,
      unifiedRuns: { m1: failure() },
      restartingModels: { m1: true },
    });
    expect(screen.getByRole('button', { name: /restarting/i })).toBeDisabled();
  });
});
