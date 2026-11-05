/**
 * Tests for MintRuns — execution lifecycle step.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils/render';
import { storeTokens } from '@/lib/auth/token-store';
import { MintRuns } from '../MintRuns';
import type { ThreadExecutionData, ModelExecutionsMap } from '@/graphql/generated/execution';
import {
  EnsembleManagerError,
  type UnifiedPublication,
  type UnifiedRunSnapshot,
} from '@/lib/ensemble-manager';
import type { ThreadAdapterPlan } from '@/lib/adapter-execution';

// ─── Mock data ────────────────────────────────────────────────────────────────

const mockModel = {
  id: 'model-1',
  name: 'FloodModel',
  input_parameters: [
    {
      id: 'param-1',
      name: 'flood_depth',
      type: 'float',
      default: '10',
    },
  ],
  input_files: [],
  output_files: [{ id: 'out-1', name: 'output_file' }],
};

const mockThreadData: ThreadExecutionData = {
  id: 'thread-1',
  models: { 'model-1': mockModel },
  model_ensembles: {
    'model-1': {
      id: 'ens-1',
      bindings: { 'param-1': ['10', '20'] },
    },
  },
  execution_summary: {
    'model-1': {
      total_runs: 2,
      submitted_runs: 0,
      failed_runs: 0,
      successful_runs: 0,
    },
  },
  data: {},
};

const mockThreadDataSubmitted: ThreadExecutionData = {
  ...mockThreadData,
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

const noParamsDoneThread: ThreadExecutionData = {
  id: 'thread-2',
  models: { 'model-1': mockModel },
  model_ensembles: { 'model-1': { id: 'ens-1', bindings: {} } }, // no bindings
  execution_summary: {},
  data: {},
};

const emptyExecutions: ModelExecutionsMap = {};
const executionsWithOneRun: ModelExecutionsMap = {
  'model-1': {
    loading: false,
    executions: [
      {
        id: 'exec-1',
        modelid: 'model-1',
        status: 'SUCCESS',
        run_progress: 1,
        bindings: {},
        results: {},
      },
    ],
  },
};
const loadingExecutions: ModelExecutionsMap = {
  'model-1': { executions: [], loading: true },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MintRuns', () => {
  it('renders the guard message when params are not done', () => {
    renderWithProviders(
      <MintRuns
        threadData={noParamsDoneThread}
        executions={emptyExecutions}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
      />,
    );
    expect(screen.getByText(/please setup some models first/i)).toBeInTheDocument();
  });

  it('renders the runs monitoring heading when params are done', () => {
    renderWithProviders(
      <MintRuns
        threadData={mockThreadData}
        executions={emptyExecutions}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
      />,
    );
    expect(screen.getByText(/monitoring model runs/i)).toBeInTheDocument();
  });

  it('renders the model name in the runs list', () => {
    renderWithProviders(
      <MintRuns
        threadData={mockThreadData}
        executions={emptyExecutions}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
      />,
    );
    expect(screen.getByText('FloodModel')).toBeInTheDocument();
  });

  it('shows Send Runs button when not yet submitted and user can execute', () => {
    renderWithProviders(
      <MintRuns
        threadData={mockThreadData}
        executions={emptyExecutions}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
      />,
    );
    expect(screen.getByTestId('submit-runs-model-1')).toBeInTheDocument();
    expect(screen.getByText(/send runs/i)).toBeInTheDocument();
  });

  it('calls onSubmitRuns when Send Runs is clicked', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <MintRuns
        threadData={mockThreadData}
        executions={emptyExecutions}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={onSubmit}
      />,
    );
    fireEvent.click(screen.getByTestId('submit-runs-model-1'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('model-1', 60));
  });

  it('shows submission errors instead of leaving the rejection unhandled', async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(new Error('Ensemble manager returned 422: no transform path found'));
    renderWithProviders(
      <MintRuns
        threadData={mockThreadData}
        executions={emptyExecutions}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={onSubmit}
      />,
    );

    fireEvent.click(screen.getByTestId('submit-runs-model-1'));

    expect(
      await screen.findByText('Ensemble manager returned 422: no transform path found'),
    ).toBeInTheDocument();
  });

  it('shows a specific message for a SECRET_REQUIRED submission error', async () => {
    const onSubmit = vi.fn().mockRejectedValue(
      new EnsembleManagerError(409, 'raw', 'SECRET_REQUIRED', {
        missing: [{ name: 'earthdata', source: 'owner', fields: ['username'] }],
      }),
    );
    renderWithProviders(
      <MintRuns
        threadData={mockThreadData}
        executions={emptyExecutions}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={onSubmit}
      />,
    );

    fireEvent.click(screen.getByTestId('submit-runs-model-1'));

    expect(
      await screen.findByText(/needs a credential its owner has not registered yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/earthdata/)).not.toBeInTheDocument();
  });

  it('passes a user-selected maximum runtime when sending runs', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <MintRuns
        threadData={mockThreadData}
        executions={emptyExecutions}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={onSubmit}
      />,
    );

    fireEvent.change(screen.getByTestId('max-runtime-model-1'), { target: { value: '135' } });
    fireEvent.click(screen.getByTestId('submit-runs-model-1'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('model-1', 135));
  });

  it('shows loading spinner when executions are loading', () => {
    renderWithProviders(
      <MintRuns
        threadData={mockThreadDataSubmitted}
        executions={loadingExecutions}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
      />,
    );
    // The runs table area should show a loading spinner (animated element)
    const spinners = document.querySelectorAll('.animate-spin');
    expect(spinners.length).toBeGreaterThan(0);
  });

  it('shows the unified pipeline stages and external workflow identifiers', () => {
    const unifiedRun: UnifiedRunSnapshot = {
      run_id: 'ue-parent-1',
      execution_mode: 'workflow_pipeline',
      status: 'adapter_running',
      model_job_id: 'model-job-1',
      tapis_workflow: {
        provider: 'tapis-workflows',
        workflow_id: 'workflow-1',
        run_id: 'tapis-run-1',
        stage_count: 1,
      },
      adapter_runs: [
        {
          execution_kind: 'workflow',
          run_id: 'adapter-run-1',
          status: 'running',
          tapis_workflow_id: 'workflow-1',
          tapis_run_id: 'tapis-run-1',
        },
      ],
    };

    renderWithProviders(
      <MintRuns
        threadData={mockThreadDataSubmitted}
        executions={emptyExecutions}
        unifiedRuns={{ 'model-1': unifiedRun }}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
      />,
    );

    expect(screen.getByTestId('unified-execution-panel')).toBeInTheDocument();
    expect(screen.getByText('Workflow pipeline')).toBeInTheDocument();
    expect(screen.getByText(/Tapis workflow run ID:/)).toBeInTheDocument();
    expect(screen.queryByText(/Ensemble Manager parent/)).not.toBeInTheDocument();
    expect(screen.getByText('model-job-1')).toBeInTheDocument();
    expect(screen.getAllByText('workflow-1').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/tapis-run-1/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Tapis Workflows tracking:/)).toBeInTheDocument();
  });

  it('flags a stalled workflow and cancels it only after confirmation', async () => {
    const onCancelWorkflow = vi.fn().mockResolvedValue(undefined);
    const unifiedRun: UnifiedRunSnapshot = {
      run_id: 'ue_parent-1',
      execution_mode: 'workflow_pipeline',
      status: 'adapter_running',
      failure_code: 'COMPOSITE_WORKFLOW_STALLED',
      error_message:
        'Dispatched to Tapis Workflows at 2026-11-02 13:05 UTC; no signal has been received from the model task in 15 min.',
      adapter_runs: [
        {
          execution_kind: 'composite_workflow',
          run_id: 'adapter-run-1',
          status: 'running',
          health: 'stalled',
          error_message:
            'Dispatched to Tapis Workflows at 2026-11-02 13:05 UTC; no signal has been received from the model task in 15 min.',
        },
      ],
    };

    renderWithProviders(
      <MintRuns
        threadData={mockThreadDataSubmitted}
        executions={emptyExecutions}
        unifiedRuns={{ 'model-1': unifiedRun }}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
        onCancelWorkflow={onCancelWorkflow}
      />,
    );

    const alert = screen.getByTestId('workflow-health');
    expect(alert).toHaveTextContent('This run appears to be stuck.');
    expect(alert).toHaveTextContent(/no signal has been received/);

    fireEvent.click(screen.getByTestId('cancel-workflow'));
    expect(onCancelWorkflow).not.toHaveBeenCalled();
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-cancel-workflow'));
    await waitFor(() => expect(onCancelWorkflow).toHaveBeenCalledWith('model-1'));
  });

  it('shows the queued model job and elapsed time for a healthy workflow', () => {
    const startedAt = new Date(Date.now() - 95 * 60_000).toISOString();
    const unifiedRun: UnifiedRunSnapshot = {
      run_id: 'ue_parent-1',
      execution_mode: 'workflow_pipeline',
      status: 'model_running',
      adapter_runs: [
        {
          execution_kind: 'composite_workflow',
          run_id: 'adapter-run-1',
          status: 'running',
          health: 'ok',
          model_job_id: 'b137dd42-86fd-412c-aa19-0a1a76ca2af7-007',
          started_at: startedAt,
        },
      ],
    };

    renderWithProviders(
      <MintRuns
        threadData={mockThreadDataSubmitted}
        executions={emptyExecutions}
        unifiedRuns={{ 'model-1': unifiedRun }}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('workflow-health')).not.toBeInTheDocument();
    const status = screen.getByTestId('workflow-queue-status');
    expect(status).toHaveTextContent('b137dd42-86fd-412c-aa19-0a1a76ca2af7-007');
    expect(status).toHaveTextContent(/1 h 35 min ago/);
  });

  it('shows the modeled spring-flow scalar in the workflow panel', () => {
    renderWithProviders(
      <MintRuns
        threadData={mockThreadDataSubmitted}
        executions={emptyExecutions}
        unifiedRuns={{
          'model-1': {
            run_id: 'ue-spring-1',
            execution_mode: 'workflow_pipeline',
            status: 'completed',
            output_handoff: {
              result: { schema_version: 1, status: 'ok', value: 23.9, unit: 'cfs' },
            },
          },
        }}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
      />,
    );

    expect(screen.getByTestId('run-answer-card')).toHaveTextContent('23.9');
    expect(screen.getByTestId('run-answer-card')).toHaveTextContent('cfs');
  });

  describe('publication outcome', () => {
    function renderWithPublication(publication: UnifiedPublication) {
      renderWithProviders(
        <MintRuns
          threadData={mockThreadDataSubmitted}
          executions={emptyExecutions}
          unifiedRuns={{
            'model-1': {
              run_id: 'ue-pub-1',
              execution_mode: 'workflow_pipeline',
              status: 'completed',
              output_handoff: { publication },
            } as UnifiedRunSnapshot,
          }}
          canWrite
          canExecute
          ensembleManagerApi="http://ensemble"
          onContinue={vi.fn()}
          onFetchRuns={vi.fn()}
          onSubmitRuns={vi.fn()}
        />,
      );
    }

    it('links the CKAN dataset and STAC item when published', () => {
      renderWithPublication({
        status: 'published',
        ckan_dataset: 'https://ckan.example/dataset/d1',
        stac_item: 'https://stac.example/collections/c/items/i1',
        public: true,
      });
      expect(screen.getByRole('link', { name: 'CKAN dataset' })).toHaveAttribute(
        'href',
        'https://ckan.example/dataset/d1',
      );
      expect(screen.getByRole('link', { name: 'STAC item' })).toHaveAttribute(
        'href',
        'https://stac.example/collections/c/items/i1',
      );
    });

    it('shows the error text when publishing failed', () => {
      renderWithPublication({ status: 'failed', error: 'HTTP 403 from CKAN' });
      expect(screen.getByTestId('publication-failed')).toHaveTextContent('HTTP 403 from CKAN');
    });

    it('says it is waiting for the owner when awaiting_owner', () => {
      renderWithPublication({ status: 'awaiting_owner' });
      expect(screen.getByTestId('publication-awaiting-owner')).toHaveTextContent(
        "Waiting for the run's owner to publish",
      );
    });

    it('renders a publish node labelled with its catalog in the graph', () => {
      const postPlan: ThreadAdapterPlan = {
        thread_model_id: 'ens-1',
        model_io_id: 'out-1',
        source_resource_id: null,
        stage: 'post_model',
        source_kind: 'model_output',
        executor: 'svo_adapter',
        adapter_plan_id: 'plan-pub',
        status: 'transform_required',
        plan_json: {
          plan_id: null,
          executor: 'svo_adapter',
          version: 1,
          status: 'ready',
          parameters: [],
          parameter_values: {},
          post_model_adapter: {
            target_contract: { catalog: 'ckan+stac' },
            steps: [{ transform_spec_id: 'ts-stac', publishes: true, catalog: 'ckan+stac' }],
          },
        },
        parameter_values: {},
      };
      renderWithProviders(
        <MintRuns
          threadData={{ ...mockThreadDataSubmitted, adapter_plans: { 'model-1': [postPlan] } }}
          executions={emptyExecutions}
          unifiedRuns={{
            'model-1': {
              run_id: 'ue-pub-2',
              execution_mode: 'workflow_pipeline',
              adapter_stage: 'post_model',
              status: 'completed',
            } as UnifiedRunSnapshot,
          }}
          canWrite
          canExecute
          ensembleManagerApi="http://ensemble"
          onContinue={vi.fn()}
          onFetchRuns={vi.fn()}
          onSubmitRuns={vi.fn()}
        />,
      );
      const node = screen.getByTestId('workflow-node-publish');
      expect(node).toHaveTextContent('publish');
      expect(node).toHaveTextContent('ckan+stac');
    });
  });

  it('keeps the model successful when only the downstream adapter fails', () => {
    const unifiedRun: UnifiedRunSnapshot = {
      run_id: 'ue-parent-failed-adapter',
      execution_mode: 'workflow_pipeline',
      adapter_stage: 'post_model',
      status: 'failed',
      model_job_id: 'model-job-1',
      model_result: { status: 'SUCCESS' },
      workflow_stages: [
        {
          stage_id: 'model',
          type: 'model',
          depends_on: [],
          status: 'failed',
          provider: 'tapis',
          provider_ids: {},
        },
        {
          stage_id: 'output-handoff',
          type: 'output_handoff',
          depends_on: ['model'],
          status: 'succeeded',
          provider: 'ensemble_manager',
          provider_ids: {},
        },
      ],
      adapter_runs: [{ run_id: 'adapter-run-1', status: 'failed' }],
    };

    renderWithProviders(
      <MintRuns
        threadData={mockThreadDataSubmitted}
        executions={emptyExecutions}
        unifiedRuns={{ 'model-1': unifiedRun }}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
      />,
    );

    const stageCards = Array.from(screen.getByTestId('workflow-stages').children);
    const handoffCard = stageCards.find((card) => card.textContent?.includes('Register outputs'))!;
    const modelCard = stageCards.find((card) => card.textContent?.includes('Run model'))!;
    expect(modelCard).toHaveTextContent('Completed');
    expect(handoffCard).toHaveTextContent('Completed');
    expect(screen.getByText('Workflow pipeline')).toBeInTheDocument();
  });

  it('renders the model-builder graph with SVO contracts and the active stage', () => {
    const postModelPlan: ThreadAdapterPlan = {
      thread_model_id: 'model-1',
      model_io_id: 'output-1',
      stage: 'post_model',
      source_kind: 'model_output',
      adapter_plan_id: 'adapter-plan-1',
      executor: 'svo_adapter',
      status: 'transform_required',
      plan_json: {
        plan_id: 'svo_adapter-plan-1',
        executor: 'svo_adapter',
        version: 1,
        status: 'ready',
        parameters: [],
        parameter_values: {},
        post_model_adapter: {
          source_contract: { standard_variable_uri: 'mint:cbc' },
          target_contract: { standard_variable_uri: 'mint:spring__volume_flow_rate' },
        },
      },
      parameter_values: {},
    };
    const unifiedRun: UnifiedRunSnapshot = {
      run_id: 'ue-parent-graph',
      execution_mode: 'workflow_pipeline',
      adapter_stage: 'post_model',
      status: 'model_running',
      model_job_id: 'model-job-graph',
      workflow_stages: [
        {
          stage_id: 'model',
          type: 'model',
          depends_on: [],
          status: 'running',
          provider: 'tapis',
          provider_ids: {},
        },
        {
          stage_id: 'output-handoff',
          type: 'output_handoff',
          depends_on: ['model'],
          status: 'waiting',
          provider: 'ensemble_manager',
          provider_ids: {},
        },
        {
          stage_id: 'adapter-output-1',
          type: 'adapter_output',
          depends_on: ['output-handoff'],
          status: 'waiting',
          provider: 'svo_adapter',
          provider_ids: {},
        },
      ],
    };

    renderWithProviders(
      <MintRuns
        threadData={{
          ...mockThreadDataSubmitted,
          adapter_plans: { 'model-1': [postModelPlan] },
        }}
        executions={emptyExecutions}
        unifiedRuns={{ 'model-1': unifiedRun }}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
      />,
    );

    expect(screen.getByTestId('workflow-graph')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-node-model')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByTestId('workflow-node-output-handoff')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-node-adapter-output-1')).toBeInTheDocument();
    expect(screen.getByText('Current step:')).toBeInTheDocument();
    expect(screen.getByText('cbc')).toBeInTheDocument();
    expect(screen.getByText('spring__volume_flow_rate')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('workflow-node-adapter-output-1'));
    expect(screen.getByTestId('workflow-graph-details')).toHaveTextContent('Stage details');
    expect(screen.getByTestId('workflow-graph-details')).toHaveTextContent(
      'spring__volume_flow_rate',
    );
  });

  it('explains that a post-model adapter is waiting instead of showing no adapter', () => {
    const unifiedRun: UnifiedRunSnapshot = {
      run_id: 'ue-post-model',
      execution_mode: 'workflow_pipeline',
      adapter_stage: 'post_model',
      status: 'model_running',
      model_job_id: '66f980bc-58eb-4f42-be9a-1ac41d2f28ce',
      adapter_runs: [],
    };

    renderWithProviders(
      <MintRuns
        threadData={mockThreadDataSubmitted}
        executions={emptyExecutions}
        unifiedRuns={{ 'model-1': unifiedRun }}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
      />,
    );

    expect(
      screen.getByText('Legacy/recovery run — composite workflow unavailable'),
    ).toBeInTheDocument();
    expect(screen.getByText('Waiting for model stage')).toBeInTheDocument();
    expect(screen.getByText(/provider workflow reference unavailable/)).toBeInTheDocument();
    expect(screen.queryByText('No adapter step')).not.toBeInTheDocument();
  });

  it('shows a workflow panel from the durable execution run id before refresh completes', () => {
    renderWithProviders(
      <MintRuns
        threadData={mockThreadDataSubmitted}
        executions={{
          'model-1': {
            loading: false,
            executions: [
              {
                ...executionsWithOneRun['model-1']!.executions[0]!,
                run_id: 'ue_parent-2',
                status: 'WAITING',
              },
            ],
          },
        }}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
      />,
    );

    expect(screen.getByTestId('unified-execution-panel')).toBeInTheDocument();
    expect(screen.queryByText('ue_parent-2')).not.toBeInTheDocument();
    expect(screen.getByText(/Tapis workflow run ID:/)).toBeInTheDocument();
    expect(screen.getByText('Workflow pipeline')).toBeInTheDocument();
  });

  it('refreshes workflow details independently from the application log', () => {
    const onRefreshWorkflow = vi.fn().mockResolvedValue(undefined);
    const unifiedRun: UnifiedRunSnapshot = {
      run_id: 'ue-parent-1',
      execution_mode: 'workflow_pipeline',
      status: 'adapter_running',
      adapter_runs: [{ run_id: 'adapter-run-1', status: 'running' }],
    };

    renderWithProviders(
      <MintRuns
        threadData={mockThreadDataSubmitted}
        executions={emptyExecutions}
        unifiedRuns={{ 'model-1': unifiedRun }}
        onRefreshWorkflow={onRefreshWorkflow}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
      />,
    );

    expect(screen.getByTestId('workflow-stages')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('refresh-workflow'));
    expect(onRefreshWorkflow).toHaveBeenCalledWith('model-1');
  });

  it('shows Continue button when all runs are done', () => {
    renderWithProviders(
      <MintRuns
        threadData={mockThreadDataSubmitted}
        executions={{
          'model-1': {
            executions: [],
            loading: false,
          },
        }}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
      />,
    );
    expect(screen.getByTestId('runs-continue-btn')).toBeInTheDocument();
  });

  it('calls onContinue when Continue is clicked', () => {
    const onContinue = vi.fn();
    renderWithProviders(
      <MintRuns
        threadData={mockThreadDataSubmitted}
        executions={{ 'model-1': { executions: [], loading: false } }}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={onContinue}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('runs-continue-btn'));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('does not show Send Runs when canExecute=false', () => {
    renderWithProviders(
      <MintRuns
        threadData={mockThreadData}
        executions={emptyExecutions}
        canWrite={false}
        canExecute={false}
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('submit-runs-model-1')).not.toBeInTheDocument();
    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
  });
});

// ─── Log fetch authentication ─────────────────────────────────────────────────
//
// Regression guard for #85: the log request read a localStorage key that nothing
// writes, so it went out with no Authorization header and failed silently. These
// assert the outgoing header, not the storage key — a key rename in token-store
// must not be able to break the call again.

describe('MintRuns log fetch authentication', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('log line') }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function renderWithOneExecution() {
    renderWithProviders(
      <MintRuns
        threadData={mockThreadDataSubmitted}
        executions={executionsWithOneRun}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /view log/i }));
  }

  function fetchInit(): RequestInit {
    const call = (globalThis.fetch as unknown as Mock).mock.calls[0] as [string, RequestInit];
    return call[1];
  }

  it('sends the stored access token as a Bearer header', async () => {
    storeTokens({ accessToken: 'stored-jwt' });
    renderWithOneExecution();

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());

    expect((globalThis.fetch as unknown as Mock).mock.calls[0]?.[0]).toBe(
      'http://ensemble/executions/exec-1/logs',
    );
    expect(fetchInit().headers).toMatchObject({ Authorization: 'Bearer stored-jwt' });
  });

  it('omits the Authorization header when no token is stored', async () => {
    renderWithOneExecution();

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());

    expect(fetchInit().headers).not.toHaveProperty('Authorization');
  });
});

// A Tapis application declares no output file type, so the user repairs that
// after the first run — from the run itself, not from the model page (#267).
describe('MintRuns archived files', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ files: [] }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers the archived files of each run', () => {
    renderWithProviders(
      <MintRuns
        threadData={mockThreadDataSubmitted}
        executions={executionsWithOneRun}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
      />,
    );
    expect(screen.getByTestId('view-files-exec-1')).toBeInTheDocument();
  });

  it('opens the files dialog on that run', async () => {
    renderWithProviders(
      <MintRuns
        threadData={mockThreadDataSubmitted}
        executions={executionsWithOneRun}
        canWrite
        canExecute
        ensembleManagerApi="http://ensemble"
        onContinue={vi.fn()}
        onFetchRuns={vi.fn()}
        onSubmitRuns={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('view-files-exec-1'));

    expect(await screen.findByTestId('execution-files-dialog')).toBeInTheDocument();
    await waitFor(() =>
      expect((globalThis.fetch as unknown as Mock).mock.calls[0]?.[0]).toBe(
        'http://ensemble/executions/exec-1/files',
      ),
    );
  });
});
