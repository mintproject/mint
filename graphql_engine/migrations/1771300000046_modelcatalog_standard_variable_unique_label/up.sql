-- One standard variable per name. Labels that differ only in case, spaces or
-- separators ("land_surface__elevation", "LAND_SURFACE__ELEVATION",
-- "Land surface elevation") are the same variable; a second row split the
-- catalog so models and pieces naming different copies never matched.
-- Dev was cleaned to one row per name on 2026-11-20 before this index.
CREATE UNIQUE INDEX modelcatalog_standard_variable_label_norm_key
    ON modelcatalog_standard_variable (
        btrim(regexp_replace(lower(btrim(label)), '[^a-z0-9]+', '_', 'g'), '_')
    );
