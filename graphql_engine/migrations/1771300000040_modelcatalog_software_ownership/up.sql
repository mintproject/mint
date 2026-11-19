BEGIN;

-- Software and Version rows had no owner, so every signed-in user could edit or delete
-- any of them, and deleting one cascades to the configurations under it.
ALTER TABLE modelcatalog_software ADD COLUMN owner_username TEXT;
ALTER TABLE modelcatalog_software_version ADD COLUMN owner_username TEXT;

CREATE INDEX idx_mc_software_owner ON modelcatalog_software(owner_username);
CREATE INDEX idx_mc_software_version_owner ON modelcatalog_software_version(owner_username);

-- Usernames that may edit, delete and reassign any catalog row. Written only with the
-- admin secret. The sign-in webhook returns identity only, so admins keep role `user`
-- and the permission filters look them up here.
CREATE TABLE modelcatalog_admin (
    username TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE modelcatalog_admin IS
    'Catalog admins. A row here lets that user edit, delete and reassign any catalog row.';

-- Existing rows are left without an owner. The catalog has no record of who registered
-- them, and guessing from the configurations underneath would hand a shared model to
-- whoever added the only configuration. An admin assigns owners after the deploy:
-- docs/runbook-catalog-ownership.md.

COMMIT;
