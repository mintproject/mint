{{/*
Expand the name of the chart.
*/}}
{{- define "helm.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "helm.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "mint.prefix" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 13 | trimSuffix "-" -}}
{{- else -}}
{{- .Release.Name | trunc 13 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}


{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "helm.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "helm.labels" -}}
helm.sh/chart: {{ include "helm.chart" . }}
{{ include "helm.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "helm.selectorLabels" -}}
app.kubernetes.io/name: {{ include "helm.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "helm.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "helm.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}



{{/*
Create ports 
*/}}
{{- define "helm.ui_node_port" -}}
{{- if .Values.service.type }}
{{- if eq .Values.service.type "NodePort" }}
{{- if .Values.service.port }}
{{- .Values.service.port }}
{{- else }}
{{- 30000 }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}


{{- define "helm.cromo_node_port" -}}
{{- if .Values.service.type }}
{{- if eq .Values.service.type "NodePort" }}
{{- if .Values.service.port }}
{{- add .Values.service.port 1 }}
{{- else }}
{{- add 30000 1 }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}



{{- define "helm.data_catalog_node_port" -}}
{{- if .Values.service.type }}
{{- if eq .Values.service.type "NodePort" }}
{{- if .Values.service.port }}
{{- add .Values.service.port 2 }}
{{- else }}
{{- add 30000 2 }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}


{{- define "helm.hasura_node_port" -}}
{{- if .Values.service.type }}
{{- if eq .Values.service.type "NodePort" }}
{{- if .Values.service.port }}
{{- add .Values.service.port 3 }}
{{- else }}
{{- add 30000 3 }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}


{{- define "helm.model_catalog_api_node_port" -}}
{{- if .Values.service.type }}
{{- if eq .Values.service.type "NodePort" }}
{{- if .Values.service.port }}
{{- add .Values.service.port 4 }}
{{- else }}
{{- add 30000 4 }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{- define "helm.model_catalog_endpoint_node_port" -}}
{{- if .Values.service.type }}
{{- if eq .Values.service.type "NodePort" }}
{{- if .Values.service.port }}
{{- add .Values.service.port 5 }}
{{- else }}
{{- add 30000 5 }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{- define "helm.mic_api_node_port" -}}
{{- if .Values.service.type }}
{{- if eq .Values.service.type "NodePort" }}
{{- if .Values.service.port }}
{{- add .Values.service.port 6 }}
{{- else }}
{{- add 30000 6 }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{- define "helm.mic_ui_node_port" -}}
{{- if .Values.service.type }}
{{- if eq .Values.service.type "NodePort" }}
{{- if .Values.service.port }}
{{- add .Values.service.port  7 }}
{{- else }}
{{- add 30000 7 }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{- define "helm.ensemble_manager_node_port" -}}
{{- if .Values.service.type }}
{{- if eq .Values.service.type "NodePort" }}
{{- if .Values.service.port }}
{{- add .Values.service.port 8 }}
{{- else }}
{{- add 30000 8 }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{- define "helm.model_catalog_explorer_node_port" -}}
{{- if .Values.service.type }}
{{- if eq .Values.service.type "NodePort" }}
{{- if .Values.service.port }}
{{- add .Values.service.port 9 }}
{{- else }}
{{- add 30000 9 }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}


{{- define "helm.ensemble_manager_data_node_port" -}}
{{- if .Values.service.type }}
{{- if eq .Values.service.type "NodePort" }}
{{- if .Values.service.port }}
{{- add .Values.service.port 10 }}
{{- else }}
{{- add 30000 10 }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}


{{/*
Return  the proper Storage Class
{{ include "common.storage.class" ( dict "persistence" .Values.path.to.the.persistence "global" $) }}
*/}}
{{- define "common.storage.class" -}}

{{- $storageClass := .persistence.storageClass -}}

{{- if .global -}}
    {{- if .global.storageClass -}}
        {{- $storageClass = .global.storageClass -}}
    {{- end -}}
{{- end -}}

{{- if $storageClass -}}
  {{- if (eq "-" $storageClass) -}}
      {{- printf "storageClassName: \"\"" -}}
  {{- else }}
      {{- printf "storageClassName: %s" $storageClass -}}
  {{- end -}}
{{- end -}}

{{- end -}}

Renders a value that contains template.
Usage:
{{ include "common.tplvalues.render" ( dict "value" .Values.path.to.the.Value "context" $) }}
*/}}
{{- define "common.tplvalues.render" -}}
    {{- if typeIs "string" .value }}
        {{- tpl .value .context }}
    {{- else }}
        {{- tpl (.value | toYaml) .context }}
    {{- end }}
{{- end -}}
