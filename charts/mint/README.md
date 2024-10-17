# MINT

![Version: 3.4.4](https://img.shields.io/badge/Version-3.4.4-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 1.16.3](https://img.shields.io/badge/AppVersion-1.16.3-informational?style=flat-square)

A Helm chart for MINT

## Maintainers

| Name | Email | Url |
| ---- | ------ | --- |
| mosoriob | <maxiosorio@gmail.com> | <https://github.com/mosoriob> |

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| affinity | object | `{}` |  |
| arm_support | bool | `false` | Enable or disable ARM support |
| auth.client_id | string | `"model_catalog"` | URL for authentication service |
| auth.realm | string | `"production"` | Realm for authentication service |
| auth.ui_client_id | string | `"mint-ui"` | Client ID for authentication service |
| auth.url | string | `"https://auth.mint.isi.edu/"` | Realm for authentication service |
| autoscaling.enabled | bool | `false` |  |
| autoscaling.maxReplicas | int | `100` |  |
| autoscaling.minReplicas | int | `1` |  |
| autoscaling.targetCPUUtilizationPercentage | int | `80` |  |
| components.backups.enabled | bool | `false` | Enable or disable backups |
| components.cromo.enabled | bool | `false` | Enable or disable Cromo |
| components.cromo.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for Cromo |
| components.cromo.image.repository | string | `"mintproject/cromo"` | Docker image repository for Cromo |
| components.cromo.image.tag | string | `"3c75586989aedf2573c37f5352f960c294377931"` | Docker image tag for Cromo |
| components.cromo.ingress.annotations | object | `{}` |  |
| components.cromo.ingress.className | string | `""` |  |
| components.cromo.ingress.enabled | bool | `true` | Enable or disable ingress for Cromo |
| components.cromo.ingress.hosts[0].host | string | `"cromo.mint.local"` |  |
| components.cromo.ingress.hosts[0].paths[0].path | string | `"/"` |  |
| components.cromo.ingress.hosts[0].paths[0].pathType | string | `"ImplementationSpecific"` |  |
| components.cromo.ingress.tls | list | `[]` |  |
| components.cromo.resources | object | `{}` | Resource specifications for Cromo |
| components.data_catalog | object | `{"arm_image":{"pullPolicy":"IfNotPresent","repository":"mintproject/data-catalog","tag":"8a6af95cae183320d596dc5219f2f76d1f234749"},"enabled":true,"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/data-catalog","tag":"9be70359feabe03ed55bfdbf92c20a7e43ab928b"},"ingress":{"annotations":{},"className":"","enabled":true,"hosts":[{"host":"datacatalog.mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"resources":{}}` | Data Catalog component configuration |
| components.data_catalog.arm_image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for ARM-based Data Catalog |
| components.data_catalog.arm_image.repository | string | `"mintproject/data-catalog"` | Docker image repository for ARM-based Data Catalog |
| components.data_catalog.arm_image.tag | string | `"8a6af95cae183320d596dc5219f2f76d1f234749"` | Docker image tag for ARM-based Data Catalog |
| components.data_catalog.enabled | bool | `true` | Enable or disable Data Catalog |
| components.data_catalog.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for Data Catalog |
| components.data_catalog.image.repository | string | `"mintproject/data-catalog"` | Docker image repository for Data Catalog |
| components.data_catalog.image.tag | string | `"9be70359feabe03ed55bfdbf92c20a7e43ab928b"` | Docker image tag for Data Catalog |
| components.data_catalog.ingress.enabled | bool | `true` | Enable or disable ingress for Data Catalog |
| components.data_catalog.resources | object | `{}` | Resource specifications for Data Catalog |
| components.data_catalog_db.arm_image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for ARM-based Data Catalog database |
| components.data_catalog_db.arm_image.repository | string | `"mintproject/data-catalog-db"` | Docker image repository for ARM-based Data Catalog database |
| components.data_catalog_db.arm_image.tag | string | `"8a6af95cae183320d596dc5219f2f76d1f234749"` | Docker image tag for ARM-based Data Catalog database |
| components.data_catalog_db.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for Data Catalog database |
| components.data_catalog_db.image.repository | string | `"mintproject/data-catalog-db"` | Docker image repository for Data Catalog database |
| components.data_catalog_db.image.tag | string | `"9be70359feabe03ed55bfdbf92c20a7e43ab928b"` | Docker image tag for Data Catalog database |
| components.data_catalog_db.persistence.accessModes[0] | string | `"ReadWriteOnce"` |  |
| components.data_catalog_db.persistence.annotations."helm.sh/resource-policy" | string | `"keep"` |  |
| components.data_catalog_db.persistence.dataSource | object | `{}` |  |
| components.data_catalog_db.persistence.enabled | bool | `true` | Enable or disable persistence for Data Catalog database |
| components.data_catalog_db.persistence.existingClaim | string | `""` |  |
| components.data_catalog_db.persistence.selector | object | `{}` |  |
| components.data_catalog_db.persistence.size | string | `"30Gi"` |  |
| components.data_catalog_db.persistence.storageClass | string | `""` |  |
| components.data_catalog_db.resources | object | `{}` | Resource specifications for Data Catalog database |
| components.ensemble_manager.api_version | string | `"v1"` | API version for Ensemble Manager |
| components.ensemble_manager.config.execution_engine.basePath | string | `""` |  |
| components.ensemble_manager.config.execution_engine.code_dir | string | `"/home/node/app/data/code"` |  |
| components.ensemble_manager.config.execution_engine.data_dir | string | `"/home/node/app/data/data"` |  |
| components.ensemble_manager.config.execution_engine.data_url | string | `"s3://mintdata"` |  |
| components.ensemble_manager.config.execution_engine.log_dir | string | `"/home/node/app/data/logs"` |  |
| components.ensemble_manager.config.execution_engine.log_url | string | `"s3://mintdata"` |  |
| components.ensemble_manager.config.execution_engine.parallelism | int | `2` |  |
| components.ensemble_manager.config.execution_engine.temp_dir | string | `"/home/node/app/data/temp"` |  |
| components.ensemble_manager.config.execution_engine.type | string | `"localex"` |  |
| components.ensemble_manager.config.execution_engine.username | string | `""` |  |
| components.ensemble_manager.config.execution_engine.wings_dot_path | string | `""` |  |
| components.ensemble_manager.config.execution_engine.wings_export_url | string | `""` |  |
| components.ensemble_manager.config.execution_engine.wings_ont_url | string | `""` |  |
| components.ensemble_manager.config.execution_engine.wings_storage | string | `""` |  |
| components.ensemble_manager.config.graphql.enable_ssl | bool | `false` |  |
| components.ensemble_manager.config.graphql.endpoint | string | `"localhost:30003/v1/graphql"` |  |
| components.ensemble_manager.config.graphql.use_secret | bool | `true` |  |
| components.ensemble_manager.enabled | bool | `true` | Enable or disable Ensemble Manager |
| components.ensemble_manager.environment.data_dir | string | `"/var/mint"` |  |
| components.ensemble_manager.image | object | `{"pullPolicy":"IfNotPresent","repository":"mintproject/ensemble-manager","tag":"3e1f40865e647a8025b06ac63178b0eed64aed3e"}` | Docker image repository for Ensemble Manager |
| components.ensemble_manager.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for Ensemble Manager |
| components.ensemble_manager.image.repository | string | `"mintproject/ensemble-manager"` | Docker image repository for Ensemble Manager |
| components.ensemble_manager.image.tag | string | `"3e1f40865e647a8025b06ac63178b0eed64aed3e"` | Docker image tag for Ensemble Manager |
| components.ensemble_manager.ingress.annotations | object | `{}` |  |
| components.ensemble_manager.ingress.className | string | `""` |  |
| components.ensemble_manager.ingress.enabled | bool | `true` |  |
| components.ensemble_manager.ingress.hosts[0].host | string | `"ensemble-manager.mint.local"` |  |
| components.ensemble_manager.ingress.hosts[0].paths[0].path | string | `"/"` |  |
| components.ensemble_manager.ingress.hosts[0].paths[0].pathType | string | `"ImplementationSpecific"` |  |
| components.ensemble_manager.ingress.tls | list | `[]` |  |
| components.ensemble_manager.persistence.accessModes[0] | string | `"ReadWriteOnce"` |  |
| components.ensemble_manager.persistence.annotations."helm.sh/resource-policy" | string | `"keep"` |  |
| components.ensemble_manager.persistence.dataSource | object | `{}` |  |
| components.ensemble_manager.persistence.enabled | bool | `true` |  |
| components.ensemble_manager.persistence.existingClaim | string | `""` |  |
| components.ensemble_manager.persistence.name | string | `"ensemble-manager"` |  |
| components.ensemble_manager.persistence.selector | object | `{}` |  |
| components.ensemble_manager.persistence.size | string | `"10Gi"` |  |
| components.ensemble_manager.persistence.storageClass | string | `""` |  |
| components.ensemble_manager.resources | object | `{}` | Resource specifications for Ensemble Manager |
| components.ensemble_manager.serviceAccountName | string | `"default"` | Service account name for Ensemble Manager, used to run jobs |
| components.ensemble_manager.strategy | object | `{"type":"Recreate"}` | Ensemble Manager deployment strategy (Recreate or RollingUpdate) |
| components.ensemble_manager.strategy.type | string | `"Recreate"` | Type of deployment strategy |
| components.hasura.enabled | bool | `true` | Enable or disable Hasura |
| components.hasura.environment.enable_console | bool | `true` | Enable or disable Hasura console |
| components.hasura.environment.enable_dev_mode | bool | `false` | Enable or disable Hasura dev mode |
| components.hasura.environment.unauthorized_role | string | `"anonymous"` | Unauthorized role for Hasura |
| components.hasura.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for Hasura |
| components.hasura.image.repository | string | `"mintproject/graphql-engine"` | Docker image repository for Hasura |
| components.hasura.image.tag | string | `"305c0dbeba1878eafe348f21fc300fbfc017d9dc"` | Docker image tag for Hasura |
| components.hasura.ingress.annotations | object | `{}` |  |
| components.hasura.ingress.className | string | `nil` |  |
| components.hasura.ingress.enabled | bool | `true` | Enable or disable ingress for Hasura |
| components.hasura.ingress.hosts[0].host | string | `"graphql.mint.local"` |  |
| components.hasura.ingress.hosts[0].paths[0].path | string | `"/"` |  |
| components.hasura.ingress.hosts[0].paths[0].pathType | string | `"ImplementationSpecific"` |  |
| components.hasura.ingress.tls | list | `[]` |  |
| components.hasura.resources | object | `{}` | Resource specifications for Hasura |
| components.hasura_db.arm_image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for ARM-based Hasura database |
| components.hasura_db.arm_image.repository | string | `"imresamu/postgis-arm64"` | Docker image repository for ARM-based Hasura database |
| components.hasura_db.arm_image.tag | string | `"12-3.4-alpine"` | Docker image tag for ARM-based Hasura database |
| components.hasura_db.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for Hasura database |
| components.hasura_db.image.repository | string | `"postgis/postgis"` | Docker image repository for Hasura database |
| components.hasura_db.image.tag | string | `"10-3.2-alpine"` | Docker image tag for Hasura database |
| components.hasura_db.persistence.accessModes[0] | string | `"ReadWriteOnce"` |  |
| components.hasura_db.persistence.annotations."helm.sh/resource-policy" | string | `"keep"` |  |
| components.hasura_db.persistence.dataSource | object | `{}` |  |
| components.hasura_db.persistence.enabled | bool | `true` | Enable or disable persistence for Hasura database |
| components.hasura_db.persistence.existingClaim | string | `""` |  |
| components.hasura_db.persistence.selector | object | `{}` |  |
| components.hasura_db.persistence.size | string | `"30Gi"` |  |
| components.hasura_db.persistence.storageClass | string | `""` |  |
| components.hasura_db.resources | object | `{}` | Resource specifications for Hasura database |
| components.mic_api | object | `{"enabled":false,"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/mic-api","tag":"ee71a1a364fc3d384f85243684ad95d37913b049"},"ingress":{"annotations":{},"className":"","enabled":true,"hosts":[{"host":"api.mic.mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"resources":{}}` | MIC API component configuration |
| components.mic_api.enabled | bool | `false` | Enable or disable MIC API |
| components.mic_api.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for MIC API |
| components.mic_api.image.repository | string | `"mintproject/mic-api"` | Docker image repository for MIC API |
| components.mic_api.image.tag | string | `"ee71a1a364fc3d384f85243684ad95d37913b049"` | Docker image tag for MIC API |
| components.mic_api.ingress.enabled | bool | `true` | Enable or disable ingress for MIC API |
| components.mic_api.resources | object | `{}` | Resource specifications for MIC API |
| components.mic_api_db.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for MIC API database |
| components.mic_api_db.image.repository | string | `"postgres"` | Docker image repository for MIC API database |
| components.mic_api_db.image.tag | float | `14.6` | Docker image tag for MIC API database |
| components.mic_api_db.persistence.accessModes | list | `["ReadWriteOnce"]` | Access modes for MIC API database |
| components.mic_api_db.persistence.annotations."helm.sh/resource-policy" | string | `"keep"` |  |
| components.mic_api_db.persistence.dataSource | object | `{}` |  |
| components.mic_api_db.persistence.enabled | bool | `true` | Enable or disable persistence for MIC API database |
| components.mic_api_db.persistence.existingClaim | string | `""` | Existing claim for MIC API database |
| components.mic_api_db.persistence.selector | object | `{}` |  |
| components.mic_api_db.persistence.size | string | `"10Gi"` | Size for MIC API database |
| components.mic_api_db.persistence.storageClass | string | `""` | Storage class for MIC API database |
| components.mic_api_db.resources | object | `{}` | Resource specifications for MIC API database |
| components.mic_ui.enabled | bool | `false` | Enable or disable MIC UI |
| components.mic_ui.image.environment.airflow_url | string | `"https://airflow.mint.isi.edu/api/v1"` | Airflow URL for MIC UI |
| components.mic_ui.image.environment.api_url | string | `nil` | API URL for MIC UI |
| components.mic_ui.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for MIC UI |
| components.mic_ui.image.repository | string | `"mintproject/mic-web"` | Docker image repository for MIC UI |
| components.mic_ui.image.tag | string | `"a736ac5841d471de4679bec80c13b0fb646ae073"` | Docker image tag for MIC UI |
| components.mic_ui.ingress.annotations | object | `{}` |  |
| components.mic_ui.ingress.className | string | `""` |  |
| components.mic_ui.ingress.enabled | bool | `true` | Enable or disable ingress for MIC UI |
| components.mic_ui.ingress.hosts[0].host | string | `"mic.mint.local"` |  |
| components.mic_ui.ingress.hosts[0].paths[0].path | string | `"/"` |  |
| components.mic_ui.ingress.hosts[0].paths[0].pathType | string | `"ImplementationSpecific"` |  |
| components.mic_ui.ingress.tls | list | `[]` |  |
| components.mic_ui.resources | object | `{}` | Resource specifications for MIC UI |
| components.model_catalog_api.api_version | string | `"v1.8.0"` | API version for Model Catalog API |
| components.model_catalog_api.enabled | bool | `true` | Enable or disable Model Catalog API |
| components.model_catalog_api.environment.context_dir | string | `"contexts/"` | Context directory for Model Catalog API |
| components.model_catalog_api.environment.queries_dir | string | `"queries/"` | Queries directory for Model Catalog API |
| components.model_catalog_api.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for Model Catalog API |
| components.model_catalog_api.image.repository | string | `"mintproject/model-catalog-fastapi"` | Docker image repository for Model Catalog API |
| components.model_catalog_api.image.tag | string | `"c5f784785c52034f75de24c46b89907c74a14312"` | Docker image tag for Model Catalog API |
| components.model_catalog_api.ingress.annotations."nginx.ingress.kubernetes.io/enable-cors" | string | `"true"` |  |
| components.model_catalog_api.ingress.className | string | `""` |  |
| components.model_catalog_api.ingress.enabled | bool | `true` | Enable or disable ingress for Model Catalog API |
| components.model_catalog_api.ingress.hosts[0].host | string | `"api.models.mint.local"` |  |
| components.model_catalog_api.ingress.hosts[0].paths[0].path | string | `"/"` |  |
| components.model_catalog_api.ingress.hosts[0].paths[0].pathType | string | `"ImplementationSpecific"` |  |
| components.model_catalog_api.ingress.tls | list | `[]` |  |
| components.model_catalog_api.resources | object | `{}` | Resource specifications for Model Catalog API |
| components.model_catalog_endpoint.enabled | bool | `true` | Enable or disable Model Catalog Endpoint |
| components.model_catalog_endpoint.environment.backup_file | string | `"/fuseki-base/seeds/model-catalog.trig"` | Backup file path for Model Catalog Endpoint |
| components.model_catalog_endpoint.environment.dataset | string | `"modelcatalog"` | Dataset name for Model Catalog Endpoint Apache Jena Fuseki |
| components.model_catalog_endpoint.environment.graph_base | string | `"http://endpoint.mint.isi.edu/modelCatalog-1.8.0/data/"` | Graph base URL for Model Catalog Endpoint. The triples are stored in this graph |
| components.model_catalog_endpoint.environment.prefix | string | `"https://w3id.org/okn/i/mint/"` | Prefix URL for Model Catalog Endpoint |
| components.model_catalog_endpoint.environment.seeds_url | string | `"https://raw.githubusercontent.com/mintproject/model-catalog-endpoint/main/data/model-catalog.trig"` | Seeds URL for Model Catalog Endpoint |
| components.model_catalog_endpoint.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for Model Catalog Endpoint |
| components.model_catalog_endpoint.image.repository | string | `"mintproject/model-catalog-endpoint"` | Docker image repository for Model Catalog Endpoint |
| components.model_catalog_endpoint.image.tag | string | `"29256555a6fbaefae4729d5cd259564708a4ab04"` | Docker image tag for Model Catalog Endpoint |
| components.model_catalog_endpoint.ingress.annotations | object | `{}` |  |
| components.model_catalog_endpoint.ingress.className | string | `""` |  |
| components.model_catalog_endpoint.ingress.enabled | bool | `true` | Enable or disable ingress for Model Catalog Endpoint |
| components.model_catalog_endpoint.ingress.hosts[0].host | string | `"endpoint.models.mint.local"` |  |
| components.model_catalog_endpoint.ingress.hosts[0].paths[0].path | string | `"/"` |  |
| components.model_catalog_endpoint.ingress.hosts[0].paths[0].pathType | string | `"ImplementationSpecific"` |  |
| components.model_catalog_endpoint.ingress.tls | list | `[]` |  |
| components.model_catalog_endpoint.persistence.accessModes[0] | string | `"ReadWriteOnce"` |  |
| components.model_catalog_endpoint.persistence.annotations."helm.sh/resource-policy" | string | `"keep"` |  |
| components.model_catalog_endpoint.persistence.dataSource | object | `{}` |  |
| components.model_catalog_endpoint.persistence.enabled | bool | `true` | Enable or disable persistence for Model Catalog Endpoint |
| components.model_catalog_endpoint.persistence.existingClaim | string | `""` |  |
| components.model_catalog_endpoint.persistence.selector | object | `{}` |  |
| components.model_catalog_endpoint.persistence.size | string | `"20Gi"` |  |
| components.model_catalog_endpoint.persistence.storageClass | string | `""` |  |
| components.model_catalog_endpoint.resources | object | `{}` | Resource specifications for Model Catalog Endpoint |
| components.model_catalog_explorer.enabled | bool | `true` | Enable or disable Model Catalog Explorer |
| components.model_catalog_explorer.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for Model Catalog Explorer |
| components.model_catalog_explorer.image.repository | string | `"mintproject/model-catalog-explorer"` | Docker image repository for Model Catalog Explorer |
| components.model_catalog_explorer.image.tag | string | `"0b2f9f0a9124076aeb492add2f123d0757066f6b"` | Docker image tag for Model Catalog Explorer |
| components.model_catalog_explorer.ingress.annotations | object | `{}` |  |
| components.model_catalog_explorer.ingress.className | string | `""` |  |
| components.model_catalog_explorer.ingress.enabled | bool | `true` | Enable or disable ingress for Model Catalog Explorer |
| components.model_catalog_explorer.ingress.hosts[0].host | string | `"models.mint.local"` |  |
| components.model_catalog_explorer.ingress.hosts[0].paths[0].path | string | `"/"` |  |
| components.model_catalog_explorer.ingress.hosts[0].paths[0].pathType | string | `"ImplementationSpecific"` |  |
| components.model_catalog_explorer.ingress.tls | list | `[]` |  |
| components.model_catalog_explorer.resources | object | `{}` | Resource specifications for Model Catalog Explorer |
| components.ui.enabled | bool | `true` | Enable or disable UI |
| components.ui.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for UI |
| components.ui.image.repository | string | `"mintproject/mint-ui-lit"` | Docker image repository for UI |
| components.ui.image.tag | string | `"858ce054d1f757d0f6ec3765e878ec54091bb110"` | Docker image tag for UI |
| components.ui.ingress.annotations | object | `{}` |  |
| components.ui.ingress.className | string | `""` |  |
| components.ui.ingress.enabled | bool | `true` | Enable or disable ingress for UI |
| components.ui.ingress.hosts[0].host | string | `"mint.local"` |  |
| components.ui.ingress.hosts[0].paths[0].path | string | `"/"` |  |
| components.ui.ingress.hosts[0].paths[0].pathType | string | `"ImplementationSpecific"` |  |
| components.ui.ingress.tls | list | `[]` |  |
| components.ui.resources | object | `{}` | Resource specifications for UI |
| default_user | string | `"mint@isi.edu"` | Default user email |
| external_services.ckan.enabled | bool | `false` | Enable or disable CKAN service |
| external_services.ckan.extra.owner_organization_id | string | `""` | Owner organization ID for CKAN service |
| external_services.ckan.extra.owner_provenance_id | string | `""` | Owner provenance ID for CKAN service |
| external_services.ckan.type | string | `"CKAN"` | CKAN service type |
| external_services.ckan.url | string | `"http://localhost:5000"` | CKAN service configuration |
| external_services.kubernetes.cpu_limit | string | `"256m"` | Job CPU limit |
| external_services.kubernetes.enabled | bool | `false` | Enable or disable Kubernetes service to run jobs used by Ensemble Manager |
| external_services.kubernetes.memory_limit | string | `"512Mi"` | Job memory limit |
| external_services.kubernetes.namespace | string | `"default"` | Kubernetes namespace |
| external_services.kubernetes.node_affinity | bool | `true` | Toggle for node affinity. The job will be scheduled on the same node as the Ensemble Manager |
| external_services.s3.bucket | string | `""` | S3 bucket |
| external_services.s3.enabled | bool | `false` | Enable or disable S3 |
| external_services.s3.region | string | `""` | S3 region |
| external_services.s3.type | string | `"S3"` | S3 configuration |
| fullnameOverride | string | `""` |  |
| google.maps.key | string | `"AIzaSyAkRnERo4F4dy9AhdrWHAN5vdJWs0vZCgM"` | API key for Google Maps |
| hostname | string | `"localhost"` | Hostname for the application |
| imagePullSecrets | list | `[]` |  |
| jobs.hasura.enabled | bool | `true` | Enable or disable MINT Database initialization |
| jobs.hasura.resources | object | `{}` | Resource specifications for MINT Database initialization |
| jobs.model_catalog_endpoint.enabled | bool | `true` | Enable or disable Model Catalog API initialization |
| jobs.model_catalog_endpoint.resources | object | `{}` | Resource specifications for Model Catalog API initialization |
| nameOverride | string | `""` |  |
| nodeSelector | object | `{}` |  |
| podAnnotations | object | `{}` |  |
| podSecurityContext | object | `{}` |  |
| resources | object | `{}` |  |
| secrets.backups.s3 | object | `{"access_key":"CHANGEME","bucket":"CHANGEME","endpoint":"example.com","path":"CHANGEME","region":null,"secret_key":"CHANGEME"}` | S3 configuration for backups of MINT databases |
| secrets.backups.s3.access_key | string | `"CHANGEME"` | Access key for S3 |
| secrets.backups.s3.bucket | string | `"CHANGEME"` | Region for S3 |
| secrets.backups.s3.endpoint | string | `"example.com"` | Url for S3 |
| secrets.backups.s3.path | string | `"CHANGEME"` | Bucket for S3 |
| secrets.backups.s3.region | string | `nil` | Path for S3 |
| secrets.backups.s3.secret_key | string | `"CHANGEME"` | Secret key for S3 |
| secrets.database.data_catalog.database | string | `"datacatalog"` | Database name for Data Catalog database |
| secrets.database.data_catalog.password | string | `"CHANGEME"` | Password for Data Catalog database |
| secrets.database.data_catalog.username | string | `"datacatalog"` | Username for Data Catalog database |
| secrets.database.hasura.database | string | `"hasura"` | Database name for Hasura database |
| secrets.database.hasura.password | string | `"CHANGEME"` | Password for Hasura database |
| secrets.database.hasura.username | string | `"hasura"` | Username for Hasura database |
| secrets.database.mic_api.database | string | `"mic"` | Database name for Mic API database |
| secrets.database.mic_api.password | string | `"CHANGEME"` | Password for Mic API database |
| secrets.database.mic_api.username | string | `"mic"` | Username for Mic API database |
| secrets.database.model_catalog_endpoint.password | string | `"CHANGEME"` | Password for Model Catalog Apache Jena Fuseki database |
| secrets.database.model_catalog_endpoint.username | string | `"admin"` | Username for Model Catalog Apache Jena Fuseki database |
| secrets.external_services.ckan.api_key | string | `"CHANGEME"` | API key for CKAN service. Used by Ensemble Manager to upload data |
| secrets.external_services.s3.access_key | string | `"CHANGEME"` | Access key for S3. Used by Ensemble Manager to upload data |
| secrets.external_services.s3.secret_key | string | `"CHANGEME"` | Secret key for S3 |
| secrets.hasura.admin_secret | string | `"CHANGEME"` | Admin secret for Hasura used to access the console |
| secrets.hasura.jwt_secret | string | `"{\"type\": \"RS256\", \"key\": \"-----BEGIN CERTIFICATE-----\\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmyQQ56WKKsVCUs8n9swlv5DV7st7UUdvNoDSnwovdU2vinQQ686//vRqlUJ5vpyI7r75qTXCPkXUitDhPvGEMfChnb9tuWdymSyZmMmT+34oaYo/2bGSZjTlLRVfRJjUnFYeWoVLoXVKJolyDWtU6bXbFNnUyysb/6YIpg5sSwxkLs/9yl6HsWdFconxPJO6KmMPSjcOc0fZermNq+cOEvj1OqRhVkxDqBebreI+zcgrJHNSN8d6cxTmfVQl1jIPHvxE5oN7qUdfYmK4D+SOlj8FlkUvwis+3Ix2AQsvNoOD1OzuqUOd/FpXBnEGaeTq9EMwDxplNqltR/qT3/poUwIDAQAB\\n-----END CERTIFICATE-----\", \"allowed_skew\": 2}"` | JWT verification secret for Hasura |
| securityContext | object | `{}` |  |
| service | object | `{"port":80,"type":"ClusterIP"}` | Service configuration |
| service.port | int | `80` | Port number for the service |
| service.type | string | `"ClusterIP"` | Type of Kubernetes service |
| serviceAccount.annotations | object | `{}` |  |
| serviceAccount.create | bool | `true` |  |
| serviceAccount.name | string | `""` |  |
| tolerations | list | `[]` |  |
| welcome_message | string | `"Welcome to MINT"` | Welcome message for MINT |

----------------------------------------------
Autogenerated from chart metadata using [helm-docs v1.14.2](https://github.com/norwoodj/helm-docs/releases/v1.14.2)
