<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw value benchmark

A small, developer- and agent-runnable benchmark that answers "is NemoClaw fast
enough on this machine?". It measures core first-use and inference-path timings
and emits both machine-readable JSON and a concise Markdown value report.

It addresses [#5604](https://github.com/NVIDIA/NemoClaw/issues/5604). v1 is
deliberately **advisory**: it does not ship owner-approved pass/warn/fail
thresholds (those are tracked by #3776), so the numbers are for comparing runs,
not for gating.

> The harness only sends requests to the inference endpoint you configure. It
> never uploads results or sends telemetry to any external service.

The configured endpoint must use HTTPS, except that HTTP is allowed for loopback
hosts (`localhost`, `127.0.0.0/8`, and `::1`) so local inference stays easy to
benchmark. URL userinfo is rejected. Redirects are refused, query values are
redacted from shareable reports, remote error bodies are never copied into
reports, and a successful sample must contain a valid OpenAI-compatible chat
completion rather than an arbitrary HTTP 2xx body.

## Metrics

| Metric | Source | Notes |
|--------|--------|-------|
| `inference-round-trip` | live request | Times N OpenAI-compatible `/v1/chat/completions` calls (warm-up + samples), reports min/median/p95/mean/max. |
| `sandbox-cold-start` | onboard trace | Total duration of the emitted `nemoclaw.onboard.phase.sandbox` span, which encloses sandbox creation and readiness. The nested `nemoclaw.sandbox.readiness_wait` span is reported as an optional breakdown without being added twice. |
| `policy-shield-overhead` | onboard trace | Marked `unsupported` in v1: the available `nemoclaw.policy.application` span measures setup, not request-path shield overhead. Interactive traces can also include human think time. |

Trace metrics require a completed NemoClaw onboard trace with successful root
and metric spans. A valid trace without a selected metric reports that metric as
`unsupported`; a malformed trace or failed metric span reports `error` and exits
non-zero.

## Prerequisites

- Node `>=22.16` (`tsx` is a dev dependency; run via `npm`/`npx`).
- An OpenAI-compatible inference endpoint and model you can reach from the host
  (e.g. an NVIDIA endpoint, a local vLLM/Ollama server, or — from inside a
  sandbox — `https://inference.local/v1`).
- The API key in `OPENAI_API_KEY` or `NVIDIA_INFERENCE_API_KEY` (the value is
  never passed as a flag). Put a compatible provider's key in one of these
  benchmark-specific names rather than selecting an unrelated process secret.
- Optional: an onboard trace artifact for the sandbox/policy metrics. Produce one
  by running `NEMOCLAW_TRACE=1 nemoclaw onboard --non-interactive ...`; the trace
  file path is printed and also controlled by `NEMOCLAW_TRACE_FILE` /
  `NEMOCLAW_TRACE_DIR`. Non-interactive collection provides more comparable
  context; request-path policy overhead remains unsupported until dedicated
  instrumentation exists.

## Usage

One documented command produces both outputs:

```bash
export OPENAI_API_KEY=...            # or NVIDIA_INFERENCE_API_KEY
npm run bench -- \
  --base-url https://integrate.api.nvidia.com/v1 \
  --model nvidia/nemotron-3-super-120b-a12b \
  --samples 10 \
  --json bench-result.json
```

This prints the Markdown report to stdout and writes structured JSON to
`bench-result.json`. Add the sandbox/policy metrics by pointing at an onboard
trace:

```bash
npm run bench -- \
  --base-url https://inference.local/v1 --model <model> \
  --trace .e2e/traces/onboard.json \
  --report bench-report.md --json bench-result.json
```

Trace-only run (no live inference):

```bash
npm run bench -- --no-inference --trace .e2e/traces/onboard.json
```

Run `npm run bench -- --help` for all flags.

## How an agent should use this

1. Confirm a provider is configured (`nemoclaw <name> status`) and export the key.
2. Run `npm run bench -- --base-url <url> --model <model> --json bench.json`.
3. Read `bench.json` (`schema_version: nemoclaw.bench.v1`). Summarize each
   metric's `status` and `stats` (median + p95) and surface any `error`/
   `unsupported` `reason`. Do not present the timings as pass/fail — they are
   advisory until thresholds land (#3776).
4. On `error` exit status, report the `reason` and the troubleshooting pointers
   from the Markdown report.

## Output schema (`nemoclaw.bench.v1`)

```jsonc
{
  "schema_version": "nemoclaw.bench.v1",
  "generated_at": "<ISO-8601>",
  "environment": { "os", "arch", "node", "cpus", "cpu_model", "total_mem_gib" },
  "target": { "base_url": "<redacted>", "model": "...", "api_key_present": true },
  "metrics": [
    { "id": "inference-round-trip", "status": "ok", "unit": "ms",
      "source": "live-request", "interpretation": "advisory-non-normative",
      "samples": 10, "stats": { "min_ms", "median_ms", "p95_ms", "mean_ms", "max_ms" } }
  ]
}
```

Trace-backed metrics also include a sanitized `context` object when available
(`provider`, `model`, `agent`, `non_interactive`, and `fresh`) so runs can be
compared without exposing sandbox names or credentials.

The harness exits non-zero when a selected metric errors, a supplied trace is
invalid, or required prerequisites (endpoint, model, API key) are missing.
