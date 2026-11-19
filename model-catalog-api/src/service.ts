/**
 * Generic CRUD service for all 46 API resource types.
 *
 * fastify-openapi-glue calls service[operationId](req, reply) for each request.
 * A JavaScript Proxy intercepts these calls, parses the operationId to extract
 * the resource name and operation, then dispatches to a generic handler.
 *
 * This replaces 230+ individual handler files with a single class.
 */

import { getResourceConfig } from './mappers/resource-registry.js'
import { transformRow, transformList } from './mappers/response.js'
import { buildTree } from './mappers/nested-tree.js'
import { compilePost, compilePut } from './mappers/mutation-compiler.js'
import { readClient, getWriteClient, gql } from './hasura/client.js'

const NOT_PERMITTED =
  'Not permitted: only the owner or an admin can change this resource, and an owner cannot ' +
  "delete a resource that holds other users' resources"
import { getFieldSelection } from './hasura/field-maps.js'
import { customHandlers } from './custom-handlers.js'

const ID_PREFIX = 'https://w3id.org/okn/i/mint/'

/** A full resource URI must start with https:// or http://. */
function isFullUri(id: string): boolean {
  return id.startsWith('https://') || id.startsWith('http://')
}

/**
 * Validate that every body-supplied relationship item ID is a full URI.
 * Returns the first offending field/value if any are bare shortnames.
 * Empty strings, missing IDs, and non-string IDs are skipped (handled
 * elsewhere — e.g. junction inserts auto-generate URIs for new rows).
 */
function findBadBodyRelationshipId(
  body: Record<string, unknown>,
  resourceConfig: { relationships: Record<string, unknown> },
): { field: string; got: string } | null {
  for (const apiFieldName of Object.keys(resourceConfig.relationships)) {
    const rawValue = body[apiFieldName]
    if (rawValue === undefined) continue
    const items = Array.isArray(rawValue) ? (rawValue as unknown[]) : []
    for (const item of items) {
      const rawId =
        typeof item === 'string'
          ? item
          : ((item as Record<string, unknown>) || {})['id']
      if (typeof rawId === 'string' && rawId !== '' && !isFullUri(rawId)) {
        return { field: apiFieldName, got: rawId }
      }
    }
  }
  return null
}


/**
 * Escape Postgres LIKE/ILIKE wildcards in user input so that a literal `%` or
 * `_` in a search term is matched as itself. Standard variable labels are full
 * of underscores (`land_surface_wind__speed`), so leaving `_` unescaped would
 * make every underscore a single-character wildcard.
 */
export function escapeLikeWildcards(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * Interpret a query-string flag. Fastify coerces a declared boolean param, but
 * be defensive: an undeclared or hand-built request can still deliver a raw
 * string, and `Boolean("false")` is `true`.
 */
export function isTruthyFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    return v === 'true' || v === '1' || v === 'yes'
  }
  return false
}

/**
 * Shape a transformed row list into the response CKAN's autocomplete widget
 * expects: `{ ResultSet: { Result: [{ Name: "..." }] } }`.
 *
 * CKAN's client-side `parseCompletions` reads `item.name || item.Name ||
 * item.Format`; our normal rows expose the label under `label` as an array, so
 * without this projection every suggestion collapses to an empty string.
 */
export function toCkanResultSet(
  rows: Record<string, unknown>[],
): { ResultSet: { Result: { Name: string }[] } } {
  const results = rows
    .map((row) => {
      const label = row['label']
      if (Array.isArray(label)) return label.length > 0 ? String(label[0]) : ''
      return label == null ? '' : String(label)
    })
    .filter((name) => name !== '')
    .map((name) => ({ Name: name }))

  return { ResultSet: { Result: results } }
}

/**
 * Build where clause for software subtype filtering.
 * Software subtypes (models, emulators, etc.) share the modelcatalog_software table.
 * The type is stored in a `type` column in Hasura.
 */
