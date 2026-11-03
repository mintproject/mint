BEGIN;

-- Token keeper (docs/design/2026-10-28-svo-adapter-workflow-token-lifecycle.md,
-- rev 2). The Workflows engine can start the composite model task hours after
-- dispatch, past the expiry of the per-run token in its args. The adapter now
-- keeps an encrypted copy of the current per-run token on the run so the task
-- can fetch a live one (POST /runs/{id}/token). `run_token_enc` is Fernet
-- ciphertext bound to the run id, never plaintext; `run_token_deadline_at`
-- bounds how long the keeper serves or renews it regardless of status.
ALTER TABLE adapter.workflow_run
    ADD COLUMN run_token_enc TEXT,
    ADD COLUMN run_token_expires_at TIMESTAMPTZ,
    ADD COLUMN run_token_deadline_at TIMESTAMPTZ,
    ADD COLUMN run_token_renewals INTEGER NOT NULL DEFAULT 0;

COMMIT;
