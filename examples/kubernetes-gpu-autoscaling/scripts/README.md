<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Scripts

Setup and load-test steps live in [`../README.md`](../README.md). Pairing files are compared in [`../AGENT-SELECTION.md`](../AGENT-SELECTION.md). This page only names what each script does.

| Script | Purpose |
| --- | --- |
| `check.sh` | Validate the four pairing files and read the cluster. Does not apply. |
| `validate-yaml.py` | Schema check used by `check.sh`. |
| `render-sandboxes.sh` | Print a pairing file expanded to `E2E_USERS` sandboxes. Does not apply. |
| `invoke.sh` | One operator prompt through `openshell sandbox exec` after `oidc`. |
| `client-openclaw.sh` | OpenClaw load client. `kubectl exec` into `fabric-agent-ctl invoke`. |
| `client-hermes.sh` | Hermes load client. Same invoke path. |
| `client-deepagents.sh` | Deep Agents load client. Same invoke path, separate namespace and state directory. |
| `e2e-fabric-load-test.py` | Per-user driver used by the three clients. |
| `set-hpa-metric.sh` | Switch the chart HPA between `gpu_utilization` and `latency_avg`. |
| `install-hpa.sh` | Monitoring, this chart, HPA, and Envoy when enabled. |
| `apply-local-secrets.sh` | NIM: create `ngc-registry` and `nim-ngc-key` from gitignored `secrets.env`. |
| `create-nim-ngc-secrets.sh` | Implementation used by `apply-local-secrets.sh`. |
| `hpa-load-test-dgx-8xh100.sh` | HPA-only Job for 8× H100. Does not create sandboxes. |
| `hpa-load-test-brev-4xl40s.sh` | Same HPA-only Job for 4× L40S. |
| `hpa-reset.sh` | Restore an idle HPA without deleting the release. |
| `hpa-watch.sh` / `get-hpa.sh` / `get-metrics-proxy-pods.sh` | Inspect the live HPA and metrics-proxy pods. |
| `cluster-recover.sh` | Destructive recovery for the selected release. Read the script before use. |
| `agent-common.sh` / `hpa-common.sh` | Shared settings. Do not run them directly. |
| `e2e_timeline.py` / `e2e-hpa-timeline.py` | Timeline rows written beside a load run. |
| `test-inference-auth-contract.ts` | Metrics-proxy requires the inference API key and rejects non-object chat bodies. |
| `test-metrics-proxy-metrics-contract.ts` | Rolling `latency_avg` uses a 30s window and expires so HPA can scale down. |
| `test-metrics-proxy-newest-sample-window.ts` | The 30s window ages from the newest sample. |
| `test-hpa-idle-replicas-contract.sh` | Idle latency HPA `1/0` is a ready baseline. |
