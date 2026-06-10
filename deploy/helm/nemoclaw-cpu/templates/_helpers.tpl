{{/* SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. */}}
{{/* SPDX-License-Identifier: Apache-2.0 */}}
{{- define "nemoclaw-cpu.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "nemoclaw-cpu.fullname" -}}
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

{{- define "nemoclaw-cpu.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "nemoclaw-cpu.labels" -}}
helm.sh/chart: {{ include "nemoclaw-cpu.chart" . }}
{{ include "nemoclaw-cpu.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "nemoclaw-cpu.selectorLabels" -}}
app.kubernetes.io/name: {{ include "nemoclaw-cpu.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
component: cpu-agent
nemoclaw.ai/workload-type: cpu
{{- end }}

{{- define "nemoclaw-cpu.namespace" -}}
{{- .Values.namespace.name }}
{{- end }}

{{- define "nemoclaw-cpu.secretName" -}}
{{- if .Values.inference.existingSecret }}
{{- .Values.inference.existingSecret }}
{{- else }}
{{- .Values.inference.secretName }}
{{- end }}
{{- end }}

{{/*
  One replica per CPU: desired cluster CPUs == replica count; each pod requests 1 CPU.
*/}}
{{- define "nemoclaw-cpu.replicas" -}}
{{- if .Values.cpuScaling.oneReplicaPerCpu -}}
{{- .Values.cpuScaling.count | int }}
{{- else -}}
{{- .Values.replicaCount | int }}
{{- end -}}
{{- end }}

{{- define "nemoclaw-cpu.agentResources" -}}
{{- if .Values.cpuScaling.oneReplicaPerCpu }}
requests:
  cpu: {{ .Values.cpuScaling.perPodRequest | quote }}
  memory: {{ .Values.cpuScaling.perPodMemory | quote }}
limits:
  cpu: {{ .Values.cpuScaling.perPodLimit | quote }}
  memory: {{ .Values.cpuScaling.perPodMemoryLimit | quote }}
{{- else }}
{{- toYaml .Values.resources }}
{{- end }}
{{- end }}

{{/*
  HPA max replicas: explicit maxReplicas, else maxCpus when one pod per CPU.
*/}}
{{- define "nemoclaw-cpu.hpaMaxReplicas" -}}
{{- if gt (int .Values.autoscaling.maxReplicas) 0 -}}
{{- int .Values.autoscaling.maxReplicas -}}
{{- else if .Values.cpuScaling.oneReplicaPerCpu -}}
{{- int .Values.autoscaling.maxCpus -}}
{{- else -}}
{{- 10 -}}
{{- end -}}
{{- end }}

{{/*
  HPA min replicas: always at least 1 when autoscaling is on (never scale to zero).
*/}}
{{- define "nemoclaw-cpu.hpaMinReplicas" -}}
{{- $min := int .Values.autoscaling.minReplicas -}}
{{- if lt $min 1 -}}
{{- 1 -}}
{{- else -}}
{{- $min -}}
{{- end -}}
{{- end }}
