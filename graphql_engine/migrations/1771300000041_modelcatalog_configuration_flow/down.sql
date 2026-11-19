BEGIN;

DROP TABLE IF EXISTS modelcatalog_configuration_step;
DROP FUNCTION IF EXISTS modelcatalog_configuration_step_only_with_its_flow();
DROP TABLE IF EXISTS modelcatalog_configuration_flow;

COMMIT;
