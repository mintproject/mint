import { describe, expect, it } from 'vitest';

import type { ThreadExecutionData } from '@/graphql/generated/execution';
import type {
  ExecutionRow,
  ThreadExecutionRow,
  ThreadModelRow,
} from '@/graphql/generated/thread-execution';
import {
  bindingsFromGQL,
  datasetsComplete,
  executionFromGQL,
  hasUnfinishedRuns,
  inputResourceCount,
  parametersComplete,
  runsComplete,
  threadExecutionFromGQL,
  totalConfigs,
} from '@/lib/thread-execution';

function spec(id: string, label: string, variable?: string) {
  return {
    id,
    label,
    presentations: variable
      ? [
          {
            presentation: {
              id: `${id}-pres`,
              standard_variable: { id: `sv-${variable}`, label: variable },
            },
          },
        ]
      : [],
  };
}

function threadModel(overrides: Partial<ThreadModelRow> = {}): ThreadModelRow {
  return {
    id: 'tm-1',
    modelcatalog_configuration_id: 'cfgA',
    execution_summary: [],
    modelcatalog_configuration: {
      id: 'cfgA',
      label: 'HAND setup',
      inputs: [
        { is_optional: false, input: spec('inA', 'DEM', 'land_surface__elevation') },
        { is_optional: true, input: spec('inB', 'Mask') },
      ],
      outputs: [{ output: spec('outA', 'Depth', 'flood__depth') }],
      parameters: [
        {
          parameter: {
            id: 'pFixed',
            label: 'resolution',
            has_fixed_value: '30',
            position: 1,
          },
        },
        {
          parameter: {
            id: 'pAdj',
            label: 'threshold',
            has_data_type: 'float',
            has_default_value: '0.5',
            has_minimum_accepted_value: '0',
            has_maximum_accepted_value: '1',
            position: 2,
          },
        },
      ],
    },
    data_bindings: [{ model_io_id: 'inA', dataslice_id: 'slice-1' }],
    parameter_bindings: [{ model_parameter_id: 'pAdj', parameter_value: '0.7' }],
    ...overrides,
  };
}

function threadRow(overrides: Partial<ThreadExecutionRow> = {}): ThreadExecutionRow {
  return {
    id: 't1',
    response_variable_id: 'var-flood',
    thread_data: [
      {
        dataslice: {
          id: 'slice-1',
          name: 'DEM for thread',
          start_date: '2020-01-01',
          end_date: '2020-12-31',
          resource_count: 2,
          dataset: { id: 'ckan-dem', name: 'National DEM' },
          resources: [
            {
              selected: true,
              resource: { id: 'hash1', dcid: 'ckan-res-1', name: 'a.tif', url: 'http://x/a.tif' },
            },
            {
              selected: false,
              resource: { id: 'hash2', dcid: 'ckan-res-2', name: 'b.tif', url: 'http://x/b.tif' },
            },
          ],
        },
      },
    ],
    thread_models: [threadModel()],
    ...overrides,
  };
}

describe('threadExecutionFromGQL', () => {
  it('returns null when the thread is absent, so "not loaded" is distinguishable', () => {
    expect(threadExecutionFromGQL(null)).toBeNull();
    expect(threadExecutionFromGQL(undefined)).toBeNull();
  });

  it('keys models, ensembles and summaries by the configuration id', () => {
    const out = threadExecutionFromGQL(
      threadRow({
        thread_models: [
          threadModel({
            execution_summary: [
              {
                total_runs: 4,
                submitted_runs: 4,
                successful_runs: 3,
                failed_runs: 1,
                ingested_runs: 0,
                registered_runs: 0,
                published_runs: 0,
                fetched_run_outputs: 0,
                submission_time: '2026-08-09T00:00:00',
                submitted_for_execution: true,
                submitted_for_ingestion: false,
                submitted_for_publishing: false,
                submitted_for_registration: false,
              },
            ],
          }),
        ],
      }),
    )!;
    expect(Object.keys(out.models)).toEqual(['cfgA']);
    // The ensemble id is the thread_model row, not the configuration: it is the
    // FK thread_model_io and thread_model_parameter are written against.
    expect(out.model_ensembles['cfgA']?.id).toBe('tm-1');
    expect(out.execution_summary['cfgA']?.total_runs).toBe(4);
    expect(out.response_variables).toEqual(['var-flood']);
  });

  it('splits fixed from adjustable parameters and sorts by position', () => {
    const params = threadExecutionFromGQL(threadRow())!.models['cfgA']!.input_parameters;
    expect(params.map((p) => p.id)).toEqual(['pFixed', 'pAdj']);
    expect(params[0]!.value).toBe('30');
    expect(params[1]!.value).toBeNull();
    expect(params[1]!.min).toBe('0');
    expect(params[1]!.max).toBe('1');
  });

  it('carries input variable labels and the optional flag', () => {
    const inputs = threadExecutionFromGQL(threadRow())!.models['cfgA']!.input_files;
    expect(inputs[0]).toMatchObject({
      id: 'inA',
      variables: ['land_surface__elevation'],
      isOptional: false,
    });
    expect(inputs[1]!.isOptional).toBe(true);
  });

  it('counts selected resources without an aggregate field', () => {
    const slice = threadExecutionFromGQL(threadRow())!.data['slice-1']!;
    expect(slice['selected_resources']).toBe(1);
    expect(slice['total_resources']).toBe(2);
    // The catalog id, not the URL-hash primary key.
    expect((slice['resources'] as Array<{ id: string }>)[0]!.id).toBe('ckan-res-1');
  });

  it('skips a thread model whose configuration no longer resolves', () => {
    const out = threadExecutionFromGQL(
      threadRow({ thread_models: [threadModel({ modelcatalog_configuration: null })] }),
    )!;
    expect(out.models).toEqual({});
  });
});

