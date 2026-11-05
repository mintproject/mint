import { describe, it, expect } from 'vitest';
import { compilePost, compilePut } from '../mutation-compiler.js';
import type { WriteNode } from '../nested-tree.js';

describe('compilePost', () => {
  it('emits scalar-only insert when no relationships', () => {
    const tree: WriteNode = {
      table: 'modelcatalog_software',
      id: 'https://w3id.org/okn/i/mint/sw-1',
      columns: { label: 'foo' },
      junctions: [],
      childFks: [],
    };
    const { mutation, variables } = compilePost(tree);
    expect(mutation).toMatch(/insert_modelcatalog_software_one/);
    expect(mutation).toMatch(/object: \$object/);
    expect(variables).toEqual({
      object: { id: 'https://w3id.org/okn/i/mint/sw-1', label: 'foo' },
    });
  });

  it('emits nested junction insert with dynamic update_columns from columns keys', () => {
    const tree: WriteNode = {
      table: 'modelcatalog_configuration',
      id: 'cfg-1',
      columns: { label: 'cfg' },
      junctions: [
        {
          apiFieldName: 'hasInput',
          junctionTable: 'modelcatalog_configuration_input',
          hasuraRelName: 'inputs',
          junctionRelName: 'input',
          parentFkColumn: 'configuration_id',
          targetFkColumn: 'input_id',
          junctionColumns: [{}],
          children: [
            {
              table: 'modelcatalog_dataset_specification',
              id: 'ds-1',
              columns: { label: 'ds-label' },
              junctions: [],
              childFks: [],
            },
          ],
        },
      ],
      childFks: [],
    };
    const { variables } = compilePost(tree);
    const obj = (variables.object as Record<string, unknown>);
    expect(obj.id).toBe('cfg-1');
    expect(obj.label).toBe('cfg');
    const inputs = (obj.inputs as { data: unknown[]; on_conflict: { update_columns: string[] } });
    expect(inputs.on_conflict.update_columns).toEqual([]);
    const inputRow = inputs.data[0] as Record<string, any>;
    const nested = inputRow.input as { data: any; on_conflict: { update_columns: string[]; constraint: string } };
    expect(nested.data.id).toBe('ds-1');
    expect(nested.data.label).toBe('ds-label');
    expect(nested.on_conflict.update_columns).toEqual(['label']);
    expect(nested.on_conflict.constraint).toBe('modelcatalog_dataset_specification_pkey');
  });

  it('link-only child (no columns, no nested) emits targetFkColumn = id, no nested target insert (bug-101)', () => {
    const tree: WriteNode = {
      table: 'modelcatalog_configuration',
      id: 'cfg-2',
      columns: {},
      junctions: [
        {
          apiFieldName: 'hasInput',
          junctionTable: 'modelcatalog_configuration_input',
          hasuraRelName: 'inputs',
          junctionRelName: 'input',
          parentFkColumn: 'configuration_id',
          targetFkColumn: 'input_id',
          junctionColumns: [{}],
          children: [
            {
              table: 'modelcatalog_dataset_specification',
              id: 'ds-existing',
              columns: {},
              junctions: [],
              childFks: [],
            },
          ],
        },
      ],
      childFks: [],
    };
    const { variables } = compilePost(tree);
    const obj = variables.object as Record<string, any>;
    const row = obj.inputs.data[0];
    expect(row.input_id).toBe('ds-existing');
    expect(row.input).toBeUndefined();
  });

  it('PUT link-only child emits targetFkColumn = id, no nested target insert (bug-101)', () => {
    const tree: WriteNode = {
      table: 'modelcatalog_configuration',
      id: 'cfg-put-link',
      columns: {},
      junctions: [
        {
          apiFieldName: 'hasInput',
          junctionTable: 'modelcatalog_configuration_input',
          hasuraRelName: 'inputs',
          junctionRelName: 'input',
          parentFkColumn: 'configuration_id',
          targetFkColumn: 'input_id',
          junctionColumns: [{}],
          children: [
            { table: 'modelcatalog_dataset_specification', id: 'ds-link', columns: {}, junctions: [], childFks: [] },
          ],
        },
      ],
      childFks: [],
    };
    const { variables } = compilePut(tree);
    const row = (variables.junc_inputs as any[])[0];
    expect(row.input_id).toBe('ds-link');
    expect(row.input).toBeUndefined();
  });

  it('applies junction extra columns to junction row', () => {
    const tree: WriteNode = {
      table: 'modelcatalog_configuration',
      id: 'cfg-3',
      columns: {},
      junctions: [
        {
          apiFieldName: 'hasInput',
          junctionTable: 'modelcatalog_configuration_input',
          hasuraRelName: 'inputs',
          junctionRelName: 'input',
          parentFkColumn: 'configuration_id',
          targetFkColumn: 'input_id',
          junctionColumns: [{ is_optional: true }],
          children: [
            { table: 'modelcatalog_dataset_specification', id: 'ds', columns: {}, junctions: [], childFks: [] },
          ],
        },
      ],
      childFks: [],
    };
    const { variables } = compilePost(tree);
    const row = (variables.object as any).inputs.data[0];
    expect(row.is_optional).toBe(true);
  });

  it('junction insert carries app_input_name', () => {
    const tree: WriteNode = {
      table: 'modelcatalog_configuration',
      id: 'cfg-3',
      columns: {},
      junctions: [
        {
          apiFieldName: 'hasInput',
          junctionTable: 'modelcatalog_configuration_input',
          hasuraRelName: 'inputs',
          junctionRelName: 'input',
          parentFkColumn: 'configuration_id',
          targetFkColumn: 'input_id',
          junctionColumns: [{ is_optional: true, app_input_name: 'aoi-geojson' }],
          children: [
            { table: 'modelcatalog_dataset_specification', id: 'ds', columns: {}, junctions: [], childFks: [] },
          ],
        },
      ],
      childFks: [],
    };
    const { variables } = compilePost(tree);
    const row = (variables.object as any).inputs.data[0];
    expect(row.is_optional).toBe(true);
    expect(row.app_input_name).toBe('aoi-geojson');
  });

  it('emits childFk nested-array insert with FK column set on each child', () => {
    const tree: WriteNode = {
      table: 'modelcatalog_software_version',
      id: 'sv-1',
      columns: { label: 'v' },
      junctions: [],
      childFks: [
        {
          apiFieldName: 'hasConfiguration',
          hasuraRelName: 'configurations',
          childTable: 'modelcatalog_configuration',
          childFkColumn: 'software_version_id',
          children: [
            { table: 'modelcatalog_configuration', id: 'cfg-a', columns: { label: 'A' }, junctions: [], childFks: [] },
            { table: 'modelcatalog_configuration', id: 'cfg-b', columns: { label: 'B' }, junctions: [], childFks: [] },
          ],
        },
      ],
    };
    const { variables } = compilePost(tree);
    const obj = variables.object as any;
    expect(obj.configurations).toBeDefined();
    const arr = obj.configurations.data as any[];
    expect(arr.length).toBe(2);
    // Hasura auto-derives software_version_id from parent context — must NOT be set
    // explicitly or Hasura raises 'cannot insert ... already determined by parent'.
    expect(arr[0].software_version_id).toBeUndefined();
    expect(arr[0].id).toBe('cfg-a');
    expect(arr[0].label).toBe('A');
    expect(arr[1].software_version_id).toBeUndefined();
  });

  it('childFk link-only ref emits aliased FK update, not nested insert (bug-089 mixed)', () => {
    // Mixed: cfg-a is inline-new (columns), cfg-existing is link-only (id only).
    // link-only must NOT enter nested data array (would NULL-violate label),
    // must surface as a top-level aliased update setting childFk on existing row.
    const tree: WriteNode = {
      table: 'modelcatalog_software',
      id: 'sw-1',
      columns: { label: 'sw' },
      junctions: [],
      childFks: [
        {
          apiFieldName: 'hasVersion',
          hasuraRelName: 'versions',
          childTable: 'modelcatalog_software_version',
          childFkColumn: 'software_id',
          children: [
            { table: 'modelcatalog_software_version', id: 'ver-new', columns: { label: 'fresh' }, junctions: [], childFks: [] },
            { table: 'modelcatalog_software_version', id: 'ver-existing', columns: {}, junctions: [], childFks: [] },
          ],
        },
      ],
    };
    const { mutation, variables } = compilePost(tree);
    const obj = variables.object as any;
    // Nested array contains ONLY inline-new children
    expect(obj.versions.data).toHaveLength(1);
    expect(obj.versions.data[0].id).toBe('ver-new');
    // Top-level aliased link op for the link-only ref
    expect(mutation).toMatch(/link_0:\s*update_modelcatalog_software_version/);
    expect(mutation).toMatch(/_in:\s*\$link_ids_0/);
    expect(mutation).toMatch(/_set:\s*\{\s*software_id:\s*\$link_parent_0\s*\}/);
    expect(variables.link_ids_0).toEqual(['ver-existing']);
    expect(variables.link_parent_0).toBe('sw-1');
  });

  it('childFk all-link-only omits nested rel and emits only link op', () => {
    const tree: WriteNode = {
      table: 'modelcatalog_software',
      id: 'sw-2',
      columns: { label: 'sw' },
      junctions: [],
      childFks: [
        {
          apiFieldName: 'hasVersion',
          hasuraRelName: 'versions',
          childTable: 'modelcatalog_software_version',
          childFkColumn: 'software_id',
          children: [
            { table: 'modelcatalog_software_version', id: 'ver-x', columns: {}, junctions: [], childFks: [] },
            { table: 'modelcatalog_software_version', id: 'ver-y', columns: {}, junctions: [], childFks: [] },
          ],
        },
      ],
    };
    const { mutation, variables } = compilePost(tree);
    const obj = variables.object as any;
    expect(obj.versions).toBeUndefined();
    expect(variables.link_ids_0).toEqual(['ver-x', 'ver-y']);
    expect(variables.link_parent_0).toBe('sw-2');
    expect(mutation).toMatch(/link_0:\s*update_modelcatalog_software_version/);
  });
});

