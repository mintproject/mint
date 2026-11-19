/**
 * Integration tests for the CatalogServiceImpl pipeline.
 *
 * Tests the full pipeline: service method -> GraphQL query construction ->
 * response transformation -> v1.8.0-compatible JSON.
 *
 * Apollo Client is mocked to avoid needing a live Hasura instance.
 * The mocks let us assert on the query variables passed (pagination, filters)
 * and the transformation applied to the mock data (array wrapping, type synthesis, null omission).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// vi.mock is hoisted to top of file; use vi.hoisted() to declare shared mocks
// that are accessible both in the factory and in tests.
// ---------------------------------------------------------------------------
const { mockQuery, mockMutate } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockMutate: vi.fn(),
}))

vi.mock('../hasura/client.js', () => ({
  readClient: {
    query: mockQuery,
  },
  getWriteClient: vi.fn().mockReturnValue({
    mutate: mockMutate,
  }),
  gql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    // Simple gql tag passthrough: join template strings for inspection
    return strings.raw.reduce((acc, str, i) => acc + str + (values[i] ?? ''), '')
  },
}))

// Import AFTER mock is set up
import { CatalogService } from '../service.js'
import { customHandlers } from '../custom-handlers.js'

// ---------------------------------------------------------------------------
// Helper: create minimal mock req/reply objects
// ---------------------------------------------------------------------------
function makeReq(overrides: {
  query?: Record<string, string>
  params?: Record<string, string>
  headers?: Record<string, string>
  body?: unknown
} = {}) {
  return {
    query: overrides.query ?? {},
    params: overrides.params ?? {},
    headers: overrides.headers ?? {},
    body: overrides.body ?? {},
    log: { error: vi.fn(), warn: vi.fn() },
  }
}

function makeReply() {
  const reply = {
    _status: 200,
    _body: undefined as unknown,
    code(status: number) { reply._status = status; return reply },
    send(body: unknown) { reply._body = body; return reply },
  }
  return reply
}

// ---------------------------------------------------------------------------
// Test 1: List software - basic pipeline validation
// ---------------------------------------------------------------------------
describe('list software', () => {
  beforeEach(() => { mockQuery.mockReset() })

  it('returns array of v1.8.0-formatted software objects', async () => {
    mockQuery.mockResolvedValueOnce({
      data: {
        modelcatalog_software: [
          {
            id: 'https://w3id.org/okn/i/mint/CYCLES',
            label: 'CYCLES',
            description: 'A multi-process agroecosystem model',
            keywords: null,
            license: null,
            website: null,
            date_created: null,
            date_published: null,
            has_documentation: null,
            has_download_url: null,
            has_purpose: null,
            author_id: null,
            author: null,
            versions: [{ id: 'https://w3id.org/okn/i/mint/CYCLES-v1', label: 'v1', description: null }],
            authors: [],
          },
        ],
      },
    })

    const req = makeReq()
    const reply = makeReply()
    await (CatalogService as any).softwares_get(req, reply)

    expect(reply._status).toBe(200)
    const body = reply._body as any[]
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(1)

    const sw = body[0]
    // id is NOT array-wrapped
    expect(sw.id).toBe('https://w3id.org/okn/i/mint/CYCLES')
    // scalars are array-wrapped
    expect(sw.label).toEqual(['CYCLES'])
    expect(sw.description).toEqual(['A multi-process agroecosystem model'])
    // type is synthesized from resourceConfig.typeArray
    expect(sw.type).toEqual(['Software'])
    // null fields are omitted
    expect('keywords' in sw).toBe(false)
    expect('license' in sw).toBe(false)
    // versions nested relationship is included (registry key is 'hasVersion' in softwares config)
    expect(sw.hasVersion).toBeDefined()
    expect(Array.isArray(sw.hasVersion)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Test 2: Get software by ID - single object returned
// ---------------------------------------------------------------------------
describe('getById software', () => {
  beforeEach(() => { mockQuery.mockReset() })

  it('returns a single v1.8.0-formatted software object', async () => {
    mockQuery.mockResolvedValueOnce({
      data: {
        modelcatalog_software_by_pk: {
          id: 'https://w3id.org/okn/i/mint/CYCLES',
          label: 'CYCLES',
          description: 'A crop model',
          keywords: null,
          license: null,
          website: null,
          date_created: null,
          date_published: null,
          has_documentation: null,
          has_download_url: null,
          has_purpose: null,
          author_id: null,
          author: null,
          versions: [],
          authors: [],
        },
      },
    })

    const req = makeReq({ params: { id: 'https%3A%2F%2Fw3id.org%2Fokn%2Fi%2Fmint%2FCYCLES' } })
    const reply = makeReply()
    await (CatalogService as any).softwares_id_get(req, reply)

    expect(reply._status).toBe(200)
    const sw = reply._body as any
    expect(sw.id).toBe('https://w3id.org/okn/i/mint/CYCLES')
    expect(sw.label).toEqual(['CYCLES'])
    expect(sw.type).toEqual(['Software'])
  })
})

// ---------------------------------------------------------------------------
// Test 3: Get setup with nested data (junction table traversal)
// ---------------------------------------------------------------------------
describe('getById setup with nested data', () => {
  beforeEach(() => { mockQuery.mockReset() })

  it('returns setup with inputs (junction), parameters (junction), and author (FK)', async () => {
    mockQuery.mockResolvedValueOnce({
      data: {
        modelcatalog_configuration_by_pk: {
          id: 'https://w3id.org/okn/i/mint/setup1',
          label: 'Test Setup',
          description: 'A test setup',
          has_component_location: null,
          has_implementation_script_location: null,
          has_software_image: null,
          has_region: null,
          author_id: 'https://w3id.org/okn/i/mint/person1',
          calibration_interval: null,
          calibration_method: null,
          parameter_assignment_method: null,
          valid_until: null,
          model_configuration_id: null,
          parent_configuration: { id: 'https://w3id.org/okn/i/mint/cfg1', label: 'Config 1' },
          author: { id: 'https://w3id.org/okn/i/mint/person1', label: 'Dr. Smith' },
          inputs: [
            { input: { id: 'https://w3id.org/okn/i/mint/spec1', label: 'precip', description: null, has_format: null, has_dimensionality: null, position: 1 } },
          ],
          outputs: [],
          parameters: [
            { parameter: { id: 'https://w3id.org/okn/i/mint/param1', label: 'alpha', description: null, has_data_type: 'float', has_default_value: '0.5', has_minimum_accepted_value: '0', has_maximum_accepted_value: '1', has_fixed_value: null, position: 1, parameter_type: null } },
          ],
          authors: [],
          calibrated_variables: [],
          calibration_targets: [],
        },
      },
    })

    const req = makeReq({ params: { id: 'https%3A%2F%2Fw3id.org%2Fokn%2Fi%2Fmint%2Fsetup1' } })
    const reply = makeReply()
    await (CatalogService as any).modelconfigurationsetups_id_get(req, reply)

    expect(reply._status).toBe(200)
    const setup = reply._body as any
    expect(setup.id).toBe('https://w3id.org/okn/i/mint/setup1')
    expect(setup.type).toEqual(['ModelConfigurationSetup'])

    // Author is object_relationship -- array-wrapped in v1.8.0
    expect(Array.isArray(setup.author)).toBe(true)
    expect(setup.author[0].id).toBe('https://w3id.org/okn/i/mint/person1')

    // Inputs via junction table -- junction is traversed to target; registry key is 'hasInput'
    expect(Array.isArray(setup.hasInput)).toBe(true)
    expect(setup.hasInput[0].id).toBe('https://w3id.org/okn/i/mint/spec1')

    // Parameters via junction table -- registry key is 'hasParameter'
    expect(Array.isArray(setup.hasParameter)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Test 4: Pagination - page=2&per_page=10 -> offset=10, limit=10
// ---------------------------------------------------------------------------
describe('pagination', () => {
  beforeEach(() => { mockQuery.mockReset() })

  it('translates page=2&per_page=10 to offset=10, limit=10 in GraphQL variables', async () => {
    mockQuery.mockResolvedValueOnce({
      data: { modelcatalog_software: [] },
    })

    const req = makeReq({ query: { page: '2', per_page: '10' } })
    const reply = makeReply()
    await (CatalogService as any).softwares_get(req, reply)

    expect(mockQuery).toHaveBeenCalledOnce()
    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.variables).toMatchObject({ limit: 10, offset: 10 })
  })
})

// ---------------------------------------------------------------------------
// Test 5: Label filter - adds where: { label: { _eq: "CYCLES" } }
// ---------------------------------------------------------------------------
describe('label filter', () => {
  beforeEach(() => { mockQuery.mockReset() })

  it('adds label filter to GraphQL query variables when label param provided', async () => {
    mockQuery.mockResolvedValueOnce({
      data: { modelcatalog_software: [] },
    })

    const req = makeReq({ query: { label: 'CYCLES' } })
    const reply = makeReply()
    await (CatalogService as any).softwares_get(req, reply)

    expect(mockQuery).toHaveBeenCalledOnce()
    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.variables).toMatchObject({ label: 'CYCLES' })
    // The query string should include the label where clause
    expect(callArgs.query).toContain('label: { _eq: $label }')
  })

  it('leaves label as an exact match (no ilike) so existing callers are unaffected', async () => {
    mockQuery.mockResolvedValueOnce({ data: { modelcatalog_software: [] } })

    const req = makeReq({ query: { label: 'CYCLES' } })
    await (CatalogService as any).softwares_get(req, makeReply())

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.query).not.toContain('_ilike')
    expect(callArgs.variables).not.toHaveProperty('labelContains')
  })
})

// ---------------------------------------------------------------------------
// Test 5b: label_contains - substring filter used by autocomplete widgets
// ---------------------------------------------------------------------------
describe('label_contains filter', () => {
  beforeEach(() => { mockQuery.mockReset() })

  it('builds a case-insensitive %term% ilike filter', async () => {
    mockQuery.mockResolvedValueOnce({ data: { modelcatalog_standard_variable: [] } })

    const req = makeReq({ query: { label_contains: 'wind' } })
    await (CatalogService as any).standardvariables_get(req, makeReply())

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.query).toContain('label: { _ilike: $labelContains }')
    expect(callArgs.query).toContain('$labelContains: String!')
    expect(callArgs.variables).toMatchObject({ labelContains: '%wind%' })
  })

  it('escapes underscores so they are literal, not single-char wildcards', async () => {
    mockQuery.mockResolvedValueOnce({ data: { modelcatalog_standard_variable: [] } })

    const req = makeReq({ query: { label_contains: 'land_surface' } })
    await (CatalogService as any).standardvariables_get(req, makeReply())

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.variables).toMatchObject({ labelContains: '%land\\_surface%' })
  })

  it('escapes percent signs in the search term', async () => {
    mockQuery.mockResolvedValueOnce({ data: { modelcatalog_standard_variable: [] } })

    const req = makeReq({ query: { label_contains: '50%' } })
    await (CatalogService as any).standardvariables_get(req, makeReply())

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.variables).toMatchObject({ labelContains: '%50\\%%' })
  })

  it('can be combined with label without dropping either condition', async () => {
    mockQuery.mockResolvedValueOnce({ data: { modelcatalog_standard_variable: [] } })

    const req = makeReq({ query: { label: 'exact_one', label_contains: 'exact' } })
    await (CatalogService as any).standardvariables_get(req, makeReply())

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.query).toContain('label: { _eq: $label }')
    expect(callArgs.query).toContain('label: { _ilike: $labelContains }')
    expect(callArgs.variables).toMatchObject({
      label: 'exact_one',
      labelContains: '%exact%',
    })
  })
})

// ---------------------------------------------------------------------------
// Test 5c: enable_ckan - CKAN autocomplete response shape
// ---------------------------------------------------------------------------
describe('enable_ckan response shape', () => {
  beforeEach(() => { mockQuery.mockReset() })

  const twoVariables = {
    data: {
      modelcatalog_standard_variable: [
        { id: 'https://w3id.org/okn/i/mint/A', label: 'land_surface_wind__speed', description: null },
        { id: 'https://w3id.org/okn/i/mint/B', label: 'soil_water__temperature', description: null },
      ],
    },
  }

  it('wraps results as ResultSet.Result[].Name when enable_ckan=true', async () => {
    mockQuery.mockResolvedValueOnce(twoVariables)

    const req = makeReq({ query: { enable_ckan: 'true', label_contains: 'w' } })
    const reply = makeReply()
    await (CatalogService as any).standardvariables_get(req, reply)

    expect(reply._status).toBe(200)
    expect(reply._body).toEqual({
      ResultSet: {
        Result: [
          { Name: 'land_surface_wind__speed' },
          { Name: 'soil_water__temperature' },
        ],
      },
    })
  })

  it('accepts a real boolean true (Fastify coerces the declared param)', async () => {
    mockQuery.mockResolvedValueOnce(twoVariables)

    const req = makeReq({ query: { enable_ckan: true } as any })
    const reply = makeReply()
    await (CatalogService as any).standardvariables_get(req, reply)

    expect(reply._body).toHaveProperty('ResultSet.Result')
  })

  it('returns the plain array when enable_ckan is absent', async () => {
    mockQuery.mockResolvedValueOnce(twoVariables)

    const req = makeReq({ query: {} })
    const reply = makeReply()
    await (CatalogService as any).standardvariables_get(req, reply)

    expect(Array.isArray(reply._body)).toBe(true)
    expect((reply._body as any[])[0]).toMatchObject({ label: ['land_surface_wind__speed'] })
  })

  it('treats enable_ckan=false as off rather than truthy', async () => {
    mockQuery.mockResolvedValueOnce(twoVariables)

    const req = makeReq({ query: { enable_ckan: 'false' } })
    const reply = makeReply()
    await (CatalogService as any).standardvariables_get(req, reply)

    expect(Array.isArray(reply._body)).toBe(true)
  })

  it('returns an empty Result list rather than an array when there are no matches', async () => {
    mockQuery.mockResolvedValueOnce({ data: { modelcatalog_standard_variable: [] } })

    const req = makeReq({ query: { enable_ckan: 'true', label_contains: 'zzzz' } })
    const reply = makeReply()
    await (CatalogService as any).standardvariables_get(req, reply)

    expect(reply._body).toEqual({ ResultSet: { Result: [] } })
  })
})

// ---------------------------------------------------------------------------
// Test 6: Username filter - accepted but ignored (no-op, no user_id column in schema)
// The modelcatalog_* tables have no user_id column; username param is accepted for
// API compatibility but does not produce any WHERE clause filtering.
// ---------------------------------------------------------------------------
describe('username filter', () => {
  beforeEach(() => { mockQuery.mockReset() })

  it('accepts username=mint@isi.edu but does not add user_id WHERE clause', async () => {
    mockQuery.mockResolvedValueOnce({
      data: { modelcatalog_software: [] },
    })

    const req = makeReq({ query: { username: 'mint@isi.edu' } })
    const reply = makeReply()
    await (CatalogService as any).softwares_get(req, reply)

    expect(mockQuery).toHaveBeenCalledOnce()
    const callArgs = mockQuery.mock.calls[0][0]
    // username is NOT passed as a GraphQL variable (no-op)
    expect(callArgs.variables).not.toHaveProperty('username')
    // The query string must NOT include the user_id where clause
    expect(callArgs.query).not.toContain('user_id')
    // Basic pagination variables are still present
    expect(callArgs.variables).toMatchObject({ limit: 25, offset: 0 })
    // Request succeeds normally
    expect(reply._status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Test 7: Null omission - null fields are not included in response
// ---------------------------------------------------------------------------
describe('null omission', () => {
  beforeEach(() => { mockQuery.mockReset() })

  it('omits null and undefined fields from response', async () => {
    mockQuery.mockResolvedValueOnce({
      data: {
        modelcatalog_software: [
          {
            id: 'https://w3id.org/okn/i/mint/CYCLES',
            label: 'CYCLES',
            description: null,
            keywords: undefined,
            license: null,
            website: null,
            date_created: null,
            date_published: null,
            has_documentation: null,
            has_download_url: null,
            has_purpose: null,
            author_id: null,
            author: null,
            versions: [],
            authors: [],
          },
        ],
      },
    })

    const req = makeReq()
    const reply = makeReply()
    await (CatalogService as any).softwares_get(req, reply)

    const body = reply._body as any[]
    const sw = body[0]
    expect('description' in sw).toBe(false)
    expect('keywords' in sw).toBe(false)
    expect('license' in sw).toBe(false)
    // id is always present (even null id would be a bug, but non-null id should be present)
    expect(sw.id).toBe('https://w3id.org/okn/i/mint/CYCLES')
  })
})

// ---------------------------------------------------------------------------
// Test 8: URI-encoded ID decoding
// ---------------------------------------------------------------------------
describe('URI-encoded ID decoding', () => {
  beforeEach(() => { mockQuery.mockReset() })

  it('decodes URI-encoded %2F-containing IDs before querying Hasura', async () => {
    mockQuery.mockResolvedValueOnce({
      data: {
        modelcatalog_software_by_pk: {
          id: 'https://w3id.org/okn/i/mint/CYCLES',
          label: 'CYCLES',
          description: null,
          keywords: null,
          license: null,
          website: null,
          date_created: null,
          date_published: null,
          has_documentation: null,
          has_download_url: null,
          has_purpose: null,
          author_id: null,
          author: null,
          versions: [],
          authors: [],
        },
      },
    })

    // URL-encoded version of "https://w3id.org/okn/i/mint/CYCLES"
    const encodedId = encodeURIComponent('https://w3id.org/okn/i/mint/CYCLES')
    const req = makeReq({ params: { id: encodedId } })
    const reply = makeReply()
    await (CatalogService as any).softwares_id_get(req, reply)

    expect(mockQuery).toHaveBeenCalledOnce()
    const callArgs = mockQuery.mock.calls[0][0]
    // The decoded URI should be passed as the id variable
    expect(callArgs.variables.id).toBe('https://w3id.org/okn/i/mint/CYCLES')
  })
})

// ---------------------------------------------------------------------------
// Test 9: Plain ID resolved by prepending resource idPrefix
// service.ts accepts a bare slug and prepends resourceConfig.idPrefix before
// querying Hasura.
// ---------------------------------------------------------------------------
describe('getById with plain ID (no URI prefix)', () => {
  beforeEach(() => { mockQuery.mockReset() })

  it('prepends idPrefix and queries Hasura with the resolved URI', async () => {
    const slug = '1bade4cb-d924-4253-bfa9-4c02b461396a'
    mockQuery.mockResolvedValueOnce({
      data: {
        modelcatalog_software_by_pk: {
          id: `https://w3id.org/okn/i/mint/${slug}`,
          label: 'X',
        },
      },
    })

    const req = makeReq({ params: { id: slug } })
    const reply = makeReply()
    await (CatalogService as any).softwares_id_get(req, reply)

    expect(reply._status).toBe(200)
    expect(mockQuery).toHaveBeenCalledOnce()
    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.variables.id).toBe(`https://w3id.org/okn/i/mint/${slug}`)
  })
})

// ---------------------------------------------------------------------------
// Test 10: Custom handler plain-ID resolution
// ---------------------------------------------------------------------------
describe('Custom handler URI strict mode', () => {
  beforeEach(() => { mockQuery.mockReset() })

  it('custom_configurationsetups_id_get resolves plain ID with idPrefix', async () => {
    const slug = 'hand_v6'
    const fullUri = `https://w3id.org/okn/i/mint/${slug}`
    mockQuery.mockResolvedValueOnce({
      data: {
        modelcatalog_configuration_by_pk: { id: fullUri, label: slug },
      },
    })

    const req = makeReq({ params: { id: slug } })
    const reply = makeReply()
    await customHandlers.custom_configurationsetups_id_get(req, reply)

    expect(reply._status).toBe(200)
    expect(mockQuery).toHaveBeenCalledOnce()
    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.variables.id).toBe(fullUri)
  })

  it('custom_modelconfigurationsetups_id_get passes full URI unchanged', async () => {
    const fullUri = 'https://w3id.org/okn/i/mint/hand_v6'
    mockQuery.mockResolvedValueOnce({
      data: {
        modelcatalog_configuration_by_pk: {
          id: fullUri,
          label: 'hand_v6',
        },
      },
    })

    const req = makeReq({ params: { id: encodeURIComponent(fullUri) } })
    const reply = makeReply()
    await customHandlers.custom_modelconfigurationsetups_id_get(req, reply)

    expect(reply._status).toBe(200)
    expect(mockQuery).toHaveBeenCalledOnce()
    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.variables.id).toBe(fullUri)
  })

  it('custom_datasetspecifications_get resolves plain configurationid with idPrefix', async () => {
    const slug = 'some-config-uuid'
    const fullCfgUri = `https://w3id.org/okn/i/mint/${slug}`
    mockQuery.mockResolvedValueOnce({
      data: {
        modelcatalog_configuration_input: [],
        modelcatalog_configuration_output: [],
      },
    })

    const req = makeReq({ query: { configurationid: slug } })
    const reply = makeReply()
    await customHandlers.custom_datasetspecifications_get(req, reply)

    expect(reply._status).toBe(200)
    expect(mockQuery).toHaveBeenCalledOnce()
    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.variables.cfgId).toBe(fullCfgUri)
  })

  it('custom_datasetspecifications_get WHERE clause uses configuration_id not model_configuration_id', async () => {
    mockQuery.mockResolvedValueOnce({
      data: {
        modelcatalog_configuration_input: [],
        modelcatalog_configuration_output: [],
      },
    })

    const cfgUri = 'https://w3id.org/okn/i/mint/some-config-uuid'
    const req = makeReq({ query: { configurationid: encodeURIComponent(cfgUri) } })
    const reply = makeReply()
    await customHandlers.custom_datasetspecifications_get(req, reply)

    expect(mockQuery).toHaveBeenCalledOnce()
    const callArgs = mockQuery.mock.calls[0][0]
    const queryStr = typeof callArgs.query === 'string' ? callArgs.query : callArgs.query?.loc?.source?.body ?? ''
    expect(queryStr).toContain('configuration_id')
    expect(queryStr).not.toContain('model_configuration_id')
    expect(callArgs.variables.cfgId).toBe(cfgUri)
  })
})

// ---------------------------------------------------------------------------
// FK-on-child relationships: parent.hasVersion / hasConfiguration / hasSetup
// where the child carries an FK column pointing back to the parent.
// ---------------------------------------------------------------------------
describe('PUT model with hasVersion sets software_id on child rows', () => {
  beforeEach(() => { mockQuery.mockReset(); mockMutate.mockReset() })

  // bug-089: link-only childFk refs (id-only) flow OUT of the upsert path
  // (would NULL-violate child NOT-NULL columns) into a top-level aliased
  // `link_N` FK update. Inline-new children remain in the upsert path.
  it('emits clear + link_N FK update for link-only PUT child (no upsert)', async () => {
    mockMutate.mockResolvedValueOnce({ data: {} })

    const req = makeReq({
      params: { id: encodeURIComponent('https://w3id.org/okn/i/mint/MODEL-1') },
      headers: { authorization: 'Bearer test' },
      body: {
        type: ['https://w3id.org/okn/o/sdm#Model'],
        id: 'https://w3id.org/okn/i/mint/MODEL-1',
        label: ['M'],
        hasVersion: [{ id: 'https://w3id.org/okn/i/mint/V-1' }],
      },
    })
    const reply = makeReply()
    await (CatalogService as any).models_id_put(req, reply)

    expect(mockMutate).toHaveBeenCalledOnce()
    expect(mockQuery).not.toHaveBeenCalled()
    const args = mockMutate.mock.calls[0][0]
    const m = typeof args.mutation === 'string' ? args.mutation : args.mutation?.loc?.source?.body ?? ''
    expect(m).toContain('clear_software_versions: update_modelcatalog_software_version')
    expect(m).not.toContain('upsert_software_versions:')
    expect(m).toContain('link_0: update_modelcatalog_software_version')
    expect(m).toContain('software_id: { _eq: $id }')
    expect(args.variables.child_ids_software_versions).toEqual(['https://w3id.org/okn/i/mint/V-1'])
    expect(args.variables.link_ids_0).toEqual(['https://w3id.org/okn/i/mint/V-1'])
    expect(args.variables.link_parent_0).toBe('https://w3id.org/okn/i/mint/MODEL-1')
    expect(args.variables.id).toBe('https://w3id.org/okn/i/mint/MODEL-1')
    expect(reply._status).toBe(200)
    expect((reply._body as any).id).toBe('https://w3id.org/okn/i/mint/MODEL-1')
  })

  it('omits upsert AND link branches when hasVersion is empty array (clear-only)', async () => {
    mockMutate.mockResolvedValueOnce({ data: {} })

    const req = makeReq({
      params: { id: encodeURIComponent('https://w3id.org/okn/i/mint/MODEL-2') },
      headers: { authorization: 'Bearer test' },
      body: {
        type: ['https://w3id.org/okn/o/sdm#Model'],
        id: 'https://w3id.org/okn/i/mint/MODEL-2',
        label: ['M2'],
        hasVersion: [],
      },
    })
    const reply = makeReply()
    await (CatalogService as any).models_id_put(req, reply)

    const args = mockMutate.mock.calls[0][0]
    const m = typeof args.mutation === 'string' ? args.mutation : args.mutation?.loc?.source?.body ?? ''
    expect(m).toContain('clear_software_versions:')
    expect(m).not.toContain('upsert_software_versions:')
    expect(m).not.toContain('link_0:')
    expect(args.variables.child_ids_software_versions).toEqual([])
  })

  it('softwareversions.hasConfiguration link-only ref -> link_0 update_modelcatalog_configuration', async () => {
    mockMutate.mockResolvedValueOnce({ data: {} })

    const req = makeReq({
      params: { id: encodeURIComponent('https://w3id.org/okn/i/mint/V-1') },
      headers: { authorization: 'Bearer test' },
      body: {
        id: 'https://w3id.org/okn/i/mint/V-1',
        label: ['v1'],
        hasConfiguration: [{ id: 'https://w3id.org/okn/i/mint/CFG-1' }],
      },
    })
    const reply = makeReply()
    await (CatalogService as any).softwareversions_id_put(req, reply)

    const args = mockMutate.mock.calls[0][0]
    const m = typeof args.mutation === 'string' ? args.mutation : args.mutation?.loc?.source?.body ?? ''
    expect(m).toContain('clear_configurations: update_modelcatalog_configuration')
    expect(m).not.toContain('upsert_configurations:')
    expect(m).toContain('link_0: update_modelcatalog_configuration')
    expect(m).toContain('software_version_id: { _eq: $id }')
    expect(args.variables.link_ids_0).toEqual(['https://w3id.org/okn/i/mint/CFG-1'])
    expect(args.variables.link_parent_0).toBe('https://w3id.org/okn/i/mint/V-1')
  })
})

describe('POST software with hasVersion links existing version rows', () => {
  beforeEach(() => { mockMutate.mockReset() })

  it('link-only childFk POST -> aliased link_N FK update (NOT nested insert)', async () => {
    // bug-089: id-only ref MUST NOT enter the nested-array data (NOT-NULL on
    // child columns would fire before ON CONFLICT). Surfaces as top-level
    // `link_N: update_modelcatalog_software_version(...)` after root insert.
    mockMutate.mockResolvedValueOnce({
      data: {
        insert_modelcatalog_software_one: { id: 'https://w3id.org/okn/i/mint/NEW-1' },
      },
    })

    const req = makeReq({
      headers: { authorization: 'Bearer test' },
      body: {
        type: ['Software'],
        id: 'https://w3id.org/okn/i/mint/NEW-1',
        label: ['New'],
        hasVersion: [{ id: 'https://w3id.org/okn/i/mint/V-99' }],
      },
    })
    const reply = makeReply()
    await (CatalogService as any).softwares_post(req, reply)

    expect(mockMutate).toHaveBeenCalledOnce()
    const args = mockMutate.mock.calls[0][0]
    const m = typeof args.mutation === 'string' ? args.mutation : args.mutation?.loc?.source?.body ?? ''
    expect(m).toContain('insert_modelcatalog_software_one')
    expect(m).toContain('link_0: update_modelcatalog_software_version')
    const obj = args.variables.object as Record<string, any>
    expect(obj.id).toBe('https://w3id.org/okn/i/mint/NEW-1')
    // versions key omitted entirely — only link-only children, no nested insert
    expect(obj.versions).toBeUndefined()
    expect(args.variables.link_ids_0).toEqual(['https://w3id.org/okn/i/mint/V-99'])
    expect(args.variables.link_parent_0).toBe('https://w3id.org/okn/i/mint/NEW-1')
  })
})

// ---------------------------------------------------------------------------
// Hasura returns null, not an error, when a permission filter excludes the row
// of an update or delete by primary key. That must not be reported as success.
// ---------------------------------------------------------------------------
describe('a write that Hasura refuses is not reported as success', () => {
  const uri = 'https://w3id.org/okn/i/mint/MODEL-OWNED'
  const putReq = () =>
    makeReq({
      params: { id: encodeURIComponent(uri) },
      headers: { authorization: 'Bearer test' },
      body: { type: ['https://w3id.org/okn/o/sdm#Model'], id: uri, label: ['M'] },
    })
  const deleteReq = () =>
    makeReq({ params: { id: encodeURIComponent(uri) }, headers: { authorization: 'Bearer test' } })

  beforeEach(() => { mockQuery.mockReset(); mockMutate.mockReset() })

  it('PUT on a row the caller may not change returns 403', async () => {
    mockMutate.mockResolvedValueOnce({ data: { update_modelcatalog_software_by_pk: null } })
    mockQuery.mockResolvedValueOnce({ data: { modelcatalog_software_by_pk: { id: uri } } })
    const reply = makeReply()
    await (CatalogService as any).models_id_put(putReq(), reply)
    expect(reply._status).toBe(403)
    expect(mockQuery.mock.calls[0][0].variables).toEqual({ id: uri })
  })

  it('PUT on a row that does not exist returns 404', async () => {
    mockMutate.mockResolvedValueOnce({ data: { update_modelcatalog_software_by_pk: null } })
    mockQuery.mockResolvedValueOnce({ data: { modelcatalog_software_by_pk: null } })
    const reply = makeReply()
    await (CatalogService as any).models_id_put(putReq(), reply)
    expect(reply._status).toBe(404)
  })

  it('PUT that changed the row still returns 200 without a second query', async () => {
    mockMutate.mockResolvedValueOnce({ data: { update_modelcatalog_software_by_pk: { id: uri } } })
    const reply = makeReply()
    await (CatalogService as any).models_id_put(putReq(), reply)
    expect(reply._status).toBe(200)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('DELETE on a row the caller may not delete returns 403', async () => {
    mockMutate.mockResolvedValueOnce({ data: { delete_modelcatalog_software_by_pk: null } })
    mockQuery.mockResolvedValueOnce({ data: { modelcatalog_software_by_pk: { id: uri } } })
    const reply = makeReply()
    await (CatalogService as any).models_id_delete(deleteReq(), reply)
    expect(reply._status).toBe(403)
  })

  it('DELETE on a row that does not exist returns 404', async () => {
    mockMutate.mockResolvedValueOnce({ data: { delete_modelcatalog_software_by_pk: null } })
    mockQuery.mockResolvedValueOnce({ data: { modelcatalog_software_by_pk: null } })
    const reply = makeReply()
    await (CatalogService as any).models_id_delete(deleteReq(), reply)
    expect(reply._status).toBe(404)
  })

  it('DELETE that removed the row returns 202', async () => {
    mockMutate.mockResolvedValueOnce({ data: { delete_modelcatalog_software_by_pk: { id: uri } } })
    const reply = makeReply()
    await (CatalogService as any).models_id_delete(deleteReq(), reply)
    expect(reply._status).toBe(202)
  })
})

describe('a nested write that Hasura refuses is a 403, not a constraint error', () => {
  beforeEach(() => { mockQuery.mockReset(); mockMutate.mockReset() })

  it('PUT whose link insert fails the permission check returns 403', async () => {
    mockMutate.mockRejectedValueOnce(
      new Error('check constraint of an insert/update permission has failed'),
    )
    const uri = 'https://w3id.org/okn/i/mint/MODEL-OWNED'
    const req = makeReq({
      params: { id: encodeURIComponent(uri) },
      headers: { authorization: 'Bearer test' },
      body: { type: ['https://w3id.org/okn/o/sdm#Model'], id: uri, label: ['M'] },
    })
    const reply = makeReply()
    await (CatalogService as any).models_id_put(req, reply)
    expect(reply._status).toBe(403)
  })
})
