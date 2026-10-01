<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Scripts

All setup, verification, security, and teardown instructions for this recipe live in the
main [`../README.md`](../README.md) (architecture, Quick start, TLS/security details,
inference runtimes, HPA/Envoy testing, Grafana, uninstall) and
[`../AGENT-SELECTION.md`](../AGENT-SELECTION.md) (per-agent comparison, recipe
quick starts, env vars, and support notes). This page is a quick reference for
what each script in this directory does — it has no instructions of its own.

| Script | Purpose |
|--------|---------|
| `install-hpa.sh` | Monitoring + chart + HPA (+ Envoy if enabled). This is the autoscaling install path. |
| `hpa-load-test-dgx-8xh100.sh` | **Keep.** Fast HPA-only test for **8× H100** (metrics-proxy pod-IP Job, `files/load-generator.ts`). GPU util default, or `HPA_METRIC=latency_avg HPA_TARGET_LATENCY_MS=3000`. The sandbox e2e does not replace this. |
| `hpa-load-test-brev-4xl40s.sh` | HPA load test for **4× L40S** on AWS (Brev). Same GPU-util default / latency env vars. |
| `agentscaling_gpuutil.sh` | Sandbox provision + GPU-util HPA (`gpu_utilization_percent` > 40%). This DGX success path. |
| `agentscaling_latency.sh` | Same sandboxes, LLM-latency HPA (`latency_avg` > 3000 ms). |
| `client.sh` | End users: 1:1 `chat.send` into each sandbox's `:18789`. Does not create sandboxes or set the HPA metric. Use after either agentscaling script. |
| `agentscaling-common.sh` | Shared HPA apply + sandbox steps. Do not run it directly. |
| `setup-openclaw-ollama-e2e-sandboxes.sh` | Sandbox create/start/stop used by the agentscaling scripts |
| `e2e-openclaw-ollama-load-test.py` | Implementation used by `client.sh` |
| `test-openclaw-ollama-e2e-hpa.sh` | Optional one-process wrapper: `agentscaling_gpuutil.sh` then `client.sh` |
| `test-openclaw-ollama-e2e-latency-hpa.sh` | Optional one-process wrapper: `agentscaling_latency.sh` then `client.sh` |
| `uninstall-e2e.sh` | Stop e2e agents/sandboxes/providers before another pairing. Does not uninstall GPU inference or OpenShell. |
| `test-hermes-e2e-hpa.sh` | Hermes + vLLM e2e (`hermes -z`); run `uninstall-e2e.sh` first if OpenClaw sandboxes are still up |
| `setup-hermes-e2e-sandboxes.sh` | Create / start / stop / cleanup `hermes-e2e-*` only |
| `e2e-hermes-load-test.py` | Per-user driver used by `test-hermes-e2e-hpa.sh` |
| `hpa-reset.sh` | Restore idle HPA / inference |
| `cluster-recover.sh` | Destructive release recovery for the selected release only — see script comments before use |
| `get-metrics-proxy-pods.sh` / `get-hpa.sh` / `hpa-watch.sh` | Inspect / watch |
| `install-openshell-k8s.sh` | OpenShell gateway |
| `create-agent-sandbox.sh` / `verify-agent-sandbox.sh` / `run-agent-sandbox.sh` / `run-agent-prompt.sh` | Called by the e2e setup scripts. Do not run them as the HPA demo path. |
| `agent-common.sh` | Per-agent config table sourced by the scripts above |
| `test-openclaw-ollama.sh` | Optional developer test: OpenClaw + Ollama, one replica, no HPA, no load test. Not required for autoscaling. |
| `test-hermes-nim.sh` | Optional developer test: Hermes + NIM, one replica, no HPA, no load test (needs NGC Secrets). Not required for autoscaling. |
| `test-deepagents-vllm.sh` | Optional developer test: Deep Agents Code + vLLM, one replica, no HPA, no load test. Not required for autoscaling. |
| `e2e-common.sh` | Shared steps sourced by those three optional pairing tests — do not run it directly |
| `test-inference-auth-contract.ts` | Local contract: metrics-proxy requires the inference API key and rejects non-object chat bodies |
| `test-metrics-proxy-metrics-contract.ts` | Local contract: rolling `latency_avg` gauge idle-expires so HPA can scale down |