describe('bindingsFromGQL', () => {
  it('merges data and parameter bindings into one map', () => {
    expect(bindingsFromGQL(threadModel())).toEqual({ inA: ['slice-1'], pAdj: ['0.7'] });
  });

  it('collects every value of a multi-value parameter sweep', () => {
    const bindings = bindingsFromGQL(
      threadModel({
        parameter_bindings: [
          { model_parameter_id: 'pAdj', parameter_value: '0.1' },
          { model_parameter_id: 'pAdj', parameter_value: '0.2' },
        ],
      }),
    );
    expect(bindings['pAdj']).toEqual(['0.1', '0.2']);
  });
});

// ─── Step completion ─────────────────────────────────────────────────────────

function execData(overrides: Partial<ThreadExecutionData> = {}): ThreadExecutionData {
  return {
    id: 't1',
    models: {
      cfgA: {
        id: 'cfgA',
        name: 'HAND',
        input_files: [
          { id: 'inA', name: 'DEM', isOptional: false },
          { id: 'inB', name: 'Mask', isOptional: true },
        ],
        output_files: [],
        input_parameters: [
          { id: 'pFixed', name: 'resolution', value: '30' },
          { id: 'pAdj', name: 'threshold' },
        ],
      },
    },
    model_ensembles: { cfgA: { id: 'tm-1', bindings: {} } },
    execution_summary: {},
    data: {},
    ...overrides,
  };
}

describe('datasetsComplete', () => {
  it('is false before anything is bound', () => {
    expect(datasetsComplete(execData())).toBe(false);
  });

  it('ignores an unbound optional input', () => {
    expect(
      datasetsComplete(
        execData({ model_ensembles: { cfgA: { id: 'tm-1', bindings: { inA: ['s1'] } } } }),
      ),
    ).toBe(true);
  });

  it('is false with no models, not vacuously true', () => {
    expect(datasetsComplete(execData({ models: {} }))).toBe(false);
    expect(datasetsComplete(null)).toBe(false);
  });
});

describe('parametersComplete', () => {
  const bound = { cfgA: { id: 'tm-1', bindings: { pAdj: ['0.7'] } } };

  it('needs the execution summary as well as the bindings', () => {
    expect(parametersComplete(execData({ model_ensembles: bound }))).toBe(false);
    expect(
      parametersComplete(
        execData({
          model_ensembles: bound,
          execution_summary: {
            cfgA: { total_runs: 1, submitted_runs: 0, failed_runs: 0, successful_runs: 0 },
          },
        }),
      ),
    ).toBe(true);
  });

  it('ignores secret rows: they never need a binding', () => {
    const base = execData();
    const withSecret = execData({
      model_ensembles: bound,
      execution_summary: {
        cfgA: { total_runs: 1, submitted_runs: 0, failed_runs: 0, successful_runs: 0 },
      },
      models: {
        cfgA: {
          ...base.models['cfgA']!,
          input_parameters: [
            ...base.models['cfgA']!.input_parameters,
            { id: 'pSecret', name: 'earthdata', parameter_type: 'secret' },
          ],
        },
      },
    });
    expect(parametersComplete(withSecret)).toBe(true);
  });

  it('is false for a model with no adjustable parameters until the step has saved', () => {
    const noParams = execData({
      models: {
        cfgA: {
          id: 'cfgA',
          name: 'HAND',
          input_files: [],
          output_files: [],
          input_parameters: [],
        },
      },
    });
    expect(parametersComplete(noParams)).toBe(false);
  });
});

