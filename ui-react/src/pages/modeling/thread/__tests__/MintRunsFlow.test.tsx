/**
 * Tests for how MintRuns treats a flow: its own run view, no model-only controls,
 * and run records that load.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils/render';
import { MintRuns } from '../MintRuns';
import type { ModelExecutionsMap, ThreadExecutionData } from '@/graphql/generated/execution';
import type { UnifiedRunSnapshot } from '@/lib/ensemble-manager';

const flowModel = {
  id: 'flow-1',
  name: 'Sensemaking',
  isFlow: true,
  input_parameters: [],
  input_files: [],
  output_files: [{ id: 'out-1', name: 'report' }],
};

function threadData(submitted: boolean): ThreadExecutionData {
  return {
    id: 'thread-1',
    models: { 'flow-1': flowModel },
    model_ensembles: { 'flow-1': { id: 'ens-1', bindings: {} } },
    execution_summary: {
      'flow-1': {
        total_runs: 1,
        submitted_runs: submitted ? 1 : 0,
        failed_runs: 0,
        successful_runs: 0,
        ...(submitted
          ? { submitted_for_execution: true, submission_time: '2024-01-01T00:00:00Z' }
          : {}),
      },
    },
    data: {},
  };
}

const run: UnifiedRunSnapshot = {
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
  workflow_stages: [
    {
      stage_id: 'step-1',
      type: 'flow_step',
      name: 'Ingest corpus',
      depends_on: [],
      status: 'completed',
      provider: 'tapis-workflows',
      provider_ids: {},
    },
    {
      stage_id: 'step-2',
      type: 'flow_step',
      name: 'Embed',
      depends_on: ['step-1'],
      status: 'running',
      provider: 'tapis-workflows',
      provider_ids: {},
    },
  ],
};

const noExecutions: ModelExecutionsMap = {};

function renderRuns(props: Partial<React.ComponentProps<typeof MintRuns>> = {}) {
  return renderWithProviders(
    <MintRuns
      threadData={threadData(true)}
      executions={noExecutions}
      unifiedRuns={{ 'flow-1': run }}
      canWrite
      canExecute
      ensembleManagerApi="http://ensemble"
      onContinue={vi.fn()}
      onFetchRuns={vi.fn()}
      onSubmitRuns={vi.fn()}
      {...props}
    />,
  );
}

describe('MintRuns for a flow', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the flow steps instead of the model rows, and says flow', () => {
    renderRuns();
    expect(screen.getByTestId('flow-run-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('unified-execution-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('flow-step-step-1')).toHaveTextContent('Ingest corpus');
    expect(screen.getByTestId('flow-step-step-2')).toHaveTextContent('Running');
    expect(screen.queryByText(/run model/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/pass inputs to model/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/the model is running/i)).not.toBeInTheDocument();
  });

  it('says the flow is running or complete in the headline', () => {
    const { unmount } = renderRuns({
      threadData: {
        ...threadData(true),
        execution_summary: {
          'flow-1': {
            total_runs: 1,
            submitted_runs: 1,
            failed_runs: 0,
            successful_runs: 0,
            submission_time: 't',
            submitted_for_execution: true,
          },
        },
      },
    });
    expect(screen.getByText(/the flow is running/i)).toBeInTheDocument();
    unmount();
    renderRuns({
      unifiedRuns: { 'flow-1': { ...run, status: 'completed' } },
      threadData: {
        ...threadData(true),
        execution_summary: {
          'flow-1': {
            total_runs: 1,
            submitted_runs: 1,
            failed_runs: 0,
            successful_runs: 1,
            submission_time: 't',
            submitted_for_execution: true,
          },
        },
      },
    });
    expect(screen.getByText(/the flow run is complete/i)).toBeInTheDocument();
  });

  it('keeps the cancel control while the flow is active', () => {
    renderRuns({ onCancelWorkflow: vi.fn() });
    expect(screen.getByTestId('cancel-workflow')).toBeInTheDocument();
  });

  it('before sending: no publishers request, no maximum run time, no publish controls', () => {
    renderRuns({ threadData: threadData(false), unifiedRuns: undefined });
    expect(screen.getByTestId('submit-runs-flow-1')).toBeInTheDocument();
    expect(screen.queryByText(/maximum run time/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('max-runtime-flow-1')).not.toBeInTheDocument();
    const calls = (globalThis.fetch as unknown as Mock).mock.calls.map((c) => String(c[0]));
    expect(calls.filter((url) => url.includes('/plans/publishers'))).toEqual([]);
  });

  it('resolves the run records table for a flow execution', () => {
    renderRuns({
      executions: {
        'flow-1': {
          loading: false,
          executions: [
            {
              id: 'exec-flow',
              modelid: 'flow-1',
              run_id: 'ue_flow-1',
              status: 'SUCCESS',
              run_progress: 1,
              bindings: {},
              results: { 'out-1': { id: 'r1', name: 'report.pdf' } },
            },
          ],
        },
      },
    });
    expect(screen.queryByText(/loading run records/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('view-files-exec-flow')).toBeInTheDocument();
  });

  it('does not claim to be loading when a flow has no run records yet', () => {
    renderRuns({ executions: { 'flow-1': { loading: false, executions: [] } } });
    expect(screen.queryByText(/loading run records/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('no-run-records-flow-1')).toBeInTheDocument();
  });

  it('reads the run records again when the flow run changes state', () => {
    const onFetchRuns = vi.fn();
    const view = renderRuns({ onFetchRuns });
    expect(onFetchRuns).toHaveBeenCalledTimes(1); // the mount fetch
    view.rerender(
      <MintRuns
        threadData={threadData(true)}
        executions={noExecutions}
        unifiedRuns={{ 'flow-1': { ...run, status: 'completed' } }}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={onFetchRuns}
        onSubmitRuns={vi.fn()}
      />,
    );
    expect(onFetchRuns).toHaveBeenCalledTimes(2);
  });
});
