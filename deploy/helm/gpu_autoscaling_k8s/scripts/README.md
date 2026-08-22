<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw Kubernetes GPU autoscaling

Experimental community recipe: a CPU-only NemoClaw sandbox (OpenShell) running OpenClaw, Hermes, or Deep Agents Code (see [`../AGENT-SELECTION.md`](../AGENT-SELECTION.md)) sends inference to authenticated GPU inference pods (Ollama, vLLM, or NVIDIA NIM — see `inference.runtime` in `../README.md#inference-runtimes`) in the same cluster. An HPA scales only those inference pods. This recipe's example signal is per-pod GPU utilization; you can switch the HPA to other or custom metrics. Unsupported / non-production.

**Envoy Gateway is optional.** Use it for LeastRequest across GPU replicas; skip it when the metrics-proxy ClusterIP Service is enough:

| Choice | Install command |
|--------|-----------------|
| With Envoy LeastRequest (default) | `./scripts/install-hpa.sh` |
| Without Envoy (metrics-proxy Service only) | `ENABLE_ENVOY_LB=0 ./scripts/install-hpa.sh` |

**New here?** Start with [Quick start](#quick-start). Teardown: [Uninstall](#uninstall).

**Want to just try it end to end?** `./scripts/try-it.sh` runs the whole Quick start below
in one script — edit the `AGENT_NAME` / `INFERENCE_RUNTIME` block at its top (or pass them
as env vars) and go. It defaults to the isolated-eval shortcuts (`ALLOW_INSECURE_HTTP=1`,
unauthenticated OpenShell) — fine for a dedicated single-user cluster, not for shared/prod.

Pins in `versions.env`: NemoClaw `v0.0.104`, OpenShell `0.0.85`, Agent Sandbox `v0.5.0`.

## Architecture

```text
OpenShell CLI → port-forward → OpenShell gateway → CPU-only NemoClaw sandbox
```

Runtime inference path (HPA scales to **N** inference pods, 1 GPU each). Envoy is optional: LeastRequest when enabled; metrics-proxy ClusterIP Service when `ENABLE_ENVOY_LB=0`. Set both `MAX_REPLICAS` and `TARGET_PODS` to your allocatable GPU count (**N**) — not fixed to 4 (or 8 on an 8-GPU node).

```text
OpenShell CPU sandbox
        ↓
Envoy Gateway — LeastRequest  (or metrics-proxy Service when ENABLE_ENVOY_LB=0)
        ↓
Authenticated inference endpoints
├─ Inference pod (ollama|vllm|nim) → GPU 1
├─ Inference pod (ollama|vllm|nim) → GPU 2
├─ …
└─ Inference pod (ollama|vllm|nim) → GPU N
        ↑
HPA (example: GPU utilization)
```

**Inference API key.** Chart-generated local Secret for Bearer auth on `/v1/models` and chat completions; users do not supply a cloud key. OpenShell injects it for the sandbox — not for the inference runtime's own model pulls (Ollama pulls, vLLM/NIM downloads), and not OpenAI/`NVIDIA_API_KEY`.

**HPA metrics (example).** The shipped path uses GPU utilization:

`DCGM_FI_DEV_GPU_UTIL` → Prometheus → Adapter `gpu_utilization_percent` → HPA

That is only an example. Point the HPA at other Prometheus Adapter custom metrics (or your own) by changing `monitoring/prometheus-adapter-gpu-values.yaml` and the chart `autoscaling` settings — for example request rate, queue depth, or another DCGM signal.
| Default | Value |
|---------|-------|
| Namespace / release | `nemoclaw-gpu` |
| Service port | `8081` |
| Model | `llama3.2:3b` |
| GPUs per pod / min–max replicas | `1` / `1`–`4` |
| HPA GPU target (example metric) | `40%` |
| Ingress host (example) | `nemoclaw.local` |

**Boundaries (short):** namespaces `nemoclaw-gpu` and `nemoclaw-sandboxes`; only GPU inference pods (ollama|vllm|nim) request GPUs; Envoy dataplane must stay **ClusterIP** while the OpenShell cleartext HTTP listener exists (`NodePort`/`LoadBalancer` rejected); chart creates **no NetworkPolicy**; installer may touch shared Prometheus, Adapter, Envoy, DCGM ServiceMonitor, MicroK8s add-ons. Validated on one MicroK8s node with 4× L40S — re-validate other hardware (e.g. an 8× H100 node).

## Prerequisites

Not everything is manual. Split what you must already have from what the recipe scripts install.

Cluster baseline matches the [NemoClaw GPU autoscaling chart](https://github.com/NVIDIA/NemoClaw/tree/main/deploy/helm/gpu_autoscaling_k8s). For host CLI / Docker when working with NemoClaw images locally, see NemoClaw’s [Prerequisites](https://github.com/NVIDIA/NemoClaw/blob/main/docs/get-started/prerequisites.mdx).

### You provide (not installed by this recipe)

- A Kubernetes cluster (1.25+; Envoy / Gateway API prefers 1.28+) and a configured `kubectl`
- Helm 3 on the machine that runs the scripts
- Allocatable `nvidia.com/gpu` and nodes labeled `nvidia.com/gpu.present=true`
- NVIDIA GPU Operator with DCGM Exporter running (on MicroK8s, `install-hpa.sh` can `microk8s enable gpu`; on other distros install the operator yourself)
- Metrics Server (on MicroK8s, `install-hpa.sh` can enable it; elsewhere install it first)
- For the OpenShell sandbox path only:
  - Docker Buildx + a registry every node can pull from (to build/push the sandbox image)
  - OpenShell CLI matching `versions.env` (for example `uv tool install "openshell==${OPENSHELL_VERSION}"`)
  - Agent Sandbox controller (manual `kubectl apply` of the pinned manifest — `install-openshell-k8s.sh` does **not** install it)
  - OIDC issuer/client for the default OpenShell path, **or** the documented unauthenticated eval exception

Check the cluster before installation:

```bash
kubectl get nodes
kubectl get nodes \
  -o jsonpath='{range .items[*]}{.metadata.name}{" GPUs="}{.status.allocatable.nvidia\.com/gpu}{"\n"}{end}'
kubectl get nodes -l nvidia.com/gpu.present=true
kubectl get pods -n gpu-operator-resources \
  -l app=nvidia-dcgm-exporter
```

### Installers provide

| Script | Installs / configures |
|--------|------------------------|
| `./scripts/install-hpa.sh` | Prometheus (if missing), Prometheus Adapter + GPU metric rule, Envoy Gateway when `ENABLE_ENVOY_LB=1`, the `nemoclaw-gpu` chart, and the GPU HPA |
| `./scripts/install-openshell-k8s.sh` | OpenShell Kubernetes gateway (after Agent Sandbox CRDs exist) |
| `./scripts/build-agent-sandbox-image.sh` | Builds/pushes the pinned sandbox image for the agent selected by `AGENT_NAME` (needs your registry) — see [`../AGENT-SELECTION.md`](../AGENT-SELECTION.md) |
| `./scripts/create-agent-sandbox.sh` | Wires the chart inference API key into OpenShell and creates the sandbox for the selected agent |

Use a dedicated evaluation cluster for the experimental OpenShell path. Do not paste kubeconfig files, registry credentials, OIDC secrets, or inference API keys into an issue or pull request.

## Quick start

From an empty clone to a working sandbox. Run from `examples/recipes/nvidia/kubernetes-gpu-autoscaling/` unless noted. Deeper options: [Install details](#install-details), [OpenShell details](#openshell-details).

### 1. Clone and tools

```bash
git clone https://github.com/NVIDIA/nemoclaw-community.git
cd nemoclaw-community/examples/recipes/nvidia/kubernetes-gpu-autoscaling
source versions.env
uv tool install "openshell==${OPENSHELL_VERSION}"
openshell --version
```

### 2. Confirm GPUs and DCGM

```bash
kubectl get nodes \
  -o jsonpath='{range .items[*]}{.metadata.name}{" GPUs="}{.status.allocatable.nvidia\.com/gpu}{"\n"}{end}'
kubectl get pods -n gpu-operator-resources -l app=nvidia-dcgm-exporter
```

### 3. Install GPU inference + HPA

TLS is required by default when Envoy is on (see [Install details](#install-details)). Isolated eval only: `ALLOW_INSECURE_HTTP=1`.

```bash
# Prefer local.env (auto-sourced). Optional overrides:
# MAX_REPLICAS=2 ./scripts/install-hpa.sh
./scripts/install-hpa.sh
# Or without Envoy: ENABLE_ENVOY_LB=0 ./scripts/install-hpa.sh
```

Wait for the first Ollama model pull (`ROLLOUT_TIMEOUT` if needed). Then:

```bash
kubectl get pods,service,hpa -n nemoclaw-gpu
./scripts/get-hpa.sh -n nemoclaw-gpu
```

Optional QA test (ask the model a real question): [Call inference](#call-inference).

### 4. Agent Sandbox, image, OpenShell

```bash
source versions.env
kubectl apply -f \
  "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/manifest.yaml"

export AGENT_NAME=openclaw   # or hermes | deepagents — see ../AGENT-SELECTION.md#comparison
export AGENT_SANDBOX_IMAGE=registry.example.com/team/nemoclaw-${AGENT_NAME}-k8s:v0.0.104
./scripts/build-agent-sandbox-image.sh

export OPENSHELL_OIDC_ISSUER=https://idp.example.com/realms/openshell
export OPENSHELL_OIDC_AUDIENCE=openshell-cli
./scripts/install-openshell-k8s.sh
```

Dedicated eval without OIDC: `ALLOW_UNAUTHENTICATED_OPENSHELL=1` plus `OPENSHELL_UNAUTHENTICATED_ACK=dedicated-cluster-port-forward-only`.

### 5. Connect CLI and create sandbox

Terminal 1 — keep running:

```bash
kubectl -n nemoclaw-sandboxes port-forward service/openshell 8080:8080
```

Terminal 2 — client TLS + gateway (OIDC flags in [OpenShell details](#openshell-details)), then create/verify/run the sandbox for the `AGENT_NAME` you picked in step 4 (re-export it here if this is a fresh shell):

```bash
export AGENT_SANDBOX_IMAGE=registry.example.com/team/nemoclaw-${AGENT_NAME}-k8s:v0.0.104
export INFERENCE_MODEL=llama3.2:3b
./scripts/create-agent-sandbox.sh
./scripts/verify-agent-sandbox.sh

# OpenClaw / Hermes — long-running gateway, keep this terminal in the foreground:
./scripts/run-agent-sandbox.sh
# Deep Agents Code — no gateway; run one-shot prompts instead:
# ./scripts/run-agent-prompt.sh "Explain this repository in one sentence."
```

Users do not paste an inference API key; the chart generates it and OpenShell injects Bearer auth.

### 6. Optional HPA / Envoy check

```bash
./scripts/hpa-load-test.sh
```

When finished: [Uninstall](#uninstall).

## Install details

Installer side effects: may install/upgrade Prometheus (if missing), Prometheus Adapter (always, with this recipe’s GPU rules), Envoy Gateway (when `ENABLE_ENVOY_LB=1`), DCGM ServiceMonitor, and MicroK8s GPU/Metrics add-ons. Review shared-cluster impact before reuse of release names.

Static checks (no cluster):

```bash
./scripts/test-render-contract.sh
./scripts/test-script-security-contract.sh
node ./scripts/test-inference-auth-contract.mjs
./scripts/test-nemoclaw-k8s-contract.sh
```

### TLS values

```bash
# Prefer local.env; overlay lives in the recipe directory
kubectl create namespace nemoclaw-gpu --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret tls nemoclaw-example-tls \
  --namespace nemoclaw-gpu \
  --cert=/path/to/tls.crt --key=/path/to/tls.key \
  --dry-run=client -o yaml | kubectl apply -f -
cp values.yaml ./hpa-tls-values.yaml
cp local.env.example local.env
# Edit hpa-tls-values.yaml + local.env (INGRESS_HOST)
```

```yaml
# in ./hpa-tls-values.yaml (recipe directory)
ingress:
  host: nemoclaw.example.com
  tls:
    - secretName: nemoclaw-example-tls
      hosts:
        - nemoclaw.example.com
```

Scripts auto-source `local.env` from the recipe directory (paths use that file’s location). Manual override from the recipe directory: `export HPA_VALUES="$PWD/hpa-tls-values.yaml"`.

The chart does not create, rotate, or delete the TLS Secret.

### Scheduling

- Unset `NEMOCLAW_TARGET_NODE` for portable scheduling. Multi-node needs RWX (or disable persistence for the selected runtime — see [Persistence](#persistence)); default `values.yaml` hostPath is single-node only.
- Pin with `export NEMOCLAW_TARGET_NODE=<exact-node-name>` after confirming Ready + GPU label + allocatable GPUs ≥ `MAX_REPLICAS`.
- Both `MAX_REPLICAS` and `TARGET_PODS` must not exceed allocatable GPUs in scope. Host `nvidia-smi` processes outside Kubernetes are not reserved by the chart.
- Keep `HPA_VALUES`, `INGRESS_HOST`, `ENABLE_ENVOY_LB`, and `NEMOCLAW_TARGET_NODE` consistent across `install-hpa.sh`, `hpa-reset.sh`, and `hpa-load-test.sh`.

### Ingress security

When Envoy is enabled:

- Dataplane Service type is **ClusterIP** only. `NodePort` / `LoadBalancer` are rejected so the hostname-unrestricted OpenShell cleartext HTTP listener is not exposed externally. Use `kubectl port-forward` from outside the cluster.
- External HTTPS route: Gateway Basic auth + inference key as `X-Api-Key` (Basic owns `Authorization`).
- OpenShell HTTPRoute: no Gateway Basic auth so OpenShell can inject `Authorization: Bearer`.
- TLS required by default. Isolated eval cleartext: `ALLOW_INSECURE_HTTP=1` (ClusterIP only). Preflight checks Kubernetes-reported exposure; it does not prove private-network isolation. Set per script invocation.
- Auth Secrets (`nemoclaw-gpu-metrics-proxy-inference-api`, `nemoclaw-gpu-metrics-proxy-ingress-auth`) use Helm `keep`. Delete explicitly to rotate; never commit keys. Optional operator Secret: `inference.auth.existingSecret`.

When Envoy is disabled (`ENABLE_ENVOY_LB=0`): no Gateway objects; clients use the metrics-proxy Service; protect with network policy and the inference API key.

### Persistence

Default persistence is single-node hostPath for all three runtimes (`ollama.persistence`, `vllm.persistence`, `nim.persistence` in `values.yaml`). Multi-node: clear `hostPath` and use an RWX StorageClass, or disable persistence (`persistence.enabled=false` → `emptyDir` per pod → re-pull/re-download on replace).

### Recovery

Destructive recovery for the selected release only: `./scripts/cluster-recover.sh` (optional `RESTART_MICROK8S=1`). See script comments before use.

## Verify

```bash
kubectl get pods,service,hpa -n nemoclaw-gpu
kubectl get --raw \
  '/apis/custom.metrics.k8s.io/v1beta1/namespaces/nemoclaw-gpu/pods/*/gpu_utilization_percent'
./scripts/get-hpa.sh -n nemoclaw-gpu
./scripts/get-metrics-proxy-pods.sh -n nemoclaw-gpu
```

Idle expectation: one Running inference pod (two containers), HPA at one replica targeting `current/40`.

## Call inference

Operator port-forward bypasses Gateway TLS/Basic; Bearer still required. Do not bind to a non-loopback address.

```bash
kubectl port-forward -n nemoclaw-gpu service/nemoclaw-gpu-metrics-proxy 8081:8081
```

```bash
curl -s http://127.0.0.1:8081/healthz
INFERENCE_API_KEY="$(kubectl get secret nemoclaw-gpu-metrics-proxy-inference-api \
  -n nemoclaw-gpu -o jsonpath='{.data.api-key}' | base64 -d)"
curl -s http://127.0.0.1:8081/v1/models \
  -H "Authorization: Bearer ${INFERENCE_API_KEY}"
# Example: ask a real question (not a ping/smoke probe)
curl -s http://127.0.0.1:8081/v1/chat/completions \
  -H "Authorization: Bearer ${INFERENCE_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"model":"llama3.2:3b","messages":[{"role":"user","content":"In one sentence, what is an AI agent sandbox?"}],"max_tokens":256,"stream":false}'
unset INFERENCE_API_KEY
```

`/healthz`, `/readyz`, `/metrics` are unauthenticated. `/readyz` may be `503` during the initial model download.

## OpenShell details

- Agent Sandbox CRDs are cluster-scoped; `install-openshell-k8s.sh` never installs them — apply the pinned manifest yourself.
- Build image: `AGENT_NAME=… AGENT_SANDBOX_IMAGE=… ./scripts/build-agent-sandbox-image.sh` (versioned, non-`latest` tag; no API key in the image; see [`../AGENT-SELECTION.md`](../AGENT-SELECTION.md) for the three `AGENT_NAME` values).
- OIDC is default. Unauthenticated mode is dedicated-cluster + port-forward only (`ALLOW_UNAUTHENTICATED_OPENSHELL=1` + ACK). ClusterIP does not isolate from other pods/users.
- Client mTLS after port-forward:

```bash
MTLS_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/openshell/gateways/nemoclaw-k8s/mtls"
mkdir -p "${MTLS_DIR}"
for key in ca.crt tls.crt tls.key; do
  kubectl get secret openshell-client-tls -n nemoclaw-sandboxes \
    -o "jsonpath={.data.${key//./\\.}}" | base64 -d >"${MTLS_DIR}/${key}"
done
chmod 600 "${MTLS_DIR}"/*
openshell gateway add https://127.0.0.1:8080 \
  --local --name nemoclaw-k8s \
  --oidc-issuer "${OPENSHELL_OIDC_ISSUER}" \
  --oidc-client-id "${OPENSHELL_OIDC_CLIENT_ID:-openshell-cli}" \
  --oidc-audience "${OPENSHELL_OIDC_AUDIENCE}"
# Unauth eval: omit --oidc-* flags
openshell status
```

- `scripts/create-agent-sandbox.sh` stores the chart inference key in the OpenShell provider, strips `integrate.api.nvidia.com` from policy (where the selected agent's upstream policy grants it — see [`../AGENT-SELECTION.md`](../AGENT-SELECTION.md)), and runs an example chat (`In one sentence, what is an AI agent sandbox?`).
- OpenShell `0.0.85` leaves sandboxes idle (`sleep infinity`); `scripts/run-agent-sandbox.sh` (OpenClaw/Hermes) must stay attached and does not auto-restart — Deep Agents Code has no such gateway to keep running. Combined topology may require powerful capabilities (`SYS_ADMIN`, `NET_ADMIN`, …) — check admission policy.

## Test autoscaling and load balancing

`hpa-load-test.sh` (when `SCALE_UP_TARGET` ≥ 2):

1. Scale-up/down via direct pod-IP load (bypasses Envoy on purpose).
2. When Envoy is on: concurrent Bearer traffic through Envoy; every Ready pod must get successes and no pod may exceed `LB_TEST_MAX_SHARE` (default `0.75`).

```bash
# local.env supplies HPA_VALUES when present
TARGET_PODS=2 SCALE_UP_TARGET=2 ./scripts/hpa-load-test.sh
# then optionally TARGET_PODS=4 SCALE_UP_TARGET=4
./scripts/hpa-reset.sh
```

| Knob | Default | Purpose |
|------|---------|---------|
| `SKIP_ENVOY_LB_TEST` | `0` | Skip Envoy distribution phase |
| `ENABLE_ENVOY_LB` | `1` | Keep consistent with install |
| `LB_TEST_REQUESTS` / `LB_TEST_CONCURRENCY` | `48` / `12` | Envoy check load |
| `TARGET_PODS` and `SCALE_UP_TARGET` | allocatable GPUs | HPA test ceiling |
| `DURATION_SEC` / `HPA_TARGET_GPU` | `720` / `40` | Load duration / util target |

Grafana is optional visualization; the script is the pass/fail check.

## Scripts

| Script | Purpose |
|--------|---------|
| `try-it.sh` | Runs the whole Quick start end to end, `AGENT_NAME` / `INFERENCE_RUNTIME` at the top |
| `install-hpa.sh` | Monitoring + chart + HPA (+ Envoy if enabled) |
| `hpa-load-test.sh` / `hpa-reset.sh` | Autoscaling (+ Envoy) test / restore idle |
| `cluster-recover.sh` | Destructive release recovery |
| `get-metrics-proxy-pods.sh` / `get-hpa.sh` / `hpa-watch.sh` | Inspect / watch |
| `install-openshell-k8s.sh` | OpenShell gateway |
| `build-agent-sandbox-image.sh` / `create-agent-sandbox.sh` / `verify-agent-sandbox.sh` / `run-agent-sandbox.sh` / `run-agent-prompt.sh` | Agent sandbox lifecycle — pick the agent (`openclaw`, `hermes`, `deepagents`) via `AGENT_NAME`; see [`../AGENT-SELECTION.md`](../AGENT-SELECTION.md) |
| `agent-common.sh` | Per-agent config table sourced by the scripts above |
| `test-*-contract.*` | Static / local contract checks |

## Grafana

Optional. After `install-hpa.sh`:

```bash
kubectl port-forward -n monitoring service/kube-prometheus-grafana 3000:80
# http://127.0.0.1:3000 — creds from secret kube-prometheus-grafana in monitoring
```

Explore → Prometheus:

```promql
avg by (exported_pod) (
  DCGM_FI_DEV_GPU_UTIL{exported_namespace="nemoclaw-gpu", exported_pod=~"nemoclaw-gpu-metrics-proxy-.*"}
)
```

```promql
sum by (pod) (
  rate(nemoclaw_llm_requests_total{namespace="nemoclaw-gpu", result="success"}[5m])
)
```

## Uninstall

Stop the running agent (`run-agent-sandbox.sh` for OpenClaw/Hermes; Deep Agents Code exits after each `run-agent-prompt.sh` call — nothing to stop). With OpenShell port-forward still up (substitute your agent's sandbox/provider name — `nemoclaw-onprem`/`onprem-ollama` for OpenClaw, `hermes-onprem`/`onprem-hermes` for Hermes, `deepagents-onprem`/`onprem-deepagents` for Deep Agents Code):

```bash
openshell sandbox delete nemoclaw-onprem
openshell provider delete onprem-ollama
openshell gateway remove nemoclaw-k8s
rm -r -- "${XDG_CONFIG_HOME:-${HOME}/.config}/openshell/gateways/nemoclaw-k8s/mtls"
```

```bash
helm uninstall openshell -n nemoclaw-sandboxes
helm uninstall nemoclaw-gpu -n nemoclaw-gpu
```

Optional explicit cleanup (only if this recipe owns them): OpenShell PVC/Secrets in `nemoclaw-sandboxes`; `nemoclaw-gpu-metrics-proxy-inference-api` and `nemoclaw-gpu-metrics-proxy-ingress-auth`; dedicated namespaces after inspection. Agent Sandbox CRDs are cluster-scoped — delete the pinned manifest only if no other sandboxes remain.

Does **not** remove shared Prometheus, Adapter, Envoy Gateway, DCGM ServiceMonitor, or MicroK8s add-ons. Review ownership before removing those.

## Known limitations

- Experimental, unsupported; OpenShell Kubernetes driver is experimental.
- Idle sandbox + foreground `run-sandbox.sh` (OpenClaw/Hermes) or one-shot `run-prompt.sh` (Deep Agents Code); no auto-restart; privilege separation runs as sandbox identity.
- No NetworkPolicy; Bearer auth is not network isolation.
- Example HPA signal is GPU utilization; other/custom metrics need Adapter + HPA edits. hostPath model cache is single-node.
- First Ollama start and sandbox image pulls depend on registry access.
- Installer mutates shared cluster components — review with the cluster admin.

Third-party notices: [THIRD-PARTY-NOTICES](../../../../THIRD-PARTY-NOTICES). Update pins in `versions.env` as one compatibility contract, then rebuild the sandbox image and recreate the sandbox.
