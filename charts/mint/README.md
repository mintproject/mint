# MINT

![Version: 3.4.0](https://img.shields.io/badge/Version-3.4.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 1.16.3](https://img.shields.io/badge/AppVersion-1.16.3-informational?style=flat-square)

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
| auth.client_id | string | `"model_catalog"` |  |
| auth.realm | string | `"production"` |  |
| auth.ui_client_id | string | `"mint-ui"` |  |
| auth.url | string | `"https://auth.mint.isi.edu/"` |  |
| autoscaling.enabled | bool | `false` |  |
| autoscaling.maxReplicas | int | `100` |  |
| autoscaling.minReplicas | int | `1` |  |
| autoscaling.targetCPUUtilizationPercentage | int | `80` |  |
| components | object | `{"backups":{"enabled":false},"cromo":{"enabled":false,"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/cromo","tag":"3c75586989aedf2573c37f5352f960c294377931"},"ingress":{"annotations":{},"className":"","enabled":true,"hosts":[{"host":"cromo.mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"resources":{}},"data_catalog":{"arm_image":{"pullPolicy":"IfNotPresent","repository":"mintproject/data-catalog","tag":"8a6af95cae183320d596dc5219f2f76d1f234749"},"enabled":true,"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/data-catalog","tag":"9be70359feabe03ed55bfdbf92c20a7e43ab928b"},"ingress":{"annotations":{},"className":"","enabled":true,"hosts":[{"host":"datacatalog.mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"resources":{}},"data_catalog_db":{"arm_image":{"pullPolicy":"IfNotPresent","repository":"mintproject/data-catalog-db","tag":"8a6af95cae183320d596dc5219f2f76d1f234749"},"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/data-catalog-db","tag":"9be70359feabe03ed55bfdbf92c20a7e43ab928b"},"persistence":{"accessModes":["ReadWriteOnce"],"annotations":{"helm.sh/resource-policy":"keep"},"dataSource":{},"enabled":true,"existingClaim":"","selector":{},"size":"30Gi","storageClass":""},"resources":{}},"ensemble_manager":{"api_version":"v1","config":{"execution_engine":{"basePath":"","code_dir":"/home/node/app/data/code","data_dir":"/home/node/app/data/data","data_url":"s3://mintdata","log_dir":"/home/node/app/data/logs","log_url":"s3://mintdata","parallelism":2,"temp_dir":"/home/node/app/data/temp","type":"localex","username":"","wings_dot_path":"","wings_export_url":"","wings_ont_url":"","wings_storage":""},"graphql":{"enable_ssl":false,"endpoint":"localhost:30003/v1/graphql","use_secret":true}},"enabled":true,"environment":{"data_dir":"/var/mint"},"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/ensemble-manager","tag":"3e1f40865e647a8025b06ac63178b0eed64aed3e"},"ingress":{"annotations":{},"className":"","enabled":true,"hosts":[{"host":"ensemble-manager.mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"persistence":{"accessModes":["ReadWriteOnce"],"annotations":{"helm.sh/resource-policy":"keep"},"dataSource":{},"enabled":true,"existingClaim":"","name":"ensemble-manager","selector":{},"size":"10Gi","storageClass":""},"resources":{},"serviceAccountName":"default","strategy":{"type":"Recreate"}},"hasura":{"enabled":true,"environment":{"enable_console":true,"enable_dev_mode":false,"unauthorized_role":"anonymous"},"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/graphql-engine","tag":"305c0dbeba1878eafe348f21fc300fbfc017d9dc"},"ingress":{"annotations":{},"className":null,"enabled":true,"hosts":[{"host":"graphql.mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"resources":{}},"hasura_db":{"arm_image":{"pullPolicy":"IfNotPresent","repository":"imresamu/postgis-arm64","tag":"12-3.4-alpine"},"image":{"pullPolicy":"IfNotPresent","repository":"postgis/postgis","tag":"10-3.2-alpine"},"persistence":{"accessModes":["ReadWriteOnce"],"annotations":{"helm.sh/resource-policy":"keep"},"dataSource":{},"enabled":true,"existingClaim":"","selector":{},"size":"30Gi","storageClass":""},"resources":{}},"mic_api":{"enabled":false,"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/mic-api","tag":"ee71a1a364fc3d384f85243684ad95d37913b049"},"ingress":{"annotations":{},"className":"","enabled":true,"hosts":[{"host":"api.mic.mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"resources":{}},"mic_api_db":{"image":{"pullPolicy":"IfNotPresent","repository":"postgres","tag":14.6},"persistence":{"accessModes":["ReadWriteOnce"],"annotations":{"helm.sh/resource-policy":"keep"},"dataSource":{},"enabled":true,"existingClaim":"","selector":{},"size":"10Gi","storageClass":""},"resources":{}},"mic_ui":{"enabled":false,"image":{"environment":{"airflow_url":"https://airflow.mint.isi.edu/api/v1","api_url":null},"pullPolicy":"IfNotPresent","repository":"mintproject/mic-web","tag":"a736ac5841d471de4679bec80c13b0fb646ae073"},"ingress":{"annotations":{},"className":"","enabled":true,"hosts":[{"host":"mic.mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"resources":{}},"model_catalog_api":{"api_version":"v1.8.0","enabled":true,"environment":{"context_dir":"contexts/","queries_dir":"queries/"},"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/model-catalog-fastapi","tag":"c5f784785c52034f75de24c46b89907c74a14312"},"ingress":{"annotations":{"nginx.ingress.kubernetes.io/enable-cors":"true"},"className":"","enabled":true,"hosts":[{"host":"api.models.mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"resources":{}},"model_catalog_endpoint":{"enabled":true,"environment":{"backup_file":"/fuseki-base/seeds/model-catalog.trig","dataset":"modelcatalog","graph_base":"http://endpoint.mint.isi.edu/modelCatalog-1.8.0/data/","prefix":"https://w3id.org/okn/i/mint/","seeds_url":"https://raw.githubusercontent.com/mintproject/model-catalog-endpoint/main/data/model-catalog.trig"},"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/model-catalog-endpoint","tag":"29256555a6fbaefae4729d5cd259564708a4ab04"},"ingress":{"annotations":{},"className":"","enabled":true,"hosts":[{"host":"endpoint.models.mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"persistence":{"accessModes":["ReadWriteOnce"],"annotations":{"helm.sh/resource-policy":"keep"},"dataSource":{},"enabled":true,"existingClaim":"","selector":{},"size":"20Gi","storageClass":""},"resources":{}},"model_catalog_explorer":{"enabled":true,"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/model-catalog-explorer","tag":"0b2f9f0a9124076aeb492add2f123d0757066f6b"},"ingress":{"annotations":{},"className":"","enabled":true,"hosts":[{"host":"models.mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"resources":{}},"ui":{"enabled":true,"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/mint-ui-lit","tag":"858ce054d1f757d0f6ec3765e878ec54091bb110"},"ingress":{"annotations":{},"className":"","enabled":true,"hosts":[{"host":"mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"resources":{}}}` | Configuration for various MINT components |
| components.backups | object | `{"enabled":false}` | Backup component configuration |
| components.backups.enabled | bool | `false` | Enable or disable backups |
| components.cromo | object | `{"enabled":false,"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/cromo","tag":"3c75586989aedf2573c37f5352f960c294377931"},"ingress":{"annotations":{},"className":"","enabled":true,"hosts":[{"host":"cromo.mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"resources":{}}` | Cromo component configuration |
| components.cromo.enabled | bool | `false` | Enable or disable Cromo |
| components.cromo.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for Cromo |
| components.cromo.image.repository | string | `"mintproject/cromo"` | Docker image repository for Cromo |
| components.cromo.image.tag | string | `"3c75586989aedf2573c37f5352f960c294377931"` | Docker image tag for Cromo |
| components.cromo.ingress.enabled | bool | `true` | Enable or disable ingress for Cromo |
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
| components.data_catalog_db | object | `{"arm_image":{"pullPolicy":"IfNotPresent","repository":"mintproject/data-catalog-db","tag":"8a6af95cae183320d596dc5219f2f76d1f234749"},"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/data-catalog-db","tag":"9be70359feabe03ed55bfdbf92c20a7e43ab928b"},"persistence":{"accessModes":["ReadWriteOnce"],"annotations":{"helm.sh/resource-policy":"keep"},"dataSource":{},"enabled":true,"existingClaim":"","selector":{},"size":"30Gi","storageClass":""},"resources":{}}` | Data Catalog database configuration |
| components.data_catalog_db.arm_image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for ARM-based Data Catalog database |
| components.data_catalog_db.arm_image.repository | string | `"mintproject/data-catalog-db"` | Docker image repository for ARM-based Data Catalog database |
| components.data_catalog_db.arm_image.tag | string | `"8a6af95cae183320d596dc5219f2f76d1f234749"` | Docker image tag for ARM-based Data Catalog database |
| components.data_catalog_db.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for Data Catalog database |
| components.data_catalog_db.image.repository | string | `"mintproject/data-catalog-db"` | Docker image repository for Data Catalog database |
| components.data_catalog_db.image.tag | string | `"9be70359feabe03ed55bfdbf92c20a7e43ab928b"` | Docker image tag for Data Catalog database |
| components.data_catalog_db.persistence.enabled | bool | `true` | Enable or disable persistence for Data Catalog database |
| components.data_catalog_db.resources | object | `{}` | Resource specifications for Data Catalog database |
| components.ensemble_manager | object | `{"api_version":"v1","config":{"execution_engine":{"basePath":"","code_dir":"/home/node/app/data/code","data_dir":"/home/node/app/data/data","data_url":"s3://mintdata","log_dir":"/home/node/app/data/logs","log_url":"s3://mintdata","parallelism":2,"temp_dir":"/home/node/app/data/temp","type":"localex","username":"","wings_dot_path":"","wings_export_url":"","wings_ont_url":"","wings_storage":""},"graphql":{"enable_ssl":false,"endpoint":"localhost:30003/v1/graphql","use_secret":true}},"enabled":true,"environment":{"data_dir":"/var/mint"},"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/ensemble-manager","tag":"3e1f40865e647a8025b06ac63178b0eed64aed3e"},"ingress":{"annotations":{},"className":"","enabled":true,"hosts":[{"host":"ensemble-manager.mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"persistence":{"accessModes":["ReadWriteOnce"],"annotations":{"helm.sh/resource-policy":"keep"},"dataSource":{},"enabled":true,"existingClaim":"","name":"ensemble-manager","selector":{},"size":"10Gi","storageClass":""},"resources":{},"serviceAccountName":"default","strategy":{"type":"Recreate"}}` | Ensemble Manager component configuration |
| components.ensemble_manager.api_version | string | `"v1"` | API version for Ensemble Manager |
| components.ensemble_manager.enabled | bool | `true` | Enable or disable Ensemble Manager |
| components.ensemble_manager.image | object | `{"pullPolicy":"IfNotPresent","repository":"mintproject/ensemble-manager","tag":"3e1f40865e647a8025b06ac63178b0eed64aed3e"}` | Docker image repository for Ensemble Manager |
| components.ensemble_manager.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for Ensemble Manager |
| components.ensemble_manager.image.repository | string | `"mintproject/ensemble-manager"` | Docker image repository for Ensemble Manager |
| components.ensemble_manager.image.tag | string | `"3e1f40865e647a8025b06ac63178b0eed64aed3e"` | Docker image tag for Ensemble Manager |
| components.ensemble_manager.resources | object | `{}` | Resource specifications for Ensemble Manager |
| components.ensemble_manager.serviceAccountName | string | `"default"` | Service account name for Ensemble Manager, used to run jobs |
| components.ensemble_manager.strategy | object | `{"type":"Recreate"}` | Ensemble Manager deployment strategy (Recreate or RollingUpdate) |
| components.ensemble_manager.strategy.type | string | `"Recreate"` | Type of deployment strategy |
| components.hasura | object | `{"enabled":true,"environment":{"enable_console":true,"enable_dev_mode":false,"unauthorized_role":"anonymous"},"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/graphql-engine","tag":"305c0dbeba1878eafe348f21fc300fbfc017d9dc"},"ingress":{"annotations":{},"className":null,"enabled":true,"hosts":[{"host":"graphql.mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"resources":{}}` | Hasura component configuration |
| components.hasura.enabled | bool | `true` | Enable or disable Hasura |
| components.hasura.environment.enable_console | bool | `true` | Enable or disable Hasura console |
| components.hasura.environment.enable_dev_mode | bool | `false` | Enable or disable Hasura dev mode |
| components.hasura.environment.unauthorized_role | string | `"anonymous"` | Unauthorized role for Hasura |
| components.hasura.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for Hasura |
| components.hasura.image.repository | string | `"mintproject/graphql-engine"` | Docker image repository for Hasura |
| components.hasura.image.tag | string | `"305c0dbeba1878eafe348f21fc300fbfc017d9dc"` | Docker image tag for Hasura |
| components.hasura.ingress.enabled | bool | `true` | Enable or disable ingress for Hasura |
| components.hasura.resources | object | `{}` | Resource specifications for Hasura |
| components.hasura_db | object | `{"arm_image":{"pullPolicy":"IfNotPresent","repository":"imresamu/postgis-arm64","tag":"12-3.4-alpine"},"image":{"pullPolicy":"IfNotPresent","repository":"postgis/postgis","tag":"10-3.2-alpine"},"persistence":{"accessModes":["ReadWriteOnce"],"annotations":{"helm.sh/resource-policy":"keep"},"dataSource":{},"enabled":true,"existingClaim":"","selector":{},"size":"30Gi","storageClass":""},"resources":{}}` | Hasura database configuration |
| components.hasura_db.arm_image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for ARM-based Hasura database |
| components.hasura_db.arm_image.repository | string | `"imresamu/postgis-arm64"` | Docker image repository for ARM-based Hasura database |
| components.hasura_db.arm_image.tag | string | `"12-3.4-alpine"` | Docker image tag for ARM-based Hasura database |
| components.hasura_db.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for Hasura database |
| components.hasura_db.image.repository | string | `"postgis/postgis"` | Docker image repository for Hasura database |
| components.hasura_db.image.tag | string | `"10-3.2-alpine"` | Docker image tag for Hasura database |
| components.hasura_db.persistence.enabled | bool | `true` | Enable or disable persistence for Hasura database |
| components.hasura_db.resources | object | `{}` | Resource specifications for Hasura database |
| components.mic_api | object | `{"enabled":false,"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/mic-api","tag":"ee71a1a364fc3d384f85243684ad95d37913b049"},"ingress":{"annotations":{},"className":"","enabled":true,"hosts":[{"host":"api.mic.mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"resources":{}}` | MIC API component configuration |
| components.mic_api.enabled | bool | `false` | Enable or disable MIC API |
| components.mic_api.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for MIC API |
| components.mic_api.image.repository | string | `"mintproject/mic-api"` | Docker image repository for MIC API |
| components.mic_api.image.tag | string | `"ee71a1a364fc3d384f85243684ad95d37913b049"` | Docker image tag for MIC API |
| components.mic_api.ingress.enabled | bool | `true` | Enable or disable ingress for MIC API |
| components.mic_api.resources | object | `{}` | Resource specifications for MIC API |
| components.mic_api_db | object | `{"image":{"pullPolicy":"IfNotPresent","repository":"postgres","tag":14.6},"persistence":{"accessModes":["ReadWriteOnce"],"annotations":{"helm.sh/resource-policy":"keep"},"dataSource":{},"enabled":true,"existingClaim":"","selector":{},"size":"10Gi","storageClass":""},"resources":{}}` | MIC API database configuration |
| components.mic_api_db.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for MIC API database |
| components.mic_api_db.image.repository | string | `"postgres"` | Docker image repository for MIC API database |
| components.mic_api_db.image.tag | float | `14.6` | Docker image tag for MIC API database |
| components.mic_api_db.persistence.enabled | bool | `true` | Enable or disable persistence for MIC API database |
| components.mic_api_db.resources | object | `{}` | Resource specifications for MIC API database |
| components.mic_ui | object | `{"enabled":false,"image":{"environment":{"airflow_url":"https://airflow.mint.isi.edu/api/v1","api_url":null},"pullPolicy":"IfNotPresent","repository":"mintproject/mic-web","tag":"a736ac5841d471de4679bec80c13b0fb646ae073"},"ingress":{"annotations":{},"className":"","enabled":true,"hosts":[{"host":"mic.mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"resources":{}}` | MIC UI component configuration |
| components.mic_ui.enabled | bool | `false` | Enable or disable MIC UI |
| components.mic_ui.image.environment.airflow_url | string | `"https://airflow.mint.isi.edu/api/v1"` | Airflow URL for MIC UI |
| components.mic_ui.image.environment.api_url | string | `nil` | API URL for MIC UI |
| components.mic_ui.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for MIC UI |
| components.mic_ui.image.repository | string | `"mintproject/mic-web"` | Docker image repository for MIC UI |
| components.mic_ui.image.tag | string | `"a736ac5841d471de4679bec80c13b0fb646ae073"` | Docker image tag for MIC UI |
| components.mic_ui.ingress.enabled | bool | `true` | Enable or disable ingress for MIC UI |
| components.mic_ui.resources | object | `{}` | Resource specifications for MIC UI |
| components.model_catalog_api | object | `{"api_version":"v1.8.0","enabled":true,"environment":{"context_dir":"contexts/","queries_dir":"queries/"},"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/model-catalog-fastapi","tag":"c5f784785c52034f75de24c46b89907c74a14312"},"ingress":{"annotations":{"nginx.ingress.kubernetes.io/enable-cors":"true"},"className":"","enabled":true,"hosts":[{"host":"api.models.mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"resources":{}}` | Model Catalog API component configuration |
| components.model_catalog_api.api_version | string | `"v1.8.0"` | API version for Model Catalog API |
| components.model_catalog_api.enabled | bool | `true` | Enable or disable Model Catalog API |
| components.model_catalog_api.environment.context_dir | string | `"contexts/"` | Context directory for Model Catalog API |
| components.model_catalog_api.environment.queries_dir | string | `"queries/"` | Queries directory for Model Catalog API |
| components.model_catalog_api.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for Model Catalog API |
| components.model_catalog_api.image.repository | string | `"mintproject/model-catalog-fastapi"` | Docker image repository for Model Catalog API |
| components.model_catalog_api.image.tag | string | `"c5f784785c52034f75de24c46b89907c74a14312"` | Docker image tag for Model Catalog API |
| components.model_catalog_api.ingress.enabled | bool | `true` | Enable or disable ingress for Model Catalog API |
| components.model_catalog_api.resources | object | `{}` | Resource specifications for Model Catalog API |
| components.model_catalog_endpoint | object | `{"enabled":true,"environment":{"backup_file":"/fuseki-base/seeds/model-catalog.trig","dataset":"modelcatalog","graph_base":"http://endpoint.mint.isi.edu/modelCatalog-1.8.0/data/","prefix":"https://w3id.org/okn/i/mint/","seeds_url":"https://raw.githubusercontent.com/mintproject/model-catalog-endpoint/main/data/model-catalog.trig"},"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/model-catalog-endpoint","tag":"29256555a6fbaefae4729d5cd259564708a4ab04"},"ingress":{"annotations":{},"className":"","enabled":true,"hosts":[{"host":"endpoint.models.mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"persistence":{"accessModes":["ReadWriteOnce"],"annotations":{"helm.sh/resource-policy":"keep"},"dataSource":{},"enabled":true,"existingClaim":"","selector":{},"size":"20Gi","storageClass":""},"resources":{}}` | Model Catalog Endpoint component configuration |
| components.model_catalog_endpoint.enabled | bool | `true` | Enable or disable Model Catalog Endpoint |
| components.model_catalog_endpoint.environment.backup_file | string | `"/fuseki-base/seeds/model-catalog.trig"` | Backup file path for Model Catalog Endpoint |
| components.model_catalog_endpoint.environment.dataset | string | `"modelcatalog"` | Dataset name for Model Catalog Endpoint |
| components.model_catalog_endpoint.environment.graph_base | string | `"http://endpoint.mint.isi.edu/modelCatalog-1.8.0/data/"` | Graph base URL for Model Catalog Endpoint |
| components.model_catalog_endpoint.environment.prefix | string | `"https://w3id.org/okn/i/mint/"` | Prefix URL for Model Catalog Endpoint |
| components.model_catalog_endpoint.environment.seeds_url | string | `"https://raw.githubusercontent.com/mintproject/model-catalog-endpoint/main/data/model-catalog.trig"` | Seeds URL for Model Catalog Endpoint |
| components.model_catalog_endpoint.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for Model Catalog Endpoint |
| components.model_catalog_endpoint.image.repository | string | `"mintproject/model-catalog-endpoint"` | Docker image repository for Model Catalog Endpoint |
| components.model_catalog_endpoint.image.tag | string | `"29256555a6fbaefae4729d5cd259564708a4ab04"` | Docker image tag for Model Catalog Endpoint |
| components.model_catalog_endpoint.ingress.enabled | bool | `true` | Enable or disable ingress for Model Catalog Endpoint |
| components.model_catalog_endpoint.persistence.enabled | bool | `true` | Enable or disable persistence for Model Catalog Endpoint |
| components.model_catalog_endpoint.resources | object | `{}` | Resource specifications for Model Catalog Endpoint |
| components.model_catalog_explorer | object | `{"enabled":true,"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/model-catalog-explorer","tag":"0b2f9f0a9124076aeb492add2f123d0757066f6b"},"ingress":{"annotations":{},"className":"","enabled":true,"hosts":[{"host":"models.mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"resources":{}}` | Model Catalog Explorer component configuration |
| components.model_catalog_explorer.enabled | bool | `true` | Enable or disable Model Catalog Explorer |
| components.model_catalog_explorer.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for Model Catalog Explorer |
| components.model_catalog_explorer.image.repository | string | `"mintproject/model-catalog-explorer"` | Docker image repository for Model Catalog Explorer |
| components.model_catalog_explorer.image.tag | string | `"0b2f9f0a9124076aeb492add2f123d0757066f6b"` | Docker image tag for Model Catalog Explorer |
| components.model_catalog_explorer.ingress.enabled | bool | `true` | Enable or disable ingress for Model Catalog Explorer |
| components.model_catalog_explorer.resources | object | `{}` | Resource specifications for Model Catalog Explorer |
| components.ui | object | `{"enabled":true,"image":{"pullPolicy":"IfNotPresent","repository":"mintproject/mint-ui-lit","tag":"858ce054d1f757d0f6ec3765e878ec54091bb110"},"ingress":{"annotations":{},"className":"","enabled":true,"hosts":[{"host":"mint.local","paths":[{"path":"/","pathType":"ImplementationSpecific"}]}],"tls":[]},"resources":{}}` | UI component configuration |
| components.ui.enabled | bool | `true` | Enable or disable UI |
| components.ui.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy for UI |
| components.ui.image.repository | string | `"mintproject/mint-ui-lit"` | Docker image repository for UI |
| components.ui.image.tag | string | `"858ce054d1f757d0f6ec3765e878ec54091bb110"` | Docker image tag for UI |
| components.ui.ingress.enabled | bool | `true` | Enable or disable ingress for UI |
| components.ui.resources | object | `{}` | Resource specifications for UI |
| default_user | string | `"mint@isi.edu"` | Default user email |
| external_services.ckan.enabled | bool | `false` |  |
| external_services.ckan.extra.owner_organization_id | string | `""` |  |
| external_services.ckan.extra.owner_provenance_id | string | `""` |  |
| external_services.ckan.type | string | `"CKAN"` |  |
| external_services.ckan.url | string | `"http://localhost:5000"` |  |
| external_services.kubernetes.cpu_limit | string | `"256m"` |  |
| external_services.kubernetes.enabled | bool | `false` |  |
| external_services.kubernetes.memory_limit | string | `"512Mi"` |  |
| external_services.kubernetes.namespace | string | `"default"` |  |
| external_services.kubernetes.node_affinity | bool | `true` |  |
| external_services.s3.bucket | string | `""` |  |
| external_services.s3.enabled | bool | `false` |  |
| external_services.s3.region | string | `""` |  |
| external_services.s3.type | string | `"S3"` |  |
| fullnameOverride | string | `""` |  |
| google | object | `{"maps":{"key":"AIzaSyAkRnERo4F4dy9AhdrWHAN5vdJWs0vZCgM"}}` | Configuration for Google Services |
| google.maps | object | `{"key":"AIzaSyAkRnERo4F4dy9AhdrWHAN5vdJWs0vZCgM"}` | Google Maps Service |
| google.maps.key | string | `"AIzaSyAkRnERo4F4dy9AhdrWHAN5vdJWs0vZCgM"` | API key for Google Maps |
| hostname | string | `"localhost"` | Hostname for the application |
| imagePullSecrets | list | `[]` |  |
| jobs | object | `{"hasura":{"enabled":true,"resources":{}},"model_catalog_endpoint":{"enabled":true,"resources":{}}}` | Configuration initialization jobs for MINT |
| jobs.hasura | object | `{"enabled":true,"resources":{}}` | Initialize MINT Database |
| jobs.hasura.enabled | bool | `true` | Enable or disable MINT Database initialization |
| jobs.hasura.resources | object | `{}` | Resource specifications for MINT Database initialization |
| jobs.model_catalog_endpoint | object | `{"enabled":true,"resources":{}}` | Initialize Model Catalog API |
| jobs.model_catalog_endpoint.enabled | bool | `true` | Enable or disable Model Catalog API initialization |
| jobs.model_catalog_endpoint.resources | object | `{}` | Resource specifications for Model Catalog API initialization |
| nameOverride | string | `""` |  |
| nodeSelector | object | `{}` |  |
| podAnnotations | object | `{}` |  |
| podSecurityContext | object | `{}` |  |
| resources | object | `{}` |  |
| secrets | object | `{"backups":{"s3":{"access_key":"CHANGEME","bucket":"CHANGEME","endpoint":"example.com","path":"CHANGEME","region":null,"secret_key":"CHANGEME"}},"database":{"data_catalog":{"database":"datacatalog","password":"CHANGEME","username":"datacatalog"},"hasura":{"database":"hasura","password":"CHANGEME","username":"hasura"},"mic_api":{"database":"mic","password":"CHANGEME","username":"mic"},"model_catalog_endpoint":{"password":"CHANGEME","username":"admin"}},"external_services":{"ckan":{"api_key":"CHANGEME"},"s3":{"access_key":"CHANGEME","secret_key":"CHANGEME"}},"hasura":{"admin_secret":"CHANGEME","jwt_secret":"{\"type\": \"RS256\", \"key\": \"-----BEGIN CERTIFICATE-----\\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmyQQ56WKKsVCUs8n9swlv5DV7st7UUdvNoDSnwovdU2vinQQ686//vRqlUJ5vpyI7r75qTXCPkXUitDhPvGEMfChnb9tuWdymSyZmMmT+34oaYo/2bGSZjTlLRVfRJjUnFYeWoVLoXVKJolyDWtU6bXbFNnUyysb/6YIpg5sSwxkLs/9yl6HsWdFconxPJO6KmMPSjcOc0fZermNq+cOEvj1OqRhVkxDqBebreI+zcgrJHNSN8d6cxTmfVQl1jIPHvxE5oN7qUdfYmK4D+SOlj8FlkUvwis+3Ix2AQsvNoOD1OzuqUOd/FpXBnEGaeTq9EMwDxplNqltR/qT3/poUwIDAQAB\\n-----END CERTIFICATE-----\", \"allowed_skew\": 2}"}}` | Secret configuration for MINT |
| secrets.backups | object | `{"s3":{"access_key":"CHANGEME","bucket":"CHANGEME","endpoint":"example.com","path":"CHANGEME","region":null,"secret_key":"CHANGEME"}}` | Backup configuration for MINT. Allow backups databases to S3 |
| secrets.backups.s3 | object | `{"access_key":"CHANGEME","bucket":"CHANGEME","endpoint":"example.com","path":"CHANGEME","region":null,"secret_key":"CHANGEME"}` | S3 configuration for backups |
| secrets.backups.s3.access_key | string | `"CHANGEME"` | Access key for S3 |
| secrets.backups.s3.bucket | string | `"CHANGEME"` | Region for S3 |
| secrets.backups.s3.endpoint | string | `"example.com"` | Url for S3 |
| secrets.backups.s3.path | string | `"CHANGEME"` | Bucket for S3 |
| secrets.backups.s3.region | string | `nil` | Path for S3 |
| secrets.backups.s3.secret_key | string | `"CHANGEME"` | Secret key for S3 |
| secrets.database | object | `{"data_catalog":{"database":"datacatalog","password":"CHANGEME","username":"datacatalog"},"hasura":{"database":"hasura","password":"CHANGEME","username":"hasura"},"mic_api":{"database":"mic","password":"CHANGEME","username":"mic"},"model_catalog_endpoint":{"password":"CHANGEME","username":"admin"}}` | Database configuration |
| secrets.database.data_catalog | object | `{"database":"datacatalog","password":"CHANGEME","username":"datacatalog"}` | Data Catalog database configuration |
| secrets.database.data_catalog.database | string | `"datacatalog"` | Database name for Data Catalog database |
| secrets.database.data_catalog.password | string | `"CHANGEME"` | Password for Data Catalog database |
| secrets.database.data_catalog.username | string | `"datacatalog"` | Username for Data Catalog database |
| secrets.database.hasura | object | `{"database":"hasura","password":"CHANGEME","username":"hasura"}` | Hasura database configuration |
| secrets.database.hasura.database | string | `"hasura"` | Database name for Hasura database |
| secrets.database.hasura.password | string | `"CHANGEME"` | Password for Hasura database |
| secrets.database.hasura.username | string | `"hasura"` | Username for Hasura database |
| secrets.database.mic_api | object | `{"database":"mic","password":"CHANGEME","username":"mic"}` | Mic API database configuration |
| secrets.database.mic_api.database | string | `"mic"` | Database name for Mic API database |
| secrets.database.mic_api.password | string | `"CHANGEME"` | Password for Mic API database |
| secrets.database.mic_api.username | string | `"mic"` | Username for Mic API database |
| secrets.database.model_catalog_endpoint | object | `{"password":"CHANGEME","username":"admin"}` | Model Catalog database configuration |
| secrets.database.model_catalog_endpoint.password | string | `"CHANGEME"` | Password for Model Catalog Apache Jena Fuseki database |
| secrets.database.model_catalog_endpoint.username | string | `"admin"` | Username for Model Catalog Apache Jena Fuseki database |
| secrets.external_services | object | `{"ckan":{"api_key":"CHANGEME"},"s3":{"access_key":"CHANGEME","secret_key":"CHANGEME"}}` | External services configuration |
| secrets.external_services.ckan | object | `{"api_key":"CHANGEME"}` | CKAN configuration: Used by ensemble manager |
| secrets.external_services.ckan.api_key | string | `"CHANGEME"` | API key for CKAN |
| secrets.external_services.s3 | object | `{"access_key":"CHANGEME","secret_key":"CHANGEME"}` | S3 configuration: Used by ensemble manager to upload data |
| secrets.external_services.s3.access_key | string | `"CHANGEME"` | Access key for S3 |
| secrets.external_services.s3.secret_key | string | `"CHANGEME"` | Secret key for S3 |
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
