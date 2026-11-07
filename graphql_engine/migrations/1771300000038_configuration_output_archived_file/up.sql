BEGIN;
ALTER TABLE modelcatalog_configuration_output
    ADD COLUMN archived_file TEXT;
COMMENT ON COLUMN modelcatalog_configuration_output.archived_file IS
    'File name, or fnmatch glob, of this output in the job''s archive directory for this configuration; a {param:<parameter id>} reference stands for that parameter''s value; NULL when the output is not bound to a file.';
COMMIT;
