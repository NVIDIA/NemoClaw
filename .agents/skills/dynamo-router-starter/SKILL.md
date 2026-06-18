---
name: dynamo-router-starter
description: Start or patch Dynamo router modes and run router endpoint smoke checks. Use for round-robin, KV-aware, least-loaded, or device-aware routing setup; use recipe-runner for recipe deployment and troubleshoot for failure diagnosis.
license: Apache-2.0
metadata:
  author: Dan Gil <dagil@nvidia.com>
  tags:
    - dynamo
    - router
    - smoke-test
    - bring-up
---

# Dynamo Router Starter

<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: CC-BY-4.0
-->

## Purpose

Make Dynamo routing feel easy by getting a baseline router mode running, enabling
KV-aware routing when appropriate, and proving the endpoint works. Keep the user
focused on exact commands and success signals, not router internals.

## Prerequisites

- Python 3.10+ with the `dynamo` package importable (`python3 -m dynamo.frontend --help` works).
- For Kubernetes runs: `kubectl` configured with access to the target namespace and a deployed Dynamo recipe.
- Network reachability to the frontend service (port-forward or direct).
- A model already loaded into at least one worker (`/v1/models` returns at least one entry).

## Required Inputs

Collect or infer:

- local Python/CLI or Kubernetes recipe path
- desired mode: `round-robin`, `kv`, `least-loaded`, `device-aware-weighted`, `direct`, or `random`
- frontend port or Kubernetes frontend service
- whether workers publish KV events; if not, use approximate KV mode
- model name for smoke requests, if `/v1/models` cannot discover it

## Instructions

### 1. Establish A Baseline

For local bring-up with already registered workers:

```bash
python3 -m dynamo.frontend --router-mode round-robin --http-port 8000
```

For Kubernetes, inspect the selected recipe `deploy.yaml` and locate the
frontend service. If the recipe is not already deployed, use
`dynamo-recipe-runner` first.

### 2. Enable KV Routing

For local frontend:

```bash
python3 -m dynamo.frontend --router-mode kv --http-port 8000
```

For Kubernetes, patch only the frontend service env:

```yaml
envs:
  - name: DYN_ROUTER_MODE
    value: kv
```

If backend workers are not publishing KV cache events, set approximate mode
instead of leaving the router waiting for events:

```yaml
envs:
  - name: DYN_ROUTER_USE_KV_EVENTS
    value: "false"
```

### 3. Smoke Test

After port-forwarding the frontend service or starting local frontend, run:

```bash
python3 scripts/check_router_health.py \
  --base-url http://127.0.0.1:8000
```

This must verify `/v1/models` and, when a model is discoverable, one
`/v1/chat/completions` request.

### 4. Compare Modes Carefully

When comparing round-robin vs KV routing:

- use the same model, workers, prompt set, concurrency, and sampling settings
- send repeated-prefix prompts if demonstrating KV reuse
- label the result as a smoke comparison unless enough benchmark samples were collected
- do not claim throughput improvement from a single chat request

If the endpoint is unhealthy or workers are missing, switch to
`dynamo-troubleshoot`.

## Available Scripts

| Script | Purpose | Arguments |
|---|---|---|
| `scripts/check_router_health.py` | Smoke-test `/v1/models` and one chat completion against a Dynamo frontend | `--base-url`, `--retries`, `--timeout` |

Invoke via the agentskills.io `run_script()` protocol:

```python
run_script("scripts/check_router_health.py", args=["--base-url", "http://127.0.0.1:8000"])
```

## Examples

Local KV-routed frontend on port 8000, then smoke-test it:

```bash
python3 -m dynamo.frontend --router-mode kv --http-port 8000 &
python3 scripts/check_router_health.py --base-url http://127.0.0.1:8000
```

Kubernetes-deployed frontend reachable via port-forward:

```bash
kubectl port-forward svc/qwen-vllm-disagg-frontend 8000:8000 -n dynamo-demo &
python3 scripts/check_router_health.py --base-url http://127.0.0.1:8000 --retries 3
```

Equivalent through the agent protocol:

```python
run_script("scripts/check_router_health.py", args=["--base-url", "http://127.0.0.1:8000", "--retries", "3"])
```

## Output Contract

Return:

- mode selected and why
- local command or Kubernetes env patch
- frontend service or URL
- smoke-test result
- any limitation, such as approximate KV mode or missing worker KV events
- next command to run for a fuller comparison

## Limitations

- Smoke test is one chat completion; it is not a benchmark. Use `dynamo-benchmark` for throughput/latency numbers.
- KV-aware mode without worker KV-event publication degrades to approximate mode; this skill flags but does not fix the underlying worker config.
- Mode comparisons require matched workloads; cross-mode latency claims need separate benchmark runs.

## Troubleshooting

| Symptom | Likely cause | Next step |
|---|---|---|
| `/v1/models` returns empty list | No worker registered with the frontend | Verify worker pods are Ready; confirm they connect to the same etcd/NATS |
| Smoke chat request times out | Frontend up, workers not serving | Switch to `dynamo-troubleshoot`; inspect worker logs |
| KV mode hangs | Workers do not publish KV cache events | Set `DYN_ROUTER_USE_KV_EVENTS=false` (approximate mode) |
| Connection refused on port-forward | Port-forward dropped or wrong service name | Re-run port-forward; verify the frontend service name matches the recipe |

## Benchmark

See `BENCHMARK.md` for the NVCARPS-EVAL performance report (auto-generated by the NVSkills CI pipeline). To refresh, re-run `/nvskills-ci` on an upstream PR touching this skill.

## References

- Read `references/router-modes.md` for the compact mode/env map.
- Use `scripts/check_router_health.py` for endpoint smoke tests.