describe('compilePut', () => {
  it('emits simple update_*_by_pk when tree has only scalars', () => {
    const tree: WriteNode = {
      table: 'modelcatalog_software',
      id: 'sw-1',
      columns: { label: 'updated' },
      junctions: [],
      childFks: [],
    };
    const { mutation, variables } = compilePut(tree);
    expect(mutation).toMatch(/update_modelcatalog_software_by_pk/);
    expect(mutation).toMatch(/_set: \$set/);
    expect(variables).toEqual({ id: 'sw-1', set: { label: 'updated' } });
  });

  it('emits delete + insert pair per junction edge with replace semantics', () => {
    const tree: WriteNode = {
      table: 'modelcatalog_configuration',
      id: 'cfg-1',
      columns: { label: 'c' },
      junctions: [
        {
          apiFieldName: 'hasInput',
          junctionTable: 'modelcatalog_configuration_input',
          hasuraRelName: 'inputs',
          junctionRelName: 'input',
          parentFkColumn: 'configuration_id',
          targetFkColumn: 'input_id',
          junctionColumns: [{}],
          children: [
            { table: 'modelcatalog_dataset_specification', id: 'ds-new', columns: { label: 'new' }, junctions: [], childFks: [] },
          ],
        },
      ],
      childFks: [],
    };
    const { mutation, variables } = compilePut(tree);
    expect(mutation).toMatch(/del_inputs:\s*delete_modelcatalog_configuration_input/);
    expect(mutation).toMatch(/where:\s*\{\s*configuration_id:\s*\{\s*_eq:\s*\$id\s*\}/);
    expect(mutation).toMatch(/ins_inputs:\s*insert_modelcatalog_configuration_input/);
    const juncVar = variables.junc_inputs as Record<string, unknown>[];
    expect(juncVar).toHaveLength(1);
    const row = juncVar[0] as any;
    expect(row.input.data.id).toBe('ds-new');
    expect(row.input.data.label).toBe('new');
    expect(row.input.on_conflict.update_columns).toEqual(['label']);
  });

  it('uses targetFkColumn from edge (bug-087 fold-in)', () => {
    const tree: WriteNode = {
      table: 'modelcatalog_configuration',
      id: 'cfg-2',
      columns: {},
      junctions: [
        {
          apiFieldName: 'hasInput',
          junctionTable: 'modelcatalog_configuration_input',
          hasuraRelName: 'inputs',
          junctionRelName: 'input',
          parentFkColumn: 'configuration_id',
          targetFkColumn: 'input_id',
          junctionColumns: [{}],
          children: [
            { table: 'modelcatalog_dataset_specification', id: 'ds-1', columns: {}, junctions: [], childFks: [] },
          ],
        },
      ],
      childFks: [],
    };
    const { variables } = compilePut(tree);
    const row = (variables.junc_inputs as any[])[0];
    if (row.input_id !== undefined) {
      expect(row.input_id).toBe('ds-1');
    } else {
      expect(row.input.data.id).toBe('ds-1');
    }
  });

  it('emits clear+upsert pair for childFk edges', () => {
    const tree: WriteNode = {
      table: 'modelcatalog_software_version',
      id: 'sv-1',
      columns: {},
      junctions: [],
      childFks: [
        {
          apiFieldName: 'hasConfiguration',
          hasuraRelName: 'configurations',
          childTable: 'modelcatalog_model_configuration',
          childFkColumn: 'software_version_id',
          children: [
            { table: 'modelcatalog_model_configuration', id: 'cfg-a', columns: { label: 'A' }, junctions: [], childFks: [] },
          ],
        },
      ],
    };
    const { mutation, variables } = compilePut(tree);
    expect(mutation).toMatch(/clear_model_configurations:\s*update_modelcatalog_model_configuration/);
    expect(mutation).toMatch(/_nin:\s*\$child_ids_model_configurations/);
    expect(mutation).toMatch(/upsert_model_configurations:\s*insert_modelcatalog_model_configuration/);
    expect(variables.child_ids_model_configurations).toEqual(['cfg-a']);
    const upsertObjs = variables.child_model_configurations as any[];
    expect(upsertObjs[0].id).toBe('cfg-a');
    expect(upsertObjs[0].software_version_id).toBe('sv-1');
    expect(upsertObjs[0].label).toBe('A');
  });

  it('childFk link-only PUT child becomes link op, not upsert (bug-089 mixed)', () => {
    const tree: WriteNode = {
      table: 'modelcatalog_software',
      id: 'sw-mixed',
      columns: {},
      junctions: [],
      childFks: [
        {
          apiFieldName: 'hasVersion',
          hasuraRelName: 'versions',
          childTable: 'modelcatalog_software_version',
          childFkColumn: 'software_id',
          children: [
            { table: 'modelcatalog_software_version', id: 'ver-new', columns: { label: 'fresh' }, junctions: [], childFks: [] },
            { table: 'modelcatalog_software_version', id: 'ver-link', columns: {}, junctions: [], childFks: [] },
          ],
        },
      ],
    };
    const { mutation, variables } = compilePut(tree);
    // clear still considers ALL incoming ids (so link-only stays attached if was already)
    expect(variables.child_ids_software_versions).toEqual(['ver-new', 'ver-link']);
    // upsert array contains ONLY inline-new
    const upsertObjs = variables.child_software_versions as any[];
    expect(upsertObjs).toHaveLength(1);
    expect(upsertObjs[0].id).toBe('ver-new');
    // link-only handled by aliased link update
    expect(mutation).toMatch(/link_0:\s*update_modelcatalog_software_version/);
    expect(variables.link_ids_0).toEqual(['ver-link']);
    expect(variables.link_parent_0).toBe('sw-mixed');
  });

  it('childFk all-link-only PUT skips upsert + emits only link op', () => {
    const tree: WriteNode = {
      table: 'modelcatalog_software',
      id: 'sw-all-link',
      columns: {},
      junctions: [],
      childFks: [
        {
          apiFieldName: 'hasVersion',
          hasuraRelName: 'versions',
          childTable: 'modelcatalog_software_version',
          childFkColumn: 'software_id',
          children: [
            { table: 'modelcatalog_software_version', id: 'ver-1', columns: {}, junctions: [], childFks: [] },
          ],
        },
      ],
    };
    const { mutation, variables } = compilePut(tree);
    expect(variables.child_software_versions).toBeUndefined();
    expect(mutation).not.toMatch(/upsert_software_versions/);
    expect(variables.link_ids_0).toEqual(['ver-1']);
    expect(variables.link_parent_0).toBe('sw-all-link');
  });

  it('hoists complex objects into variables (no JSON in mutation string)', () => {
    const tree: WriteNode = {
      table: 'modelcatalog_configuration',
      id: 'cfg-3',
      columns: {},
      junctions: [
        {
          apiFieldName: 'hasInput',
          junctionTable: 'modelcatalog_configuration_input',
          hasuraRelName: 'inputs',
          junctionRelName: 'input',
          parentFkColumn: 'configuration_id',
          targetFkColumn: 'input_id',
          junctionColumns: [{}],
          children: [{ table: 'modelcatalog_dataset_specification', id: 'ds', columns: {}, junctions: [], childFks: [] }],
        },
      ],
      childFks: [],
    };
    const { mutation } = compilePut(tree);
    expect(mutation).not.toMatch(/"id":\s*"ds"/);
    expect(mutation).toMatch(/objects:\s*\$junc_inputs/);
  });
});
