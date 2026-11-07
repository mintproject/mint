import { describe, it, expect } from 'vitest';
import { transformRow, transformList, snakeToCamel } from '../response.js';
import { toHasuraInput, camelToSnake } from '../request.js';
import { RESOURCE_REGISTRY } from '../resource-registry.js';

// ============================================================================
// Utility function tests
// ============================================================================

describe('snakeToCamel', () => {
  it('converts simple snake_case to camelCase', () => {
    expect(snakeToCamel('has_documentation')).toBe('hasDocumentation');
    expect(snakeToCamel('date_created')).toBe('dateCreated');
    expect(snakeToCamel('has_download_url')).toBe('hasDownloadUrl');
  });

  it('leaves already-camelCase strings unchanged', () => {
    expect(snakeToCamel('label')).toBe('label');
    expect(snakeToCamel('id')).toBe('id');
  });
});

describe('camelToSnake', () => {
  it('converts camelCase to snake_case', () => {
    expect(camelToSnake('hasDocumentation')).toBe('has_documentation');
    expect(camelToSnake('dateCreated')).toBe('date_created');
    expect(camelToSnake('hasDownloadUrl')).toBe('has_download_url');
  });

  it('leaves already-snake_case strings unchanged', () => {
    expect(camelToSnake('label')).toBe('label');
    expect(camelToSnake('id')).toBe('id');
  });
});

// ============================================================================
// transformRow tests
// ============================================================================

const softwareConfig = RESOURCE_REGISTRY['softwares']!;

describe('transformRow - scalar wrapping', () => {
  it('wraps scalar fields in single-element arrays', () => {
    const row = {
      id: 'https://w3id.org/okn/i/mint/CYCLES',
      label: 'CYCLES',
      license: 'MIT',
    };
    const result = transformRow(row, softwareConfig);

    // id stays as URI string (not wrapped)
    expect(result['id']).toBe('https://w3id.org/okn/i/mint/CYCLES');

    // scalars are wrapped in arrays
    expect(result['label']).toEqual(['CYCLES']);
    expect(result['license']).toEqual(['MIT']);
  });

  it('synthesizes type field from resourceConfig.typeArray', () => {
    const row = { id: 'https://w3id.org/okn/i/mint/CYCLES', label: 'CYCLES' };
    const result = transformRow(row, softwareConfig);

    expect(result['type']).toEqual(['Software']);
  });

  it('synthesizes multi-class type array for models resource', () => {
    const modelConfig = RESOURCE_REGISTRY['models']!;
    const row = { id: 'https://w3id.org/okn/i/mint/CYCLES', label: 'CYCLES' };
    const result = transformRow(row, modelConfig);

    expect(result['type']).toEqual(['Model', 'SoftwareDescription']);
  });
});

describe('transformRow - null omission', () => {
  it('omits null fields entirely', () => {
    const row = {
      id: 'https://w3id.org/okn/i/mint/CYCLES',
      label: 'CYCLES',
      description: null,
      license: null,
    };
    const result = transformRow(row, softwareConfig);

    expect(result).not.toHaveProperty('description');
    expect(result).not.toHaveProperty('license');
    expect(result['label']).toEqual(['CYCLES']);
  });

  it('omits undefined fields entirely', () => {
    const row = {
      id: 'https://w3id.org/okn/i/mint/CYCLES',
      label: 'CYCLES',
      website: undefined,
    };
    const result = transformRow(row, softwareConfig);

    expect(result).not.toHaveProperty('website');
  });
});

describe('transformRow - snake_case to camelCase field name conversion', () => {
  it('converts snake_case Hasura column names to camelCase', () => {
    const row = {
      id: 'https://w3id.org/okn/i/mint/CYCLES',
      label: 'CYCLES',
      has_documentation: 'http://example.com/docs',
      date_created: '2019',
      has_download_url: 'http://example.com/download',
    };
    const result = transformRow(row, softwareConfig);

    expect(result).toHaveProperty('hasDocumentation');
    expect(result).toHaveProperty('dateCreated');
    expect(result).toHaveProperty('hasDownloadUrl');

    // Original snake_case names should NOT be present
    expect(result).not.toHaveProperty('has_documentation');
    expect(result).not.toHaveProperty('date_created');
    expect(result).not.toHaveProperty('has_download_url');

    expect(result['hasDocumentation']).toEqual(['http://example.com/docs']);
    expect(result['dateCreated']).toEqual(['2019']);
  });
});

