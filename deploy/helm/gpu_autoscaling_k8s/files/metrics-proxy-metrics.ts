// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Shared Prometheus helpers for metrics-proxy /metrics (LLM latency, HTTP counters).
// HPA latency_avg is the mean of every sample since the last idle reset.

// After this many ms with no new samples, clear the HPA average so it reports 0
// (below target) instead of retaining the last high latency. 0 disables idle
// expiration. Clients stop *new* chats at max GPUs; this only affects the HPA
// gauge after those in-flight replies finish. It does not drop in-flight chats.
const configuredIdleExpireMs = Number(process.env.LLM_LATENCY_IDLE_EXPIRE_MS ?? "15000");
const LLM_LATENCY_IDLE_EXPIRE_MS =
  Number.isFinite(configuredIdleExpireMs) && configuredIdleExpireMs >= 0
    ? configuredIdleExpireMs
    : 15_000;

let hpaLatencySumMs = 0;
let hpaLatencyCount = 0;
let llmDurationSumSec = 0;
let llmDurationCount = 0;
let llmRequestsOk = 0;
let llmRequestsError = 0;
let lastLlmSampleAtMs = 0;
let llmEverSampled = false;
let nowMsProvider = () => Date.now();
const llmHistogramBucketsSec = [0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];
const llmHistogramCounts = Array.from({ length: llmHistogramBucketsSec.length + 1 }, () => 0);

function clearHpaLatencyAvg() {
  hpaLatencySumMs = 0;
  hpaLatencyCount = 0;
  lastLlmSampleAtMs = 0;
}

function expireIdleHpaLatencyAvg(nowMs = nowMsProvider()) {
  if (!hpaLatencyCount || LLM_LATENCY_IDLE_EXPIRE_MS <= 0 || lastLlmSampleAtMs <= 0) {
    return;
  }
  if (nowMs - lastLlmSampleAtMs >= LLM_LATENCY_IDLE_EXPIRE_MS) {
    clearHpaLatencyAvg();
  }
}

export function recordLlmLatency(durationMs, ok) {
  // Normalize once so the HPA average and the cumulative counters/histogram
  // below always agree on the same finite, non-negative value.
  const normalizedMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const sec = normalizedMs / 1000;
  llmDurationSumSec += sec;
  llmDurationCount += 1;
  if (ok) llmRequestsOk += 1;
  else llmRequestsError += 1;

  hpaLatencySumMs += normalizedMs;
  hpaLatencyCount += 1;
  lastLlmSampleAtMs = nowMsProvider();
  llmEverSampled = true;

  let bucketIdx = llmHistogramBucketsSec.findIndex((bound) => sec <= bound);
  if (bucketIdx === -1) bucketIdx = llmHistogramBucketsSec.length;
  for (let i = bucketIdx; i < llmHistogramCounts.length; i += 1) {
    llmHistogramCounts[i] += 1;
  }
}

function llmLatencyAvgMs() {
  expireIdleHpaLatencyAvg();
  if (!hpaLatencyCount) return 0;
  return hpaLatencySumMs / hpaLatencyCount;
}

export function llmMetricsLines() {
  const avg = llmLatencyAvgMs();
  const lines = [
    "# HELP nemoclaw_llm_requests_total Chat/completions proxied to inference backend",
    "# TYPE nemoclaw_llm_requests_total counter",
    `nemoclaw_llm_requests_total{result="success"} ${llmRequestsOk}`,
    `nemoclaw_llm_requests_total{result="error"} ${llmRequestsError}`,
    "# HELP nemoclaw_llm_request_duration_seconds LLM chat/completions end-to-end proxy latency",
    "# TYPE nemoclaw_llm_request_duration_seconds histogram",
  ];

  for (let i = 0; i < llmHistogramBucketsSec.length; i += 1) {
    lines.push(
      `nemoclaw_llm_request_duration_seconds_bucket{le="${llmHistogramBucketsSec[i]}"} ${llmHistogramCounts[i]}`,
    );
  }
  lines.push(
    `nemoclaw_llm_request_duration_seconds_bucket{le="+Inf"} ${llmHistogramCounts[llmHistogramCounts.length - 1]}`,
    `nemoclaw_llm_request_duration_seconds_sum ${llmDurationSumSec}`,
    `nemoclaw_llm_request_duration_seconds_count ${llmDurationCount}`,
  );
  // New GPU replicas have no samples yet. Exporting 0 here dilutes Pods
  // AverageValue and stalls latency HPA around 4–5 GPUs. Omit the gauge until
  // this replica has served a chat. After idle-expire, still export 0 so
  // scale-down can proceed.
  if (llmEverSampled) {
    lines.push(
      "# HELP nemoclaw_llm_latency_avg_milliseconds Average LLM latency of all samples since last idle reset",
      "# TYPE nemoclaw_llm_latency_avg_milliseconds gauge",
      `nemoclaw_llm_latency_avg_milliseconds ${Math.round(avg)}`,
    );
  }
  return lines;
}

/** Test-only: override the clock used for idle expiration. Pass null to restore. */
export function setLlmMetricsClockForTests(clockFn) {
  nowMsProvider = typeof clockFn === "function" ? clockFn : () => Date.now();
}

/** Test-only: clear HPA latency average (does not reset cumulative counters). */
export function resetLlmLatencyWindowForTests() {
  clearHpaLatencyAvg();
  llmEverSampled = false;
}
