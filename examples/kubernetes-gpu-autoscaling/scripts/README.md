<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Scripts

All setup, verification, security, and teardown instructions for this recipe live in the
main [`../README.md`](../README.md) (architecture, Quick start, security details,
inference runtimes, HPA/Envoy testing, Grafana, uninstall) and
[`../AGENT-SELECTION.md`](../AGENT-SELECTION.md) (per-agent comparison, recipe
quick starts, env vars, and support notes). This page is a quick reference for
what each script in this directory does — it has no instructions of its own.

| Script | Purpose |
|--------|---------|
| `apply-local-secrets.sh` | NIM (6c): create `ngc-registry` and `nim-ngc-key` from gitignored `secrets.env`. Public vLLM (6b) does not use this. Use `--replace` if 6b left only one Secret. |
| `create-nim-ngc-secrets.sh` | Implementation used by `apply-local-secrets.sh`. Do not run it as the README 6c path. |
| `install-hpa.sh` | Monitoring + chart + HPA (+ Envoy if enabled). This is the autoscaling install path. |
| `hpa-load-test-dgx-8xh100.sh` | **Keep.** Fast HPA-only test for **8× H100** (metrics-proxy pod-IP Job, `files/load-generator.ts`). GPU util default, or `HPA_METRIC=latency_avg HPA_TARGET_LATENCY_MS=3000`. The sandbox e2e does not replace this. |
| `hpa-load-test-brev-4xl40s.sh` | HPA load test for **4× L40S** on AWS (Brev). Same GPU-util default / latency env vars. |
| `agentscaling_gpuutil.sh` | Sandbox provision + GPU-util HPA. Keeps current GPUs at 1 (`maxReplicas=8`) until `client.sh`. |
| `agentscaling_latency.sh` | Same sandboxes, LLM-latency HPA. Keeps current GPUs at 1 (`maxReplicas=8`) until `client.sh`. |
| `client.sh` | End users: 1:1 HTTP to `http://dgx-ip:18789+i`. One client for both metrics. Stop at 8. Latency defaults: `INFLIGHT=1`, `MAX_TOKENS=2048` until 6 GPUs, then short prompts (`E2E_USERS=5 ./scripts/client.sh`). GPU util flags: `INFLIGHT=4 MAX_TOKENS=2048`. Laptop: `E2E_CLIENT_HOST=dgx-ip E2E_USERS=5 ./scripts/client.sh`. |
| `agentscaling-common.sh` | Shared HPA apply + sandbox steps. Do not run it directly. |
| `setup-openclaw-ollama-e2e-sandboxes.sh` | Sandbox create/start/stop used by the agentscaling scripts |
| `e2e-openclaw-ollama-load-test.py` | Implementation used by `client.sh` |
| `uninstall-e2e.sh` | Remove e2e sandboxes/providers before another pairing. Does not uninstall GPU inference or OpenShell. Next `agentscaling_*` helm-upgrades `INFERENCE_RUNTIME`. |
| `setup-hermes-vllm-e2e-sandboxes.sh` | Create / start / stop / cleanup `hermes-vllm-e2e-*` only |
| `e2e-hermes-load-test.py` | Per-user driver used by `client_hermes.sh` |
| `agentscaling_hermes_gpuutil.sh` | Hermes + vLLM sandbox provision + GPU-util HPA. Keeps current GPUs at 1 (`maxReplicas=8`) until `client_hermes.sh`. |
| `agentscaling_hermes_latency.sh` | Same Hermes sandboxes, LLM-latency HPA. Keeps current GPUs at 1 (`maxReplicas=8`) until `client_hermes.sh`. |
| `client_hermes.sh` | End users: 1:1 HTTP to Hermes (`E2E_USERS=10`). GPU util: `INFLIGHT=2 MAX_TOKENS=1024`. Latency: `E2E_USERS=10 ./scripts/client_hermes.sh` (`INFLIGHT=1 MAX_TOKENS=2048` in the code). Does not copy a load helper or pause HPA scale-down. Laptop UI `http://dgx-ip:18789/` ; CLI `E2E_CLIENT_HOST=dgx-ip`. |
| `publish-hermes-remote-http.sh` | DGX: republish Hermes UI `:18789+i` and API `:8642+i` for the laptop. The DGX injects the Hermes key; the laptop does not set one. Keep step 5 attached. |
| `agentscaling_deepagents_gpuutil.sh` | Deep Agents + NIM sandbox provision + GPU-util HPA. Keeps current GPUs at 1 (`maxReplicas=8`) until `client_deepagents.sh`. |
| `agentscaling_deepagents_latency.sh` | Same Deep Agents sandboxes, LLM-latency HPA. Keeps current GPUs at 1 (`maxReplicas=8`) until `client_deepagents.sh`. |
| `client_deepagents.sh` | End users: 1:1 `dcode -n` on the DGX (`E2E_USERS=10`). No laptop HTTP. GPU util and latency omit `INFLIGHT`/`MAX_TOKENS` (`INFLIGHT=1 MAX_TOKENS=1024` in the code). Does not copy a load helper or pause HPA scale-down. |
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
| `test-metrics-proxy-newest-sample-window.ts` | Local contract: the 30s window ages from the newest sample so a 45s gap stays until 60s idle expire |
| `test-e2e-load-stop.py` | Local contract: HPA helper reports 8 GPUs; OpenClaw client requires `--host`, does not copy helpers into sandboxes, and on stop leaves OpenClaw running |
| `test-e2e-timeline.py` | Local contract: client and HPA JSONL rows share even-second UTC timestamps |
| `test-hpa-idle-replicas-contract.sh` | Local contract: idle latency HPA `1/0` is a ready baseline; leftover `5/6` is not; Helm 3 omits `--force-conflicts`, Helm 4 adds it, and the check runs before the HPA is deleted |
