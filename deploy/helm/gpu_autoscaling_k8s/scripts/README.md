<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Scripts

All setup, verification, security, and teardown instructions for this recipe live in the
main [`../README.md`](../README.md) (architecture, Quick start, TLS/security details,
inference runtimes, HPA/Envoy testing, Grafana, uninstall) and
[`../AGENT-SELECTION.md`](../AGENT-SELECTION.md) (per-agent comparison, env vars, and
support matrix). This page is a quick reference for what each script in this directory
does — it has no instructions of its own.

| Script | Purpose |
|--------|---------|
| `try-it.sh` | Runs the whole Quick start end to end (incl. `hpa-load-test.sh`), `AGENT_NAME` / `INFERENCE_RUNTIME` at the top; requires explicit opt-in for the insecure-eval shortcut |
| `install-hpa.sh` | Monitoring + chart + HPA (+ Envoy if enabled) |
| `hpa-load-test.sh` / `hpa-reset.sh` | Autoscaling (+ Envoy) test / restore idle |
| `cluster-recover.sh` | Destructive release recovery for the selected release only — see script comments before use |
| `get-metrics-proxy-pods.sh` / `get-hpa.sh` / `hpa-watch.sh` | Inspect / watch |
| `install-openshell-k8s.sh` | OpenShell gateway |
| `build-agent-sandbox-image.sh` / `create-agent-sandbox.sh` / `verify-agent-sandbox.sh` / `run-agent-sandbox.sh` / `run-agent-prompt.sh` | Agent sandbox lifecycle — pick the agent (`openclaw`, `hermes`, or `deepagents`, mirroring [`NVIDIA/NemoClaw/agents`](https://github.com/NVIDIA/NemoClaw/tree/main/agents)) via a single `AGENT_NAME` flag; see [`../AGENT-SELECTION.md`](../AGENT-SELECTION.md) |
| `agent-common.sh` | Per-agent config table sourced by the scripts above |
| `test-*-contract.*` | Static / local contract checks |