describe('transformRow - nested related objects', () => {
  it('transforms object relationship to nested object with id and type', () => {
    const row = {
      id: 'https://w3id.org/okn/i/mint/CYCLES',
      label: 'CYCLES',
      // author is a Hasura object_relationship
      author: {
        id: 'https://w3id.org/okn/i/mint/person1',
        label: 'Jane Doe',
        name: 'Jane Doe',
      },
    };
    const result = transformRow(row, softwareConfig);

    // author should be array-wrapped (v1.8.0 wraps object relationships too)
    expect(result['author']).toBeDefined();
    const authorArr = result['author'] as Array<Record<string, unknown>>;
    expect(Array.isArray(authorArr)).toBe(true);
    expect(authorArr).toHaveLength(1);

    const authorObj = authorArr[0]!;
    expect(authorObj['id']).toBe('https://w3id.org/okn/i/mint/person1');
    expect(authorObj['type']).toEqual(['Person']);
    expect(authorObj['label']).toEqual(['Jane Doe']);
  });

  it('transforms array relationship to array of nested objects', () => {
    const row = {
      id: 'https://w3id.org/okn/i/mint/CYCLES',
      label: 'CYCLES',
      // versions is a Hasura array_relationship; API key is 'hasVersion' in softwares registry
      versions: [
        { id: 'https://w3id.org/okn/i/mint/CYCLES_v1', label: 'v1.0', software_id: 'https://w3id.org/okn/i/mint/CYCLES' },
        { id: 'https://w3id.org/okn/i/mint/CYCLES_v2', label: 'v2.0', software_id: 'https://w3id.org/okn/i/mint/CYCLES' },
      ],
    };
    const result = transformRow(row, softwareConfig);

    // The API field name is 'hasVersion' (OWL property), not 'versions'
    const versions = result['hasVersion'] as Array<Record<string, unknown>>;
    expect(Array.isArray(versions)).toBe(true);
    expect(versions).toHaveLength(2);

    expect(versions[0]!['id']).toBe('https://w3id.org/okn/i/mint/CYCLES_v1');
    expect(versions[0]!['type']).toEqual(['SoftwareVersion']);
    expect(versions[0]!['label']).toEqual(['v1.0']);
    expect(versions[1]!['id']).toBe('https://w3id.org/okn/i/mint/CYCLES_v2');
  });

  it('omits relationship field when value is null', () => {
    const row = {
      id: 'https://w3id.org/okn/i/mint/CYCLES',
      label: 'CYCLES',
      author: null,
    };
    const result = transformRow(row, softwareConfig);
    expect(result).not.toHaveProperty('author');
  });

  it('omits relationship field when array is empty', () => {
    const row = {
      id: 'https://w3id.org/okn/i/mint/CYCLES',
      label: 'CYCLES',
      versions: [],
    };
    const result = transformRow(row, softwareConfig);
    expect(result).not.toHaveProperty('hasVersion');
  });
});

