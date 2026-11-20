import asyncio
import logging
import os
from collections import defaultdict
from functools import lru_cache
from typing import Any, Literal

import psycopg
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

app = FastAPI(title="MINT Semantic Search")


def cors_origins(value: str | None = None) -> list[str]:
    """Return the exact browser origins allowed to call the search API."""
    configured = value if value is not None else os.getenv("SVO_CORS_ORIGINS", "http://localhost:3000")
    return [origin.strip() for origin in configured.split(",") if origin.strip()]


app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins(),
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://mint:mint@postgres:5432/mint")
MODEL_NAME = os.getenv("SVO_EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
EMBEDDING_REFRESH_SECONDS = max(float(os.getenv("SVO_EMBEDDING_REFRESH_SECONDS", "60")), 5.0)
MIN_RECOMMENDATION_CONTEXT_LENGTH = max(
    int(os.getenv("SVO_MIN_RECOMMENDATION_CONTEXT_LENGTH", "1")), 1
)
log = logging.getLogger(__name__)
refresh_task: asyncio.Task | None = None
refresh_event: asyncio.Event | None = None


@lru_cache(maxsize=1)
def model():
    return SentenceTransformer(MODEL_NAME)


CATALOG_VARIABLE_CONTEXT_SQL = """
    SELECT sv.id,
           sv.label,
           sv.description,
           COALESCE(context.model_context, '') AS model_context,
           sv.semantic_text,
           sv.embedding IS NOT NULL AS has_embedding
    FROM modelcatalog_standard_variable sv
    LEFT JOIN LATERAL (
      SELECT string_agg(
               DISTINCT concat_ws(' ',
                 c.label,
                 c.description,
                 c.keywords,
                 c.usage_notes,
                 s.label,
                 s.description,
                 s.keywords,
                 v.label,
                 v.description,
                 v.keywords,
                 v.short_description,
                 v.theoretical_basis,
                 u.label,
                 category_context.labels,
                 region_context.labels,
                 links.role
               ),
               ' '
             ) AS model_context
      FROM (
        SELECT configuration_id, input_id AS dataset_specification_id, 'input' AS role
        FROM modelcatalog_configuration_input
        UNION ALL
        SELECT configuration_id, output_id AS dataset_specification_id, 'output' AS role
        FROM modelcatalog_configuration_output
      ) links
      JOIN modelcatalog_configuration c ON c.id = links.configuration_id
      LEFT JOIN modelcatalog_software_version v ON v.id = c.software_version_id
      LEFT JOIN modelcatalog_software s ON s.id = v.software_id
      JOIN modelcatalog_dataset_specification_presentation dsp
        ON dsp.dataset_specification_id = links.dataset_specification_id
      JOIN modelcatalog_variable_presentation vp ON vp.id = dsp.presentation_id
      LEFT JOIN modelcatalog_unit u ON u.id = vp.uses_unit
      LEFT JOIN LATERAL (
        SELECT string_agg(DISTINCT category.label, ' ') AS labels
        FROM modelcatalog_configuration_category cc
        JOIN modelcatalog_model_category category ON category.id = cc.category_id
        WHERE cc.configuration_id = c.id
      ) category_context ON TRUE
      LEFT JOIN LATERAL (
        SELECT string_agg(DISTINCT region.label, ' ') AS labels
        FROM modelcatalog_configuration_region cr
        JOIN modelcatalog_region region ON region.id = cr.region_id
        WHERE cr.configuration_id = c.id
      ) region_context ON TRUE
      WHERE vp.has_standard_variable = sv.id
    ) context ON TRUE
"""


MODEL_CONFIGURATION_CONTEXT_SQL = """
    SELECT c.id,
           c.label,
           c.description,
           COALESCE(context.searchable_context, '') AS searchable_context,
           c.semantic_text,
           c.embedding IS NOT NULL AS has_embedding
    FROM modelcatalog_configuration c
    LEFT JOIN modelcatalog_software_version v ON v.id = c.software_version_id
    LEFT JOIN modelcatalog_software s ON s.id = v.software_id
    LEFT JOIN LATERAL (
      SELECT string_agg(
               DISTINCT concat_ws(' ',
                 links.role,
                 sv.label,
                 sv.description,
                 unit.label
               ),
               ' '
             ) AS variable_context
      FROM (
        SELECT configuration_id, input_id AS dataset_specification_id, 'input' AS role
        FROM modelcatalog_configuration_input
        UNION ALL
        SELECT configuration_id, output_id AS dataset_specification_id, 'output' AS role
        FROM modelcatalog_configuration_output
      ) links
      JOIN modelcatalog_dataset_specification_presentation dsp
        ON dsp.dataset_specification_id = links.dataset_specification_id
      JOIN modelcatalog_variable_presentation vp ON vp.id = dsp.presentation_id
      JOIN modelcatalog_standard_variable sv ON sv.id = vp.has_standard_variable
      LEFT JOIN modelcatalog_unit unit ON unit.id = vp.uses_unit
      WHERE links.configuration_id = c.id
    ) variable_context ON TRUE
    LEFT JOIN LATERAL (
      SELECT string_agg(DISTINCT category.label, ' ') AS labels
      FROM modelcatalog_configuration_category cc
      JOIN modelcatalog_model_category category ON category.id = cc.category_id
      WHERE cc.configuration_id = c.id
    ) category_context ON TRUE
    LEFT JOIN LATERAL (
      SELECT string_agg(DISTINCT region.label, ' ') AS labels
      FROM modelcatalog_configuration_region cr
      JOIN modelcatalog_region region ON region.id = cr.region_id
      WHERE cr.configuration_id = c.id
    ) region_context ON TRUE
    CROSS JOIN LATERAL (
      SELECT concat_ws(' ',
        c.label,
        c.description,
        c.keywords,
        c.usage_notes,
        s.label,
        s.description,
        s.keywords,
        v.label,
        v.description,
        v.keywords,
        v.short_description,
        v.theoretical_basis,
        c.has_region,
        variable_context.variable_context,
        category_context.labels,
        region_context.labels
      ) AS searchable_context
    ) context
"""


ETL_PIECE_CONTEXT_SQL = """
    SELECT p.id,
           p.label,
           p.description,
           concat_ws(' ',
             'Inputs:', COALESCE(io.inputs, ''),
             'Outputs:', COALESCE(io.outputs, '')
           ) AS io_context,
           p.semantic_text,
           p.embedding IS NOT NULL AS has_embedding
    FROM modelcatalog_etl_process p
    LEFT JOIN LATERAL (
      SELECT string_agg(concat_ws(' ', sv.label, sv.description), '; ' ORDER BY c.position)
               FILTER (WHERE c.role = 'input') AS inputs,
             string_agg(concat_ws(' ', sv.label, sv.description), '; ' ORDER BY c.position)
               FILTER (WHERE c.role = 'output') AS outputs
      FROM modelcatalog_etl_process_contract c
      JOIN modelcatalog_standard_variable sv ON sv.id = c.standard_variable_uri
      WHERE c.etl_process_id = p.id
    ) io ON TRUE
"""


def catalog_variable_rows(conn):
    return conn.execute(CATALOG_VARIABLE_CONTEXT_SQL).fetchall()


def catalog_configuration_rows(conn):
    return conn.execute(MODEL_CONFIGURATION_CONTEXT_SQL).fetchall()


def catalog_etl_piece_rows(conn):
    return conn.execute(ETL_PIECE_CONTEXT_SQL).fetchall()


def etl_piece_embedding_text(label, description, io_context):
    return f"{label or ''}. {description or ''}. Data contract: {io_context or ''}"


def embedding_text(label, description, model_context):
    return f"{label or ''}. {description or ''}. Models and workflows: {model_context or ''}"


def configuration_embedding_text(label, description, searchable_context):
    return f"{label or ''}. {description or ''}. Catalog context: {searchable_context or ''}"


EMBEDDING_UPDATE_SQL = {
    "svo": "UPDATE modelcatalog_standard_variable SET semantic_text = %s, embedding = %s::vector WHERE id = %s",
    "model_configuration": "UPDATE modelcatalog_configuration SET semantic_text = %s, embedding = %s::vector WHERE id = %s",
    "etl_piece": "UPDATE modelcatalog_etl_process SET semantic_text = %s, embedding = %s::vector WHERE id = %s",
}


def pending_rows(rows, text_builder, force: bool):
    """Rows whose stored semantic_text is stale or that have no embedding yet."""
    pending = []
    for row in rows:
        text = text_builder(row[1], row[2], row[3])
        if force or row[4] != text or not row[5]:
            pending.append((row, text))
    return pending


def index_catalog_embeddings(force: bool = False) -> int:
    """Index new/changed SVO, configuration and ETL piece context."""
    with psycopg.connect(DATABASE_URL) as conn:
        pending = [
            ("svo", row, text)
            for row, text in pending_rows(catalog_variable_rows(conn), embedding_text, force)
        ]
        pending += [
            ("model_configuration", row, text)
            for row, text in pending_rows(
                catalog_configuration_rows(conn), configuration_embedding_text, force
            )
        ]
        pending += [
            ("etl_piece", row, text)
            for row, text in pending_rows(
                catalog_etl_piece_rows(conn), etl_piece_embedding_text, force
            )
        ]
        if not pending:
            return 0

        vectors = model().encode([text for _, _, text in pending], normalize_embeddings=True)
        for (target, row, text), vector in zip(pending, vectors):
            literal = "[" + ",".join(str(value) for value in vector.tolist()) + "]"
            conn.execute(EMBEDDING_UPDATE_SQL[target], (text, literal, row[0]))
        conn.commit()
        return len(pending)


async def refresh_embeddings_loop():
    while True:
        assert refresh_event is not None
        try:
            # Hasura event triggers wake this immediately after catalog writes.
            # The timeout is a safety net for imports or writes that bypass Hasura.
            await asyncio.wait_for(refresh_event.wait(), timeout=EMBEDDING_REFRESH_SECONDS)
            refresh_event.clear()
        except asyncio.TimeoutError:
            pass
        try:
            refreshed = await asyncio.to_thread(index_catalog_embeddings)
            if refreshed:
                log.info("refreshed %d changed semantic-search embeddings", refreshed)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("semantic embedding refresh failed; will retry")


@app.on_event("startup")
def start_embedding_indexer():
    # Preserve the initial full build, then respond to Hasura catalog events
    # without re-encoding rows whose SVO/model context has not changed.
    #
    # The first build must not stop the service. On a first install the catalog
    # tables do not exist yet, because the Hasura migrations run in their own
    # container. An unguarded query there raises UndefinedTable, the startup
    # event fails and the process exits 3. The refresh loop below retries, so a
    # failure here costs one refresh interval and nothing more.
    try:
        refreshed = index_catalog_embeddings(force=True)
        log.info("indexed %d semantic-search embeddings", refreshed)
    except Exception:
        log.exception("initial embedding index failed; the refresh loop will retry")
    global refresh_event
    refresh_event = asyncio.Event()
    global refresh_task
    refresh_task = asyncio.create_task(refresh_embeddings_loop())


@app.on_event("shutdown")
async def stop_embedding_indexer():
    global refresh_event
    refresh_event = None
    if refresh_task:
        refresh_task.cancel()
        try:
            await refresh_task
        except asyncio.CancelledError:
            pass


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "embedding_refresh_seconds": EMBEDDING_REFRESH_SECONDS,
    }


