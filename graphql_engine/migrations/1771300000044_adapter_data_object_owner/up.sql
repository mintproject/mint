BEGIN;

-- Who registered a data object, from the Tapis-verified token at create. Rows that
-- exist before this migration have no owner and are listed for no user; only an
-- operator reads them, straight from the table.
ALTER TABLE adapter.data_object ADD COLUMN owner_username TEXT;

COMMENT ON COLUMN adapter.data_object.owner_username IS
    'Tapis username that registered the object. NULL for rows made before owners were recorded and for model outputs registered by the Ensemble Manager without a forwarded token; GET /data-objects lists them for nobody.';

CREATE INDEX data_object_owner_username_idx ON adapter.data_object (owner_username);

COMMIT;
