{{/* SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. */}}
{{/* SPDX-License-Identifier: Apache-2.0 */}}
{{- define "nemoclaw-gpu.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "nemoclaw-gpu.fullname" -}}
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

{{- define "nemoclaw-gpu.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "nemoclaw-gpu.labels" -}}
helm.sh/chart: {{ include "nemoclaw-gpu.chart" . }}
{{ include "nemoclaw-gpu.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "nemoclaw-gpu.selectorLabels" -}}
app.kubernetes.io/name: {{ include "nemoclaw-gpu.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
component: gpu-agent
nemoclaw.ai/workload-type: gpu
{{- end }}

{{- define "nemoclaw-gpu.namespace" -}}
{{- .Values.namespace.name }}
{{- end }}

{{- define "nemoclaw-gpu.ingressAuthSecretName" -}}
{{- printf "%s-agent-ingress-auth" (include "nemoclaw-gpu.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "nemoclaw-gpu.replicas" -}}
{{- if .Values.gpuScaling.oneReplicaPerGpu -}}
{{- .Values.gpuScaling.count | int }}
{{- else -}}
{{- .Values.replicaCount | int }}
{{- end -}}
{{- end }}

{{- define "nemoclaw-gpu.ollamaResources" -}}
requests:
  cpu: {{ .Values.gpuScaling.perPodCpuRequest | quote }}
  memory: {{ .Values.gpuScaling.perPodMemory | quote }}
  nvidia.com/gpu: {{ .Values.gpuScaling.perPodGpu | quote }}
limits:
  cpu: {{ .Values.gpuScaling.perPodCpuLimit | quote }}
  memory: {{ .Values.gpuScaling.perPodMemoryLimit | quote }}
  nvidia.com/gpu: {{ .Values.gpuScaling.perPodGpu | quote }}
{{- end }}

{{- define "nemoclaw-gpu.agentResources" -}}
requests:
  cpu: {{ .Values.gpuScaling.agentCpuRequest | quote }}
  memory: {{ .Values.gpuScaling.agentMemory | quote }}
limits:
  cpu: {{ .Values.gpuScaling.agentCpuLimit | quote }}
  memory: {{ .Values.gpuScaling.agentMemoryLimit | quote }}
{{- end }}

{{- /*
One replica = one GPU in GPU mode, so the HPA must never be allowed to scale past
maxGpus even if maxReplicas is set higher — extra pods would just sit Pending with
no GPU to schedule onto. Use the lower of the two positive limits in that mode.
*/}}
{{- define "nemoclaw-gpu.hpaMaxReplicas" -}}
{{- $maxReplicas := int .Values.autoscaling.maxReplicas -}}
{{- $maxGpus := int .Values.autoscaling.maxGpus -}}
{{- if .Values.gpuScaling.oneReplicaPerGpu -}}
{{- if and (gt $maxReplicas 0) (gt $maxGpus 0) -}}
{{- min $maxReplicas $maxGpus -}}
{{- else if gt $maxGpus 0 -}}
{{- $maxGpus -}}
{{- else if gt $maxReplicas 0 -}}
{{- $maxReplicas -}}
{{- else -}}
{{- 10 -}}
{{- end -}}
{{- else if gt $maxReplicas 0 -}}
{{- $maxReplicas -}}
{{- else -}}
{{- 10 -}}
{{- end -}}
{{- end }}

{{- define "nemoclaw-gpu.hpaMinReplicas" -}}
{{- $min := int .Values.autoscaling.minReplicas -}}
{{- if lt $min 1 -}}
{{- 1 -}}
{{- else -}}
{{- $min -}}
{{- end -}}
{{- end }}