@app.post("/events/catalog")
async def catalog_event():
    """Accept a Hasura catalog event and queue an incremental re-index."""
    if refresh_event is not None:
        refresh_event.set()
    return {"status": "accepted"}


@app.get("/search")
def search(
    q: str = Query(min_length=1),
    target: Literal["svo", "model_configuration", "etl_piece"] = Query(default="svo"),
    limit: int = Query(default=20, ge=1, le=100),
    region_id: list[str] | None = Query(default=None),
    category_id: list[str] | None = Query(default=None),
    variable_id: list[str] | None = Query(default=None),
    output_variable_id: list[str] | None = Query(default=None),
    role: Literal["input", "output"] | None = Query(default=None),
):
    """Search one catalog target with deterministic relationship filters."""
    filters = SearchFilters(
        region_ids=region_id or [],
        category_ids=category_id or [],
        variable_ids=variable_id or [],
        output_variable_ids=output_variable_id or [],
        role=role,
    )
    with psycopg.connect(DATABASE_URL) as conn:
        filters.region_ids = resolve_region_ids(conn, filters.region_ids)
        results = search_target(conn, target, q, limit, filters)
    return {"target": target, "query": q, "filters": filters.as_response(), "results": results}


@app.get("/similar")
def similar(
    id: str = Query(min_length=1),
    target: Literal["svo"] = Query(default="svo"),
    limit: int = Query(default=10, ge=1, le=100),
):
    """Return the standard variables nearest by embedding to the given one."""
    with psycopg.connect(DATABASE_URL) as conn:
        return similar_variables(conn, id, limit)


