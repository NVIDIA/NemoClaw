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
| `agentscaling_gpuutil.sh` | Sandbox provision + GPU-util HPA. Keeps current GPUs at 1 (`maxReplicas=8`) until `client.sh`. |
| `agentscaling_latency.sh` | Same sandboxes, LLM-latency HPA. Keeps current GPUs at 1 (`maxReplicas=8`) until `client.sh`. |
| `client.sh` | End users: 1:1 HTTP to `http://dgx-ip:18789+i`. Laptop: `E2E_CLIENT_HOST=dgx-ip E2E_USERS=5 ./scripts/client.sh`. |
| `agentscaling-common.sh` | Shared HPA apply + sandbox steps. Do not run it directly. |
| `setup-openclaw-ollama-e2e-sandboxes.sh` | Sandbox create/start/stop used by the agentscaling scripts |
| `e2e-openclaw-ollama-load-test.py` | Implementation used by `client.sh` |
| `uninstall-e2e.sh` | Remove e2e sandboxes/providers before another pairing. Does not uninstall GPU inference or OpenShell. Next `agentscaling_*` helm-upgrades `INFERENCE_RUNTIME`. |
| `setup-hermes-vllm-e2e-sandboxes.sh` | Create / start / stop / cleanup `hermes-vllm-e2e-*` only |
| `e2e-hermes-load-test.py` | Per-user driver used by `client_hermes.sh` |
| `agentscaling_hermes_gpuutil.sh` | Hermes + vLLM sandbox provision + GPU-util HPA. Keeps current GPUs at 1 (`maxReplicas=8`) until `client_hermes.sh`. |
| `agentscaling_hermes_latency.sh` | Same Hermes sandboxes, LLM-latency HPA. Keeps current GPUs at 1 (`maxReplicas=8`) until `client_hermes.sh`. |
| `client_hermes.sh` | End users: 1:1 HTTP to Hermes. Laptop UI `http://dgx-ip:18789/` ; CLI `E2E_CLIENT_HOST=dgx-ip`. |
| `agentscaling_deepagents_gpuutil.sh` | Deep Agents + NIM sandbox provision + GPU-util HPA. Keeps current GPUs at 1 (`maxReplicas=8`) until `client_deepagents.sh`. |
| `agentscaling_deepagents_latency.sh` | Same Deep Agents sandboxes, LLM-latency HPA. Keeps current GPUs at 1 (`maxReplicas=8`) until `client_deepagents.sh`. |
| `client_deepagents.sh` | End users: 1:1 `dcode -n`. No HTTP dashboard. |
| `setup-deepagent-nim-e2e-sandboxes.sh` | Create / cleanup `deepagent-nim-e2e-*` only |
| `e2e-deepagents-load-test.py` | Per-user driver used by `client_deepagents.sh` |
| `hpa-reset.sh` | Restore idle HPA / inference |
| `cluster-recover.sh` | Destructive release recovery for the selected release only — see script comments before use |
| `get-metrics-proxy-pods.sh` / `get-hpa.sh` / `hpa-watch.sh` | Inspect / watch |
| `install-openshell-k8s.sh` | OpenShell gateway |
| `create-agent-sandbox.sh` / `verify-agent-sandbox.sh` / `run-agent-sandbox.sh` / `run-agent-prompt.sh` | Called by the e2e setup scripts. Do not run them as the HPA demo path. |
| `agent-common.sh` | Per-agent config table sourced by the scripts above |
| `test-inference-auth-contract.ts` | Local contract: metrics-proxy requires the inference API key and rejects non-object chat bodies |
| `test-metrics-proxy-metrics-contract.ts` | Local contract: rolling `latency_avg` uses a 30s sample window and idle-expires so HPA can scale down |
| `test-e2e-load-stop.py` | Local contract: HPA helper reports 8 GPUs; a failed poll is not treated as 8 |
| `test-e2e-latency-load-ramp.py` | Local contract: latency load is 2048 tokens through 5 GPUs, 32 at 6/7, stop at 8 |
| `test-hpa-idle-replicas-contract.sh` | Local contract: idle latency HPA `1/0` is a ready baseline; leftover `5/6` is not |