export function getSoftwareTypeFilter(resource: string): string | string[] | null {
  const SUBTYPE_MAP: Record<string, string | string[]> = {
    models: [
      'https://w3id.org/okn/o/sdm#Model',
      'https://w3id.org/okn/o/sdm#EmpiricalModel',
      'https://w3id.org/okn/o/sdm#CoupledModel',
      'https://w3id.org/okn/o/sdm#Emulator',
      'https://w3id.org/okn/o/sdm#HybridModel',
      'https://w3id.org/okn/o/sdm#Theory-GuidedModel',
    ],
    empiricalmodels: 'https://w3id.org/okn/o/sdm#EmpiricalModel',
    hybridmodels: 'https://w3id.org/okn/o/sdm#HybridModel',
    emulators: 'https://w3id.org/okn/o/sdm#Emulator',
    'theory-guidedmodels': 'https://w3id.org/okn/o/sdm#Theory-GuidedModel',
    theory_guidedmodels: 'https://w3id.org/okn/o/sdm#Theory-GuidedModel',
    coupledmodels: 'https://w3id.org/okn/o/sdm#CoupledModel',
  }
  return SUBTYPE_MAP[resource] ?? null
}

class CatalogServiceImpl {
  /**
   * Generic list handler: GET /resources?username=X&label=Y&page=N&per_page=M
   */
  async list(resource: string, req: any, reply: any) {
    const resourceConfig = getResourceConfig(resource)
    if (!resourceConfig) {
      reply.code(404).send({ error: `Unknown resource type: ${resource}` })
      return
    }
    if (!resourceConfig.hasuraTable) {
      // No backing table -- return empty list (matches v1.8.0 behavior for empty named graphs)
      const emptyCkan = isTruthyFlag((req.query || {}).enable_ckan)
      reply.code(200).send(emptyCkan ? toCkanResultSet([]) : [])
      return
    }

    const {
      username,
      label,
      label_contains,
      enable_ckan,
      page = 1,
      per_page = 25,
    } = req.query || {}
    const limit = parseInt(String(per_page), 10) || 25
    const offset = (parseInt(String(page), 10) - 1) * limit || 0
    const ckanOutput = isTruthyFlag(enable_ckan)

    // Build dynamic where clause
    const whereConditions: string[] = []
    const variables: Record<string, unknown> = { limit, offset }

    // `label` stays an exact match (unchanged, existing callers depend on it).
    // `label_contains` is the substring form autocomplete widgets need.
    if (label) {
      whereConditions.push('label: { _eq: $label }')
      variables['label'] = label
    }

    if (label_contains) {
      whereConditions.push('label: { _ilike: $labelContains }')
      variables['labelContains'] = `%${escapeLikeWildcards(String(label_contains))}%`
    }

    // Software subtype filter
    const typeFilter = getSoftwareTypeFilter(resource)
    if (typeFilter) {
      if (Array.isArray(typeFilter)) {
        whereConditions.push('type: { _in: $typeFilter }')
      } else {
        whereConditions.push('type: { _eq: $typeFilter }')
      }
      variables['typeFilter'] = typeFilter
    }

    const whereClause = whereConditions.length > 0
      ? `where: { ${whereConditions.join(', ')} }`
      : ''

    const fields = getFieldSelection(resourceConfig.hasuraTable!)

    // Build variable declarations for query signature
    let varDecls = '$limit: Int!, $offset: Int!'
    if (label) varDecls += ', $label: String!'
    if (label_contains) varDecls += ', $labelContains: String!'
    if (typeFilter) {
      varDecls += Array.isArray(typeFilter) ? ', $typeFilter: [String!]!' : ', $typeFilter: String!'
    }

    const queryStr = `
      query ListQuery(${varDecls}) {
        modelcatalog_${resourceConfig.hasuraTable.replace('modelcatalog_', '')}(
          ${whereClause}
          limit: $limit
          offset: $offset
        ) {
          ${fields}
        }
      }
    `

    try {
      const result = await readClient.query({
        query: gql`${queryStr}`,
        variables,
      })
      const data = result.data as Record<string, unknown>
      const dataKey = `modelcatalog_${resourceConfig.hasuraTable.replace('modelcatalog_', '')}`
      const rows: Record<string, unknown>[] = (data[dataKey] as Record<string, unknown>[]) || []
      const transformed = transformList(rows, resourceConfig)
      reply
        .code(200)
        .send(ckanOutput ? toCkanResultSet(transformed) : transformed)
    } catch (err: any) {
      req.log.error({ err }, 'GraphQL list query failed')
      reply.code(500).send({ error: 'Internal server error', details: err?.message })
    }
  }

