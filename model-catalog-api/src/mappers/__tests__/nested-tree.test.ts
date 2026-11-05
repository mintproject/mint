import { describe, it, expect } from 'vitest';
import {
  MAX_DEPTH,
  MAX_NODES,
  MAX_ARRAY_LENGTH,
  ValidationError,
  type WriteNode,
  type JunctionEdge,
  type ChildFkEdge,
  type BuildTreeOptions,
} from '../nested-tree.js';
import { buildTree } from '../nested-tree.js';
import { getResourceConfig } from '../resource-registry.js';

describe('nested-tree types and constants', () => {
  it('exposes hard caps as numeric constants', () => {
    expect(MAX_DEPTH).toBe(8);
    expect(MAX_NODES).toBe(500);
    expect(MAX_ARRAY_LENGTH).toBe(200);
  });

  it('ValidationError carries code, path, message, http status', () => {
    const err = new ValidationError('DEPTH_EXCEEDED', '/hasVersion/0', 'too deep', 400);
    expect(err.code).toBe('DEPTH_EXCEEDED');
    expect(err.path).toBe('/hasVersion/0');
    expect(err.message).toBe('too deep');
    expect(err.httpStatus).toBe(400);
    expect(err).toBeInstanceOf(Error);
  });

  it('WriteNode/JunctionEdge/ChildFkEdge can be constructed', () => {
    const node: WriteNode = {
      table: 'modelcatalog_software',
      id: 'https://w3id.org/okn/i/mint/x',
      columns: { label: 'foo' },
      junctions: [],
      childFks: [],
    };
    const junc: JunctionEdge = {
      apiFieldName: 'hasInput',
      junctionTable: 'modelcatalog_configuration_input',
      hasuraRelName: 'inputs',
      junctionRelName: 'input',
      parentFkColumn: 'configuration_id',
      targetFkColumn: 'input_id',
      junctionColumns: [],
      children: [],
    };
    const child: ChildFkEdge = {
      apiFieldName: 'hasConfiguration',
      hasuraRelName: 'configurations',
      childTable: 'modelcatalog_model_configuration',
      childFkColumn: 'model_version_id',
      children: [],
    };
    expect(node.id).toBe('https://w3id.org/okn/i/mint/x');
    expect(junc.targetFkColumn).toBe('input_id');
    expect(child.childFkColumn).toBe('model_version_id');
    expect(child.hasuraRelName).toBe('configurations');
  });
});

describe('buildTree — single-level junction', () => {
  it('builds tree for ModelConfiguration with hasInput id-only payload', () => {
    const cfg = getResourceConfig('modelconfigurations')!;
    const body = {
      id: 'cfg-1',
      label: 'my config',
      hasInput: [{ id: 'ds-existing-1' }],
    };

    const tree = buildTree(body, cfg);

    expect(tree.table).toBe('modelcatalog_configuration');
    expect(tree.id).toBe('https://w3id.org/okn/i/mint/cfg-1');
    expect(tree.columns).toEqual({ label: 'my config' });
    expect(tree.junctions).toHaveLength(1);

    const j = tree.junctions[0];
    expect(j.apiFieldName).toBe('hasInput');
    expect(j.junctionTable).toBe('modelcatalog_configuration_input');
    expect(j.junctionRelName).toBe('input');
    expect(j.parentFkColumn).toBe('configuration_id');
    expect(j.targetFkColumn).toBe('input_id');
    expect(j.children).toHaveLength(1);
    expect(j.children[0].id).toBe('https://w3id.org/okn/i/mint/ds-existing-1');
    expect(j.children[0].columns).toEqual({});
    expect(j.children[0].table).toBe('modelcatalog_dataset_specification');
  });

  it('captures scalar fields on nested target entity (upsert path)', () => {
    const cfg = getResourceConfig('modelconfigurations')!;
    const body = {
      id: 'cfg-2',
      hasInput: [{ id: 'ds-2', label: 'updated label' }],
    };
    const tree = buildTree(body, cfg);
    expect(tree.junctions[0].children[0].columns).toEqual({ label: 'updated label' });
  });

  it('captures junction extra columns (is_optional)', () => {
    const cfg = getResourceConfig('modelconfigurations')!;
    const body = {
      id: 'cfg-3',
      hasInput: [{ id: 'ds-3', isOptional: true }],
    };
    const tree = buildTree(body, cfg);
    expect(tree.junctions[0].junctionColumns).toEqual([{ is_optional: true }]);
    expect(tree.junctions[0].children[0].columns).toEqual({});
  });

  it('captures junction extra column app_input_name (appInputName)', () => {
    const cfg = getResourceConfig('modelconfigurations')!;
    const body = {
      id: 'cfg-3b',
      hasInput: [{ id: 'ds-3b', isOptional: true, appInputName: 'aoi-geojson' }],
    };
    const tree = buildTree(body, cfg);
    expect(tree.junctions[0].junctionColumns).toEqual([
      { is_optional: true, app_input_name: 'aoi-geojson' },
    ]);
    expect(tree.junctions[0].children[0].columns).toEqual({});
  });

  it('auto-generates id when nested entity lacks one', () => {
    const cfg = getResourceConfig('modelconfigurations')!;
    const body = {
      id: 'cfg-4',
      hasInput: [{ label: 'brand new ds' }],
    };
    const tree = buildTree(body, cfg);
    expect(tree.junctions[0].children[0].id).toMatch(/^https:\/\/w3id\.org\/okn\/i\/mint\/[0-9a-f-]{36}$/);
  });
});

