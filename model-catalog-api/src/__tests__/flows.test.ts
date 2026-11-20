import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockQuery, mockMutate } = vi.hoisted(() => ({ mockQuery: vi.fn(), mockMutate: vi.fn() }))
vi.mock('../hasura/client.js', () => ({
  readClient: { query: mockQuery },
  getWriteClient: vi.fn(() => ({ mutate: mockMutate })),
  gql: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
}))

import {
  custom_flows_post,
  planRegistration,
  buildRows,
  registrationMutation,
  usernameFromBearer,
  FlowError,
} from '../flows.js'

const bearer = (claims: Record<string, unknown>) =>
  `Bearer h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
const ALICE = bearer({ 'tapis/username': 'alice' })

const BODY = () => ({
  software: { label: 'Semantic Sensemaking' },
  version: { label: 'a23bfc5', version_id: 'a23bfc5' },
  configuration: { id: 'https://w3id.org/okn/i/mint/dictionary', label: 'Dictionary' },
  inputs: [
    { key: 'corpus', label: 'Documents', format: 'folder', standard_variable: 'sv:text' },
    { key: 'lexicon', label: 'Lexicon', standard_variable: 'sv:terms', optional: true },
  ],
  steps: [
    { position: 1, etl_process_id: 'p:ingest', wires: [{ to: { input: 0 }, from: { flow_input: 'corpus' } }] },
    {
      position: 2, etl_process_id: 'p:score', settings: { top_n: 25 },
      wires: [{ to: { input: 0 }, from: { step: 1, output: 0 } }, { to: { input: 1 }, from: { flow_input: 'lexicon' } }],
    },
  ],
  outputs: [{ step: 2, output: 0, label: 'Term counts' }, { step: 2, value: 'job_uuid' }],
  thread_bindings: { region: { input: 'corpus' }, start_date: { setting: 'start' } },
})

const PIECES = {
  'p:ingest': { settings: ['start'], setting_details: { start: { type: 'string', default: '2024-01-01' } }, output_contracts: {} },
  'p:score': {
    settings: ['top_n', 'start'],
    setting_details: { top_n: { type: 'integer', default: 10, description: 'How many' }, start: {} },
    output_contracts: { '0': { standard_variable_uri: 'sv:counts', format: 'csv' } },
  },
}
const C = 'https://w3id.org/okn/i/mint/dictionary'

function makeReply() {
  const reply: any = { _status: 0, _body: undefined }
  reply.code = (status: number) => { reply._status = status; return reply }
  reply.send = (body: unknown) => { reply._body = body; return reply }
  return reply
}
const makeReq = (body: unknown, authorization: string | undefined = ALICE) =>
  ({ body, headers: { authorization }, log: { error: vi.fn() } })

function adapterAnswers(answer: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => answer })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  mockQuery.mockReset(); mockMutate.mockReset()
  process.env.SVO_ADAPTER_API_URL = 'https://adapter.example/'
  mockQuery.mockResolvedValue({ data: { modelcatalog_software_by_pk: null, modelcatalog_software_version_by_pk: null } })
  mockMutate.mockResolvedValue({ data: {} })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('what is sent to the adapter to check', () => {
  it('names each flow input by the id it will have in the catalog', () => {
    const plan = planRegistration(BODY())
    expect(plan.inputIds).toEqual({ corpus: `${C}_input_1`, lexicon: `${C}_input_2` })
    expect(plan.check.inputs[0]).toEqual({ id: `${C}_input_1`, contract: { standard_variable_uri: 'sv:text', format: 'folder' } })
    expect(plan.check.steps[1].wires[1]).toEqual({ to: { input: 1 }, from: { flow_input: `${C}_input_2` } })
    expect(plan.check.outputs).toEqual([{ step: 2, output: 0 }, { step: 2, value: 'job_uuid' }])
  })

  it.each([
    [{ ...BODY(), steps: [] }, 'at least one step'],
    [{ ...BODY(), configuration: {} }, 'configuration.label'],
    [{ ...BODY(), software: {} }, 'software.label'],
    [{ ...BODY(), inputs: [{ key: 'a b', label: 'x', standard_variable: 'sv' }] }, 'unique plain name'],
    [{ ...BODY(), inputs: [BODY().inputs[0], BODY().inputs[0]] }, 'unique plain name'],
    [{ ...BODY(), steps: [{ position: 1, wires: [{ to: { input: 0 }, from: { flow_input: 'nope' } }] }] }, 'no flow input is named'],
    [{ ...BODY(), steps: new Array(25).fill({ position: 1 }) }, 'at most 24'],
    [{ ...BODY(), outputs: 'nope' }, 'outputs must be a list'],
  ])('refuses a request that is not in the expected form', (body, message) => {
    expect(() => planRegistration(body as any)).toThrow(FlowError)
    expect(() => planRegistration(body as any)).toThrow(message)
  })
})

describe('the catalog rows for a flow', () => {
  const rows = () => buildRows(BODY(), planRegistration(BODY()), PIECES, 'alice')

  it('gives the configuration to the caller, with inputs numbered from 1', () => {
    const { configuration } = rows()
    expect(configuration.owner_username).toBe('alice')
    expect(configuration.inputs.data.map((i: any) => [i.input.data.position, i.is_optional])).toEqual([[1, false], [2, true]])
    expect(configuration.inputs.data[0].input.data.presentations.data[0].presentation.data.has_standard_variable).toBe('sv:text')
  })

  it('makes one setting per name, with the flow default over the piece default', () => {
    const parameters = rows().configuration.parameters.data.map((p: any) => p.parameter.data)
    expect(parameters.map((p: any) => [p.label, p.has_data_type, p.has_default_value, p.position])).toEqual([
      ['start', 'string', '2024-01-01', 1],
      ['top_n', 'integer', '25', 2],
    ])
  })

  it('describes a data output from the piece and passes a value output through', () => {
    const { configuration, flow } = rows()
    const output = configuration.outputs.data[0].output.data
    expect([output.label, output.has_format, output.position]).toEqual(['Term counts', 'csv', 1])
    expect(output.presentations.data[0].presentation.data.has_standard_variable).toBe('sv:counts')
    expect(flow.outputs_json).toEqual([{ step: 2, output: 0, output_id: `${C}_output_1` }, { step: 2, value: 'job_uuid' }])
  })

  it('binds the thread region and dates to catalog ids', () => {
    expect(rows().flow.thread_bindings_json).toEqual({
      region: { input: `${C}_input_1` },
      start_date: { parameter: `${C}_setting_start` },
    })
    const bad = { ...BODY(), thread_bindings: { region: { setting: 'nope' } } }
    expect(() => buildRows(bad, planRegistration(bad), PIECES, 'alice')).toThrow('thread_bindings.region')
  })

  it('stores the inputs that take a collection as input ids', () => {
    const body = { ...BODY(), thread_bindings: { region: { input: 'corpus' }, collections: ['corpus'] } }
    const stored = buildRows(body, planRegistration(body), PIECES, 'alice').flow.thread_bindings_json
    expect(stored).toEqual({ region: { input: `${C}_input_1` }, collections: [`${C}_input_1`] })
  })

  it('refuses a collection marker that is unknown, repeated or not a list of keys', () => {
    for (const collections of [['nope'], ['corpus', 'corpus'], [1], 'corpus']) {
      const bad = { ...BODY(), thread_bindings: { collections } }
      expect(() => buildRows(bad, planRegistration(bad), PIECES, 'alice')).toThrow('thread_bindings.collections')
    }
  })

  it('stores each step with its links as the adapter checked them', () => {
    const step = rows().flow.steps.data[1]
    expect(step).toEqual({
      position: 2, etl_process_id: 'p:score', settings_json: { top_n: 25 }, pause_after: false,
      wires_json: [{ to: { input: 0 }, from: { step: 1, output: 0 } }, { to: { input: 1 }, from: { flow_input: `${C}_input_2` } }],
    })
  })
})

describe('one mutation, whatever already exists', () => {
  it('creates the family, the version or only the configuration', () => {
    expect(registrationMutation(false, false)).toContain('insert_modelcatalog_software_one(object: $parent)')
    expect(registrationMutation(true, false)).toContain('insert_modelcatalog_software_version_one(object: $parent)')
    expect(registrationMutation(true, true)).toContain('insert_modelcatalog_configuration_one(object: $parent)')
    for (const mutation of [registrationMutation(false, false), registrationMutation(true, true)]) {
      // The flow row and its steps go in the same request as the model rows.
      expect(mutation).toContain('insert_modelcatalog_configuration_flow_one(object: $flow)')
      expect(mutation.match(/mutation /g)).toHaveLength(1)
    }
  })
})

describe('POST /flows', () => {
  it('checks with the adapter as the caller, then writes everything in one request', async () => {
    const fetchMock = adapterAnswers({ ok: true, problems: [], pieces: PIECES })
    const reply = makeReply()
    await custom_flows_post(makeReq(BODY()), reply)

    expect(reply._status).toBe(201)
    expect(reply._body.configuration_id).toBe(C)
    expect(reply._body.inputs).toEqual({ corpus: `${C}_input_1`, lexicon: `${C}_input_2` })
    const [url, request] = fetchMock.mock.calls[0]
    expect(url).toBe('https://adapter.example/flows/check')
    expect(request.headers.Authorization).toBe(ALICE)
    expect(mockMutate).toHaveBeenCalledOnce()
    const { variables } = mockMutate.mock.calls[0][0]
    expect(variables.parent.versions.data[0].configurations.data[0].id).toBe(C)
    expect(variables.flow.configuration_id).toBe(C)
  })

  it('adds to an existing family and version without recreating them', async () => {
    adapterAnswers({ ok: true, problems: [], pieces: PIECES })
    const body = { ...BODY(), software: { id: 'sw' }, version: { id: 'ver' } }
    mockQuery.mockResolvedValue({ data: {
      modelcatalog_software_by_pk: { id: 'https://w3id.org/okn/i/mint/sw' },
      modelcatalog_software_version_by_pk: { id: 'https://w3id.org/okn/i/mint/ver', software_id: 'https://w3id.org/okn/i/mint/sw' },
    } })
    const reply = makeReply()
    await custom_flows_post(makeReq(body), reply)
    expect(reply._status).toBe(201)
    const { variables } = mockMutate.mock.calls[0][0]
    expect(variables.parent.software_version_id).toBe('https://w3id.org/okn/i/mint/ver')
    expect(variables.parent.versions).toBeUndefined()
  })

  it('writes nothing when the adapter says the flow does not fit', async () => {
    adapterAnswers({ ok: false, problems: [{ code: 'FLOW_WIRE_DOES_NOT_FIT', step: 2, wire: 0 }] })
    const reply = makeReply()
    await custom_flows_post(makeReq(BODY()), reply)
    expect(reply._status).toBe(422)
    expect(reply._body.code).toBe('FLOW_DOES_NOT_CHECK_OUT')
    expect(reply._body.problems).toEqual([{ code: 'FLOW_WIRE_DOES_NOT_FIT', step: 2, wire: 0 }])
    expect(mockMutate).not.toHaveBeenCalled()
  })

  it.each([
    ['', 401], ['Bearer not-a-jwt', 401], [bearer({ sub: 'x' }), 401],
  ])('needs a signed-in caller', async (authorization, status) => {
    const fetchMock = adapterAnswers({ ok: true })
    const reply = makeReply()
    await custom_flows_post(makeReq(BODY(), authorization as any), reply)
    expect(reply._status).toBe(status)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('says so when no adapter is configured, or it cannot be reached', async () => {
    delete process.env.SVO_ADAPTER_API_URL
    let reply = makeReply()
    await custom_flows_post(makeReq(BODY()), reply)
    expect([reply._status, reply._body.code]).toEqual([503, 'FLOWS_NOT_CONFIGURED'])

    process.env.SVO_ADAPTER_API_URL = 'https://adapter.example'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    reply = makeReply()
    await custom_flows_post(makeReq(BODY()), reply)
    expect([reply._status, reply._body.code]).toEqual([502, 'FLOW_CHECK_UNAVAILABLE'])
    expect(mockMutate).not.toHaveBeenCalled()
  })

  it.each([
    ['check constraint of an insert/update permission has failed', 403, 'FLOW_NOT_PERMITTED'],
    ['Uniqueness violation. duplicate key value violates unique constraint', 409, 'FLOW_EXISTS'],
    ['Foreign key violation. insert or update violates foreign key', 400, 'FLOW_REQUEST_INVALID'],
    ['connection reset', 502, 'FLOW_WRITE_FAILED'],
  ])('reports a refused write as what it is', async (message, status, code) => {
    adapterAnswers({ ok: true, problems: [], pieces: PIECES })
    mockMutate.mockRejectedValue(new Error(message))
    const reply = makeReply()
    await custom_flows_post(makeReq(BODY()), reply)
    expect([reply._status, reply._body.code]).toEqual([status, code])
  })

  it('refuses a version that belongs to another software', async () => {
    adapterAnswers({ ok: true, problems: [], pieces: PIECES })
    mockQuery.mockResolvedValue({ data: {
      modelcatalog_software_by_pk: { id: 'x' },
      modelcatalog_software_version_by_pk: { id: 'v', software_id: 'someone-elses' },
    } })
    const reply = makeReply()
    await custom_flows_post(makeReq({ ...BODY(), software: { id: 'sw' }, version: { id: 'ver' } }), reply)
    expect(reply._status).toBe(400)
    expect(mockMutate).not.toHaveBeenCalled()
  })
})

describe('the username in a token', () => {
  it('is read from the Tapis claim', () => {
    expect(usernameFromBearer(ALICE)).toBe('alice')
    expect(usernameFromBearer(undefined)).toBeUndefined()
    expect(usernameFromBearer('Bearer a.b.c')).toBeUndefined()
    expect(usernameFromBearer(bearer({ 'tapis/username': '' }))).toBeUndefined()
  })
})