  /**
   * Generic get-by-id handler: GET /resources/{id}
   */
  async getById(resource: string, req: any, reply: any) {
    const resourceConfig = getResourceConfig(resource)
    if (!resourceConfig) {
      reply.code(404).send({ error: `Unknown resource type: ${resource}` })
      return
    }
    if (!resourceConfig.hasuraTable) {
      // No backing table -- resource cannot exist
      reply.code(404).send({ error: 'Not found' })
      return
    }

    const id = decodeURIComponent(req.params.id)
    const fullId = isFullUri(id) ? id : `${resourceConfig.idPrefix}${id}`
    const fields = getFieldSelection(resourceConfig.hasuraTable!, 'byId')

    const tableSuffix = resourceConfig.hasuraTable.replace('modelcatalog_', '')
    const queryStr = `
      query GetByIdQuery($id: String!) {
        modelcatalog_${tableSuffix}_by_pk(id: $id) {
          ${fields}
        }
      }
    `

    try {
      const result = await readClient.query({
        query: gql`${queryStr}`,
        variables: { id: fullId },
      })
      const data = result.data as Record<string, unknown>
      const dataKey = `modelcatalog_${tableSuffix}_by_pk`
      const row = data[dataKey] as Record<string, unknown> | null
      if (!row) {
        reply.code(404).send({ error: 'Not found' })
        return
      }
      reply.code(200).send(transformRow(row, resourceConfig))
    } catch (err: any) {
      req.log.error({ err }, 'GraphQL getById query failed')
      reply.code(500).send({ error: 'Internal server error', details: err?.message })
    }
  }

  /**
   * Generic create handler: POST /resources
   */
  async create(resource: string, req: any, reply: any) {
    const resourceConfig = getResourceConfig(resource)
    if (!resourceConfig) {
      reply.code(404).send({ error: `Unknown resource type: ${resource}` })
      return
    }
    if (!resourceConfig.hasuraTable) {
      reply.code(501).send({ error: `Resource type '${resource}' not yet implemented` })
      return
    }

    const authHeader = req.headers?.authorization
    if (!authHeader) {
      reply.code(401).send({ error: 'Authorization header required' })
      return
    }

    const body = req.body || {}

    let tree
    try {
      tree = buildTree(body as Record<string, unknown>, resourceConfig)
    } catch (err: any) {
      if (err && err.name === 'ValidationError') {
        req.log.warn(
          { verb: 'POST', resource, error_code: err.code, path: err.path },
          'nested write validation failed',
        )
        reply.code(err.httpStatus).send({ error: err.message, code: err.code, path: err.path })
        return
      }
      throw err
    }

    // Inject type column for software resources only (existing behavior)
    if (resourceConfig.hasuraTable === 'modelcatalog_software') {
      tree.columns['type'] = resourceConfig.typeUri
    }

    const { mutation, variables } = compilePost(tree)

    try {
      const writeClient = getWriteClient(authHeader)
      const result = await writeClient.mutate({
        mutation: gql`${mutation}`,
        variables,
      })
      const data = result.data as Record<string, unknown> | null
      const tableSuffix = resourceConfig.hasuraTable.replace('modelcatalog_', '')
      const dataKey = `insert_modelcatalog_${tableSuffix}_one`
      const created = data?.[dataKey] as { id?: string } | undefined
      reply.code(201).send({ id: created?.id ?? tree.id })
    } catch (err: any) {
      req.log.error({ err }, 'GraphQL create mutation failed')
      const msg = err?.message || ''
      if (msg.includes('Foreign key violation')) {
        reply.code(400).send({
          error: 'FK violation — id may target wrong resource type',
          details: msg,
        })
        return
      }
      if (msg.includes('uniqueness violation') || msg.includes('constraint')) {
        reply.code(400).send({ error: 'Constraint violation', details: msg })
        return
      }
      reply.code(500).send({ error: 'Internal server error', details: err?.message })
    }
  }