describe('buildTree — recursion (multi-level)', () => {
  it('walks 2 levels: ModelConfiguration > hasInput > hasPresentation', () => {
    const cfg = getResourceConfig('modelconfigurations')!;
    const body = {
      id: 'cfg-deep',
      hasInput: [
        {
          id: 'ds-deep',
          label: 'deep ds',
          hasPresentation: [{ id: 'vp-1', label: 'pres' }],
        },
      ],
    };
    const tree = buildTree(body, cfg);
    const ds = tree.junctions[0].children[0];
    expect(ds.id).toBe('https://w3id.org/okn/i/mint/ds-deep');
    expect(ds.columns).toEqual({ label: 'deep ds' });
    expect(ds.junctions.length).toBeGreaterThanOrEqual(1);
    const pres = ds.junctions.find((j) => j.apiFieldName === 'hasPresentation');
    expect(pres).toBeDefined();
    expect(pres!.children[0].id).toBe('https://w3id.org/okn/i/mint/vp-1');
    expect(pres!.children[0].columns).toEqual({ label: 'pres' });
  });
});

describe('buildTree — childFk relationships', () => {
  it('builds childFk edge for SoftwareVersion.hasConfiguration', () => {
    const cfg = getResourceConfig('softwareversions')!;
    const body = {
      id: 'sv-1',
      label: 'v1',
      hasConfiguration: [{ id: 'cfg-a', label: 'A' }, { id: 'cfg-b' }],
    };
    const tree = buildTree(body, cfg);
    expect(tree.junctions).toHaveLength(0);
    expect(tree.childFks).toHaveLength(1);
    const c = tree.childFks[0];
    expect(c.apiFieldName).toBe('hasConfiguration');
    expect(c.hasuraRelName).toBe('configurations');
    expect(c.childTable).toBe('modelcatalog_configuration');
    expect(c.childFkColumn).toBe('software_version_id');
    expect(c.children).toHaveLength(2);
    expect(c.children[0].id).toBe('https://w3id.org/okn/i/mint/cfg-a');
    expect(c.children[0].columns).toEqual({ label: 'A' });
    expect(c.children[1].columns).toEqual({});
  });

  it('recurses childFk children to grand-children', () => {
    const cfg = getResourceConfig('softwareversions')!;
    const body = {
      id: 'sv-2',
      hasConfiguration: [
        { id: 'cfg-x', hasInput: [{ id: 'ds-x' }] },
      ],
    };
    const tree = buildTree(body, cfg);
    const cfgNode = tree.childFks[0].children[0];
    expect(cfgNode.junctions).toHaveLength(1);
    expect(cfgNode.junctions[0].children[0].id).toBe('https://w3id.org/okn/i/mint/ds-x');
  });
});

describe('buildTree — validation rules', () => {
  it('rejects string-id array form with STRING_ID_DEPRECATED', () => {
    const cfg = getResourceConfig('modelconfigurations')!;
    expect(() => buildTree({ id: 'c1', hasInput: ['ds-1'] }, cfg)).toThrow(
      expect.objectContaining({
        code: 'STRING_ID_DEPRECATED',
        httpStatus: 400,
        path: '/hasInput/0',
      }),
    );
  });

  it('rejects array length over MAX_ARRAY_LENGTH with ARRAY_TOO_LONG', () => {
    const cfg = getResourceConfig('modelconfigurations')!;
    const big = Array.from({ length: 201 }, (_, i) => ({ id: `ds-${i}` }));
    expect(() => buildTree({ id: 'c1', hasInput: big }, cfg)).toThrow(
      expect.objectContaining({ code: 'ARRAY_TOO_LONG', httpStatus: 413 }),
    );
  });

  it('rejects depth over MAX_DEPTH with DEPTH_EXCEEDED', () => {
    const cfg = getResourceConfig('modelconfigurations')!;
    const body = { id: 'root', hasInput: [{ id: 'child-1' }] };
    // maxDepth:1 means root is at depth 1 (ok), child is at depth 2 > 1 → DEPTH_EXCEEDED
    expect(() => buildTree(body, cfg, { maxDepth: 1 })).toThrow(
      expect.objectContaining({ code: 'DEPTH_EXCEEDED', httpStatus: 400 }),
    );
  });

  it('rejects too many total nodes with TOO_MANY_NODES', () => {
    const cfg = getResourceConfig('modelconfigurations')!;
    const make = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));
    const body = {
      id: 'c-big',
      hasInput: make(200, 'in'),
      hasOutput: make(200, 'out'),
      hasParameter: make(150, 'p'),
    };
    expect(() => buildTree(body, cfg)).toThrow(
      expect.objectContaining({ code: 'TOO_MANY_NODES', httpStatus: 413 }),
    );
  });

  it('detects cycles in ancestor path with CYCLE', () => {
    const cfg = getResourceConfig('modelconfigurations')!;
    const body = {
      id: 'c-1',
      hasInput: [
        {
          id: 'ds-1',
          hasPresentation: [{ id: 'c-1' }],
        },
      ],
    };
    expect(() => buildTree(body, cfg)).toThrow(
      expect.objectContaining({ code: 'CYCLE', httpStatus: 400 }),
    );
  });

  it('allows sibling repeats (same id linked twice from same parent is legal)', () => {
    const cfg = getResourceConfig('modelconfigurations')!;
    const body = {
      id: 'c-2',
      hasInput: [{ id: 'ds-shared' }],
      hasOutput: [{ id: 'ds-shared' }],
    };
    expect(() => buildTree(body, cfg)).not.toThrow();
  });
});
