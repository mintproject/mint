/**
 * POST /flows: register a flow of ETL pieces as a model.
 *
 * A flow is stored as a Software > Version > Configuration like any model, plus a
 * row that marks the configuration as a flow and one row per step. The SVO adapter
 * owns the rules for whether a graph of pieces fits together, so this handler asks
 * it, with the caller's token, before writing anything. Every write is made with the
 * caller's token, so the catalog's ownership rules apply, and in one mutation, so a
 * refused registration leaves nothing behind.
 */
import { randomUUID } from 'node:crypto'
import { readClient, getWriteClient, gql } from './hasura/client.js'

type Json = Record<string, any>

const ID_PREFIX = 'https://w3id.org/okn/i/mint/'
const MODEL_TYPE = 'https://w3id.org/okn/o/sdm#Model'
const MAX_STEPS = 24
const MAX_ITEMS = 64

export class FlowError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Json = {},
  ) {
    super(message)
  }
}

function text(value: unknown, field: string, max = 500, required = true): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new FlowError(400, 'FLOW_REQUEST_INVALID', `${field} is required`)
    return undefined
  }
  if (typeof value !== 'string' || value.length > max) {
    throw new FlowError(400, 'FLOW_REQUEST_INVALID', `${field} must be text of at most ${max} characters`)
  }
  return value
}

function list(value: unknown, field: string, max: number): any[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > max) {
    throw new FlowError(400, 'FLOW_REQUEST_INVALID', `${field} must be a list of at most ${max} items`)
  }
  return value
}

function object(value: unknown, field: string): Json {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new FlowError(400, 'FLOW_REQUEST_INVALID', `${field} must be an object`)
  }
  return value as Json
}

function fullId(value: unknown, field: string): string | undefined {
  const id = text(value, field, 500, false)
  if (!id) return undefined
  return id.startsWith('http://') || id.startsWith('https://') ? id : `${ID_PREFIX}${id}`
}

/** The Tapis username in a bearer token. Not verified here: the catalog checks the
 *  token itself and refuses a write whose owner is not the caller. */
export function usernameFromBearer(authorization: string | undefined): string | undefined {
  const token = (authorization || '').replace(/^Bearer\s+/i, '')
  const payload = token.split('.')[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    const username = claims['tapis/username']
    return typeof username === 'string' && username ? username : undefined
  } catch {
    return undefined
  }
}

export interface FlowRegistration {
  softwareId: string
  versionId: string
  configurationId: string
  inputIds: Record<string, string>
  check: Json
}

/**
 * Turn a registration request into what the adapter checks. Flow inputs are named
 * by a short key in the request; in the catalog and in the check they are dataset
 * specification ids.
 */
export function planRegistration(body: Json): FlowRegistration {
  const software = object(body.software, 'software')
  const version = object(body.version, 'version')
  const configuration = object(body.configuration, 'configuration')
  text(software.label, 'software.label', 300, !software.id)
  text(version.label, 'version.label', 300, !version.id)
  text(configuration.label, 'configuration.label', 300)

  const configurationId = fullId(configuration.id, 'configuration.id') ?? `${ID_PREFIX}${randomUUID()}`
  const inputs = list(body.inputs, 'inputs', MAX_ITEMS)
  const inputIds: Record<string, string> = {}
  inputs.forEach((input, index) => {
    const key = text(object(input, `inputs[${index}]`).key, `inputs[${index}].key`, 64)!
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || key in inputIds) {
      throw new FlowError(400, 'FLOW_REQUEST_INVALID', `inputs[${index}].key must be a unique plain name`)
    }
    text(input.label, `inputs[${index}].label`, 300)
    text(input.standard_variable, `inputs[${index}].standard_variable`)
    inputIds[key] = `${configurationId}_input_${index + 1}`
  })

  const steps = list(body.steps, 'steps', MAX_STEPS)
  if (steps.length === 0) throw new FlowError(400, 'FLOW_REQUEST_INVALID', 'steps: a flow needs at least one step')
  const checkedSteps = steps.map((step, index) => {
    const wires = list(object(step, `steps[${index}]`).wires, `steps[${index}].wires`, MAX_ITEMS).map((wire) => {
      const key = wire?.from?.flow_input
      if (key === undefined) return wire
      if (typeof key !== 'string' || !(key in inputIds)) {
        throw new FlowError(400, 'FLOW_REQUEST_INVALID', `steps[${index}]: no flow input is named ${String(key)}`)
      }
      return { ...wire, from: { flow_input: inputIds[key] } }
    })
    return {
      position: step.position,
      etl_process_id: step.etl_process_id ?? null,
      settings: object(step.settings, `steps[${index}].settings`),
      wires,
      pause_after: step.pause_after === true,
    }
  })

  return {
    softwareId: fullId(software.id, 'software.id') ?? `${ID_PREFIX}${randomUUID()}`,
    versionId: fullId(version.id, 'version.id') ?? `${ID_PREFIX}${randomUUID()}`,
    configurationId,
    inputIds,
    check: {
      inputs: inputs.map((input) => ({
        id: inputIds[input.key],
        contract: { standard_variable_uri: input.standard_variable, format: input.format ?? null },
      })),
      steps: checkedSteps,
      outputs: list(body.outputs, 'outputs', MAX_ITEMS).map((output) => {
        const { label, format, standard_variable, description, ...where } = object(output, 'outputs[]')
        return where
      }),
    },
  }
}

