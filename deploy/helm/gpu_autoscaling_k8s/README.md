
<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw Kubernetes GPU autoscaling

| Catalog field | Value |
|---------------|-------|
| Description | Helps Kubernetes operators match GPU inference capacity to demand by pairing CPU-only OpenShell sandboxes with Ollama replicas that scale on utilization or latency and return to one after load. |
| Industry | Data center and Cloud service |
| Requirements | Kubernetes 1.25+ · Helm 3 · NVIDIA GPU Operator/DCGM · Metrics Server · Docker Buildx + registry · OpenShell + Agent Sandbox CRDs pinned in versions.env · OIDC or acknowledged isolated-eval exception · experimental |
| NemoClaw | v0.0.104 |
| Harness | OpenClaw 2026.7.1 |
| OpenShell | 0.0.85 |

This experimental recipe demonstrates a cost-efficient architecture that runs AI agents securely inside CPU-only OpenShell sandboxes (one sandbox per end user) while independently autoscaling GPU-backed inference. The agents running in OpenShell sandboxes are one of **[`Openclaw | hermes | deepagents`](https://github.com/maggiezha/NemoClaw/tree/0821-2026/agents)**. Because GPU inference is the primary compute and cost bottleneck, Kubernetes HPA dynamically adjusts capacity from one to **N** replicas (1 GPU each) as demand changes—maintaining responsiveness during traffic spikes while releasing idle GPU resources when demand falls.

Supported GPU inference runtimes include **`ollama` / `vllm` / `nim`**.  Example pairings for e2e demo include: OpenClaw + Ollama (`AGENT_NAME=openclaw`), Hermes + vLLM (`AGENT_NAME=hermes`), Deep Agents Code + NIM (`AGENT_NAME=deepagents`).

Kubernetes HPA scales those inference pods using a Pods **`AverageValue`** metric (average across Ready pods). Example HPA metrics: **GPU utilization** (scale out when average per-pod util is **above 40%**) and **LLM latency** (scale out when average per-pod latency is **above 3000 ms**).


## Deployment Architecture

HPA scales to **N** inference pods (1 GPU each). The load balancer is **Envoy** (LeastRequest). Sandboxes reach GPUs at `https://inference.local`. Set install `MAX_REPLICAS` to the GPUs you intend to use (**N**). Load-test with the matching script in [Test autoscaling and load balancing](#test-autoscaling-and-load-balancing).

Each GPU pod is **2/2 Ready** when healthy: inference (`ollama` / `vllm` / `nim`) + `metrics-proxy` (auth, `/v1`, health, `/metrics`). Metrics-proxy, HPA, and the Envoy load balancer stay the same. Official pairings: [6a OpenClaw + Ollama](#6a-openclaw--ollama), [6b Hermes + vLLM](#6b-hermes--vllm-n-user-end-to-end), [6c Deep Agents + NIM](#6c-deep-agents-code--nim-n-user-end-to-end).

Isolated eval uses `ALLOW_INSECURE_HTTP=1` (Envoy with no TLS overlay). HTTPS Envoy uses [TLS values](#tls-values).

```text
End users (1 pairing sandbox, or M e2e sandboxes — one per user)
        ↓
CPU-only OpenShell sandboxes (AGENT_NAME=openclaw | hermes | deepagents)
        ↓
OpenShell https://inference.local
        ↓
Envoy load balancer — LeastRequest
        ↓
Authenticated inference endpoints
├─ Inference pod (ollama|vllm|nim) → GPU 1
├─ …
└─ Inference pod (ollama|vllm|nim) → GPU N
        ↑
HPA (GPU util >40% or latency >3000 ms)
```


The chart generates a local inference API key (Bearer on `/v1`). OpenShell injects it for the sandbox. It is not an Ollama pull key, OpenAI key, or `NVIDIA_API_KEY`.

`latency_avg` is metrics-proxy **chat/completions duration** on that pod (in-pod fetch until the full response, including streams). It excludes client→Envoy time. After 60s with no samples the gauge resets to 0 so HPA can scale down. `get-hpa.sh` prints milliseconds (`46514/3000` = 46514 ms / 3000 ms).

## Prerequisites

Install Kubernetes and make sure `kubectl get nodes` succeeds. Cluster install scripts: [How to install Kubernetes](#how-to-install-kubernetes).

## Quick start guide

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
# Helm GPU Operator: export DCGM_NAMESPACE=gpu-operator
# microk8s enable gpu: default gpu-operator-resources
kubectl get nodes \
  -o jsonpath='{range .items[*]}{.metadata.name}{" GPUs="}{.status.allocatable.nvidia\.com/gpu}{"\n"}{end}'
kubectl get pods -n "${DCGM_NAMESPACE:-gpu-operator-resources}" -l app=nvidia-dcgm-exporter
```

### 3. Install the OpenShell gateway once

Skip this if `kubectl -n nemoclaw-sandboxes get svc openshell` succeeds. The e2e scripts do not create this namespace.

```bash
source versions.env
kubectl apply -f \
  "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/manifest.yaml"
AGENT_SANDBOX_IMAGE=ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:bd935f0198b99889d9479fea123b62a59e3797da13e392dcc2160f114216c1ba \
ALLOW_UNAUTHENTICATED_OPENSHELL=1 \
OPENSHELL_UNAUTHENTICATED_ACK=dedicated-cluster-port-forward-only \
  ./scripts/install-openshell-k8s.sh
```

### 4. Install GPU inference and the Envoy load balancer once

Skip this if `kubectl get gatewayclass eg` succeeds. The e2e scripts update the GPU chart; they do not install the Envoy load balancer.

```bash
# MicroK8s GPU addon: DCGM_NAMESPACE=gpu-operator-resources
DCGM_NAMESPACE=gpu-operator MAX_REPLICAS=8 ENABLE_ENVOY_LB=1 ALLOW_INSECURE_HTTP=1 \
  ./scripts/install-hpa.sh
kubectl get gatewayclass eg
```

### 5. Connect the OpenShell CLI

Keep this attached:

```bash
./scripts/openshell-port-forward.sh
```

In another terminal, copy client TLS and register the gateway. After a reinstall, refresh the certs or you get `BadSignature`.

```bash
MTLS_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/openshell/gateways/nemoclaw-k8s/mtls"
mkdir -p "${MTLS_DIR}"
for key in ca.crt tls.crt tls.key; do
  kubectl get secret openshell-client-tls -n nemoclaw-sandboxes \
    -o "jsonpath={.data.${key//./\\.}}" | base64 -d >"${MTLS_DIR}/${key}"
done
chmod 600 "${MTLS_DIR}"/*
openshell gateway remove nemoclaw-k8s 2>/dev/null || true
openshell gateway add https://127.0.0.1:18080 --local --name nemoclaw-k8s
openshell status
```

`openshell status` must succeed before the e2e.

### 6. E2E test with multiple end users and sandboxes

Queries from end users go **into the sandboxes**, one sandbox per end user. Any pairing can be first after steps 1–5. Provision waits for HPA **1/1** Ready (up to 240s, `HPA_BASELINE_WAIT_SEC`). 

Validation is on DGX **8× H100** (80 GB) on-prem. The DGX H100 demo uses 5 end users, `E2E_USERS=5` and one sandbox per user. This 8×H100 demo runs those sandboxes on the DGX H100 **CPU cores and DRAM**.. Sandboxes can run on a different CPU node with more memory to support more sandboxes and end users. Size `E2E_USERS` so `E2E_USERS × AGENT_SANDBOX_MEMORY` fits the CPU node. 

<img width="643" height="584" alt="Screenshot 2026-09-11 at 1 26 10 AM" src="https://github.com/user-attachments/assets/2c940d43-c304-4e0a-ac32-55f13da5f722" />

#### 6a. OpenClaw + Ollama

- `AGENT_SANDBOX_CPU` **1**, `AGENT_SANDBOX_MEMORY` **8Gi** (1Gi, 2Gi, and 4Gi OOM-kill OpenClaw before `:18789` binds)
- inflight **1** per sandbox (one agent per sandbox)
- Job-like chats (`files/load-generator.ts`, `stream=false`). Questions average **~38 llama3.2 tokens**; `MAX_TOKENS` defaults to **608**

Agent sandboxes can run on a **different CPU node** with more memory. Keep GPU inference on the H100 node. See [FAQ](#agents-and-sandboxes-run-on-cpu--what-limits-how-many-i-can-run). 

```text
E2E test: OpenClaw + Ollama
  5 end users send requests to 5 OpenClaw agents
  5 OpenClaw agents run in 5 OpenShell sandboxes
  LLM (Ollama llama3.2:3b) runs on GPUs
  HPA scales Ollama from 1 to 8 GPUs

        5 end users
            ↓  prompt to the OpenShell sandbox :18789
        5 OpenShell sandboxes (sandbox 0 … sandbox 4)
            ↓  https://inference.local
        Envoy load balancer — LeastRequest
            ↓
        Ollama on GPUs
            1 GPU  →  demand rises  →  8 GPUs  →  idle  →  1 GPU
```

**GPU util** HPA metric `gpu_utilization_percent`, target 40%. kubectl TARGETS like `67500m/40` means **67.5%/40%**. Watch percentages with `get-hpa.sh`. On this host the 5-user client run drove GPU-util HPA to **8** replicas, then back to **1** after chats stopped. 

```bash
cd deploy/helm/gpu_autoscaling_k8s
export PATH="${HOME}/.local/bin:${PATH}"
export KUBECONFIG="${HOME}/.kube/config"

# Terminal A — sandbox provision + GPU-util HPA
# Isolated eval (no TLS overlay): keep ALLOW_INSECURE_HTTP=1 from step 4.
# A TLS install can omit that variable.
E2E_USERS=5 ALLOW_INSECURE_HTTP=1 ./scripts/agentscaling_gpuutil.sh

# Terminal B — watch 67.5%/40%, not 67500m/40
./scripts/get-hpa.sh -n nemoclaw-gpu -w

# Terminal C — same client for any HPA metric (inflight 1 is the script default)
E2E_USERS=5 \
MAX_TOKENS=608 \
./scripts/client.sh
```


**LLM latency.** Same sandboxes and the same `client.sh`. Provision switches HPA to `latency_avg` (target 3000 ms). `get-hpa.sh` prints milliseconds (`46514/3000`). Load keeps running until HPA **current replicas = 8**, then drops so GPUs can scale back to 1. Do not pass `DURATION_SEC=180` — that stopped the last run at 5 GPUs.

```bash
# Terminal A — sandbox provision + latency HPA
E2E_USERS=5 ALLOW_INSECURE_HTTP=1 ./scripts/agentscaling_latency.sh

# Terminal B
./scripts/get-hpa.sh -n nemoclaw-gpu -w

# Terminal C — same client; stops at 8 GPUs, not at 5 users
E2E_USERS=5 \
MAX_TOKENS=608 \
./scripts/client.sh
```

Validated on DGX 8×H100, HPA metric for autoscaling: GPU utilization (target 40%):
<p align="center">
<img width="818" height="561" alt="Screenshot 2026-09-30 at 2 28 52 PM" src="https://github.com/user-attachments/assets/f2152e25-bde8-4156-9391-db3bee85aa1b" />
</p>


Validated on DGX 8xH100, HPA metric for autoscaling: LLM latency (target 3000 ms):
<p align="center">
<img width="841" height="251" alt="Screenshot 2026-09-30 at 5 02 10 PM" src="https://github.com/user-attachments/assets/6235b4f9-9156-43d6-8196-c3e75ee1d7c9" />
</p>


Check the log to see the end users, sandboxes, and chats: 
<p align="center">
<img width="791" height="261" alt="Screenshot 2026-09-28 at 6 04 34 PM" src="https://github.com/user-attachments/assets/be06f646-84a8-49b9-889a-082ef1c73b5d" />
</p>





#### 6b. Hermes + vLLM 

vLLM pulls the image `nvcr.io/nvidia/vllm`. Kubelet needs an `nvcr.io` **image-pull** Secret before `agentscaling_hermes_gpuutil.sh`. The `nvapi-` value in `secrets.env` is that pull password. `apply-local-secrets.sh` stores it as Kubernetes Secret `ngc-registry` (`dockerconfigjson`). The vLLM **container** never gets `NGC_API_KEY`; only NIM uses that in-container env for model-profile download.

```bash
cd deploy/helm/gpu_autoscaling_k8s
cp -n secrets.env.example secrets.env
# edit secrets.env: paste NGC_API_KEY=nvapi-...  (required — becomes Secret ngc-registry for kubelet)
# optional: HF_TOKEN=hf_... only if Hugging Face returns 401 for the model
./scripts/apply-local-secrets.sh
```

If `HF_TOKEN` is set, the script also creates Secret `hf-token`. Put only the **Secret names** in gitignored `local.env`:

```bash
# local.env — names, not key values
export VLLM_IMAGE_PULL_SECRET=ngc-registry
# export VLLM_HF_TOKEN_SECRET=hf-token   # only if you set HF_TOKEN
``` 

After steps 1–5 (`openshell status` Connected, `gatewayclass eg` present). **One OpenShell gateway** for all sandboxes. This DGX demo uses `E2E_USERS=5`, inflight **1**, and **4Gi** sandboxes. 

```text
E2E test: Hermes + vLLM
  5 end users send requests to 5 Hermes agents
  5 Hermes agents run in 5 OpenShell sandboxes
  LLM (vLLM NVIDIA-Nemotron-3-Nano-4B-FP8) runs on GPUs
  HPA scales vLLM from 1 to 8 GPUs

        5 end users
            ↓  prompt to the OpenShell sandbox (hermes -z)
        5 OpenShell sandboxes (sandbox 0 … sandbox 4)
            ↓  https://inference.local
        Envoy load balancer — LeastRequest
            ↓
        vLLM on GPUs
            1 GPU  →  demand rises  →  8 GPUs  →  idle  →  1 GPU
```

```bash
cd deploy/helm/gpu_autoscaling_k8s
export PATH="${HOME}/.local/bin:${PATH}"
export KUBECONFIG="${HOME}/.kube/config"

# Terminal A — sandbox provision + GPU-util HPA
# Isolated eval (no TLS overlay): keep ALLOW_INSECURE_HTTP=1 from step 4.
E2E_USERS=5 ALLOW_INSECURE_HTTP=1 ./scripts/agentscaling_hermes_gpuutil.sh

# Terminal B — watch 99%/40%, not millicores
./scripts/get-hpa.sh -n nemoclaw-gpu -w

# Terminal C — same client for either HPA metric (inflight 1 is the script default)
E2E_USERS=5 ./scripts/client_hermes.sh
```

**LLM latency.** Same sandboxes and the same `client_hermes.sh`. Provision switches HPA to `latency_avg` (target 3000 ms).

```bash
# Terminal A — sandbox provision + latency HPA
E2E_USERS=5 ALLOW_INSECURE_HTTP=1 ./scripts/agentscaling_hermes_latency.sh

# Terminal B
./scripts/get-hpa.sh -n nemoclaw-gpu -w

# Terminal C
E2E_USERS=5 ./scripts/client_hermes.sh
```

Validated on DGX 8×H100, HPA metric for autoscaling: GPU utilization (target 40%):
<img width="820" height="387" alt="Screenshot 2026-10-01 at 2 08 53 PM" src="https://github.com/user-attachments/assets/7f90447e-ce20-4e14-80bf-5716be28001a" />


Validated on DGX 8xH100, HPA metric for autoscaling: LLM latency (target 3000 ms):
<img width="849" height="521" alt="Screenshot 2026-10-01 at 1 53 17 PM" src="https://github.com/user-attachments/assets/2c0c3b90-761a-4b9b-9a34-0551219d4441" />





#### 6c. Deep Agents Code + NIM 

NIM needs **both** NGC_API_KEY before `agentscaling_deepagents_gpuutil.sh`. 

- Kubernetes Secret `ngc-registry` (`dockerconfigjson`) — kubelet pulls `nvcr.io/nim/nvidia/nemotron-3-nano`
- Kubernetes Secret `nim-ngc-key` (Opaque, key `NGC_API_KEY`) — the **running NIM container** downloads the model profile

```bash
cd deploy/helm/gpu_autoscaling_k8s
cp -n secrets.env.example secrets.env
# edit secrets.env: paste NGC_API_KEY=nvapi-...  (required — both Secrets above)
./scripts/apply-local-secrets.sh
```

Put only the **Secret names** in gitignored `local.env`:

```bash
# local.env — names, not key values
export NIM_IMAGE_PULL_SECRET=ngc-registry
export NIM_NGC_API_KEY_SECRET=nim-ngc-key
```

Deep Agents has no long-running gateway.

```text
E2E test: Deep Agents Code + NIM
  5 end users send requests to 5 Deep Agents
  5 Deep Agents run in 5 OpenShell sandboxes
  LLM (NIM nvidia/nemotron-3-nano) runs on GPUs
  HPA scales NIM from 1 to 8 GPUs

        5 end users
            ↓  prompt to the OpenShell sandbox (dcode -n)
        5 OpenShell sandboxes (sandbox 0 … sandbox 4)
            ↓  https://inference.local
        Envoy load balancer — LeastRequest
            ↓
        NIM on GPUs
            1 GPU  →  demand rises  →  8 GPUs  →  idle  →  1 GPU
```

```bash
cd deploy/helm/gpu_autoscaling_k8s
export PATH="${HOME}/.local/bin:${PATH}"
export KUBECONFIG="${HOME}/.kube/config"

# Terminal A — sandbox provision + GPU-util HPA
# Isolated eval (no TLS overlay): keep ALLOW_INSECURE_HTTP=1 from step 4.
E2E_USERS=5 ALLOW_INSECURE_HTTP=1 ./scripts/agentscaling_deepagents_gpuutil.sh

# Terminal B — watch 99%/40%, not millicores
./scripts/get-hpa.sh -n nemoclaw-gpu -w

# Terminal C — same client for either HPA metric (inflight 1 is the script default)
E2E_USERS=5 ./scripts/client_deepagents.sh
```

**LLM latency.** Same sandboxes and the same `client_deepagents.sh`. Provision switches HPA to `latency_avg` (target 3000 ms).

```bash
# Terminal A — sandbox provision + latency HPA
E2E_USERS=5 ALLOW_INSECURE_HTTP=1 ./scripts/agentscaling_deepagents_latency.sh

# Terminal B
./scripts/get-hpa.sh -n nemoclaw-gpu -w

# Terminal C
E2E_USERS=5 ./scripts/client_deepagents.sh
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

HTTPS Envoy needs a TLS overlay. Isolated eval uses `ALLOW_INSECURE_HTTP=1` (no overlay). **Every** recipe `helm upgrade` that serves HTTPS needs an overlay with `ingress.tls` — chart `values.yaml` alone is not enough.

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

### Scheduling

- Unset `NEMOCLAW_TARGET_NODE` for portable scheduling. Multi-node needs RWX (or disable persistence — [Persistence](#persistence)); default hostPath is single-node.
- Pin with `export NEMOCLAW_TARGET_NODE=<node>` after Ready + GPU label + allocatable GPUs ≥ `MAX_REPLICAS`.
- `MAX_REPLICAS` and load-test `TARGET_PODS` must not exceed allocatable GPUs in scope. Host `nvidia-smi` processes are not reserved.
- Keep `HPA_VALUES`, `INGRESS_HOST`, and `NEMOCLAW_TARGET_NODE` consistent across install, reset, and load test.

### Ingress security

The Envoy dataplane Service is **ClusterIP** only (`NodePort` / `LoadBalancer` rejected). Use `kubectl port-forward` from outside.

- External HTTPS: Gateway Basic auth + inference key as `X-Api-Key`. OpenShell HTTPRoute: Bearer only.
- TLS required by default. Isolated eval: `ALLOW_INSECURE_HTTP=1` (ClusterIP). Preflight checks reported exposure; it does not prove private-network isolation.
- Auth Secrets use Helm `keep`. Delete to rotate; never commit keys.
- No NetworkPolicy from the chart — add one if the cluster needs it.

### Inference runtimes

`INFERENCE_RUNTIME` / `inference.runtime`: **`ollama`** (default), **`vllm`**, or **`nim`**. Same 1 GPU → 1 pod → local `/v1` pattern.

| Runtime | Default model | Image | Credentials | Min VRAM |
|---------|----------------|-------|-------------|----------|
| **Ollama** | `llama3.2:3b` | `ollama/ollama` | None | ~2 GB |
| **vLLM** | `nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8` | `nvcr.io/nvidia/vllm` | `VLLM_IMAGE_PULL_SECRET` only if nvcr.io requires it; `VLLM_HF_TOKEN_SECRET` only for gated HF | ~5.3 GB |
| **NIM** | `nvidia/nemotron-3-nano` | `nvcr.io/nim/nvidia/nemotron-3-nano` | `apply-local-secrets.sh` then `NIM_IMAGE_PULL_SECRET` + `NIM_NGC_API_KEY_SECRET` | ~8 GB |

These are registry/model credentials, not the chart inference API key. Put **Secret names** in `local.env`, never key values. For `nvcr.io` pulls (vLLM image and NIM), run `./scripts/apply-local-secrets.sh` from gitignored `secrets.env` — do not put `nvapi-` keys on the kubectl command line.

#### Persistence

This is the **on-disk cache for downloaded model weights**, not a database. On this single-node DGX the chart writes them to a folder on the GPU node (`/var/lib/nemoclaw-gpu/ollama`, `/vllm`, or `/nim`). The first pod pulls the model once; later HPA replicas on the same node reuse that folder. If you turn persistence off, each new pod downloads the model again. Shared storage (RWX) is only needed if inference pods run on more than one node.

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

## Example test

### OpenClaw simple test

Ask **In one sentence, what is an AI agent sandbox?** through authenticated inference. This is the pairing check for OpenClaw (`AGENT_NAME=openclaw`). Keep `./scripts/run-agent-sandbox.sh` attached so `:18789` is up.

| Path | Port-forward | Local URL |
|------|----------------|-----------|
| OpenShell (recommended) | `./scripts/openshell-port-forward.sh` | `https://127.0.0.1:18080` |
| Metrics-proxy | `kubectl port-forward -n nemoclaw-gpu service/nemoclaw-gpu-metrics-proxy 8081:8081` | `http://127.0.0.1:8081` |

```bash
export AGENT_NAME=openclaw
./scripts/verify-agent-sandbox.sh
```

A non-empty answer plus the final `OK:` line is a pass. Wording varies; small models may not know product names. Sample output: [`AGENT-SELECTION.md`](AGENT-SELECTION.md#example-verify-output).


### Hermes simple test

This is the pairing check for Hermes. It is a oneshot through the in-sandbox
`hermes` binary and on-prem `https://inference.local`. It does **not** open a
browser, does **not** use `nemohermes launch`, and does **not** need the Hermes
gateway on `:8642`.

```bash
export PATH="${HOME}/.local/bin:${PATH}"
openshell sandbox exec -n hermes-onprem --no-tty -- \
  hermes -z "In one sentence, what is an AI agent sandbox?" --safe-mode
```

Pass: a non-empty sentence (wording varies). Do not pass `-m` (`hermes -z`
treats `-m` as the prompt). `--safe-mode` keeps a small local model from emitting
tool JSON instead of a sentence. OpenShell must already be connected (`openshell status`).

`./scripts/verify-agent-sandbox.sh` also waits for in-sandbox
`http://localhost:8642/health`. That URL is inside the sandbox, not on the host
and not in a browser. Skip that script unless `./scripts/run-agent-sandbox.sh`
is already attached and healthy. Per-agent loops: [`AGENT-SELECTION.md`](AGENT-SELECTION.md#hermes).

Direct curl (loopback only; Bearer still required; **8081**):

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

### Gateway and sandbox

- Apply Agent Sandbox CRDs yourself (`install-openshell-k8s.sh` does not).
- Sandbox image is the published GHCR digest (`ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:…` for OpenClaw e2e; Hermes e2e uses `ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:…`). No API key is in the image.
- OIDC is default. Unauthenticated mode is dedicated-cluster + port-forward only. ClusterIP does not isolate from other pods.

```bash
MTLS_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/openshell/gateways/nemoclaw-k8s/mtls"
mkdir -p "${MTLS_DIR}"
for key in ca.crt tls.crt tls.key; do
  kubectl get secret openshell-client-tls -n nemoclaw-sandboxes \
    -o "jsonpath={.data.${key//./\\.}}" | base64 -d >"${MTLS_DIR}/${key}"
done
chmod 600 "${MTLS_DIR}"/*
openshell gateway add https://127.0.0.1:18080 --local --name nemoclaw-k8s
openshell status
```

`create-agent-sandbox.sh` stores the inference key, strips `integrate.api.nvidia.com` where the agent policy grants it, and smokes `/v1/models` plus a version check. It does not start the OpenClaw agent or send the example prompt — that is `verify-agent-sandbox.sh`. OpenClaw/Hermes need `run-agent-sandbox.sh` attached; Deep Agents Code uses `run-agent-prompt.sh`. Combined topology may need `SYS_ADMIN` / `NET_ADMIN` — check admission policy.

## Simple HPA only test 

This only tests if K8s HPA can autoscale the number of pods and GPUs based on inference requests, not an e2e test.

Use GPU utilization as a HPA metric

```bash
# 8× H100 on-prem
./scripts/hpa-load-test-dgx-8xh100.sh

# 4× L40S on AWS (Brev)
./scripts/hpa-load-test-brev-4xl40s.sh
```


Use LLM latency as a HPA metric: 

```bash
# 8× H100 on-prem
HPA_METRIC=latency_avg HPA_TARGET_LATENCY_MS=3000 ./scripts/hpa-load-test-dgx-8xh100.sh

# 4× L40S on AWS (Brev)
HPA_METRIC=latency_avg HPA_TARGET_LATENCY_MS=3000 ./scripts/hpa-load-test-brev-4xl40s.sh
```

The HPA-only test has been verified on DGX 8xH100 on-prem `maxReplicas=8`, and [Brev AWS](https://brev.nvidia.com) **4× L40S** (48 GB), `MAX_REPLICAS=4`.

HPA still adds **one** pod per step. After each step a new GPU sits at 0% until the model is loaded, which can drop the **average** under 40% and delay the next replica (~2 min/pod when busy GPUs are only ~50%). Raise in-flight on the already-busy pods so the average stays above 40% without waiting for the new GPU (do not add two pods per step — that dip is worse). If you see many HTTP 502s on 8× H100, stay at or below the 640 in-flight cap.


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

<p align="center">
<img width="1505" height="847" alt="Grafana GPU utilization by pod" src="https://github.com/user-attachments/assets/7b20b03f-fe4a-4d9c-8c04-722dd8863c70" />
</p>

Successful requests by pod (distribution, not an HPA metric):

```promql
sum by (pod) (
  rate(nemoclaw_llm_requests_total{
    namespace="nemoclaw-gpu",
    result="success"
  }[5m])
)
```

<p align="center">
<img width="1502" height="852" alt="Grafana successful inference requests by pod" src="https://github.com/user-attachments/assets/9858911e-73cf-4d60-87b6-70972df6d90c" />
</p>

After scale-up you should see multiple series. If latency graphs stay empty, check `kubectl get servicemonitor -n nemoclaw-gpu`.

## Uninstall

There is **one** OpenShell gateway for every sandbox (OpenClaw, Hermes, and Deep Agents). Do not install a second gateway.

### Optional: e2e sandboxes — only if you want to save CPU RAM

Skip this if the node has enough DRAM. Agent sandboxes use this DGX H100's **CPU cores and DRAM**, not the H100 GPUs (OpenClaw e2e is 8Gi each; Hermes and Deep Agents e2e are 4Gi each). This 2 TB DGX has plenty, so other-agent sandboxes can stay. GPU inference can stay too.

```bash
./scripts/agentscaling_gpuutil.sh cleanup               # openclaw-ollama-e2e-*
./scripts/agentscaling_hermes_gpuutil.sh cleanup        # hermes-e2e-*
./scripts/agentscaling_deepagents_gpuutil.sh cleanup    # deepagents-e2e-*
# or all agent sandboxes (pairing names too): ./scripts/uninstall-e2e.sh
```

### Full recipe uninstall

Stop `run-agent-sandbox.sh` (OpenClaw/Hermes). With the OpenShell port-forward up:

```bash
./scripts/uninstall-e2e.sh
openshell gateway remove nemoclaw-k8s
rm -r -- "${XDG_CONFIG_HOME:-${HOME}/.config}/openshell/gateways/nemoclaw-k8s/mtls"
helm uninstall openshell -n nemoclaw-sandboxes
helm uninstall nemoclaw-gpu -n nemoclaw-gpu
```

Shared Prometheus, Adapter, the Envoy load balancer, and Agent Sandbox CRDs are left in place.

## FAQ

### Agents and sandboxes run on CPU — what limits how many I can run?

This 8×H100 path is a **demo**. Agents and OpenShell sandboxes use **CPU cores and DRAM**, not the H100 GPUs. Each end user has one sandbox (`E2E_USERS`). `MAX_REPLICAS` is GPU pods only.

On this demo cluster the sandboxes run on the same DGX H100 node as Ollama. That node's CPU RAM limits how many 8Gi OpenShell sandboxes you can start.

This DGX H100 uses **dual Intel Xeon Platinum 8480C** processors (56 cores each, 112 cores total) and **2 TB** DRAM. See the [DGX H100/H200 hardware overview](https://docs.nvidia.com/dgx/dgxh100-user-guide/introduction-to-dgxh100.html). 

Agent sandboxes do not need GPUs. They can run on a **different CPU node** with more memory. That node can hold more sandboxes and more end users. Keep inference runtimes and autoscaling on the GPUs. 

NVIDIA's data center CPU is **NVIDIA Grace** (Arm Neoverse V2):

- **Grace CPU C1** — 72 cores, single socket
- **Grace CPU Superchip** — 144 cores (two Grace chips linked by NVLink-C2C)

See the [NVIDIA Grace CPU Superchip](https://www.nvidia.com/en-us/data-center/grace-cpu-superchip/). NVIDIA also pairs Grace with GPUs in GH200 and GB200; those are GPU systems, not extra CPU-only capacity on this H100 box.


### How is LLM latency calculated for HPA?

The **metrics-proxy** times the in-pod `chat/completions` fetch until the full response (including streams). That duration is **not** client→Envoy time. It is stored in a rolling window of 128 samples and exported as `nemoclaw_llm_latency_avg_milliseconds`. After 60s with no samples the gauge resets to 0 so HPA can scale down. Prometheus scrapes `/metrics`; the adapter exposes the same name; HPA uses Pods `AverageValue` **3000** (milliseconds). `kubectl get hpa` TARGETS like `46514/3000` means 46514 ms vs 3000 ms. GPU-util TARGETS like `20666m/40` are a different metric (`gpu_utilization_percent`).

### What port numbers are used?

`kubectl port-forward` is **`LOCAL:REMOTE`**: host port, then the Service port in the cluster.

| Name | Port | Where |
|------|------|-------|
| OpenShell CLI | **18080** | Host. `./scripts/openshell-port-forward.sh`. `openshell status` uses `https://127.0.0.1:18080`. |
| OpenClaw agent | **18789** | Inside each OpenClaw sandbox. E2e clients talk here. Do not port-forward. |
| Hermes gateway | **8642** | Inside each Hermes sandbox. `hermes -z` e2e does not forward it. |
| Envoy load balancer | **443** / **80** | Cluster. Sandboxes use `https://inference.local`. |
| Metrics-proxy | **8081** | Cluster `service/nemoclaw-gpu-metrics-proxy`. Optional host forward `8081:8081`. |
| Ollama | **11434** | Inside each Ollama GPU pod. |
| vLLM / NIM | **8000** | Inside each vLLM or NIM GPU pod. |
| Grafana | **3000** | Host, optional `3000:80` (Service port 80). |
| k3s API | **6443** | Host. Connection refused here means the cluster is down. |
| MicroK8s API | **16443** | Host. Same role as k3s 6443. |
| minikube API | **8443** | Host, when using [minikube](#minikube). |

### How to install Kubernetes?

Pick one of [k3s](https://docs.k3s.io/quick-start), [MicroK8s](https://microk8s.io/docs/getting-started), or [minikube](https://minikube.sigs.k8s.io/docs/start/). Then `kubectl get nodes` must succeed. Return to [Quick start](#quick-start-guide).

This DGX demo uses **k3s**. The [Brev](https://brev.nvidia.com) 4× L40S HPA test used **MicroK8s**.

#### k3s

If k3s is already installed, do not run `get.k3s.io` again.

```bash
curl -sfL https://get.k3s.io | sh -
mkdir -p "${HOME}/.kube"
sudo cp /etc/rancher/k3s/k3s.yaml "${HOME}/.kube/config"
sudo chown "$(id -u):$(id -g)" "${HOME}/.kube/config"
export KUBECONFIG="${HOME}/.kube/config"
kubectl get nodes
```

If `kubectl` prints connection refused to `127.0.0.1:6443`, start k3s: `sudo systemctl start k3s`. Then retry `kubectl get nodes`.

This k3s host uses Helm GPU Operator with `DCGM_NAMESPACE=gpu-operator` (`driver.enabled=false` when the host already has the NVIDIA driver).

#### MicroK8s

```bash
sudo snap install microk8s --classic
sudo microk8s status --wait-ready
mkdir -p "${HOME}/.kube"
sudo microk8s config > "${HOME}/.kube/config"
export KUBECONFIG="${HOME}/.kube/config"
kubectl get nodes
```

If `kubectl` cannot reach the API, start MicroK8s: `sudo microk8s start` and `sudo microk8s status --wait-ready`.

MicroK8s GPU addon: `install-hpa.sh` can run `microk8s enable gpu` and `microk8s enable metrics-server`. DCGM namespace is then `gpu-operator-resources`.

#### minikube

```bash
curl -LO https://github.com/kubernetes/minikube/releases/latest/download/minikube-linux-amd64
sudo install minikube-linux-amd64 /usr/local/bin/minikube
rm -f minikube-linux-amd64
minikube start
export KUBECONFIG="${HOME}/.kube/config"
kubectl get nodes
```

GPU on minikube is outside this DGX path. Use the [minikube NVIDIA GPU tutorial](https://minikube.sigs.k8s.io/docs/tutorials/nvidia/) if you need GPUs there.