class SearchFilters(BaseModel):
    region_ids: list[str] = Field(default_factory=list)
    category_ids: list[str] = Field(default_factory=list)
    variable_ids: list[str] = Field(default_factory=list)
    output_variable_ids: list[str] = Field(default_factory=list)
    role: Literal["input", "output"] | None = None

    def as_response(self):
        return {
            "region_ids": self.region_ids,
            "category_ids": self.category_ids,
            "variable_ids": self.variable_ids,
            "output_variable_ids": self.output_variable_ids,
            "role": self.role,
        }

    def has_relationship_filters(self):
        return bool(
            self.region_ids
            or self.category_ids
            or self.variable_ids
            or self.output_variable_ids
            or self.role
        )


class ProblemStatementRequest(BaseModel):
    title: str | None = None
    name: str | None = None
    description: str | None = None
    goals: list[str] = Field(default_factory=list)
    region_id: str | None = None
    region_name: str | None = None
    category_ids: list[str] = Field(default_factory=list)
    selected_variable_ids: list[str] = Field(default_factory=list)
    selected_model_configuration_ids: list[str] = Field(default_factory=list)
    start_date: str | None = None
    end_date: str | None = None
    # Structured spatial context for problem framing. It is optional metadata,
    # intentionally separate from the free-text embedding query.
    spatial_conditions: dict[str, Any] | None = None
    limit: int = Field(default=10, ge=1, le=50)


