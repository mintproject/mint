BEGIN;

-- Who registered a data object, from the Tapis-verified token at create, and whether
-- it is shared. A user may use a data object that is shared or that they own. Rows
-- that exist before this migration have no owner and are not shared, so no user may
-- use them; only an operator reads them, straight from the table. The CKAN sync sets
-- `shared` on the public datasets it registers (see app/ckan_sync.py); nothing a user
-- sends can set it.
ALTER TABLE adapter.data_object
    ADD COLUMN owner_username TEXT,
    ADD COLUMN shared BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN adapter.data_object.owner_username IS
    'Tapis username that registered the object. NULL for rows made before owners were recorded and for model outputs registered by the Ensemble Manager without a forwarded token; only the owner, or anyone for a shared row, may use it.';
COMMENT ON COLUMN adapter.data_object.shared IS
    'True for catalog rows every signed-in user may use as a source. Set only by the CKAN sync of public datasets; never from a request body. Do not set it if the sync ever includes private datasets.';

CREATE INDEX data_object_owner_username_idx ON adapter.data_object (owner_username);

COMMIT;
