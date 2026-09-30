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
| `hpa-load-test-dgx-8xh100.sh` | **Keep.** Fast HPA-only test for **8× H100** (metrics-proxy pod-IP Job, `files/load-generator.ts`). GPU util or `HPA_METRIC=latency_avg`. The sandbox e2e does not replace this. |
| `hpa-load-test-brev-4xl40s.sh` | HPA load test for **4× L40S** on AWS (Brev) |
| `test-openclaw-ollama-e2e-hpa.sh` | Longer OpenClaw + Ollama e2e (additional): N sandboxes (default `E2E_USERS=10`, 1 CPU / 4Gi) send 1–2 Job-like chats (questions ~38 llama3.2 tokens, `max_tokens` 16× that) through Envoy **on GPU util**. Not a replacement for `hpa-load-test-dgx-8xh100.sh`. |
| `test-openclaw-ollama-e2e-latency-hpa.sh` | Same user→sandbox path, but HPA metric is **LLM latency** (`latency_avg` / `nemoclaw_llm_latency_avg_milliseconds`, target 3000 ms) like `HPA_METRIC=latency_avg ./scripts/hpa-load-test-dgx-8xh100.sh`. Light per-agent inflight to avoid CPU-sandbox OOM. |
| `agentscaling.sh` | Create/start/stop/cleanup OpenClaw sandboxes (one per user). Clients do not run this. |
| `client.sh` | End users: 1:1 `chat.send` into each sandbox's `:18789`. Does not create sandboxes. |
| `setup-openclaw-ollama-e2e-sandboxes.sh` | Implementation used by `agentscaling.sh` |
| `e2e-openclaw-ollama-load-test.py` | Implementation used by `client.sh` |
| `test-hermes-e2e-hpa.sh` | Hermes + vLLM e2e next (`hermes -z`); do not run while OpenClaw e2e owns the GPUs |
| `setup-hermes-e2e-sandboxes.sh` | Create / start / stop / cleanup `hermes-e2e-*` only |
| `e2e-hermes-load-test.py` | Per-user driver used by `test-hermes-e2e-hpa.sh` |
| `hpa-reset.sh` | Restore idle HPA / inference |
| `cluster-recover.sh` | Destructive release recovery for the selected release only — see script comments before use |
| `get-metrics-proxy-pods.sh` / `get-hpa.sh` / `hpa-watch.sh` | Inspect / watch |
| `install-openshell-k8s.sh` | OpenShell gateway |
| `build-agent-sandbox-image.sh` / `create-agent-sandbox.sh` / `verify-agent-sandbox.sh` / `run-agent-sandbox.sh` / `run-agent-prompt.sh` | Agent sandbox lifecycle — pick the agent (`openclaw`, `hermes`, or `deepagents`, mirroring [`NVIDIA/NemoClaw/agents`](https://github.com/NVIDIA/NemoClaw/tree/main/agents)) via a single `AGENT_NAME` flag; see [`../AGENT-SELECTION.md`](../AGENT-SELECTION.md) |
| `agent-common.sh` | Per-agent config table sourced by the scripts above |
| `test-openclaw-ollama.sh` | Optional developer test: OpenClaw + Ollama, one replica, no HPA, no load test. Not required for autoscaling. |
| `test-hermes-nim.sh` | Optional developer test: Hermes + NIM, one replica, no HPA, no load test (needs NGC Secrets). Not required for autoscaling. |
| `test-deepagents-vllm.sh` | Optional developer test: Deep Agents Code + vLLM, one replica, no HPA, no load test. Not required for autoscaling. |
| `e2e-common.sh` | Shared steps sourced by those three optional pairing tests — do not run it directly |
