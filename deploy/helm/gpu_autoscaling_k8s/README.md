<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw Kubernetes GPU autoscaling

This experimental recipe shows a cost-efficient architecture: AI agents run in CPU-only OpenShell sandboxes, each sandbox responding to one end user's inference request, while GPU inference autoscales using K8s HPA based on the workload. The e2e demo uses **one sandbox per end user** sharing `inference.local` → Envoy → GPU inference runtimes -> K8s HPA autoscaling. The CPU agent is an OpenShell Kubernetes sandbox (Agent Sandbox CRD + OpenShell 0.0.85); GPU inference is a separate Helm chart with HPA. 

HPA scales GPU inference from 1 to **N** replicas (1 GPU each) so spikes stay responsive and idle GPUs are released.

| Agent | `AGENT_NAME` | After create |
|-------|--------------|--------------|
| OpenClaw (default) | `openclaw` | `./scripts/run-agent-sandbox.sh` (keep attached) |
| Hermes | `hermes` | `./scripts/run-agent-sandbox.sh` (keep attached) |
| Deep Agents Code | `deepagents` | `./scripts/run-agent-prompt.sh "…"` |

Set `AGENT_NAME` once and reuse it. Do not install two agents in one sandbox. Optional pairing checks: [recipe examples](#agent-and-runtime-support).

GPU inference runtime is **Ollama**, **vLLM**, or **NVIDIA NIM**. Metrics-proxy, HPA, and Envoy stay the same. Official pairings: [Agent and runtime support](#agent-and-runtime-support).

HPA uses Pods **`AverageValue`**. Built-in metrics: **GPU utilization** (scale out when average per-pod util **> 40%**) and **LLM latency** (scale out when average per-pod chat proxy latency **> 3000 ms**).

**The Envoy load balancer is optional.** Default is LeastRequest in front of GPU replicas. Skip it when the metrics-proxy ClusterIP Service is enough:

| Choice | Install |
|--------|---------|
| Envoy LeastRequest (default) | TLS Secret + `ingress.tls` — [TLS values](#tls-values) — then `./scripts/install-hpa.sh` |
| Metrics-proxy Service only | `ENABLE_ENVOY_LB=0 ./scripts/install-hpa.sh` |

Keep `versions.env` aligned: NemoClaw `v0.0.104`, OpenShell `0.0.85`, Agent Sandbox `v0.5.0`. Bump all three together when upstream moves.

## Deployment Architecture

HPA scales to **N** inference pods (1 GPU each). Envoy LeastRequest when enabled; otherwise the metrics-proxy Service. Set install `MAX_REPLICAS` to the GPUs you intend to use (**N**). Load-test with the matching script in [Validation](#validation).

Each GPU pod is **2/2 Ready** when healthy: inference (`ollama` / `vllm` / `nim`) + `metrics-proxy` (auth, `/v1`, health, `/metrics`). The sandboxed agent is CPU-only OpenShell, not this pod.

```text
End users (1 pairing sandbox, or M e2e sandboxes — one per user)
        ↓
CPU-only OpenShell sandboxes (AGENT_NAME=openclaw | hermes | deepagents)
        ↓
OpenShell https://inference.local
        ↓
Envoy load balancer — LeastRequest  (or metrics-proxy Service when ENABLE_ENVOY_LB=0)
        ↓
Authenticated inference endpoints
├─ Inference pod (ollama|vllm|nim) → GPU 1
├─ …
└─ Inference pod (ollama|vllm|nim) → GPU N
        ↑
HPA (GPU util >40% or latency >3000 ms)
```

 provision sandboxes with `agentscaling_gpuutil.sh` or `agentscaling_latency.sh`, then send chats with the same `client.sh`. This DGX demo uses 5 end users,`E2E_USERS=5` and 8Gi sandboxes, one sandbox per user. 

The chart generates a local inference API key (Bearer on `/v1`). OpenShell injects it for the sandbox. It is not an Ollama pull key, OpenAI key, or `NVIDIA_API_KEY`.

`latency_avg` is metrics-proxy **chat/completions duration** on that pod (in-pod fetch until the full response, including streams). It excludes client→Envoy time. After 60s with no samples the gauge resets to 0 so HPA can scale down. `get-hpa.sh` prints milliseconds (`46514/3000` = 46514 ms / 3000 ms).

## Validation

| Hardware | Install ceiling | Simple HPA-only test | End users and sandboxes E2E test |
|----------|-----------------|----------------------|----------------------------------|
| On-prem DGX **8× H100** (80 GB) | `MAX_REPLICAS=8` | `./scripts/hpa-load-test-dgx-8xh100.sh` (GPU util or `latency_avg`) | `./scripts/agentscaling_gpuutil.sh` or `./scripts/agentscaling_latency.sh` then `./scripts/client.sh` |


Both paths cover chart deploy, optional Envoy LeastRequest, authenticated inference, HPA scale-up/down, Envoy distribution, and OpenShell → `https://inference.local/v1`. Default models fit either GPU. Pin a node with `NEMOCLAW_TARGET_NODE` when other GPU nodes exist.

<img width="1512" height="982" alt="Screenshot 2026-09-11 at 1 26 10 AM" src="https://github.com/user-attachments/assets/94506026-48d5-444f-a699-8c6f135c1678" />


The DGX H100 demo uses 5 end users,`E2E_USERS=5` and 8Gi sandboxes, one sandbox per user. This 8×H100 demo runs those sandboxes on the DGX box's CPUs. Sandboxes can run on a different CPU node with more memory to support more sandboxes and end users; see [FAQ](#agents-and-sandboxes-run-on-cpu--what-limits-how-many-i-can-run). 

The HPA test was also verified on [Brev AWS](https://brev.nvidia.com) **4× L40S** (48 GB), MicroK8s, `MAX_REPLICAS=4` using `./scripts/hpa-load-test-brev-4xl40s.sh`.


## Prerequisites

- Kubernetes 1.25+ (`kubectl`; 1.28+ preferred with Gateway API), Helm 3
- Allocatable `nvidia.com/gpu`; nodes labeled `nvidia.com/gpu.present=true`
- NVIDIA GPU Operator + DCGM Exporter (MicroK8s: `install-hpa.sh` can `microk8s enable gpu`)
- Metrics Server
- OpenShell path: Docker Buildx + a registry nodes can pull (MicroK8s: [local registry](#microk8s-local-registry)); OpenShell CLI matching `versions.env`; Agent Sandbox CRDs; OIDC **or** the unauthenticated eval exception

DCGM namespace defaults to `gpu-operator-resources` (MicroK8s). Use `DCGM_NAMESPACE=gpu-operator` with the standard GPU Operator.

```bash
# export DCGM_NAMESPACE=gpu-operator
kubectl get nodes \
  -o jsonpath='{range .items[*]}{.metadata.name}{" GPUs="}{.status.allocatable.nvidia\.com/gpu}{"\n"}{end}'
kubectl get nodes -l nvidia.com/gpu.present=true
kubectl get pods -n "${DCGM_NAMESPACE:-gpu-operator-resources}" -l app=nvidia-dcgm-exporter
```

Chart baseline: [NemoClaw GPU autoscaling chart](https://github.com/NVIDIA/NemoClaw/tree/main/deploy/helm/gpu_autoscaling_k8s). Host CLI/Docker: NemoClaw [Prerequisites](https://github.com/NVIDIA/NemoClaw/blob/main/docs/get-started/prerequisites.mdx).

## Quick start

From `deploy/helm/gpu_autoscaling_k8s/`. This uses OpenShell's Kubernetes driver, not `nemoclaw onboard` / `nemohermes launch` / `nemo-deepagents launch`. After create, OpenShell 0.0.85 leaves the sandbox idle (`sleep infinity`). OpenClaw/Hermes listen only while `./scripts/run-agent-sandbox.sh` stays attached. Deep Agents Code has no gateway — use `verify-agent-sandbox.sh` / `run-agent-prompt.sh`. Per-agent loops: [`AGENT-SELECTION.md`](AGENT-SELECTION.md#recipe-quick-start).

### 1. Clone and tools

```bash
git clone https://github.com/NVIDIA/NemoClaw.git
cd NemoClaw/deploy/helm/gpu_autoscaling_k8s
source versions.env
uv tool install "openshell==${OPENSHELL_VERSION}"
export PATH="${HOME}/.local/bin:${PATH}"
openshell --version
```

### 2. Confirm GPUs and DCGM

```bash
# export DCGM_NAMESPACE=gpu-operator   # standard GPU Operator only
kubectl get nodes \
  -o jsonpath='{range .items[*]}{.metadata.name}{" GPUs="}{.status.allocatable.nvidia\.com/gpu}{"\n"}{end}'
kubectl get pods -n "${DCGM_NAMESPACE:-gpu-operator-resources}" -l app=nvidia-dcgm-exporter
```

### 3. Install GPU inference + HPA

- **Envoy (default):** [TLS values](#tls-values). Copy `local.env.example` → `local.env` (gitignored) and point `HPA_VALUES` at the TLS overlay. Scripts source `local.env` from the recipe directory.
- **Service only:** `ENABLE_ENVOY_LB=0`. No Gateway or TLS Secret. `ALLOW_INSECURE_HTTP=1` is not a substitute for this.

```bash
cp local.env.example local.env
cp values.yaml ./hpa-tls-values.yaml
# Edit hpa-tls-values.yaml (ingress.host + ingress.tls) and local.env (INGRESS_HOST)

# Optional: export NEMOCLAW_TARGET_NODE=<gpu-node-name>
# Optional: export INFERENCE_MODEL=<ollama-tag>   # default llama3.2:3b
# Standard GPU Operator: export DCGM_NAMESPACE=gpu-operator
export MAX_REPLICAS=8   # 8× H100; use 4 on 4× L40S
./scripts/install-hpa.sh
# Or: ENABLE_ENVOY_LB=0 ./scripts/install-hpa.sh
```

Default runtime is **Ollama** (public image, no NGC key). For **NIM**, create Secrets first:

```bash
NAMESPACE=nemoclaw-gpu ./scripts/create-nim-ngc-secrets.sh
export INFERENCE_RUNTIME=nim INFERENCE_MODEL=nvidia/nemotron-3-nano
export NIM_NGC_API_KEY_SECRET=nim-ngc-key NIM_IMAGE_PULL_SECRET=ngc-registry
./scripts/install-hpa.sh
```

That helper creates both the in-container `NGC_API_KEY` Secret and the `nvcr.io` imagePullSecret. Do not commit the NGC key.

Wait for the first model pull (`ROLLOUT_TIMEOUT` if needed). Metrics-proxy listens on **8081**.

```bash
kubectl get pods,service,hpa -n nemoclaw-gpu
./scripts/get-hpa.sh -n nemoclaw-gpu
```

### 4. Agent Sandbox, image, OpenShell

Pick `AGENT_NAME` (`openclaw`, `hermes`, or `deepagents`) once. Comparison: [`AGENT-SELECTION.md`](AGENT-SELECTION.md#comparison).

```bash
source versions.env
kubectl apply -f \
  "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/manifest.yaml"

export AGENT_NAME=openclaw
microk8s enable registry   # if not already on
export AGENT_SANDBOX_IMAGE=localhost:32000/nemoclaw-${AGENT_NAME}-k8s:${NEMOCLAW_VERSION}
./scripts/build-agent-sandbox-image.sh

export OPENSHELL_OIDC_ISSUER=https://idp.example.com/realms/openshell
export OPENSHELL_OIDC_AUDIENCE=openshell-cli
./scripts/install-openshell-k8s.sh
```

Dedicated eval without OIDC: `ALLOW_UNAUTHENTICATED_OPENSHELL=1` plus `OPENSHELL_UNAUTHENTICATED_ACK=dedicated-cluster-port-forward-only`. GPU HPA scripts do not require a sandbox.

### 5. Connect CLI and create sandbox

Terminal 1 — keep running:

```bash
kubectl -n nemoclaw-sandboxes port-forward service/openshell 8080:8080
```

Terminal 2 — client TLS + gateway ([OpenShell details](#openshell-details)), then:

```bash
export AGENT_SANDBOX_IMAGE=localhost:32000/nemoclaw-${AGENT_NAME}-k8s:${NEMOCLAW_VERSION}
export INFERENCE_MODEL=llama3.2:3b   # must match the GPU chart
./scripts/create-agent-sandbox.sh
# OpenClaw / Hermes only — keep attached. Skip for deepagents.
./scripts/run-agent-sandbox.sh
```

Create does **not** start Hermes/OpenClaw. Do not use `nemohermes launch` / `nemo-deepagents launch`. Verify from another terminal (Deep Agents: skip `run-agent-sandbox.sh`):

```bash
./scripts/verify-agent-sandbox.sh
# deepagents only: ./scripts/run-agent-prompt.sh "Explain this repository in one sentence."
```


### 6. E2E test: multiple end users and sandboxes

Terminal A — provision (sandboxes and GPUs)
```bash
cd ~/NemoClaw/deploy/helm/gpu_autoscaling_k8s
E2E_USERS=5 ./scripts/agentscaling_latency.sh
```

Terminal B — client (end users)
```bash
cd ~/NemoClaw/deploy/helm/gpu_autoscaling_k8s
E2E_USERS=5 \
E2E_INFLIGHT_START_PER_USER=1 \
E2E_INFLIGHT_PER_USER=2 \
MAX_TOKENS=608 \
DURATION_SEC=180 \
./scripts/client.sh
```

Optional watch (percentages become ms for this metric, e.g. 46514/3000):
```bash
cd ~/NemoClaw/deploy/helm/gpu_autoscaling_k8s
./scripts/get-hpa.sh -n nemoclaw-gpu -w
```

## Install details

### Aggregated metrics API

The installer needs Metrics Server and Prometheus Adapter custom-metrics to stay reachable, not merely `True` once:

```bash
for endpoint in /apis/metrics.k8s.io/v1beta1 /apis/custom.metrics.k8s.io/v1beta1; do
  for attempt in 1 2 3; do
    kubectl get --raw "${endpoint}" >/dev/null && echo "${endpoint}: ok" || echo "${endpoint}: failed"
  done
done
```

Intermittent `401` is a control-plane aggregated-API client cert problem. This recipe does not manage those certificates.

### TLS values

Needed only when Envoy serves HTTPS. Isolated eval: `ALLOW_INSECURE_HTTP=1` (no TLS overlay). When Envoy is on, **every** recipe `helm upgrade` needs an overlay with `ingress.tls` — chart `values.yaml` alone is not enough.

1. Create the TLS Secret in `nemoclaw-gpu` (SAN must include `ingress.host`).
2. Overlay `./hpa-tls-values.yaml`.
3. `local.env.example` → `local.env` for `HPA_VALUES` / `INGRESS_HOST`.

```bash
kubectl create namespace nemoclaw-gpu --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret tls nemoclaw-example-tls \
  --namespace nemoclaw-gpu \
  --cert=/path/to/tls.crt --key=/path/to/tls.key \
  --dry-run=client -o yaml | kubectl apply -f -
cp values.yaml ./hpa-tls-values.yaml
cp local.env.example local.env
```

```yaml
# ./hpa-tls-values.yaml
ingress:
  host: nemoclaw.example.com
  tls:
    - secretName: nemoclaw-example-tls
      hosts:
        - nemoclaw.example.com
```

`local.env` resolves paths from **its own directory**. Manual export from the recipe directory: `export HPA_VALUES="$PWD/hpa-tls-values.yaml"`. Explicit env wins over `local.env`. The chart never creates or rotates the TLS Secret.

Without Envoy, skip TLS and keep `ENABLE_ENVOY_LB=0` on `install-hpa.sh`, `hpa-reset.sh`, and the load-test script you use.

### Scheduling

- Unset `NEMOCLAW_TARGET_NODE` for portable scheduling. Multi-node needs RWX (or disable persistence — [Persistence](#persistence)); default hostPath is single-node.
- Pin with `export NEMOCLAW_TARGET_NODE=<node>` after Ready + GPU label + allocatable GPUs ≥ `MAX_REPLICAS`.
- `MAX_REPLICAS` and load-test `TARGET_PODS` must not exceed allocatable GPUs in scope. Host `nvidia-smi` processes are not reserved.
- Keep `HPA_VALUES`, `INGRESS_HOST`, `ENABLE_ENVOY_LB`, and `NEMOCLAW_TARGET_NODE` consistent across install, reset, and load test.

### Ingress security

When Envoy is enabled:

- Dataplane Service is **ClusterIP** only (`NodePort` / `LoadBalancer` rejected). Use `kubectl port-forward` from outside.
- External HTTPS: Gateway Basic auth + inference key as `X-Api-Key`. OpenShell HTTPRoute: Bearer only.
- TLS required by default. Isolated eval: `ALLOW_INSECURE_HTTP=1` (ClusterIP). Preflight checks reported exposure; it does not prove private-network isolation.
- Auth Secrets use Helm `keep`. Delete to rotate; never commit keys.
- No NetworkPolicy from the chart — add one if the cluster needs it.

When Envoy is off: metrics-proxy Service only; protect with NetworkPolicy + the inference API key.

### Inference runtimes

`INFERENCE_RUNTIME` / `inference.runtime`: **`ollama`** (default), **`vllm`**, or **`nim`**. Same 1 GPU → 1 pod → local `/v1` pattern.

| Runtime | Default model | Image | Credentials | Min VRAM |
|---------|----------------|-------|-------------|----------|
| **Ollama** | `llama3.2:3b` | `ollama/ollama` | None | ~2 GB |
| **vLLM** | `nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8` | `nvcr.io/nvidia/vllm` | `VLLM_IMAGE_PULL_SECRET` only if nvcr.io requires it; `VLLM_HF_TOKEN_SECRET` only for gated HF | ~5.3 GB |
| **NIM** | `nvidia/nemotron-3-nano` | `nvcr.io/nim/nvidia/nemotron-3-nano` | `create-nim-ngc-secrets.sh` then `NIM_NGC_API_KEY_SECRET` + `NIM_IMAGE_PULL_SECRET` | ~8 GB |

These are registry/model credentials, not the chart inference API key. Put **Secret names** in `local.env`, never key values.

#### Agent and runtime support

Recipe examples (optional test scripts, no HPA):

- **OpenClaw** + Ollama (`llama3.2:3b`) — chart default — [`scripts/test-openclaw-ollama.sh`](scripts/test-openclaw-ollama.sh)
- **Hermes** + NIM (`nvidia/nemotron-3-nano`) — [`scripts/test-hermes-nim.sh`](scripts/test-hermes-nim.sh)
- **Deep Agents Code** + vLLM (`nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8`) — [`scripts/test-deepagents-vllm.sh`](scripts/test-deepagents-vllm.sh)


#### Switching runtimes

```bash
export INFERENCE_RUNTIME=vllm
export INFERENCE_MODEL=nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8
./scripts/install-hpa.sh

export INFERENCE_RUNTIME=nim INFERENCE_MODEL=nvidia/nemotron-3-nano
export NIM_NGC_API_KEY_SECRET=nim-ngc-key NIM_IMAGE_PULL_SECRET=ngc-registry
./scripts/install-hpa.sh

./scripts/create-agent-sandbox.sh   # recreate if it exists
./scripts/verify-agent-sandbox.sh
```

#### NVIDIA NIM registry access

NIM needs the same NGC key in **two** places: kubelet `imagePullSecret` (`nvcr.io/nim/...`) and in-container `NGC_API_KEY` (model profile). `create-nim-ngc-secrets.sh` creates both. 


```bash
kubectl create secret docker-registry ngc-registry \
  --docker-server=nvcr.io \
  --docker-username='$oauthtoken' \
  --docker-password=nvapi-... \
  -n nemoclaw-gpu
export NIM_NGC_API_KEY_SECRET=nim-ngc-key NIM_IMAGE_PULL_SECRET=ngc-registry
./scripts/install-hpa.sh
```

Set `nim.imagePullSecret.create=false` only if every GPU node already has nvcr.io pull access.

#### Ollama model tags

| Tag | Typical VRAM | Notes |
|-----|--------------|--------|
| `llama3.2:3b` | ~2 GB | Recipe default |
| `nemotron-3-nano:30b` | ~24–40 GB | Nemotron on L40S/H100 via Ollama |
| `qwen3.5:9b` / `qwen3.6:35b` | ~12 GB / ~30 GB | Alternatives that fit GPU memory |

```bash
export INFERENCE_MODEL=nemotron-3-nano:30b
./scripts/install-hpa.sh
./scripts/create-agent-sandbox.sh
./scripts/verify-agent-sandbox.sh
```

Helm: `inference.runtime`, `inference.model`. Scripts: `INFERENCE_RUNTIME`, `INFERENCE_MODEL`.

#### Persistence

Each runtime has its own hostPath cache (`ollama` / `vllm` / `nim` under `/var/lib/nemoclaw-gpu/…`). Multi-node: RWX StorageClass, or disable persistence (`emptyDir` → re-pull on replace).

### Recovery

Selected release only: `./scripts/cluster-recover.sh` (optional `RESTART_MICROK8S=1`). Read the script comments first.

### Kubernetes HPA metrics

| Metric | Scale out when | Install / test |
|--------|----------------|----------------|
| `gpu_utilization` (default) | avg GPU util **> 40%** | `./scripts/install-hpa.sh` |
| `latency_avg` | avg chat proxy latency **> 3000 ms** | `HPA_METRIC=latency_avg HPA_TARGET_LATENCY_MS=3000 ./scripts/install-hpa.sh` |

```bash
kubectl get --raw \
  '/apis/custom.metrics.k8s.io/v1beta1/namespaces/nemoclaw-gpu/pods/*/gpu_utilization_percent'
./scripts/get-hpa.sh -n nemoclaw-gpu
```

Latency load tests send a smoke request first, then wait up to 180s for Prometheus/Adapter (`LATENCY_METRIC_WAIT_SEC` to raise). Other Prometheus → Adapter metrics: extend `monitoring/prometheus-adapter-gpu-values.yaml` and `nemoclaw-gpu.hpaMetric`.

## Verify

```bash
kubectl get pods,service,hpa -n nemoclaw-gpu
./scripts/get-hpa.sh -n nemoclaw-gpu
./scripts/hpa-watch.sh
./scripts/get-metrics-proxy-pods.sh -n nemoclaw-gpu
```

Idle: one Running inference pod (two containers), HPA at 1 replica. GPU-util target `current/40`; latency `current/3000` (ms). Prefer `get-hpa.sh` over raw kubectl Quantity suffixes.

## Example test

Ask **In one sentence, what is an AI agent sandbox?** through authenticated inference.

| Path | Port-forward | Local URL |
|------|----------------|-----------|
| OpenShell (recommended) | `kubectl -n nemoclaw-sandboxes port-forward service/openshell 8080:8080` | `https://127.0.0.1:8080` |
| Metrics-proxy | `kubectl port-forward -n nemoclaw-gpu service/nemoclaw-gpu-metrics-proxy 8081:8081` | `http://127.0.0.1:8081` |

```bash
./scripts/verify-agent-sandbox.sh
```

A non-empty answer plus the final `OK:` line is a pass. Wording varies; small models may not know product names. Sample output: [`AGENT-SELECTION.md`](AGENT-SELECTION.md#example-verify-output).

N users / N OpenClaw + Ollama sandboxes through Envoy (`E2E_USERS=5` on this DGX): [OpenClaw + Ollama N-user end-to-end](#openclaw-ollama-n-user-end-to-end-sandboxes-saturate-hpa).

### Hermes simple test

This is the pairing check for Hermes. It is a oneshot through the in-sandbox
`hermes` binary and on-prem `https://inference.local`. It does **not** open a
browser, does **not** use `nemohermes launch`, and does **not** need the Hermes
gateway on `:8642`.

```bash
export PATH="${HOME}/.local/bin:${PATH}"
openshell sandbox exec -n hermes-onprem --no-tty -- \
  hermes -z "In one sentence, what is an AI agent sandbox?"
```

Pass: a non-empty sentence (wording varies). Do not pass `-m` (`hermes -z`
treats `-m` as the prompt). OpenShell must already be connected (`openshell status`).

`./scripts/verify-agent-sandbox.sh` also waits for in-sandbox
`http://localhost:8642/health`. That URL is inside the sandbox, not on the host
and not in a browser. Skip that script unless `./scripts/run-agent-sandbox.sh`
is already attached and healthy. Per-agent loops: [`AGENT-SELECTION.md`](AGENT-SELECTION.md#hermes).

Direct curl (loopback only; Bearer still required; **8081** not 8080):

```bash
kubectl port-forward -n nemoclaw-gpu service/nemoclaw-gpu-metrics-proxy 8081:8081
curl -s http://127.0.0.1:8081/healthz
INFERENCE_API_KEY="$(kubectl get secret nemoclaw-gpu-metrics-proxy-inference-api \
  -n nemoclaw-gpu -o jsonpath='{.data.api-key}' | base64 -d)"
curl -s http://127.0.0.1:8081/v1/chat/completions \
  -H "Authorization: Bearer ${INFERENCE_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"model":"llama3.2:3b","messages":[{"role":"user","content":"In one sentence, what is an AI agent sandbox?"}],"max_tokens":256,"stream":false}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["choices"][0]["message"]["content"])'
unset INFERENCE_API_KEY
```

`/healthz`, `/readyz`, `/metrics` are unauthenticated. `/readyz` may be `503` during the first model download.

## OpenShell details

### MicroK8s local registry

NodePort **32000**, plain HTTP `localhost:32000/...`. Docker needs `insecure-registries` for that host, then restart Docker.

```bash
microk8s enable registry
source versions.env
export AGENT_NAME=openclaw   # or hermes | deepagents
export AGENT_SANDBOX_IMAGE=localhost:32000/nemoclaw-${AGENT_NAME}-k8s:${NEMOCLAW_VERSION}
./scripts/build-agent-sandbox-image.sh
```

Any registry works if every node can pull the tag.

### Gateway and sandbox

- Apply Agent Sandbox CRDs yourself (`install-openshell-k8s.sh` does not).
- Image: versioned tag, no API key in the image.
- OIDC is default. Unauthenticated mode is dedicated-cluster + port-forward only. ClusterIP does not isolate from other pods.

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
# Unauth eval: omit --oidc-*
openshell status
```

`create-agent-sandbox.sh` stores the inference key, strips `integrate.api.nvidia.com` where the agent policy grants it, and smokes `/v1/models` plus a version check. It does not start the OpenClaw agent or send the example prompt — that is `verify-agent-sandbox.sh`. OpenClaw/Hermes need `run-agent-sandbox.sh` attached; Deep Agents Code uses `run-agent-prompt.sh`. Combined topology may need `SYS_ADMIN` / `NET_ADMIN` — check admission policy.

## Test autoscaling and load balancing

On 8× H100  `minReplicas=1` and `maxReplicas=8`. 

- **Fast HPA-only test:** it only tests if K8s HPA can autoscale the number of pods and GPUs based on inference requests, not an e2d test.

Use this for GPU-util HPA and for `HPA_METRIC=latency_avg HPA_TARGET_LATENCY_MS=3000`.

```bash
# 8× H100 on-prem
./scripts/hpa-load-test-dgx-8xh100.sh

# 4× L40S on AWS (Brev)
./scripts/hpa-load-test-brev-4xl40s.sh
```

- **OpenClaw + Ollama e2e test:** two terminals. Provision sandboxes with `agentscaling_gpuutil.sh` or `agentscaling_latency.sh`. Send chats with the same `client.sh`. Users talk only to sandbox `:18789`. The client does not set the HPA metric.
- `./scripts/test-hermes-e2e-hpa.sh` — Hermes + vLLM, next step. Do not run it while the OpenClaw + Ollama e2e owns the GPUs.

This DGX OpenClaw GPU-util run used **5** end users (one sandbox each). Size `E2E_USERS` so `E2E_USERS × AGENT_SANDBOX_MEMORY` fits the CPU node. Sandboxes use DGX **CPU cores and DRAM**, not the H100 GPUs.

OpenClaw + Ollama defaults (this DGX GPU-util success path):

- `AGENT_SANDBOX_CPU` **1**, `AGENT_SANDBOX_MEMORY` **8Gi** (1Gi, 2Gi, and 4Gi OOM-kill OpenClaw before `:18789` binds)
- one OpenClaw sandbox per user
- Job-like chats (`files/load-generator.ts` questions, `stream=false`). Questions average **~38 llama3.2 tokens**; `MAX_TOKENS` defaults to **608**
- inflight **1→2** per sandbox
- slim pin: `nemoclaw` plugin only, `NEMOCLAW_MINIMAL_BOOTSTRAP=1`

Hermes e2e still defaults to 1Gi unless you raise it. Pairing (`create-agent-sandbox.sh`) still defaults to 2 CPU / 4Gi for interactive use.

Agent sandboxes can run on a **different CPU node** with more memory. Keep GPU inference on the H100 node. See [FAQ](#agents-and-sandboxes-run-on-cpu--what-limits-how-many-i-can-run).

### OpenClaw + Ollama N-user end-to-end (sandboxes saturate HPA)

This is the multi-user architecture test for **OpenClaw + Ollama**. Pairing (`test-openclaw-ollama.sh`) stays one sandbox and does **not** enable HPA. Do not point this e2e at `nemoclaw-deepagents-vllm` / vLLM.

```text
E2E test: OpenClaw + Ollama
  5 end users send requests to 5 OpenClaw sandboxes
  5 OpenClaw sandboxes run on CPU
  LLM (Ollama llama3.2:3b) runs on GPUs
  HPA scales Ollama from 1 to 8 GPUs

        5 end users
            ↓  prompt to the OpenClaw sandbox :18789
        5 CPU OpenClaw sandboxes (openclaw-ollama-e2e-0000 … 0004)
            ↓  https://inference.local
        Envoy load balancer — LeastRequest
            ↓
        Ollama on GPUs
            1 GPU  →  demand rises  →  8 GPUs  →  idle  →  1 GPU
```

Queries go **into the sandboxes**. They are not POSTed at Envoy or metrics-proxy pod IPs. The Job (`hpa-load-test-dgx-8xh100.sh`) remains the fast HPA-only test.

The client does **not** build images, create sandboxes, or choose the HPA metric. Pick the provision script for the metric, then use the same client.

**GPU util (this DGX success path).** HPA metric `gpu_utilization_percent`, target 40%. kubectl TARGETS like `67500m/40` means **67.5%/40%**. Watch percentages with `get-hpa.sh`. On this host the 5-user client run drove GPU-util HPA to **8** replicas, then back to **1** after chats stopped. GPU % can cross 40% both ways, so replicas may step 3↔4 or 6↔7 before they settle.

```bash
cd deploy/helm/gpu_autoscaling_k8s
export PATH="${HOME}/.local/bin:${PATH}"
export KUBECONFIG="${HOME}/.kube/config"

# Terminal A — sandbox provision + GPU-util HPA
E2E_USERS=5 ./scripts/agentscaling_gpuutil.sh

# Terminal B — watch 67.5%/40%, not 67500m/40
./scripts/get-hpa.sh -n nemoclaw-gpu -w

# Terminal C — same client for any HPA metric
E2E_USERS=5 \
E2E_INFLIGHT_START_PER_USER=1 \
E2E_INFLIGHT_PER_USER=2 \
MAX_TOKENS=608 \
DURATION_SEC=180 \
./scripts/client.sh
```

`DURATION_SEC=180` is the short demo from that run. Raise it (default in `client.sh` is 900) if you need chats to stay up while HPA steps to 8. This k3s rejects `kubectl get hpa,deploy,svc`; watch one resource type per command, or use `get-hpa.sh`.

**LLM latency.** Same sandboxes and the same `client.sh`. Provision switches HPA to `latency_avg` (target 3000 ms). `get-hpa.sh` prints milliseconds (`46514/3000`).

```bash
# Terminal A — sandbox provision + latency HPA
E2E_USERS=5 ./scripts/agentscaling_latency.sh

# Terminal B
./scripts/get-hpa.sh -n nemoclaw-gpu -w

# Terminal C — identical client
E2E_USERS=5 ./scripts/client.sh
```

OpenShell must already be connected (`openshell status`). `ENABLE_ENVOY_LB=1`. Do not source `e2e-common.sh` (it forces `ENABLE_AUTOSCALING=0`). Do not set `minReplicas=8`. Tear down sandboxes with `./scripts/agentscaling_gpuutil.sh cleanup` or `./scripts/agentscaling_latency.sh cleanup`.

Optional one-process wrappers (same two steps in one terminal):

```bash
./scripts/test-openclaw-ollama-e2e-hpa.sh
./scripts/test-openclaw-ollama-e2e-latency-hpa.sh
```

Results land in `e2e-results/openclaw-ollama/` (gitignored).

### Hermes + vLLM N-user end-to-end (next step, do not run now)

Same user → sandbox path after OpenClaw + Ollama is done: load generator → N Hermes sandboxes (`hermes -z`) → `inference.local` → Envoy → **vLLM** HPA. Use the same `E2E_USERS` example (10). Cleanup only destroys `hermes-e2e-*` (not `hermes-onprem`, not `openclaw-ollama-e2e-*`). Do not run this while OpenClaw e2e owns the GPUs.

```bash
# After OpenClaw + Ollama e2e is done:
# ./scripts/test-hermes-e2e-hpa.sh
```

| Hardware | Command | Kind |
|----------|---------|------|
| **8× H100** on-prem | `./scripts/hpa-load-test-dgx-8xh100.sh` | Fast HPA-only Job (keep) |
| **8× H100** on-prem | `./scripts/agentscaling_gpuutil.sh` then `./scripts/client.sh` | OpenClaw + Ollama GPU-util (this DGX success path; 5 users) |
| **8× H100** on-prem | `./scripts/agentscaling_latency.sh` then `./scripts/client.sh` | OpenClaw + Ollama LLM-latency (`latency_avg` 3000 ms; same client) |
| **8× H100** on-prem | `./scripts/test-hermes-e2e-hpa.sh` | Longer Hermes + vLLM e2e (next) |
| **4× L40S** on AWS (Brev) | `./scripts/hpa-load-test-brev-4xl40s.sh` | Fast HPA-only Job |

Each run waits for HPA **1/1** Ready (up to 240s, `HPA_BASELINE_WAIT_SEC`) so a new test does not inherit a prior scale-down window — it will not force a scale-down under real traffic. While running, the HPA uses one-pod 40% steps, then restores `HPA_VALUES`. Load stops after a short hold at max so replicas return to 1.

```bash
# Same TLS overlay / local.env as install
# Fast HPA-only (keep; GPU util):
./scripts/hpa-load-test-dgx-8xh100.sh
# Fast HPA-only (keep; latency):
HPA_METRIC=latency_avg HPA_TARGET_LATENCY_MS=3000 ./scripts/hpa-load-test-dgx-8xh100.sh
# OpenClaw + Ollama GPU util (two terminals; this DGX success path):
#   ./scripts/agentscaling_gpuutil.sh
#   ./scripts/client.sh
# OpenClaw + Ollama LLM latency (same client):
#   ./scripts/agentscaling_latency.sh
#   ./scripts/client.sh
# 4× L40S:
./scripts/hpa-load-test-brev-4xl40s.sh
HPA_METRIC=latency_avg HPA_TARGET_LATENCY_MS=3000 ./scripts/hpa-load-test-brev-4xl40s.sh
./scripts/hpa-reset.sh
```

On 8× H100, `hpa-load-test-dgx-8xh100.sh` sets the metrics-proxy ServiceMonitor `release` label to `PROM_RELEASE` (default `kube-prometheus-stack`) so Prometheus scrapes `nemoclaw_llm_*` and latency HPA can read a current value instead of `?/3000`. GPU-util HPA uses DCGM and does not need that label.

With Envoy on, the script prints `Envoy LeastRequest OK: <pod>:+<delta>, …`. Skip that phase with `SKIP_ENVOY_LB_TEST=1`. Keep `ENABLE_ENVOY_LB` consistent with install.

HPA still adds **one** pod per step. After each step a new GPU sits at 0% until the model is loaded, which can drop the **average** under 40% and delay the next replica (~2 min/pod when busy GPUs are only ~50%). Raise in-flight on the already-busy pods so the average stays above 40% without waiting for the new GPU (do not add two pods per step — that dip is worse). If you see many HTTP 502s on 8× H100, stay at or below the 640 in-flight cap.

| Knob | Default | Purpose |
|------|---------|---------|
| `SKIP_ENVOY_LB_TEST` | `0` | Skip Envoy distribution check |
| `LB_TEST_REQUESTS` / `LB_TEST_CONCURRENCY` | `48` / `12` | Envoy check load |
| `DURATION_SEC` / `HPA_TARGET_GPU` | script / `40` | Load duration / util target |
| `INFLIGHT_PER_GPU` | `320` on 8× H100; `64` on 4× L40S | Concurrent chats aimed at each GPU |
| `LOAD_MULTIPLIER` | `2` | Extra in-flight vs `INFLIGHT_PER_GPU` |
| `MAX_INFLIGHT_PER_POD` | `640` on 8× H100; `512` on 4× L40S | Hard cap per pod |

Validated 4× L40S — GPU util > 40%:

<img width="1480" height="569" alt="HPA scaling to four GPU replicas under load (GPU utilization)" src="https://github.com/user-attachments/assets/6c37e52e-48fa-44a1-8ab6-878d90347bb9" />

Validated 4× L40S — latency > 3000 ms:

<img width="1484" height="557" alt="HPA scaling to four GPU replicas under load (latency_avg)" src="https://github.com/user-attachments/assets/c8cc50cd-455f-4348-9347-f45acc2e264b" />

## Grafana: watch workload balancing

Optional, while a load-test script is running.

```bash
kubectl port-forward -n monitoring service/kube-prometheus-grafana 3000:80
# http://127.0.0.1:3000 — login from secret kube-prometheus-grafana (admin-user / admin-password)
```

GPU util by pod:

```promql
avg by (exported_pod) (
  DCGM_FI_DEV_GPU_UTIL{
    exported_namespace="nemoclaw-gpu",
    exported_pod=~"nemoclaw-gpu-metrics-proxy-.*"
  }
)
```

LLM latency by pod (ms):

```promql
avg by (pod) (
  nemoclaw_llm_latency_avg_milliseconds{
    namespace="nemoclaw-gpu",
    pod=~"nemoclaw-gpu-metrics-proxy-.*"
  }
)
```

<img width="1505" height="847" alt="Grafana GPU utilization by pod" src="https://github.com/user-attachments/assets/7b20b03f-fe4a-4d9c-8c04-722dd8863c70" />

Successful requests by pod (distribution, not an HPA metric):

```promql
sum by (pod) (
  rate(nemoclaw_llm_requests_total{
    namespace="nemoclaw-gpu",
    result="success"
  }[5m])
)
```

<img width="1502" height="852" alt="Grafana successful inference requests by pod" src="https://github.com/user-attachments/assets/9858911e-73cf-4d60-87b6-70972df6d90c" />

After scale-up you should see multiple series. If latency graphs stay empty, check `kubectl get servicemonitor -n nemoclaw-gpu`.

## Uninstall

Stop `run-agent-sandbox.sh` (OpenClaw/Hermes). With the OpenShell port-forward up (names: `nemoclaw-onprem` / `onprem-ollama`, `hermes-onprem` / `onprem-hermes`, `deepagents-onprem` / `onprem-deepagents`):

```bash
openshell sandbox delete nemoclaw-onprem
openshell provider delete onprem-ollama
openshell gateway remove nemoclaw-k8s
rm -r -- "${XDG_CONFIG_HOME:-${HOME}/.config}/openshell/gateways/nemoclaw-k8s/mtls"
helm uninstall openshell -n nemoclaw-sandboxes
helm uninstall nemoclaw-gpu -n nemoclaw-gpu
```

Shared Prometheus, Adapter, Envoy, and Agent Sandbox CRDs are left in place.

## FAQ

### Agents and sandboxes run on CPU — what limits how many I can run?

This 8×H100 path is a **demo**. Agents and OpenShell sandboxes use **CPU cores and DRAM**, not the H100 GPUs. Each end user has one sandbox (`E2E_USERS`). `MAX_REPLICAS` is GPU pods only.

On this demo cluster the sandboxes run on the same DGX H100 node as Ollama. That node's CPU RAM limits how many 8Gi OpenClaw sandboxes you can start.

This DGX H100 uses **dual Intel Xeon Platinum 8480C** processors (56 cores each, 112 cores total) and **2 TB** DRAM. See the [DGX H100/H200 hardware overview](https://docs.nvidia.com/dgx/dgxh100-user-guide/introduction-to-dgxh100.html). It does not include an NVIDIA CPU.

Agent sandboxes do not need GPUs. They can run on a **different CPU node** with more memory. That node can hold more sandboxes and more end users. Keep Ollama and GPU HPA on the H100 node. This recipe does not add that CPU node. In this demo, `NEMOCLAW_TARGET_NODE` pins inference and sandboxes to the same GPU node. Multi-node sandbox disks need RWX storage (or disable persistence).

NVIDIA's data center CPU is **NVIDIA Grace** (Arm Neoverse V2):

- **Grace CPU C1** — 72 cores, single socket
- **Grace CPU Superchip** — 144 cores (two Grace chips linked by NVLink-C2C)

See the [NVIDIA Grace CPU Superchip](https://www.nvidia.com/en-us/data-center/grace-cpu-superchip/). NVIDIA also pairs Grace with GPUs in GH200 and GB200; those are GPU systems, not extra CPU-only capacity on this H100 box.

On this demo, OpenClaw e2e sandboxes are **1 CPU / 8Gi**. 1Gi, 2Gi, and 4Gi **OOMKill** OpenClaw at sandbox start (`exit 137`) because leftover Node.js workers fill the cgroup before `:18789` binds. Keep **one sandbox per user** and inflight **1→2**. Prefer more sandboxes × fewer prompts over packing Job-sized inflight into one sandbox.

### How is LLM latency calculated for HPA?

The **metrics-proxy** times the in-pod `chat/completions` fetch until the full response (including streams). That duration is **not** client→Envoy time. It is stored in a rolling window of 128 samples and exported as `nemoclaw_llm_latency_avg_milliseconds`. After 60s with no samples the gauge resets to 0 so HPA can scale down. Prometheus scrapes `/metrics`; the adapter exposes the same name; HPA uses Pods `AverageValue` **3000** (milliseconds). `kubectl get hpa` TARGETS like `46514/3000` means 46514 ms vs 3000 ms. GPU-util TARGETS like `20666m/40` are a different metric (`gpu_utilization_percent`).

Third-party notices: [THIRD-PARTY-NOTICES](../../../../THIRD-PARTY-NOTICES).
