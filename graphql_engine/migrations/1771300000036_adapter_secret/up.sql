BEGIN;

-- Adapter secrets store (docs/design/2026-11-04-svo-adapter-secrets-store.md).
-- adapter.secret holds Fernet ciphertext only. Both tables are tracked in
-- Hasura with NO permissions for any role (admin secret only) and are
-- excluded from the committed database dump.
CREATE TABLE adapter.secret (
    id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
    scope TEXT NOT NULL CHECK (scope IN ('model_owner', 'user')),
    owner_username TEXT NOT NULL,
    name TEXT NOT NULL,
    -- Part of the identity key and never NULL ('' for user scope), so the
    -- unique indexes below hold.
    configuration_id TEXT NOT NULL DEFAULT '',
    -- The actual FK: a partial FK is not expressible in Postgres, so model_owner
    -- rows repeat configuration_id here and the CHECK keeps the two in step.
    -- Deleting the configuration (e.g. a --reset re-registration) drops its
    -- secrets by design.
    configuration_ref TEXT REFERENCES public.modelcatalog_configuration(id) ON DELETE CASCADE,
    pinned_app_id TEXT NOT NULL DEFAULT '',
    pinned_app_version TEXT NOT NULL DEFAULT '',
    -- Fernet token; the encrypted JSON embeds {id, scope, owner, name,
    -- configuration_id, version} and is verified after decrypt.
    ciphertext TEXT NOT NULL,
    -- Field names only (derived on write); display and coverage checks.
    fields TEXT[] NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1,
    acknowledged_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    CONSTRAINT secret_model_owner_ref_check CHECK (
        (scope = 'model_owner' AND configuration_ref IS NOT NULL AND configuration_ref = configuration_id)
        OR (scope <> 'model_owner' AND configuration_ref IS NULL)
    )
);

CREATE UNIQUE INDEX secret_model_owner_key
    ON adapter.secret (owner_username, name, configuration_id)
    WHERE scope = 'model_owner';
CREATE UNIQUE INDEX secret_user_key
    ON adapter.secret (owner_username, name)
    WHERE scope = 'user';

-- Insert-only audit trail, retained 13 months. No FK to secret so deleting a
-- secret keeps its history. Ids, names and versions only: never a value.
CREATE TABLE adapter.secret_event (
    id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
    secret_id uuid,
    scope TEXT,
    owner_username TEXT,
    name TEXT,
    configuration_id TEXT,
    event TEXT NOT NULL CHECK (event IN ('created', 'replaced', 'deleted', 'bound', 'issued', 'mismatch')),
    run_id TEXT,
    actor TEXT,
    actor_token_kind TEXT,
    secret_version INTEGER,
    at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX secret_event_secret_id_idx ON adapter.secret_event (secret_id);
CREATE INDEX secret_event_run_id_idx ON adapter.secret_event (run_id);
CREATE INDEX secret_event_at_idx ON adapter.secret_event (at);

-- Secrets bound to a run at submit (ids, versions, names and env maps; no
-- values) and how many times the model task has fetched them (cap of 3).
ALTER TABLE adapter.workflow_run
    ADD COLUMN bound_secrets JSONB,
    ADD COLUMN credentials_issued INTEGER NOT NULL DEFAULT 0;

COMMIT;