describe('transformRow - junction column hoist (D-21 round-trip)', () => {
  const configurationConfig = RESOURCE_REGISTRY['modelconfigurations']!;

  it('hoists is_optional from junction row onto nested DSpec as scalar (not array)', () => {
    const row = {
      id: 'https://w3id.org/okn/i/mint/Cfg1',
      label: 'Cfg1',
      // GraphQL traversal: configuration -> inputs[] (junction rows) -> input (DSpec)
      inputs: [
        {
          is_optional: false,
          input: {
            id: 'https://w3id.org/okn/i/mint/Dspec1',
            label: 'Dspec1',
          },
        },
        {
          is_optional: true,
          input: {
            id: 'https://w3id.org/okn/i/mint/Dspec2',
            label: 'Dspec2',
          },
        },
      ],
    };
    const result = transformRow(row, configurationConfig);
    const hasInput = result['hasInput'] as Array<Record<string, unknown>>;

    expect(Array.isArray(hasInput)).toBe(true);
    expect(hasInput).toHaveLength(2);

    // Junction column hoisted as scalar — array wrapping makes UI coerce
    // !![false] to true on refresh and the checkbox lies.
    expect(hasInput[0]!['isOptional']).toBe(false);
    expect(hasInput[1]!['isOptional']).toBe(true);
    expect(Array.isArray(hasInput[0]!['isOptional'])).toBe(false);
  });

  it('omits isOptional when junction column is null', () => {
    const row = {
      id: 'https://w3id.org/okn/i/mint/Cfg1',
      inputs: [
        {
          is_optional: null,
          input: { id: 'https://w3id.org/okn/i/mint/Dspec1' },
        },
      ],
    };
    const result = transformRow(row, configurationConfig);
    const hasInput = result['hasInput'] as Array<Record<string, unknown>>;
    expect(hasInput[0]).not.toHaveProperty('isOptional');
  });

  it('hoists app_input_name from junction row onto nested DSpec as scalar', () => {
    const row = {
      id: 'https://w3id.org/okn/i/mint/Cfg1',
      inputs: [
        {
          is_optional: false,
          app_input_name: 'aoi-geojson',
          input: { id: 'https://w3id.org/okn/i/mint/Dspec1' },
        },
      ],
    };
    const result = transformRow(row, configurationConfig);
    const hasInput = result['hasInput'] as Array<Record<string, unknown>>;
    expect(hasInput[0]!['appInputName']).toBe('aoi-geojson');
    expect(Array.isArray(hasInput[0]!['appInputName'])).toBe(false);
  });

  it('omits appInputName when junction column is null', () => {
    const row = {
      id: 'https://w3id.org/okn/i/mint/Cfg1',
      inputs: [
        {
          is_optional: false,
          app_input_name: null,
          input: { id: 'https://w3id.org/okn/i/mint/Dspec1' },
        },
      ],
    };
    const result = transformRow(row, configurationConfig);
    const hasInput = result['hasInput'] as Array<Record<string, unknown>>;
    expect(hasInput[0]).not.toHaveProperty('appInputName');
  });
  it('hoists archived_file from junction row onto nested output DSpec as scalar', () => {
    const row = {
      id: 'https://w3id.org/okn/i/mint/Cfg1',
      outputs: [
        { archived_file: 'head*.tif', output: { id: 'https://w3id.org/okn/i/mint/Dspec1' } },
      ],
    };
    const result = transformRow(row, configurationConfig);
    const hasOutput = result['hasOutput'] as Array<Record<string, unknown>>;
    expect(hasOutput[0]!['archivedFile']).toBe('head*.tif');
  });

  it('omits archivedFile when junction column is null', () => {
    const row = {
      id: 'https://w3id.org/okn/i/mint/Cfg1',
      outputs: [{ archived_file: null, output: { id: 'https://w3id.org/okn/i/mint/Dspec1' } }],
    };
    const result = transformRow(row, configurationConfig);
    const hasOutput = result['hasOutput'] as Array<Record<string, unknown>>;
    expect(hasOutput[0]).not.toHaveProperty('archivedFile');
  });
});

describe('transformList', () => {
  it('maps transformRow over an array of rows', () => {
    const rows = [
      { id: 'https://w3id.org/okn/i/mint/SW1', label: 'Software 1' },
      { id: 'https://w3id.org/okn/i/mint/SW2', label: 'Software 2' },
    ];
    const results = transformList(rows, softwareConfig);

    expect(results).toHaveLength(2);
    expect(results[0]!['id']).toBe('https://w3id.org/okn/i/mint/SW1');
    expect(results[0]!['label']).toEqual(['Software 1']);
    expect(results[1]!['id']).toBe('https://w3id.org/okn/i/mint/SW2');
    expect(results[1]!['label']).toEqual(['Software 2']);
  });

  it('returns empty array for empty input', () => {
    const results = transformList([], softwareConfig);
    expect(results).toEqual([]);
  });
});

