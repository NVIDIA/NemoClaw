// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Shared retry primitives for inference probes. Extracted from
// onboard-probes.ts so the responses and chat-completions probe paths can
// share one definition of "is this curl result retriable" and one HTTP
// retry/backoff loop. See PR #5975 review note PRA-8.

// @ts-nocheck — onboard-probes.ts is CommonJS-style and require()-based;
// keeping this module in the same shape lets it slot in without a separate
// adapter shim. The retry surface itself is trivial (constants, predicates,
// one loop) and is exercised by the existing retry/timeout tests in
// onboard-probes.test.ts.

const trace = require("../trace");

const CURL_TIMEOUT_STATUS = 28;
const NODE_SPAWN_TIMEOUT_STATUS = -110;

// 429 = Too Many Requests; 502/503/504 = upstream gateway/availability flakes
// (NVIDIA Endpoints and other hosted providers periodically emit these for
// minutes at a time). All four are transient — retry with backoff before
// surfacing a hard failure to the wizard. See issues #2980 and #3033.
const RETRIABLE_HTTP_PROBE_STATUSES = new Set([429, 502, 503, 504]);
const HTTP_PROBE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

function sleepSync(ms) {
  if (ms <= 0) return;
  // Skip real waits under vitest so retry-loop coverage doesn't burn 50s of
  // wall-clock per test. process.env.VITEST is set automatically by the
  // test runner.
  if (process.env.VITEST === "true" || process.env.NEMOCLAW_TEST_NO_SLEEP === "1") return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function shouldRetryHttpProbe(result) {
  return (
    result &&
    !result.ok &&
    result.curlStatus === 0 &&
    RETRIABLE_HTTP_PROBE_STATUSES.has(result.httpStatus)
  );
}

function isProbeTimeout(result) {
  return (
    result &&
    !result.ok &&
    (result.curlStatus === CURL_TIMEOUT_STATUS || result.curlStatus === NODE_SPAWN_TIMEOUT_STATUS)
  );
}

function isTimeoutOrConnFailureStatus(curlStatus) {
  return (
    curlStatus === CURL_TIMEOUT_STATUS ||
    curlStatus === NODE_SPAWN_TIMEOUT_STATUS ||
    curlStatus === 6 ||
    curlStatus === 7
  );
}

function isRetriableProbeResult(result) {
  return (
    isTimeoutOrConnFailureStatus(result.curlStatus) ||
    RETRIABLE_HTTP_PROBE_STATUSES.has(result.httpStatus)
  );
}

function executeProbeWithHttpRetry(probe) {
  return trace.withTraceSpan(
    "nemoclaw.inference.validation_probe",
    { probe_name: probe.name, api: probe.api || null },
    () => {
      let attempt = 1;
      let result = probe.execute();
      trace.addTraceEvent("probe_result", {
        attempt,
        ok: result.ok,
        http_status: result.httpStatus,
        curl_status: result.curlStatus,
      });
      for (const delayMs of HTTP_PROBE_RETRY_DELAYS_MS) {
        if (!shouldRetryHttpProbe(result)) break;
        console.log(
          `  ${probe.name} validation returned HTTP ${result.httpStatus}; retrying in ${Math.round(delayMs / 1000)}s...`,
        );
        trace.addTraceEvent("probe_retry_sleep", {
          delay_ms: delayMs,
          http_status: result.httpStatus,
        });
        sleepSync(delayMs);
        attempt += 1;
        result = probe.execute();
        trace.addTraceEvent("probe_result", {
          attempt,
          ok: result.ok,
          http_status: result.httpStatus,
          curl_status: result.curlStatus,
        });
      }
      return result;
    },
  );
}

// Drive a backoff loop for the doubled-timeout chat-completions retry that
// the OpenAI-like probe runs after a connection/timeout failure. Returns the
// final probe result. Logs the same "retrying in Xs" notice the responses
// retry loop emits so users on slow links see consistent progress messages.
function runChatCompletionsRetryLoop(runProbe) {
  let result = runProbe();
  if (result.ok) return result;
  for (const delayMs of HTTP_PROBE_RETRY_DELAYS_MS) {
    if (!isRetriableProbeResult(result)) break;
    const reason = isTimeoutOrConnFailureStatus(result.curlStatus)
      ? "timed out"
      : `returned HTTP ${result.httpStatus}`;
    console.log(
      `  Chat Completions API validation ${reason}; retrying in ${Math.round(delayMs / 1000)}s...`,
    );
    sleepSync(delayMs);
    result = runProbe();
    if (result.ok) return result;
  }
  return result;
}

module.exports = {
  CURL_TIMEOUT_STATUS,
  HTTP_PROBE_RETRY_DELAYS_MS,
  NODE_SPAWN_TIMEOUT_STATUS,
  RETRIABLE_HTTP_PROBE_STATUSES,
  executeProbeWithHttpRetry,
  isProbeTimeout,
  isRetriableProbeResult,
  isTimeoutOrConnFailureStatus,
  runChatCompletionsRetryLoop,
  shouldRetryHttpProbe,
  sleepSync,
};