  /**
   * Generic update handler: PUT /resources/{id}
   */
  async update(resource: string, req: any, reply: any) {
    const resourceConfig = getResourceConfig(resource)
    if (!resourceConfig) {
      reply.code(404).send({ error: `Unknown resource type: ${resource}` })
      return
    }
    if (!resourceConfig.hasuraTable) {
      reply.code(501).send({ error: `Resource type '${resource}' not yet implemented` })
      return
    }

    const authHeader = req.headers?.authorization
    if (!authHeader) {
      reply.code(401).send({ error: 'Authorization header required' })
      return
    }

    const id = decodeURIComponent(req.params.id)
    const fullId = isFullUri(id) ? id : `${resourceConfig.idPrefix}${id}`
    const body = { ...(req.body || {}), id: fullId }

    let tree
    try {
      tree = buildTree(body as Record<string, unknown>, resourceConfig)
    } catch (err: any) {
      if (err && err.name === 'ValidationError') {
        req.log.warn(
          { verb: 'PUT', resource, root_id: fullId, error_code: err.code, path: err.path },
          'nested write validation failed',
        )
        reply.code(err.httpStatus).send({ error: err.message, code: err.code, path: err.path })
        return
      }
      throw err
    }

    const { mutation, variables } = compilePut(tree)

    try {
      const writeClient = getWriteClient(authHeader)
      const result = await writeClient.mutate({
        mutation: gql`${mutation}`,
        variables,
      })
      const updateKey = `update_${resourceConfig.hasuraTable}_by_pk`
      if (await this.replyIfNoRowWritten(result?.data, updateKey, resourceConfig.hasuraTable, fullId, reply)) {
        return
      }
      reply.code(200).send({ id: fullId })
    } catch (err: any) {
      req.log.error({ err }, 'GraphQL update mutation failed')
      const msg = err?.message || ''
      if (msg.includes('check constraint of an insert/update permission has failed')) {
        // A nested link or child write was refused. Hasura rolled the whole mutation back.
        reply.code(403).send({ error: NOT_PERMITTED })
        return
      }
      if (msg.includes('Foreign key violation')) {
        reply.code(400).send({
          error: 'FK violation — id may target wrong resource type',
          details: msg,
        })
        return
      }
      if (msg.includes('uniqueness violation') || msg.includes('constraint')) {
        reply.code(400).send({ error: 'Constraint violation', details: msg })
        return
      }
      reply.code(500).send({ error: 'Internal server error', details: err?.message })
    }
  }

  /**
   * Hasura does not raise an error when a permission filter excludes the row of an
   * update or delete by primary key: it returns null for that field. Report that as
   * 403, or 404 when the row does not exist, instead of as success.
   *
   * Returns true when it has sent the reply.
   */
  private async replyIfNoRowWritten(
    data: unknown,
    mutationKey: string,
    hasuraTable: string,
    id: string,
    reply: any,
  ): Promise<boolean> {
    const fields = (data ?? {}) as Record<string, unknown>
    if (!(mutationKey in fields) || fields[mutationKey] !== null) {
      return false
    }
    const existsKey = `${hasuraTable}_by_pk`
    const exists = await readClient.query({
      query: gql`query RowExists($id: String!) { ${existsKey}(id: $id) { id } }`,
      variables: { id },
      fetchPolicy: 'no-cache',
    })
    if ((exists.data as Record<string, unknown>)?.[existsKey]) {
      reply.code(403).send({ error: NOT_PERMITTED })
    } else {
      reply.code(404).send({ error: 'Not found' })
    }
    return true
  }

  /**
   * Generic delete handler: DELETE /resources/{id}
   */
  async deleteResource(resource: string, req: any, reply: any) {
    const resourceConfig = getResourceConfig(resource)
    if (!resourceConfig) {
      reply.code(404).send({ error: `Unknown resource type: ${resource}` })
      return
    }
    if (!resourceConfig.hasuraTable) {
      reply.code(501).send({ error: `Resource type '${resource}' not yet implemented` })
      return
    }

    const id = decodeURIComponent(req.params.id)
    const fullId = isFullUri(id) ? id : `${resourceConfig.idPrefix}${id}`
    const tableSuffix = resourceConfig.hasuraTable.replace('modelcatalog_', '')
    const mutationStr = `
      mutation DeleteMutation($id: String!) {
        delete_modelcatalog_${tableSuffix}_by_pk(id: $id) {
          id
        }
      }
    `

    const authHeader = req.headers?.authorization
    if (!authHeader) {
      reply.code(401).send({ error: 'Authorization header required' })
      return
    }

    try {
      const writeClient = getWriteClient(authHeader)
      const result = await writeClient.mutate({
        mutation: gql`${mutationStr}`,
        variables: { id: fullId },
      })
      const deleteKey = `delete_${resourceConfig.hasuraTable}_by_pk`
      if (await this.replyIfNoRowWritten(result?.data, deleteKey, resourceConfig.hasuraTable, fullId, reply)) {
        return
      }
      reply.code(202).send({ deleted: fullId })
    } catch (err: any) {
      req.log.error({ err }, 'GraphQL delete mutation failed')
      reply.code(500).send({ error: 'Internal server error', details: err?.message })
    }
  }

