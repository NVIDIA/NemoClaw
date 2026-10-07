
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

Kubernetes HPA scales those inference pods using a Pods **`AverageValue`** metric (average across Ready pods). Example HPA metrics: **GPU utilization** (target **40%**) and **LLM latency** (target **3000 ms**). Kubernetes does not scale on every sample above the target; see [Kubernetes HPA metrics](#kubernetes-hpa-metrics).


## Deployment Architecture

HPA scales to **N** inference pods (1 GPU each). The load balancer is **Envoy** (LeastRequest). Sandboxes reach GPUs at `https://inference.local`. Set install `MAX_REPLICAS` to the GPUs you intend to use (**N**). Load-test with the matching script in [Simple HPA only test (optional)](#simple-hpa-only-test-optional).

Each GPU pod is **2/2 Ready** when healthy: inference (`ollama` / `vllm` / `nim`) + `metrics-proxy` (auth, `/v1`, health, `/metrics`). Metrics-proxy, HPA, and the Envoy load balancer stay the same. Official pairings: [6a OpenClaw + Ollama](#6a-openclaw--ollama), [6b Hermes + vLLM](#6b-hermes--vllm), [6c Deep Agents + NIM](#6c-deep-agents-code--nim).

Isolated eval uses `ALLOW_INSECURE_HTTP=1` (Envoy with no TLS overlay). HTTPS Envoy uses [TLS values](#tls-values).

```text
End users (1 pairing sandbox, or M sandboxes — one per user)
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

`latency_avg` is metrics-proxy **chat/completions duration** on that pod (in-pod fetch until the full response, including streams). It excludes client→Envoy time. The gauge averages samples from the last 30s so HPA can leave 8 GPUs while chats continue. After 60s with no samples the gauge resets to 0 so HPA can scale down. `get-hpa.sh` prints milliseconds (`46514/3000` = 46514 ms / 3000 ms).

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

Queries from end users go **into the sandboxes**, one sandbox per end user. Any pairing can be first after steps 1–5. Provision waits for one Ready GPU replica (up to 240s, `HPA_BASELINE_WAIT_SEC`). Latency HPA may show desired 0 until chats produce the metric; that is idle, not leftover load. One end user ↔ one sandbox ↔ one agent. End users do not log into the DGX. CLI is `E2E_CLIENT_HOST=dgx-ip` plus the pairing script in 6a / 6b / 6c (or the same script from the same DGX in another terminal). The OpenClaw remote laptop UI is [OpenClaw simple test](#openclaw-simple-test).

| | Agent | Default `INFERENCE_RUNTIME` | Default model | Provision | Client |
|--|-------|------------------------------|---------------|-----------|--------|
| **6a** | OpenClaw | `ollama` | `llama3.2:3b` | `agentscaling_gpuutil.sh` | `client.sh` |
| **6b** | Hermes | `vllm` | `nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8` | `agentscaling_hermes_gpuutil.sh` | `client_hermes.sh` |
| **6c** | Deep Agents | `nim` | `nvidia/nemotron-3-nano` | `agentscaling_deepagents_gpuutil.sh` | `client_deepagents.sh` |

Each wrapper pins **`AGENT_NAME`**. Do not pass `AGENT_NAME=hermes` into `agentscaling_gpuutil.sh`.

**`INFERENCE_RUNTIME`** selects which GPU backend this run connects to (`ollama` | `vllm` | `nim`). Example pairings are in the table but you can switch to other inference runtime.

**`INFERENCE_MODEL`** is set on provision (Ollama tag, vLLM HF id, or NIM catalog id). 


Validation is on DGX 8× H100 (80 GB) on-prem. The DGX H100 demo uses 5 end users, `E2E_USERS=5` and one sandbox per user. This 8×H100 demo runs those sandboxes on the DGX H100 **CPU cores and DRAM**. Sandboxes can run on a different CPU node with more memory to support more sandboxes and end users. Size `E2E_USERS` so `E2E_USERS × AGENT_SANDBOX_MEMORY` fits the CPU node.


#### 6a. OpenClaw + Ollama

- `AGENT_SANDBOX_CPU` **1**, `AGENT_SANDBOX_MEMORY` **8Gi** (1Gi, 2Gi, and 4Gi OOM-kill OpenClaw before `:18789` binds)
- inflight **1** per sandbox (one agent per sandbox)
- `MAX_TOKENS` default **1024** (GPU util). Latency HPA uses **2048** tokens from 1–5 GPUs, **32** at 6–7 GPUs, then stops new chats at 8. Do not pass `MAX_TOKENS=32` or `MAX_TOKENS=64` on the latency client.

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

**GPU util** HPA metric `gpu_utilization_percent`, target 40%. Provision keeps **current** GPUs at **1** replica (`maxReplicas=8`). `client.sh` sends chats; users → sandboxes → Envoy → Ollama. kubectl TARGETS like `67500m/40` means **67.5%/40%**. Watch percentages with `get-hpa.sh`. On this host the 5-user client run drove GPU-util HPA to **8** replicas, then back to **1** after chats stopped. 

```bash
cd deploy/helm/gpu_autoscaling_k8s
export PATH="${HOME}/.local/bin:${PATH}"
export KUBECONFIG="${HOME}/.kube/config"
```

```bash
# Terminal A
# Isolated eval (no TLS overlay): keep ALLOW_INSECURE_HTTP=1 from step 4.
# A TLS install can omit that variable.
# Default INFERENCE_RUNTIME=ollama. Do not set vllm/nim unless you intend to override.
E2E_USERS=5 ALLOW_INSECURE_HTTP=1 ./scripts/agentscaling_gpuutil.sh
```


```bash
# Terminal B 
./scripts/get-hpa.sh -n nemoclaw-gpu -w
```

```bash
# Terminal C — from a remote terminal such as your laptop (HTTP)
E2E_CLIENT_HOST=dgx-ip E2E_USERS=5 ./scripts/client.sh


# Or a simpler option — from the same DGX in another terminal
E2E_USERS=5 ./scripts/client.sh
```


**LLM latency.** Same sandboxes and the same `client.sh`. Provision switches HPA to `latency_avg` (target 3000 ms) and keeps **current** GPUs at **1** replica (`maxReplicas=8`). OpenClaw start must not scale. `client.sh` then sends chats; users → sandboxes → Envoy → Ollama. `get-hpa.sh` prints milliseconds (`46514/3000`). Latency load is 2048 tokens through 5 GPUs, 32 at 6 and 7, then 0 new chats at 8. The 30s latency window lets HPA scale down when current latency is below 3000 ms. Do not pass `DURATION_SEC=180` — that stopped an earlier run at 5 GPUs.

```bash
# Terminal A 
E2E_USERS=5 ALLOW_INSECURE_HTTP=1 ./scripts/agentscaling_latency.sh
```
<img width="849" height="466" alt="Screenshot 2026-10-06 at 9 02 49 PM" src="https://github.com/user-attachments/assets/1b2602a9-a8f4-482e-a071-9fb5f87e2ac1" />


```bash
# Terminal B
./scripts/get-hpa.sh -n nemoclaw-gpu -w
```
<img width="854" height="635" alt="Screenshot 2026-10-06 at 9 03 08 PM" src="https://github.com/user-attachments/assets/9797b59d-01f1-437c-baeb-775eb2c96977" />



```bash
# Terminal C — from a remote terminal such as your laptop (HTTP)
# Latency: 2048 until 6 GPUs, 32, then 0 at 8. GPU util: 2048 until 8, then 0.
E2E_CLIENT_HOST=dgx-ip E2E_USERS=5 ./scripts/client.sh
```
<img width="671" height="288" alt="Screenshot 2026-10-06 at 8 59 44 PM" src="https://github.com/user-attachments/assets/1065ffe2-af3e-467b-9d66-e08a0472050d" />


```bash
# or a simpler option — from the same DGX in another terminal
E2E_USERS=5 ./scripts/client.sh
```





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

After steps 1–5 (`openshell status` Connected, `gatewayclass eg` present). **One OpenShell gateway** for all sandboxes. This DGX demo uses `E2E_USERS=5`, inflight **1**, and **4Gi** sandboxes. `MAX_TOKENS` default **1024** (GPU util). Latency HPA uses **2048** tokens from 1–5 GPUs, **32** at 6–7 GPUs, then stops new chats at 8. 

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
```


**GPU Utilization.** (target 40%):
```bash
# Terminal A 
# Isolated eval (no TLS overlay): keep ALLOW_INSECURE_HTTP=1 from step 4.
E2E_USERS=5 ALLOW_INSECURE_HTTP=1 ./scripts/agentscaling_hermes_gpuutil.sh
```
<img width="869" height="929" alt="Screenshot 2026-10-01 at 1 54 32 PM" src="https://github.com/user-attachments/assets/60b7f887-3a80-46b3-84a0-1caebf6ea807" />

```bash
# Terminal B 
./scripts/get-hpa.sh -n nemoclaw-gpu -w
```
<img width="821" height="383" alt="Screenshot 2026-10-01 at 6 24 21 PM" src="https://github.com/user-attachments/assets/99f9ae4a-8427-4651-a5d8-69118d00f6f3" />

```bash
# Terminal C — from a remote terminal such as your laptop (HTTP)
E2E_CLIENT_HOST=dgx-ip E2E_USERS=5 ./scripts/client_hermes.sh


# simpler option — from the same DGX in another terminal
E2E_USERS=5 ./scripts/client_hermes.sh
```

**LLM latency.** Same sandboxes and the same `client_hermes.sh`. Provision switches HPA to `latency_avg` (target 3000 ms) and keeps current GPUs at 1 replica (`maxReplicas=8`). `client_hermes.sh` sends `hermes -z`.

```bash
# Terminal A
E2E_USERS=5 ALLOW_INSECURE_HTTP=1 ./scripts/agentscaling_hermes_latency.sh
```
<img width="847" height="827" alt="Screenshot 2026-10-01 at 10 52 48 PM" src="https://github.com/user-attachments/assets/f81b1fea-7421-4d99-8e6d-c493472650e9" />

```bash
# Terminal B
./scripts/get-hpa.sh -n nemoclaw-gpu -w
```
<img width="849" height="521" alt="Screenshot 2026-10-01 at 1 53 17 PM" src="https://github.com/user-attachments/assets/2c0c3b90-761a-4b9b-9a34-0551219d4441" />

```bash
# Terminal C — from a remote terminal such as your laptop (HTTP)
# Latency: 2048 until 6 GPUs, 32, then 0 at 8. GPU util: 2048 until 8, then 0.
E2E_CLIENT_HOST=dgx-ip E2E_USERS=5 ./scripts/client_hermes.sh


# simpler option — from the same DGX in another terminal
E2E_USERS=5 ./scripts/client_hermes.sh
```




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

After steps 1–5 (`openshell status` Connected, `gatewayclass eg` present). **One OpenShell gateway** for all sandboxes. Clients use `dcode -n` (no per-sandbox Deep Agents listener). This DGX demo uses `E2E_USERS=5`, inflight **1**, and **4Gi** sandboxes. `MAX_TOKENS` default **2048** (GPU util). Latency HPA uses **2048** tokens from 1–5 GPUs, **32** at 6–7 GPUs, then stops new chats at 8.

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
```

**GPU Utilization.** (target 40%):
```bash
# Terminal A 
# Isolated eval (no TLS overlay): keep ALLOW_INSECURE_HTTP=1 from step 4.
E2E_USERS=5 ALLOW_INSECURE_HTTP=1 ./scripts/agentscaling_deepagents_gpuutil.sh
```
<img width="820" height="827" alt="Screenshot 2026-10-01 at 10 49 59 PM" src="https://github.com/user-attachments/assets/cd71a258-3ff3-4f62-b1ca-baf440e8c220" />

```bash
# Terminal B
./scripts/get-hpa.sh -n nemoclaw-gpu -w
```

<img width="830" height="443" alt="Screenshot 2026-10-01 at 10 48 31 PM" src="https://github.com/user-attachments/assets/23be5f75-0822-4b39-b6db-31b27f8a2f48" />

```bash
# Terminal C — from the same DGX in another terminal
E2E_USERS=5 ./scripts/client_deepagents.sh
```



**LLM latency.** Same sandboxes and the same `client_deepagents.sh`. Provision switches HPA to `latency_avg` (target 3000 ms) and keeps current GPUs at 1 replica (`maxReplicas=8`). `client_deepagents.sh` sends `dcode -n`.

```bash
# Terminal A 
E2E_USERS=5 ALLOW_INSECURE_HTTP=1 ./scripts/agentscaling_deepagents_latency.sh
```
<img width="849" height="797" alt="Screenshot 2026-10-01 at 11 13 50 PM" src="https://github.com/user-attachments/assets/83f6963e-63a4-46bc-92c4-e29f43b30256" />

```bash
# Terminal B
./scripts/get-hpa.sh -n nemoclaw-gpu -w
```
<img width="853" height="320" alt="Screenshot 2026-10-01 at 11 10 09 PM" src="https://github.com/user-attachments/assets/3179e6de-1002-4fc1-be71-03a6ef4875d2" />


```bash
# Terminal C — from the same DGX in another terminal
# Latency: 2048 until 6 GPUs, 32, then 0 at 8. GPU util: 2048 until 8, then 0.
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

Default models and how to override them (or switch agent) are in [Quick start 6](#6-e2e-test-with-multiple-end-users-and-sandboxes). Check VRAM against `gpuScaling.perPodMemory`.

#### Persistence

This is the **on-disk cache for downloaded model weights**, not a database. On this single-node DGX the chart writes them to a folder on the GPU node (`/var/lib/nemoclaw-gpu/ollama`, `/vllm`, or `/nim`). The first pod pulls the model once; later HPA replicas on the same node reuse that folder. If you turn persistence off, each new pod downloads the model again. Shared storage (RWX) is only needed if inference pods run on more than one node.

### Kubernetes HPA metrics

| Metric | Target | E2E (6a / 6b / 6c) |
|--------|--------|---------------------|
| `gpu_utilization` (default) | avg GPU util **40%** | `./scripts/agentscaling_gpuutil.sh` / `agentscaling_hermes_gpuutil.sh` / `agentscaling_deepagents_gpuutil.sh` |
| `latency_avg` | avg chat proxy latency **3000 ms** | `./scripts/agentscaling_latency.sh` / `agentscaling_hermes_latency.sh` / `agentscaling_deepagents_latency.sh` |

This recipe sets those **targets** only. It does **not** set a 10% threshold in `install-hpa.sh` or `values.yaml`.

Kubernetes HPA uses the ratio of current metric to target. From [Horizontal Pod Autoscaling — algorithm details](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/#algorithm-details):

```text
desiredReplicas = ceil(currentReplicas × currentMetricValue / desiredMetricValue)
```

When a `targetAverageValue` (this chart) or `targetAverageUtilization` is set, `currentMetricValue` is the **average** of that metric across the pods in the HPA scale target (`gpu_utilization_percent` or `nemoclaw_llm_latency_avg_milliseconds`).

Examples: replica `1` x current `3706m` / desired `3000m` = 1.235 

ceiling to 2 desired replicas 

The control plane **skips** a scale if that ratio is close to 1.0 (within a configurable tolerance, **0.1 by default**). The cluster-wide flag is kube-controller-manager `--horizontal-pod-autoscaler-tolerance`. This recipe does not set it.

Example with this recipe’s 3000 ms latency target (`./scripts/get-hpa.sh -n nemoclaw-gpu -w`):

```text
3188/3000   # +6%  — no scale-up (ratio 1.06; inside the default 10% band)
3713/3000   # +24% — eligible (ratio 1.24). At 1 replica: ceil(1 × 3713/3000) = 2
```


```bash
kubectl get --raw \
  '/apis/custom.metrics.k8s.io/v1beta1/namespaces/nemoclaw-gpu/pods/*/gpu_utilization_percent'
./scripts/get-hpa.sh -n nemoclaw-gpu
```

Other Prometheus → Adapter metrics: extend `monitoring/prometheus-adapter-gpu-values.yaml` and `nemoclaw-gpu.hpaMetric`.

## Simple HPA only test (optional)

This is the **OpenClaw + Ollama** HPA-only path (same defaults as Quick start 6a: `INFERENCE_RUNTIME=ollama`, `INFERENCE_MODEL=llama3.2:3b`). It only checks that Kubernetes HPA can change GPU pod count from synthetic inference load (`files/load-generator.ts`). It does **not** create OpenClaw sandboxes and does **not** use `client.sh`.
The HPA-only test has been verified on DGX 8xH100 on-prem `maxReplicas=8`, and [Brev AWS](https://brev.nvidia.com) **4× L40S** (48 GB), `MAX_REPLICAS=4`.

If you already ran Quick start 4 or the OpenClaw + Ollama e2e (`agentscaling_gpuutil.sh` / `agentscaling_latency.sh`), HPA is already installed. Skip `install-hpa.sh` and run a load-test script below.

If you did **not** run e2e, install Prometheus, Envoy, and the GPU chart + HPA first (default Ollama / `llama3.2:3b`):

```bash
DCGM_NAMESPACE=gpu-operator MAX_REPLICAS=8 ENABLE_ENVOY_LB=1 ALLOW_INSECURE_HTTP=1 \
  ./scripts/install-hpa.sh
```

The HPA-only test **uses** Prometheus (DCGM GPU util and metrics-proxy latency → adapter → HPA) and Envoy (LeastRequest). `install-hpa.sh` puts that stack on the cluster when Quick start 4 / e2e has not already done so. The load-test scripts then Helm-upgrade the GPU chart and send synthetic load through Envoy.

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

HPA adds **one** pod per step. After each step a new GPU sits at 0% until the model is loaded, which can drop the **average** under 40% and delay the next replica (~2 min/pod when busy GPUs are only ~50%). Raise in-flight on the already-busy pods so the average stays above 40% without waiting for the new GPU (do not add two pods per step — that dip is worse). If you see many HTTP 502s on 8× H100, stay at or below the 640 in-flight cap.

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



**Remote UI test** (from any browser). After [6a](#6a-openclaw--ollama) has the five sandboxes up, open these URLs on the browser. Each user is a **different host port**. You do not type a token. Leave Password empty.

| User | Open this in the browser on your laptop |
|------|-----------------------------------------|
| 0    | `http://dgx-ip:18789/u/0`               |
| 1    | `http://dgx-ip:18790/u/0`               |
| 2    | `http://dgx-ip:18791/u/0`               |
| 3    | `http://dgx-ip:18792/u/0`               |
| 4    | `http://dgx-ip:18793/u/0`               |

Remote laptop UI 
<img width="1458" height="854" alt="Screenshot 2026-10-02 at 9 54 48 PM" src="https://github.com/user-attachments/assets/95cac638-145d-4e86-a976-bf80522d4dcc" />



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
- Each agent has its own published GHCR image: OpenClaw `openclaw-sandbox`, Hermes `hermes-sandbox`, Deep Agents `langchain-deepagents-code-sandbox`. Deep Agents never uses the Hermes image. No API key is in the image.
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

Use **one** script for e2e teardown. `uninstall-e2e.sh` removes all pairing CPU sandboxes (`openclaw-ollama-e2e-*`, `hermes-vllm-e2e-*`, `deepagent-nim-e2e-*`) and OpenShell providers (`onprem-ollama` / `onprem-hermes` / `onprem-deepagents`). It does **not** uninstall GPU inference (Ollama / vLLM / NIM), OpenShell, Envoy, or Prometheus. The next `agentscaling_*` helm-upgrades the same GPU release to `INFERENCE_RUNTIME`.

```bash
# Stop client.sh / client_hermes.sh / client_deepagents.sh first (Ctrl-C).
# Keep ./scripts/openshell-port-forward.sh attached.
./scripts/uninstall-e2e.sh
```

To also scale leftover GPU replicas to 1 (runtime unchanged):

```bash
RESET_GPU_REPLICAS=1 ./scripts/uninstall-e2e.sh
```

### Full recipe uninstall

Sandboxes first, same script. Then, only if you want OpenShell and the GPU chart gone too (keep the port-forward up until `uninstall-e2e.sh` finishes):

```bash
./scripts/uninstall-e2e.sh
openshell gateway remove nemoclaw-k8s
rm -r -- "${XDG_CONFIG_HOME:-${HOME}/.config}/openshell/gateways/nemoclaw-k8s/mtls"
helm uninstall openshell -n nemoclaw-sandboxes
helm uninstall nemoclaw-gpu -n nemoclaw-gpu
```

Shared Prometheus, Adapter, the Envoy load balancer, and Agent Sandbox CRDs are left in place.

## FAQ

### Can I run the client from my laptop?

Yes. Terminal C is a **remote terminal such as your laptop** (`E2E_CLIENT_HOST=dgx-ip` plus `client.sh` / `client_hermes.sh` / `client_deepagents.sh`). A simpler option is the same script from the same DGX in another terminal. The OpenClaw remote laptop UI is [OpenClaw simple test](#openclaw-simple-test). End users do not log into the DGX.

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

The **metrics-proxy** times the in-pod `chat/completions` fetch until the full response (including streams). That duration is **not** client→Envoy time. `nemoclaw_llm_latency_avg_milliseconds` averages samples from the last 30s (no 128-sample cap). Clients keep sending chats for `DURATION_SEC`. After 60s with no samples the gauge resets to 0 so HPA can scale down. Prometheus scrapes `/metrics`; the adapter exposes the same name; HPA uses Pods `AverageValue` **3000** (milliseconds). `kubectl get hpa` TARGETS like `46514/3000` means 46514 ms vs 3000 ms. GPU-util TARGETS like `20666m/40` are a different metric (`gpu_utilization_percent`). Kubernetes still applies the default **10%** tolerance (`3188/3000` does not scale); see [Kubernetes HPA metrics](#kubernetes-hpa-metrics).

### What port numbers are used?

`kubectl port-forward` is **`LOCAL:REMOTE`**: host port, then the Service port in the cluster.

| Name | Port | Where |
|------|------|-------|
| OpenShell CLI | **18080** | Host. `./scripts/openshell-port-forward.sh`. `openshell status` uses `https://127.0.0.1:18080`. |
| OpenClaw agent | **18789** | Inside each OpenClaw sandbox netns. Published on the DGX as `18789+user` (`http://dgx-ip:18789` … `:18793` for five users). |
| Hermes gateway | **8642** | Inside each Hermes sandbox. Published on the DGX as `8642+user` (`http://dgx-ip:8642` … `:8646`). Hermes UI uses `18789+user`. |
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