/**
 * The catalog rows for a flow that checked out: the configuration with its inputs,
 * outputs and settings, and the flow row with its steps.
 */
export function buildRows(body: Json, plan: FlowRegistration, pieces: Json, username: string) {
  const configuration = object(body.configuration, 'configuration')
  const { configurationId, inputIds } = plan

  const inputs = list(body.inputs, 'inputs', MAX_ITEMS).map((input, index) => ({
    is_optional: input.optional === true,
    input: {
      data: {
        id: inputIds[input.key],
        label: input.label,
        description: input.description ?? null,
        has_format: input.format ?? null,
        // Numbered from 1: the Ensemble Manager reads 0 as "no position".
        position: index + 1,
        presentations: {
          data: [{
            presentation: {
              data: {
                id: `${inputIds[input.key]}_variable`,
                label: input.label,
                has_standard_variable: input.standard_variable,
              },
            },
          }],
        },
      },
    },
  }))

  // Settings are shared by name across a flow's steps. Each becomes one parameter:
  // the flow's default where a step gives one, the piece's own otherwise.
  const settings = new Map<string, Json>()
  for (const step of plan.check.steps) {
    const piece = pieces[step.etl_process_id] ?? {}
    for (const name of (piece.settings ?? []) as string[]) {
      const details = (piece.setting_details ?? {})[name] ?? {}
      const current = settings.get(name) ?? { type: details.type ?? 'string', description: details.description ?? null }
      if (current.default === undefined && details.default !== undefined) current.default = details.default
      if (name in step.settings) current.default = step.settings[name]
      settings.set(name, current)
    }
  }
  const parameterIds: Record<string, string> = {}
  const parameters = [...settings.keys()].sort().map((name, index) => {
    const setting = settings.get(name)!
    parameterIds[name] = `${configurationId}_setting_${name}`
    return {
      parameter: {
        data: {
          id: parameterIds[name],
          label: name,
          description: setting.description,
          has_data_type: String(setting.type),
          has_default_value: setting.default === undefined || setting.default === null
            ? null
            : typeof setting.default === 'string' ? setting.default : JSON.stringify(setting.default),
          position: index + 1,
        },
      },
    }
  })

  const outputsJson: Json[] = []
  const outputs: Json[] = []
  list(body.outputs, 'outputs', MAX_ITEMS).forEach((output, index) => {
    const { label, format, standard_variable, description, ...where } = object(output, `outputs[${index}]`)
    if (!('output' in where)) {
      outputsJson.push(where) // a value or a published record: no dataset to describe
      return
    }
    const id = `${configurationId}_output_${outputs.length + 1}`
    const contract = ((pieces[plan.check.steps.find((s: Json) => s.position === where.step)?.etl_process_id] ?? {})
      .output_contracts ?? {})[String(where.output)] ?? {}
    const variable = standard_variable ?? contract.standard_variable_uri
    outputs.push({
      output: {
        data: {
          id,
          label: text(label, `outputs[${index}].label`, 300),
          description: description ?? null,
          has_format: format ?? contract.format ?? null,
          position: outputs.length + 1,
          ...(variable
            ? { presentations: { data: [{ presentation: { data: { id: `${id}_variable`, label, has_standard_variable: variable } } }] } }
            : {}),
        },
      },
    })
    outputsJson.push({ ...where, output_id: id })
  })

  const bindings: Json = {}
  const { collections, ...roles } = object(body.thread_bindings, 'thread_bindings')
  for (const [role, target] of Object.entries(roles)) {
    const to = object(target, `thread_bindings.${role}`)
    if (typeof to.input === 'string' && to.input in inputIds) bindings[role] = { input: inputIds[to.input] }
    else if (typeof to.setting === 'string' && to.setting in parameterIds) bindings[role] = { parameter: parameterIds[to.setting] }
    else {
      throw new FlowError(400, 'FLOW_REQUEST_INVALID',
        `thread_bindings.${role} must name a flow input by key or a setting of one of the pieces`)
    }
  }

  // Inputs that take a collection: every resource bound to one is a single input
  // of many files, so a thread makes one run instead of one per resource.
  if (collections !== undefined) {
    const keys = list(collections, 'thread_bindings.collections', MAX_ITEMS)
    const ids = keys.map((key) => {
      if (typeof key !== 'string' || !(key in inputIds)) {
        throw new FlowError(400, 'FLOW_REQUEST_INVALID',
          `thread_bindings.collections must name flow inputs by key: ${String(key)} is not one`)
      }
      return inputIds[key]
    })
    if (new Set(ids).size !== ids.length) {
      throw new FlowError(400, 'FLOW_REQUEST_INVALID', 'thread_bindings.collections names an input more than once')
    }
    bindings.collections = ids
  }

  return {
    configuration: {
      id: configurationId,
      label: configuration.label,
      description: configuration.description ?? null,
      keywords: configuration.keywords ?? null,
      usage_notes: configuration.usage_notes ?? null,
      owner_username: username,
      inputs: { data: inputs },
      outputs: { data: outputs },
      parameters: { data: parameters },
    },
    flow: {
      configuration_id: configurationId,
      outputs_json: outputsJson,
      thread_bindings_json: bindings,
      steps: {
        data: plan.check.steps.map((step: Json) => ({
          position: step.position,
          etl_process_id: step.etl_process_id,
          settings_json: step.settings,
          wires_json: step.wires,
          pause_after: step.pause_after,
        })),
      },
    },
    parameterIds,
  }
}

