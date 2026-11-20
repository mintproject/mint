/**
 * Tests for FlowRunPanel and the flow graph it draws from `workflow_stages`.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { UnifiedRunSnapshot } from '@/lib/ensemble-manager';
import { FlowRunPanel, flowStageGraph, flowStepState } from '../FlowRunPanel';

type Stages = NonNullable<UnifiedRunSnapshot['workflow_stages']>;

function step(
  id: string,
  name: string,
  status: string,
  dependsOn: string[] = [],
  extra: Partial<Stages[number]> = {},
): Stages[number] {
  return {
    stage_id: id,
    type: 'flow_step',
    name,
    depends_on: dependsOn,
    status,
    provider: 'tapis-workflows',
    provider_ids: { workflow_id: 'wf-1', run_id: 'wr-1', task_id: `task-${id}` },
    ...extra,
  };
}

const fourSteps: Stages = [
  step('step-1', 'Sensemaking: ingest corpus', 'completed'),
  step('step-2', 'Sensemaking: embed', 'running', ['step-1']),
  step('step-3', 'Sensemaking: cluster', 'pending', ['step-1']),
  step('step-4', 'Sensemaking: report', 'pending', ['step-2', 'step-3']),
];

function flowRun(overrides: Partial<UnifiedRunSnapshot> = {}): UnifiedRunSnapshot {
  return {
    run_id: 'ue_flow-1',
    status: 'adapter_running',
    adapter_stage: 'flow',
    execution_mode: 'workflow_pipeline',
    tapis_workflow: {
      provider: 'tapis-workflows',
      workflow_id: 'wf-1',
      run_id: 'wr-1',
      stage_count: 4,
    },
    workflow_stages: fourSteps,
    ...overrides,
  };
}

describe('flowStageGraph', () => {
  it('puts steps with the same dependency in one layer and joins a multi-dependency step', () => {
    const graph = flowStageGraph(fourSteps);
    const at = (id: string) => graph.positions.find((p) => p.node.id === id)!;

    expect(at('step-2').x).toBe(at('step-3').x);
    expect(at('step-2').y).not.toBe(at('step-3').y);
    expect(at('step-2').x).toBeGreaterThan(at('step-1').x);
    expect(at('step-4').x).toBeGreaterThan(at('step-2').x);

    const incoming = (id: string) =>
      graph.edges.filter((e) => e.target === id).map((e) => e.source);
    expect(incoming('step-2')).toEqual(['step-1']);
    expect(incoming('step-3')).toEqual(['step-1']);
    expect(incoming('step-4')?.sort()).toEqual(['step-2', 'step-3']);
    expect(incoming('step-1')).toEqual([]);
  });

  it('ignores a dependency on a step that is not in the run', () => {
    const graph = flowStageGraph([step('a', 'A', 'pending', ['missing'])]);
    expect(graph.edges).toEqual([]);
  });
});

describe('gather stages', () => {
  const gather: Stages = [
    step('step-gather-1', 'Gather Elevation files', 'running'),
    step('step-1', 'Sensemaking: ingest corpus', 'pending', ['step-gather-1']),
  ];

  it('links a gather stage to the step that depends on it', () => {
    const graph = flowStageGraph(gather);
    expect(graph.edges.map((e) => [e.source, e.target])).toEqual([['step-gather-1', 'step-1']]);
    const at = (id: string) => graph.positions.find((p) => p.node.id === id)!;
    expect(at('step-1').x).toBeGreaterThan(at('step-gather-1').x);
  });

  it('renders a gather stage and says why one failed in plain words', () => {
    const failed: Stages = [
      step('step-gather-1', 'Gather Elevation files', 'failed', [], {
        error_message: 'GATHER_RESOURCE_NEEDS_LOGIN: file 3 on data.example.org',
      }),
      ...gather.slice(1),
    ];
    render(<FlowRunPanel run={flowRun({ workflow_stages: failed })} />);
    expect(screen.getByTestId('flow-step-step-gather-1')).toHaveTextContent(
      'Gather Elevation files',
    );
    expect(screen.getByTestId('flow-step-step-gather-1')).toHaveTextContent(
      'file 3 on data.example.org',
    );
    expect(screen.getByTestId('flow-step-step-1')).toBeInTheDocument();
  });
});

describe('flowStepState', () => {
  it('maps the reported words', () => {
    expect(flowStepState('pending')).toBe('waiting');
    expect(flowStepState('running')).toBe('running');
    expect(flowStepState('completed')).toBe('completed');
    expect(flowStepState('failed')).toBe('failed');
    expect(flowStepState('skipped')).toBe('skipped');
  });
});

describe('FlowRunPanel', () => {
  it('lists every step by name with its status', () => {
    render(<FlowRunPanel run={flowRun()} />);
    const list = screen.getByTestId('flow-step-list');
    expect(list.children).toHaveLength(4);
    expect(screen.getByTestId('flow-step-step-1')).toHaveTextContent('Sensemaking: ingest corpus');
    expect(screen.getByTestId('flow-step-step-1')).toHaveTextContent('Completed');
    expect(screen.getByTestId('flow-step-step-2')).toHaveTextContent('Running');
    expect(screen.getByTestId('flow-step-step-3')).toHaveTextContent('Waiting');
    expect(screen.getByTestId('flow-node-step-4')).toBeInTheDocument();
    expect(screen.queryByText(/run model/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/pass inputs to model/i)).not.toBeInTheDocument();
  });

  it('updates the graph nodes when a re-render brings new step states', async () => {
    const { rerender } = render(<FlowRunPanel run={flowRun()} />);
    expect(await screen.findByTestId('flow-node-step-2')).toHaveTextContent('Running');
    expect(screen.getByTestId('flow-node-step-3')).toHaveTextContent('Waiting');

    const later: Stages = [
      step('step-1', 'Sensemaking: ingest corpus', 'completed'),
      step('step-2', 'Sensemaking: embed', 'completed', ['step-1']),
      step('step-3', 'Sensemaking: cluster', 'running', ['step-1']),
      step('step-4', 'Sensemaking: report', 'pending', ['step-2', 'step-3']),
    ];
    rerender(<FlowRunPanel run={flowRun({ workflow_stages: later })} />);

    for (const [id, word] of [
      ['step-2', 'Completed'],
      ['step-3', 'Running'],
    ] as const) {
      expect(screen.getByTestId(`flow-step-${id}`)).toHaveTextContent(word);
      expect(screen.getByTestId(`flow-node-${id}`)).toHaveTextContent(word);
    }
  });

  it('shows the single pre-poll stage as Starting the flow', () => {
    render(
      <FlowRunPanel
        run={flowRun({
          workflow_stages: [
            {
              stage_id: 'flow',
              type: 'flow_step',
              depends_on: [],
              status: 'running',
              provider: 'tapis-workflows',
              provider_ids: {},
            },
          ],
        })}
      />,
    );
    expect(screen.getAllByText('Starting the flow').length).toBeGreaterThan(0);
    expect(screen.getByTestId('flow-step-list').children).toHaveLength(1);
  });

  it('shows a failed step with its error message', () => {
    render(
      <FlowRunPanel
        run={flowRun({
          status: 'failed',
          workflow_stages: [
            step('step-1', 'Ingest', 'completed'),
            step('step-2', 'Embed', 'failed', ['step-1'], { error_message: 'out of memory' }),
          ],
        })}
      />,
    );
    expect(screen.getByTestId('flow-step-step-2')).toHaveTextContent('Failed');
    expect(screen.getByTestId('flow-step-step-2')).toHaveTextContent('out of memory');
  });

  it('shows a readable run-level message once', () => {
    render(
      <FlowRunPanel
        run={flowRun({
          status: 'failed',
          failure_code: 'FLOW_OUTPUTS_UNREPORTED',
          error_message: 'raw server text',
        })}
      />,
    );
    expect(screen.getAllByText('The flow finished but reported no outputs')).toHaveLength(1);
    expect(screen.queryByText('raw server text')).not.toBeInTheDocument();
  });

  it('falls back to the raw failure for a code it has no message for', () => {
    render(
      <FlowRunPanel
        run={flowRun({ status: 'failed', failure_code: 'SOMETHING_ELSE', error_message: 'boom' })}
      />,
    );
    expect(screen.getByText('Failure: SOMETHING_ELSE')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('keeps the Tapis ids under Technical identifiers and each step task id', () => {
    render(<FlowRunPanel run={flowRun()} />);
    expect(screen.getByText('wr-1')).toBeInTheDocument();
    expect(screen.getByText('wf-1')).toBeInTheDocument();
    expect(screen.getByTestId('flow-step-step-2')).toHaveTextContent('task-step-2');
  });

  it('offers cancel while the run is active and not after it ends', () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<FlowRunPanel run={flowRun()} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('cancel-workflow'));
    fireEvent.click(screen.getByTestId('confirm-cancel-workflow'));
    expect(onCancel).toHaveBeenCalledTimes(1);

    rerender(<FlowRunPanel run={flowRun({ status: 'completed' })} onCancel={onCancel} />);
    expect(screen.queryByTestId('cancel-workflow')).not.toBeInTheDocument();
  });
});