describe('runsComplete / hasUnfinishedRuns', () => {
  const running = {
    cfgA: {
      total_runs: 4,
      submitted_runs: 4,
      successful_runs: 1,
      failed_runs: 0,
      submitted_for_execution: true,
    },
  };
  const finished = {
    cfgA: {
      total_runs: 4,
      submitted_runs: 4,
      successful_runs: 3,
      failed_runs: 1,
      submitted_for_execution: true,
    },
  };

  it('is complete only once every run has landed', () => {
    expect(runsComplete(execData({ execution_summary: running }))).toBe(false);
    expect(runsComplete(execData({ execution_summary: finished }))).toBe(true);
  });

  it('polls while runs are outstanding and stops when they are not', () => {
    expect(hasUnfinishedRuns(running)).toBe(true);
    expect(hasUnfinishedRuns(finished)).toBe(false);
    // Nothing submitted yet is not "in flight" — it is waiting on the user.
    expect(hasUnfinishedRuns({ cfgA: { ...running.cfgA, submitted_for_execution: false } })).toBe(
      false,
    );
  });
});

describe('executionFromGQL', () => {
  const row: ExecutionRow = {
    id: 'ex-1',
    status: 'SUCCESS',
    run_progress: 100,
    start_time: '2026-08-09T10:00:00',
    end_time: '2026-08-09T10:05:00',
    execution_engine: 'tapis',
    run_id: 'ue-parent-1',
    modelcatalog_configuration_id: 'cfgA',
    parameter_bindings: [{ model_parameter_id: 'pAdj', parameter_value: '0.7' }],
    data_bindings: [
      { model_io_id: 'inA', resource: { id: 'r1', name: 'dem.tif', url: 'http://x/dem.tif' } },
    ],
    results: [
      { model_io_id: 'outA', resource: { id: 'r2', name: 'depth.tif', url: 'http://x/d.tif' } },
    ],
  };

  it('flattens bindings and results into the maps the run table renders', () => {
    const ex = executionFromGQL(row);
    expect(ex.modelid).toBe('cfgA');
    expect(ex.run_id).toBe('ue-parent-1');
    expect(ex.bindings['pAdj']).toBe('0.7');
    expect((ex.bindings['inA'] as { name: string }).name).toBe('dem.tif');
    expect(ex.results['outA']?.url).toBe('http://x/d.tif');
  });

  it('falls back to WAITING when the engine has not set a status', () => {
    expect(executionFromGQL({ ...row, status: null }).status).toBe('WAITING');
  });
});

// totalConfigs lives with the Parameters step but is the number the Runs step
// judges completion against, so it is tested alongside the other predicates.
describe('totalConfigs', () => {
  const model = {
    id: 'cfgA',
    name: 'HAND',
    input_files: [{ id: 'inA', name: 'DEM' }],
    output_files: [],
    input_parameters: [
      { id: 'pFixed', name: 'resolution', value: '30' },
      { id: 'pAdj', name: 'threshold' },
    ],
  };
  const data = { 'slice-1': { id: 'slice-1', selected_resources: 5 } };

  it('excludes secret rows from the ensemble size', () => {
    const withSecret = {
      ...model,
      input_parameters: [
        ...model.input_parameters,
        { id: 'pSecret', name: 'earthdata', parameter_type: 'secret' },
      ],
    };
    expect(totalConfigs(withSecret, { inA: ['slice-1'], pAdj: ['0.1', '0.2', '0.3'] }, data)).toBe(
      15,
    );
  });

  it('multiplies input resources by parameter values', () => {
    expect(totalConfigs(model, { inA: ['slice-1'], pAdj: ['0.1', '0.2', '0.3'] }, data)).toBe(15);
  });

  it('ignores fixed parameters, which contribute no sweep', () => {
    expect(totalConfigs(model, { inA: ['slice-1'], pAdj: ['0.1'] }, data)).toBe(5);
  });

  it('treats an unbound input as no constraint rather than zero runs', () => {
    expect(totalConfigs(model, { pAdj: ['0.1'] }, {})).toBe(1);
  });
});

describe('inputResourceCount', () => {
  it('does not turn an optional unbound input into zero resources', () => {
    const model = {
      id: 'cfgA',
      name: 'MODFLOW',
      input_files: [
        { id: 'archive', name: 'Archive' },
        { id: 'rch', name: 'Recharge', isOptional: true },
        { id: 'wel', name: 'Wells', isOptional: true },
      ],
      output_files: [],
      input_parameters: [],
    };

    expect(inputResourceCount(model, { archive: ['slice-1'] })).toBe(1);
  });

  it('reports zero when a required input is missing', () => {
    const model = {
      id: 'cfgA',
      name: 'MODFLOW',
      input_files: [{ id: 'archive', name: 'Archive' }],
      output_files: [],
      input_parameters: [],
    };

    expect(inputResourceCount(model, {})).toBe(0);
  });
});