async function checkWithAdapter(check: Json, authorization: string): Promise<Json> {
  const base = process.env.SVO_ADAPTER_API_URL
  if (!base) {
    throw new FlowError(503, 'FLOWS_NOT_CONFIGURED', 'this deployment has no SVO adapter to check a flow with')
  }
  let response: Response
  try {
    response = await globalThis.fetch(`${base.replace(/\/$/, '')}/flows/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify(check),
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new FlowError(502, 'FLOW_CHECK_UNAVAILABLE', 'the SVO adapter could not be reached to check the flow')
  }
  if (response.status === 401) throw new FlowError(401, 'TAPIS_AUTH_REQUIRED', 'a valid Tapis bearer token is required')
  if (!response.ok) throw new FlowError(502, 'FLOW_CHECK_UNAVAILABLE', `the SVO adapter answered ${response.status}`)
  return (await response.json()) as Json
}

const EXISTING = gql`
  query FlowParents($software: String!, $version: String!) {
    modelcatalog_software_by_pk(id: $software) { id }
    modelcatalog_software_version_by_pk(id: $version) { id software_id }
  }
`

/** The one mutation that writes a flow. Which parent rows it creates depends on
 *  which already exist; the configuration and the flow are always new. */
export function registrationMutation(softwareExists: boolean, versionExists: boolean): string {
  const parent = versionExists
    ? 'insert_modelcatalog_configuration_one(object: $parent) { id }'
    : softwareExists
      ? 'insert_modelcatalog_software_version_one(object: $parent) { id }'
      : 'insert_modelcatalog_software_one(object: $parent) { id }'
  const type = versionExists
    ? 'modelcatalog_configuration_insert_input'
    : softwareExists ? 'modelcatalog_software_version_insert_input' : 'modelcatalog_software_insert_input'
  // Two fields of one mutation run in one transaction: if the flow is refused,
  // the configuration and everything under it is rolled back too.
  return `
    mutation RegisterFlow($parent: ${type}!, $flow: modelcatalog_configuration_flow_insert_input!) {
      ${parent}
      insert_modelcatalog_configuration_flow_one(object: $flow) { configuration_id }
    }
  `
}

export async function custom_flows_post(req: any, reply: any): Promise<void> {
  try {
    const authorization = req.headers?.authorization as string | undefined
    const username = usernameFromBearer(authorization)
    if (!authorization || !username) {
      throw new FlowError(401, 'TAPIS_AUTH_REQUIRED', 'a valid Tapis bearer token is required')
    }
    const body = object(req.body, 'body')
    const plan = planRegistration(body)

    const checked = await checkWithAdapter(plan.check, authorization)
    if (checked.ok !== true) {
      throw new FlowError(422, 'FLOW_DOES_NOT_CHECK_OUT', 'the flow does not fit its pieces', {
        problems: checked.problems ?? [],
      })
    }
    const rows = buildRows(body, plan, checked.pieces ?? {}, username)

    const existing = (await readClient.query({
      query: EXISTING,
      variables: { software: plan.softwareId, version: plan.versionId },
      fetchPolicy: 'no-cache',
    })).data as Json
    const softwareExists = Boolean(existing.modelcatalog_software_by_pk)
    const version = existing.modelcatalog_software_version_by_pk
    if (version && version.software_id !== plan.softwareId) {
      throw new FlowError(400, 'FLOW_REQUEST_INVALID', 'version.id belongs to a different software')
    }

    const software = object(body.software, 'software')
    const versionBody = object(body.version, 'version')
    const versionRow = {
      id: plan.versionId,
      label: versionBody.label,
      version_id: versionBody.version_id ?? null,
      description: versionBody.description ?? null,
      has_source_code: versionBody.source_code ?? null,
    }
    const parent = version
      ? { ...rows.configuration, software_version_id: plan.versionId }
      : softwareExists
        ? { ...versionRow, software_id: plan.softwareId, configurations: { data: [rows.configuration] } }
        : {
            id: plan.softwareId,
            label: software.label,
            description: software.description ?? null,
            keywords: software.keywords ?? null,
            license: software.license ?? null,
            website: software.website ?? null,
            has_documentation: software.documentation ?? null,
            has_purpose: software.purpose ?? null,
            type: MODEL_TYPE,
            versions: { data: [{ ...versionRow, configurations: { data: [rows.configuration] } }] },
          }

    await getWriteClient(authorization).mutate({
      mutation: gql`${registrationMutation(softwareExists, Boolean(version))}`,
      variables: { parent, flow: rows.flow },
    })
    reply.code(201).send({
      software_id: plan.softwareId,
      version_id: plan.versionId,
      configuration_id: plan.configurationId,
      inputs: plan.inputIds,
      settings: rows.parameterIds,
    })
  } catch (error: any) {
    if (error instanceof FlowError) {
      reply.code(error.status).send({ error: error.message, code: error.code, ...error.details })
      return
    }
    const message = String(error?.message ?? '')
    req.log?.error({ err: error }, 'Flow registration failed')
    if (/check constraint of an insert\/update permission has failed|a step can only be added/i.test(message)) {
      reply.code(403).send({
        error: 'Not permitted: the flow names a piece you cannot see, or a model or version you may not add to',
        code: 'FLOW_NOT_PERMITTED',
      })
      return
    }
    if (/uniqueness violation|duplicate key/i.test(message)) {
      reply.code(409).send({ error: 'A configuration, input or setting with that id already exists', code: 'FLOW_EXISTS' })
      return
    }
    if (/foreign key violation/i.test(message)) {
      reply.code(400).send({
        error: 'The flow names a standard variable or a piece that is not in the catalog',
        code: 'FLOW_REQUEST_INVALID',
        details: message,
      })
      return
    }
    reply.code(502).send({ error: 'The catalog refused the flow', code: 'FLOW_WRITE_FAILED', details: message })
  }
}