  /**
   * Dispatch custom endpoints to the customHandlers registry.
   * Custom operationIds and user_login_post are handled here.
   */
  async handleCustom(operationId: string, req: any, reply: any) {
    const handler = customHandlers[operationId]
    if (handler) {
      return handler(req, reply)
    }
    req.log.warn({ operationId }, 'Custom endpoint not implemented')
    reply.code(501).send({ error: `Custom endpoint '${operationId}' not implemented` })
  }

  /**
   * user_login_post is also dispatched through customHandlers.
   */
  async userLogin(req: any, reply: any) {
    const handler = customHandlers['user_login_post']
    if (handler) {
      return handler(req, reply)
    }
    reply.code(501).send({ error: 'Login endpoint not implemented' })
  }
}

/**
 * CatalogService: a Proxy around CatalogServiceImpl that intercepts operationId method calls
 * and dispatches them to the appropriate generic CRUD handler.
 *
 * OperationId patterns (from openapi.yaml):
 * - softwares_get -> list('softwares', ...)
 * - softwares_id_get -> getById('softwares', ...)
 * - softwares_post -> create('softwares', ...)
 * - softwares_id_put -> update('softwares', ...)
 * - softwares_id_delete -> deleteResource('softwares', ...)
 * - custom_* -> handleCustom(operationId, ...)
 * - user_login_post -> userLogin(...)
 */
/**
 * Returns true if the given operationId is handled by the CatalogService proxy.
 * Used by both the `has` trap (for `in` operator) and the `get` trap.
 */
function isHandledOperationId(prop: string): boolean {
  if (typeof prop !== 'string') return false
  if (prop.startsWith('custom_')) return true
  if (prop === 'user_login_post') return true
  if (/^(.+?)_(id_)?(get|post|put|delete)$/.test(prop)) return true
  return false
}

export const CatalogService = new Proxy(new CatalogServiceImpl(), {
  /**
   * The `has` trap is called by the `in` operator.
   * fastify-openapi-glue checks `operationId in serviceHandlers` to determine
   * if a handler exists. Without this trap, all dynamic operationIds return false
   * and the glue falls back to "Operation not implemented".
   */
  has(target, prop: string) {
    if (isHandledOperationId(prop)) return true
    return prop in target
  },

  get(target, prop: string) {
    // Pass through non-string or symbol properties
    if (typeof prop !== 'string') {
      return (target as any)[prop]
    }

    // Custom endpoints: custom_model_index_get, custom_models_variable_get, etc.
    if (prop.startsWith('custom_')) {
      return (req: any, reply: any) => target.handleCustom(prop, req, reply)
    }

    // User login: user_login_post
    if (prop === 'user_login_post') {
      return (req: any, reply: any) => target.userLogin(req, reply)
    }

    // Standard CRUD operationId pattern: {resource}_(id_)?(get|post|put|delete)
    // The regex uses non-greedy .+? so "theory_guidedmodels_id_get" correctly
    // captures resource="theory_guidedmodels", hasId="id_", method="get"
    const match = prop.match(/^(.+?)_(id_)?(get|post|put|delete)$/)
    if (match) {
      const [, resource, hasId, method] = match
      if (method === 'get' && hasId) return (req: any, reply: any) => target.getById(resource, req, reply)
      if (method === 'get') return (req: any, reply: any) => target.list(resource, req, reply)
      if (method === 'post') return (req: any, reply: any) => target.create(resource, req, reply)
      if (method === 'put') return (req: any, reply: any) => target.update(resource, req, reply)
      if (method === 'delete') return (req: any, reply: any) => target.deleteResource(resource, req, reply)
    }

    // Fall through to native property access (for 'then', Symbol.toStringTag, etc.)
    return (target as any)[prop]
  },
})