// ============================================================================
// toHasuraInput tests (request mapper)
// ============================================================================

describe('toHasuraInput - array unwrapping', () => {
  it('unwraps single-element arrays to scalars', () => {
    const body = {
      id: 'https://w3id.org/okn/i/mint/CYCLES',
      label: ['CYCLES'],
      license: ['MIT'],
    };
    const result = toHasuraInput(body, softwareConfig);

    expect(result['label']).toBe('CYCLES');
    expect(result['license']).toBe('MIT');
  });

  it('passes id through without wrapping or conversion', () => {
    const body = { id: 'https://w3id.org/okn/i/mint/CYCLES', label: ['CYCLES'] };
    const result = toHasuraInput(body, softwareConfig);

    expect(result['id']).toBe('https://w3id.org/okn/i/mint/CYCLES');
  });

  it('omits type field from Hasura input', () => {
    const body = {
      id: 'https://w3id.org/okn/i/mint/CYCLES',
      type: ['Software'],
      label: ['CYCLES'],
    };
    const result = toHasuraInput(body, softwareConfig);

    expect(result).not.toHaveProperty('type');
    expect(result['label']).toBe('CYCLES');
  });

  it('converts camelCase field names to snake_case', () => {
    const body = {
      id: 'https://w3id.org/okn/i/mint/CYCLES',
      hasDocumentation: ['http://example.com/docs'],
      dateCreated: ['2019'],
    };
    const result = toHasuraInput(body, softwareConfig);

    expect(result).toHaveProperty('has_documentation');
    expect(result).toHaveProperty('date_created');
    expect(result).not.toHaveProperty('hasDocumentation');
    expect(result).not.toHaveProperty('dateCreated');

    expect(result['has_documentation']).toBe('http://example.com/docs');
    expect(result['date_created']).toBe('2019');
  });

  it('omits null values from output', () => {
    const body = {
      id: 'https://w3id.org/okn/i/mint/CYCLES',
      label: ['CYCLES'],
      description: null,
    };
    const result = toHasuraInput(body, softwareConfig);

    expect(result).not.toHaveProperty('description');
  });

  it('omits empty array fields', () => {
    const body = {
      id: 'https://w3id.org/okn/i/mint/CYCLES',
      label: ['CYCLES'],
      license: [],
    };
    const result = toHasuraInput(body, softwareConfig);

    expect(result).not.toHaveProperty('license');
  });

  it('skips relationship fields (handled by caller as FK updates)', () => {
    const body = {
      id: 'https://w3id.org/okn/i/mint/CYCLES',
      label: ['CYCLES'],
      // author is a relationship field in softwareConfig
      author: [{ id: 'https://w3id.org/okn/i/mint/person1', type: ['Person'] }],
    };
    const result = toHasuraInput(body, softwareConfig);

    expect(result).not.toHaveProperty('author');
    expect(result['label']).toBe('CYCLES');
  });
});

// ============================================================================
// Round-trip test: transformRow -> toHasuraInput
// ============================================================================

describe('round-trip transform', () => {
  it('recovers original scalar values after transformRow then toHasuraInput', () => {
    const hasuraRow = {
      id: 'https://w3id.org/okn/i/mint/CYCLES',
      label: 'CYCLES',
      has_documentation: 'http://example.com/docs',
      date_created: '2019',
      license: 'MIT',
    };

    // Transform to API format
    const apiShape = transformRow(hasuraRow, softwareConfig);

    // Transform back to Hasura format
    const backToHasura = toHasuraInput(apiShape as Record<string, unknown>, softwareConfig);

    expect(backToHasura['id']).toBe(hasuraRow['id']);
    expect(backToHasura['label']).toBe(hasuraRow['label']);
    expect(backToHasura['has_documentation']).toBe(hasuraRow['has_documentation']);
    expect(backToHasura['date_created']).toBe(hasuraRow['date_created']);
    expect(backToHasura['license']).toBe(hasuraRow['license']);
  });
});