def vector_literal(query: str) -> str:
    vector = model().encode([query], normalize_embeddings=True)[0].tolist()
    return "[" + ",".join(str(value) for value in vector) + "]"


CONFIGURATION_FILTER_SQL = """
      AND (
        cardinality(%s::text[]) = 0
        OR EXISTS (
          SELECT 1
          FROM modelcatalog_configuration_region cr
          WHERE cr.configuration_id = c.id AND cr.region_id = ANY(%s::text[])
        )
        OR c.has_region = ANY(%s::text[])
      )
      AND (
        cardinality(%s::text[]) = 0
        OR EXISTS (
          SELECT 1
          FROM modelcatalog_configuration_category cc
          WHERE cc.configuration_id = c.id AND cc.category_id = ANY(%s::text[])
        )
      )
      AND (
        cardinality(%s::text[]) = 0
        OR EXISTS (
          SELECT 1
          FROM (
            SELECT configuration_id, input_id AS dataset_specification_id, 'input' AS role
            FROM modelcatalog_configuration_input
            UNION ALL
            SELECT configuration_id, output_id AS dataset_specification_id, 'output' AS role
            FROM modelcatalog_configuration_output
          ) variable_links
          JOIN modelcatalog_dataset_specification_presentation dsp
            ON dsp.dataset_specification_id = variable_links.dataset_specification_id
          JOIN modelcatalog_variable_presentation vp ON vp.id = dsp.presentation_id
          WHERE variable_links.configuration_id = c.id
            AND vp.has_standard_variable = ANY(%s::text[])
        )
      )
      AND (
        CAST(%s AS text) IS NULL
        OR EXISTS (
          SELECT 1
          FROM (
            SELECT configuration_id, 'input' AS role
            FROM modelcatalog_configuration_input
            UNION ALL
            SELECT configuration_id, 'output' AS role
            FROM modelcatalog_configuration_output
          ) role_links
          WHERE role_links.configuration_id = c.id AND role_links.role = %s
        )
      )
      AND (
        cardinality(%s::text[]) = 0
        OR EXISTS (
          SELECT 1
          FROM modelcatalog_configuration_output output_link
          JOIN modelcatalog_dataset_specification_presentation dsp
            ON dsp.dataset_specification_id = output_link.output_id
          JOIN modelcatalog_variable_presentation vp ON vp.id = dsp.presentation_id
          WHERE output_link.configuration_id = c.id
            AND vp.has_standard_variable = ANY(%s::text[])
        )
      )
"""


def configuration_filter_parameters(filters: SearchFilters):
    return (
        filters.region_ids,
        filters.region_ids,
        filters.region_ids,
        filters.category_ids,
        filters.category_ids,
        filters.variable_ids,
        filters.variable_ids,
        filters.role,
        filters.role,
        filters.output_variable_ids,
        filters.output_variable_ids,
    )


def resolve_region_ids(conn, region_ids: list[str]):
    """Accept either legacy UI region IDs or model-catalog region URIs."""
    if not region_ids:
        return []
    rows = conn.execute(
        """
        SELECT id, model_catalog_uri
        FROM region
        WHERE id = ANY(%s::text[]) OR model_catalog_uri = ANY(%s::text[])
        """,
        (region_ids, region_ids),
    ).fetchall()
    resolved = set(region_ids)
    for legacy_id, model_catalog_uri in rows:
        if model_catalog_uri:
            resolved.add(model_catalog_uri)
        else:
            resolved.add(legacy_id)
    return sorted(resolved)


def search_target(conn, target: str, query: str, limit: int, filters: SearchFilters):
    if target == "svo":
        return search_svos(conn, query, limit, filters)
    if target == "model_configuration":
        return search_configurations(conn, query, limit, filters)
    if target == "etl_piece":
        return search_etl_pieces(conn, query, limit)
    raise HTTPException(
        status_code=422, detail="target must be svo, model_configuration or etl_piece"
    )


