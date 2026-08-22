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
component: gpu-metrics-proxy
nemoclaw.ai/workload-type: gpu
{{- end }}

{{- define "nemoclaw-gpu.namespace" -}}
{{- .Values.namespace.name }}
{{- end }}

{{- define "nemoclaw-gpu.ingressAuthSecretName" -}}
{{- printf "%s-metrics-proxy-ingress-auth" (include "nemoclaw-gpu.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "nemoclaw-gpu.gatewayName" -}}
{{- printf "%s-metrics-proxy" (include "nemoclaw-gpu.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "nemoclaw-gpu.httpRouteName" -}}
{{- printf "%s-metrics-proxy" (include "nemoclaw-gpu.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "nemoclaw-gpu.openShellHttpRouteName" -}}
{{- printf "%s-openshell" (include "nemoclaw-gpu.httpRouteName" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "nemoclaw-gpu.httpPathMatchType" -}}
{{- /* Map chart pathType (Prefix|Exact only) to Gateway API PathMatchType. */ -}}
{{- $pathType := .Values.ingress.pathType | default "Prefix" -}}
{{- if eq $pathType "Exact" -}}
Exact
{{- else if eq $pathType "Prefix" -}}
PathPrefix
{{- else -}}
{{- fail (printf "ingress.pathType %q is unsupported; use Prefix or Exact" $pathType) -}}
{{- end -}}
{{- end }}

{{- define "nemoclaw-gpu.inferenceApiSecretName" -}}
{{- if .Values.inference.auth.existingSecret -}}
{{- .Values.inference.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-metrics-proxy-inference-api" (include "nemoclaw-gpu.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
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

{{- define "nemoclaw-gpu.metricsProxyResources" -}}
requests:
  cpu: {{ .Values.gpuScaling.metricsProxyCpuRequest | quote }}
  memory: {{ .Values.gpuScaling.metricsProxyMemory | quote }}
limits:
  cpu: {{ .Values.gpuScaling.metricsProxyCpuLimit | quote }}
  memory: {{ .Values.gpuScaling.metricsProxyMemoryLimit | quote }}
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

{{- define "nemoclaw-gpu.hpaMetric" -}}
{{- $metric := .Values.autoscaling.metric | default "gpu_utilization" -}}
{{- if or (eq $metric "gpu_utilization") (eq $metric "gpu") -}}
gpu_utilization_percent
{{- else if eq $metric "latency_avg" -}}
nemoclaw_llm_latency_avg_milliseconds
{{- else -}}
{{- fail (printf "autoscaling.metric %q is unsupported; use gpu_utilization or latency_avg" $metric) -}}
{{- end -}}
{{- end }}

{{- define "nemoclaw-gpu.hpaMetricTarget" -}}
{{- $metric := .Values.autoscaling.metric | default "gpu_utilization" -}}
{{- if or (eq $metric "gpu_utilization") (eq $metric "gpu") -}}
{{- .Values.autoscaling.targetGPUUtilizationPercentage | toString -}}
{{- else if eq $metric "latency_avg" -}}
{{- .Values.autoscaling.targetLatencyMilliseconds | toString -}}
{{- else -}}
{{- fail (printf "autoscaling.metric %q is unsupported; use gpu_utilization or latency_avg" $metric) -}}
{{- end -}}
{{- end }}

{{- define "nemoclaw-gpu.hpaMetricDisplay" -}}
{{- $metric := .Values.autoscaling.metric | default "gpu_utilization" -}}
{{- if or (eq $metric "gpu_utilization") (eq $metric "gpu") -}}
GPU utilization % (DCGM)
{{- else if eq $metric "latency_avg" -}}
LLM chat proxy latency avg (ms)
{{- end -}}
{{- end }}

{{- /*
Selects which GPU inference container this chart renders (ollama | vllm | nim). The three
values.yaml blocks are deliberately named to match these exact strings so templates can look
up the active runtime's config with `index .Values (include "nemoclaw-gpu.runtime" .)`.
*/}}
{{- define "nemoclaw-gpu.runtime" -}}
{{- $runtime := .Values.inference.runtime | default "ollama" -}}
{{- if not (or (eq $runtime "ollama") (eq $runtime "vllm") (eq $runtime "nim")) -}}
{{- fail (printf "inference.runtime %q is unsupported; use ollama, vllm, or nim" $runtime) -}}
{{- end -}}
{{- $runtime -}}
{{- end }}

{{- /* Renders a `repository:tag@digest` image reference, tolerating a blank tag or digest
(some registries, e.g. nvcr.io NIM/vLLM images, are referenced by digest only). */}}
{{- define "nemoclaw-gpu.imageRef" -}}
{{- $img := . -}}
{{- if not $img.repository -}}
{{- fail "image.repository is required" -}}
{{- end -}}
{{- if and $img.tag $img.digest -}}
{{- printf "%s:%s@%s" $img.repository $img.tag $img.digest -}}
{{- else if $img.digest -}}
{{- printf "%s@%s" $img.repository $img.digest -}}
{{- else if $img.tag -}}
{{- printf "%s:%s" $img.repository $img.tag -}}
{{- else -}}
{{- fail (printf "image repository %q requires image.tag or image.digest" $img.repository) -}}
{{- end -}}
{{- end }}

{{- define "nemoclaw-gpu.runtimePort" -}}
{{- $runtime := include "nemoclaw-gpu.runtime" . -}}
{{- (index .Values $runtime).port | int -}}
{{- end }}

{{- /*
Root URL (no /v1) for the active runtime's own API on loopback. Ollama's native API lives at
this root (e.g. /api/tags); vLLM and NIM mount their OpenAI-compatible API under /v1 on the same
root, so this also doubles as the prefix the metrics-proxy readiness check calls directly.
*/}}
{{- define "nemoclaw-gpu.runtimeRootUrl" -}}
{{- printf "http://127.0.0.1:%d" (int (include "nemoclaw-gpu.runtimePort" .)) -}}
{{- end }}

{{- /* OpenAI-compatible chat-completions base URL the metrics-proxy proxies to. Auto-computed
from the active runtime's port unless inference.baseUrl is explicitly overridden (advanced use:
pointing at an inference endpoint outside this pod). */}}
{{- define "nemoclaw-gpu.runtimeBaseUrl" -}}
{{- if .Values.inference.baseUrl -}}
{{- .Values.inference.baseUrl -}}
{{- else -}}
{{- printf "%s/v1" (include "nemoclaw-gpu.runtimeRootUrl" .) -}}
{{- end -}}
{{- end }}

{{- define "nemoclaw-gpu.runtimeDataVolumeName" -}}
{{- printf "%s-data" (include "nemoclaw-gpu.runtime" .) -}}
{{- end }}

{{- define "nemoclaw-gpu.runtimePvcName" -}}
{{- printf "%s-%s" (include "nemoclaw-gpu.fullname" .) (include "nemoclaw-gpu.runtime" .) | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- /* Where each runtime caches downloaded model weights on the shared data volume. */}}
{{- define "nemoclaw-gpu.runtimeMountPath" -}}
{{- $runtime := include "nemoclaw-gpu.runtime" . -}}
{{- if eq $runtime "ollama" -}}
/root/.ollama
{{- else if eq $runtime "vllm" -}}
/root/.cache/huggingface
{{- else if eq $runtime "nim" -}}
/opt/nim/.cache
{{- end -}}
{{- end }}