def similar_variables(conn, variable_id: str, limit: int):
    row = conn.execute(
        "SELECT embedding IS NOT NULL FROM modelcatalog_standard_variable WHERE id = %s",
        (variable_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="standard variable not found")
    if not row[0]:
        return {"target": "svo", "id": variable_id, "status": "not_indexed", "results": []}
    rows = conn.execute(
        """
        SELECT sv.id, sv.label, sv.description,
               1 - (sv.embedding <=> origin.embedding) AS score
        FROM modelcatalog_standard_variable sv,
             (SELECT embedding FROM modelcatalog_standard_variable WHERE id = %s) origin
        WHERE sv.id <> %s AND sv.embedding IS NOT NULL
        ORDER BY sv.embedding <=> origin.embedding
        LIMIT %s
        """,
        (variable_id, variable_id, limit),
    ).fetchall()
    return {
        "target": "svo",
        "id": variable_id,
        "results": [
            {"id": r[0], "label": r[1], "description": r[2], "score": float(r[3] or 0)}
            for r in rows
        ],
    }


# The service has no caller identity (the browser calls it directly, with no
# token), so it must never return a private piece. Callers merge in their own
# private pieces from Hasura.
ETL_PIECE_VISIBILITY_SQL = "p.visibility IN ('public', 'shared')"


def try_vector_literal(query: str) -> str | None:
    """Embed the query, or return None so callers can fall back to keywords."""
    try:
        return vector_literal(query)
    except Exception:
        log.exception("embedding model unavailable; falling back to keyword search")
        return None


def search_etl_pieces(conn, query: str, limit: int):
    query_vector = try_vector_literal(query)
    if query_vector is not None:
        score_sql = """(0.7 * (1 - (p.embedding <=> %s::vector)) +
              0.3 * ts_rank(to_tsvector('english', coalesce(p.semantic_text, '')),
                            plainto_tsquery('english', %s)))"""
        embedded_sql = "p.embedding IS NOT NULL"
        params = (query_vector, query, limit)
        ranking_source = "0.7 embedding + 0.3 english_text_search"
    else:
        score_sql = """ts_rank(
              to_tsvector('english', concat_ws(' ', p.label, p.description, p.semantic_text)),
              plainto_tsquery('english', %s))"""
        embedded_sql = """to_tsvector('english', concat_ws(' ', p.label, p.description, p.semantic_text))
              @@ plainto_tsquery('english', %s)"""
        params = (query, query, limit)
        ranking_source = "english_text_search (embedding unavailable)"
    rows = conn.execute(
        f"""
        SELECT p.id, p.label, p.description, p.visibility, p.owner_username,
               {score_sql} AS score
        FROM modelcatalog_etl_process p
        WHERE {ETL_PIECE_VISIBILITY_SQL}
          AND {embedded_sql}
        ORDER BY score DESC
        LIMIT %s
        """,
        params,
    ).fetchall()
    if not rows:
        return []
    contract_rows = conn.execute(
        """
        SELECT c.etl_process_id, c.role, c.position, c.standard_variable_uri, sv.label, c.format
        FROM modelcatalog_etl_process_contract c
        LEFT JOIN modelcatalog_standard_variable sv ON sv.id = c.standard_variable_uri
        WHERE c.etl_process_id = ANY(%s::text[])
        ORDER BY c.etl_process_id, c.role, c.position
        """,
        ([row[0] for row in rows],),
    ).fetchall()
    contracts = defaultdict(lambda: {"input": [], "output": []})
    for piece_id, role, position, uri, label, fmt in contract_rows:
        contracts[piece_id][role].append(
            {"position": position, "standard_variable_uri": uri, "label": label, "format": fmt}
        )
    return [
        {
            "id": row[0],
            "label": row[1],
            "description": row[2],
            "score": float(row[5] or 0),
            "ranking_source": ranking_source,
            "visibility": row[3],
            "owner_username": row[4],
            "inputs": contracts[row[0]]["input"],
            "outputs": contracts[row[0]]["output"],
        }
        for row in rows
    ]


def search_svos(conn, query: str, limit: int, filters: SearchFilters):
    relationship_match = ""
    query_vector = vector_literal(query)
    params = (query_vector, query, limit)
    if filters.has_relationship_filters():
        relationship_match = f"""
          AND EXISTS (
            SELECT 1
            FROM (
              SELECT configuration_id, input_id AS dataset_specification_id, 'input' AS role
              FROM modelcatalog_configuration_input
              UNION ALL
              SELECT configuration_id, output_id AS dataset_specification_id, 'output' AS role
              FROM modelcatalog_configuration_output
            ) variable_links
            JOIN modelcatalog_configuration c ON c.id = variable_links.configuration_id
            JOIN modelcatalog_dataset_specification_presentation dsp
              ON dsp.dataset_specification_id = variable_links.dataset_specification_id
            JOIN modelcatalog_variable_presentation vp ON vp.id = dsp.presentation_id
            WHERE vp.has_standard_variable = sv.id
            {CONFIGURATION_FILTER_SQL}
          )
        """
        params = (query_vector, query, *configuration_filter_parameters(filters), limit)
    rows = conn.execute(
        f"""
        SELECT sv.id, sv.label, sv.description,
          (0.7 * (1 - (sv.embedding <=> %s::vector)) +
           0.3 * ts_rank(to_tsvector('english', coalesce(sv.semantic_text, '')),
                         plainto_tsquery('english', %s))) AS score
        FROM modelcatalog_standard_variable sv
        WHERE sv.embedding IS NOT NULL
        {relationship_match}
        ORDER BY score DESC
        LIMIT %s
        """,
        params,
    ).fetchall()
    if not rows:
        return []

    variable_ids = [row[0] for row in rows]
    context_rows = conn.execute(
        f"""
        SELECT vp.has_standard_variable, c.id, c.label, links.role,
               category.id, category.label, region.id, region.label
        FROM (
          SELECT configuration_id, input_id AS dataset_specification_id, 'input' AS role
          FROM modelcatalog_configuration_input
          UNION ALL
          SELECT configuration_id, output_id AS dataset_specification_id, 'output' AS role
          FROM modelcatalog_configuration_output
        ) links
        JOIN modelcatalog_configuration c ON c.id = links.configuration_id
        JOIN modelcatalog_dataset_specification_presentation dsp
          ON dsp.dataset_specification_id = links.dataset_specification_id
        JOIN modelcatalog_variable_presentation vp ON vp.id = dsp.presentation_id
        LEFT JOIN modelcatalog_configuration_category cc ON cc.configuration_id = c.id
        LEFT JOIN modelcatalog_model_category category ON category.id = cc.category_id
        LEFT JOIN modelcatalog_configuration_region cr ON cr.configuration_id = c.id
        LEFT JOIN modelcatalog_region region ON region.id = cr.region_id
        WHERE vp.has_standard_variable = ANY(%s::text[])
        {CONFIGURATION_FILTER_SQL}
        ORDER BY c.label, links.role
        """,
        (variable_ids, *configuration_filter_parameters(filters)),
    ).fetchall()
    models_by_variable = defaultdict(list)
    evidence_by_variable = defaultdict(list)
    seen = set()
    for (
        variable_id,
        config_id,
        config_label,
        link_role,
        category_id,
        category_label,
        region_id,
        region_label,
    ) in context_rows:
        link_key = (variable_id, config_id, link_role)
        if link_key in seen:
            continue
        seen.add(link_key)
        models_by_variable[variable_id].append(
            {"id": config_id, "label": config_label, "role": link_role}
        )
        evidence_by_variable[variable_id].append(
            {
                "source": "model_configuration",
                "id": config_id,
                "label": config_label,
                "relation": link_role,
            }
        )
        if category_id:
            evidence_by_variable[variable_id].append(
                {
                    "source": "category",
                    "id": category_id,
                    "label": category_label,
                    "relation": "configuration_category",
                }
            )
        if region_id:
            evidence_by_variable[variable_id].append(
                {
                    "source": "region",
                    "id": region_id,
                    "label": region_label,
                    "relation": "configuration_region",
                }
            )
    return [
        {
            "id": row[0],
            "label": row[1],
            "description": row[2],
            "score": float(row[3] or 0),
            "ranking_source": "0.7 embedding + 0.3 english_text_search",
            "models": models_by_variable.get(row[0], []),
            "evidence": evidence_by_variable.get(row[0], []),
        }
        for row in rows
    ]


def search_configurations(conn, query: str, limit: int, filters: SearchFilters):
    params = (
        vector_literal(query),
        query,
        *configuration_filter_parameters(filters),
        limit,
    )
    rows = conn.execute(
        f"""
        SELECT c.id, c.label, c.description, c.model_configuration_id,
               c.software_version_id, v.label AS software_version_label,
               COALESCE(fallback_region.id, c.has_region) AS fallback_region_id,
               fallback_region.label AS fallback_region_label,
          (0.7 * (1 - (c.embedding <=> %s::vector)) +
           0.3 * ts_rank(to_tsvector('english', coalesce(c.semantic_text, '')),
                         plainto_tsquery('english', %s))) AS score
        FROM modelcatalog_configuration c
        LEFT JOIN modelcatalog_software_version v ON v.id = c.software_version_id
        LEFT JOIN modelcatalog_region fallback_region ON fallback_region.id = c.has_region
        WHERE c.embedding IS NOT NULL
        {CONFIGURATION_FILTER_SQL}
        ORDER BY score DESC
        LIMIT %s
        """,
        params,
    ).fetchall()
    if not rows:
        return []

    configuration_ids = [row[0] for row in rows]
    variable_rows = conn.execute(
        """
        SELECT links.configuration_id, sv.id, sv.label, links.role
        FROM (
          SELECT configuration_id, input_id AS dataset_specification_id, 'input' AS role
          FROM modelcatalog_configuration_input
          UNION ALL
          SELECT configuration_id, output_id AS dataset_specification_id, 'output' AS role
          FROM modelcatalog_configuration_output
        ) links
        JOIN modelcatalog_dataset_specification_presentation dsp
          ON dsp.dataset_specification_id = links.dataset_specification_id
        JOIN modelcatalog_variable_presentation vp ON vp.id = dsp.presentation_id
        JOIN modelcatalog_standard_variable sv ON sv.id = vp.has_standard_variable
        WHERE links.configuration_id = ANY(%s::text[])
        ORDER BY sv.label, links.role
        """,
        (configuration_ids,),
    ).fetchall()
    category_rows = conn.execute(
        """
        SELECT cc.configuration_id, category.id, category.label
        FROM modelcatalog_configuration_category cc
        JOIN modelcatalog_model_category category ON category.id = cc.category_id
        WHERE cc.configuration_id = ANY(%s::text[])
        ORDER BY category.label
        """,
        (configuration_ids,),
    ).fetchall()
    region_rows = conn.execute(
        """
        SELECT cr.configuration_id, region.id, region.label
        FROM modelcatalog_configuration_region cr
        JOIN modelcatalog_region region ON region.id = cr.region_id
        WHERE cr.configuration_id = ANY(%s::text[])
        ORDER BY region.label
        """,
        (configuration_ids,),
    ).fetchall()
    variables = defaultdict(list)
    categories = defaultdict(list)
    regions = defaultdict(list)
    evidence = defaultdict(list)
    for config_id, variable_id, variable_label, link_role in variable_rows:
        item = {"id": variable_id, "label": variable_label, "role": link_role}
        if item not in variables[config_id]:
            variables[config_id].append(item)
        evidence_item = {
            "source": "standard_variable",
            "id": variable_id,
            "label": variable_label,
            "relation": link_role,
        }
        if evidence_item not in evidence[config_id]:
            evidence[config_id].append(evidence_item)
    for config_id, category_id, category_label in category_rows:
        item = {"id": category_id, "label": category_label}
        if item not in categories[config_id]:
            categories[config_id].append(item)
        evidence_item = {
            "source": "category",
            "id": category_id,
            "label": category_label,
            "relation": "category",
        }
        if evidence_item not in evidence[config_id]:
            evidence[config_id].append(evidence_item)
    for config_id, region_id, region_label in region_rows:
        item = {"id": region_id, "label": region_label}
        if item not in regions[config_id]:
            regions[config_id].append(item)
        evidence_item = {
            "source": "region",
            "id": region_id,
            "label": region_label,
            "relation": "region",
        }
        if evidence_item not in evidence[config_id]:
            evidence[config_id].append(evidence_item)
    for row in rows:
        if row[6]:
            item = {"id": row[6], "label": row[7] or row[6]}
            if item not in regions[row[0]]:
                regions[row[0]].append(item)
            evidence_item = {
                "source": "region",
                "id": row[6],
                "label": row[7] or row[6],
                "relation": "configuration_has_region",
            }
            if evidence_item not in evidence[row[0]]:
                evidence[row[0]].append(evidence_item)
    return [
        {
            "id": row[0],
            "label": row[1],
            "description": row[2],
            "parent_id": row[3],
            "software_version": {"id": row[4], "label": row[5]} if row[4] else None,
            "score": float(row[8] or 0),
            "ranking_source": "0.7 embedding + 0.3 english_text_search",
            "standard_variables": variables.get(row[0], []),
            "categories": categories.get(row[0], []),
            "regions": regions.get(row[0], []),
            "evidence": evidence.get(row[0], []),
        }
        for row in rows
    ]


def normalize_context(request: ProblemStatementRequest, selected_context: list[str] | None = None):
    pieces = []
    for value in [
        request.title,
        request.name,
        request.description,
        request.region_name,
        *(request.goals or []),
        *(selected_context or []),
    ]:
        cleaned = str(value or "").strip()
        if cleaned and cleaned not in pieces:
            pieces.append(cleaned)
    return " ".join(pieces), pieces


def fetch_selected_context(conn, request: ProblemStatementRequest):
    pieces = []
    if request.selected_variable_ids:
        rows = conn.execute(
            "SELECT label, description FROM modelcatalog_standard_variable WHERE id = ANY(%s::text[])",
            (request.selected_variable_ids,),
        ).fetchall()
        pieces.extend(" ".join(part for part in row if part).strip() for row in rows)
    if request.selected_model_configuration_ids:
        rows = conn.execute(
            "SELECT label, description FROM modelcatalog_configuration WHERE id = ANY(%s::text[])",
            (request.selected_model_configuration_ids,),
        ).fetchall()
        pieces.extend(" ".join(part for part in row if part).strip() for row in rows)
    return [piece for piece in pieces if piece]


def recommendation_response(conn, request: ProblemStatementRequest):
    selected_context = fetch_selected_context(conn, request)
    query, context_pieces = normalize_context(request, selected_context)
    if len(query.strip()) < MIN_RECOMMENDATION_CONTEXT_LENGTH:
        return {
            "capability": "problem_statement_recommendations",
            "status": "abstained",
            "reason": "insufficient_context",
            "context": {"text": "", "sources": []},
            "spatial_conditions": request.spatial_conditions or {},
            "results": {"svo": [], "model_configuration": []},
        }

    filters = SearchFilters(
        region_ids=resolve_region_ids(conn, [request.region_id]) if request.region_id else [],
        category_ids=request.category_ids,
        variable_ids=[],
        output_variable_ids=[],
    )
    svo_results = search_target(conn, "svo", query, request.limit, filters)
    model_results = search_target(conn, "model_configuration", query, request.limit, filters)
    response = {
        "capability": "problem_statement_recommendations",
        "status": "ok" if svo_results or model_results else "empty",
        "context": {"text": query, "sources": context_pieces},
        "spatial_conditions": request.spatial_conditions or {},
        "results": {
            "svo": svo_results,
            "model_configuration": model_results,
        },
    }
    if response["status"] == "empty":
        response["reason"] = "no_candidates_after_hard_filters"
    return response


def saved_problem_statement_request(conn, problem_statement_id: str):
    statement = conn.execute(
        """
        SELECT p.id, p.name, p.start_date::text, p.end_date::text, p.region_id, r.name
        FROM problem_statement p
        LEFT JOIN region r ON r.id = p.region_id
        WHERE p.id = %s
        """,
        (problem_statement_id,),
    ).fetchone()
    if not statement:
        raise HTTPException(status_code=404, detail="problem statement not found")
    tasks = conn.execute(
        """
        SELECT t.name, t.response_variable_id, response.label,
               t.driving_variable_id, driving.label
        FROM task t
        LEFT JOIN modelcatalog_standard_variable response ON response.id = t.response_variable_id
        LEFT JOIN modelcatalog_standard_variable driving ON driving.id = t.driving_variable_id
        WHERE t.problem_statement_id = %s
        ORDER BY t.name
        """,
        (problem_statement_id,),
    ).fetchall()
    selected_models = conn.execute(
        """
        SELECT DISTINCT tm.modelcatalog_configuration_id
        FROM thread t
        JOIN task task_row ON task_row.id = t.task_id
        JOIN thread_model tm ON tm.thread_id = t.id
        WHERE task_row.problem_statement_id = %s
          AND tm.modelcatalog_configuration_id IS NOT NULL
        """,
        (problem_statement_id,),
    ).fetchall()
    return ProblemStatementRequest(
        title=statement[1],
        region_id=statement[4],
        region_name=statement[5],
        start_date=statement[2],
        end_date=statement[3],
        goals=[task[0] for task in tasks if task[0]],
        selected_variable_ids=[
            variable_id
            for task in tasks
            for variable_id in (task[1], task[3])
            if variable_id
        ],
        selected_model_configuration_ids=[model_id[0] for model_id in selected_models if model_id[0]],
    )


@app.post("/problem-statements/recommendations")
def draft_problem_statement_recommendations(request: ProblemStatementRequest = Body(...)):
    """Return on-demand SVO and model recommendations for a draft statement."""
    with psycopg.connect(DATABASE_URL) as conn:
        return recommendation_response(conn, request)


@app.get("/problem-statements/{problem_statement_id}/recommendations")
def saved_problem_statement_recommendations(problem_statement_id: str, limit: int = Query(default=10, ge=1, le=50)):
    """Return recommendations for a saved catalog problem statement."""
    with psycopg.connect(DATABASE_URL) as conn:
        request = saved_problem_statement_request(conn, problem_statement_id)
        request.limit = limit
        return recommendation_response(conn, request)
