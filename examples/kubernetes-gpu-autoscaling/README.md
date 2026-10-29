
<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Agent Scaling: NemoClaw Kubernetes autoscaling on multi-GPUs

| Catalog field | Value |
| --- | --- |
| Description | A cost-efficient architecture that runs AI agents securely inside CPU-only OpenShell sandboxes (one sandbox per end user) while scaling GPU-backed inference dynamically. |
| Industry | ☁️ Cloud Services |
| Requirements | Kubernetes 1.25+ · Helm 3 (Helm 4 also works; the scripts add `--force-conflicts` only on Helm 4+) · NVIDIA GPU Operator/DCGM · Metrics Server · Docker Buildx + registry · OpenShell + Agent Sandbox CRDs pinned in versions.env · OIDC or acknowledged isolated-eval exception · experimental |
| NemoClaw | v0.0.104 |
| Harness | OpenClaw 2026.7.1 |
| OpenShell | 0.0.85 |

This experimental recipe demonstrates a cost-efficient architecture that runs AI agents securely inside CPU-only OpenShell sandboxes (one sandbox per end user) while scaling GPU-backed inference dynamically. It can be deployed both on-prem and on cloud. The agents running in OpenShell sandboxes are one of **[`Openclaw | hermes | deepagents`](https://github.com/NVIDIA/NemoClaw/tree/main/agents)**. Since GPU inference is the primary compute and cost bottleneck, Kubernetes HPA dynamically adjusts capacity from **1** to **N** replicas (1 GPU each) as demand changes, maintaining responsiveness during traffic spikes while releasing idle GPU resources when demand falls.

Supported GPU inference runtimes include **`ollama` / `vllm` / `nim`**.  Example pairings for e2e demo include: OpenClaw + Ollama (`AGENT_NAME=openclaw`), Hermes + vLLM (`AGENT_NAME=hermes`), Deep Agents Code + NIM (`AGENT_NAME=deepagents`). You can extend the pairings as far as the agents support the inference runtimes.  

Kubernetes HPA scales those inference pods using a Pods **`AverageValue`** metric (average across **Ready** pods). Example HPA metrics: **GPU utilization** (target **40%**) and **LLM latency** (target **3000 ms**). See [Kubernetes HPA metrics](#kubernetes-hpa-metrics).


## NemoClaw v1

This recipe runs on NemoClaw v0 (the steps below). The [`v1/`](v1/README.md) folder holds an experimental NemoClaw v1 version of the agent step: one YAML per agent and inference pairing, plus helper scripts. It reuses the GPU chart, HPA scripts, and Envoy load balancer from this folder, because v1 does not install that chart. v1 has no release download yet, and the OpenClaw + Ollama pairing does not start on v1 Fabric. See [`v1/README.md`](v1/README.md) for the current status and prerequisites.

## Deployment Architecture



<img width="1672" height="941" alt="architecture" src="https://github.com/user-attachments/assets/4e61491d-7a8b-4ce7-9910-9715965e4e7c" />

Queries from end users go to the agents running in the sandboxes, one sandbox per end user. One end user ↔ one sandbox ↔ one agent. **One OpenShell gateway** for all sandboxes. Sandboxes reach GPUs at `https://inference.local`. The load balancer is **Envoy** with LeastRequest policy. HPA scales from **1** to **N** inference pods (1 GPU each). Each GPU pod is **2/2 Ready** when healthy: inference runtimes (`ollama` / `vllm` / `nim`) + `metrics-proxy` (auth, `/v1`, health, `/metrics`). The chart generates a local inference API key (Bearer on `/v1`). OpenShell injects it for the sandbox. 

The metric **LLM latency** `latency_avg` is **chat completions duration** on that GPU pod (in-pod fetch until the full response, including streams). It averages **completed** samples from the last 30s. In-flight chats do not count. After 15s with no completed sample the gauge publishes 0 so HPA can scale down. That 0 is not 0 ms latency. `get-hpa.sh` prints milliseconds (`46514/3000` = 46514 ms / 3000 ms). See [How is LLM latency calculated for HPA?](#how-is-llm-latency-calculated-for-hpa).

## Prerequisites

Install Kubernetes and make sure `kubectl get nodes` succeeds. See [How to install Kubernetes](#how-to-install-kubernetes).

## Quick start guide

### 1. Clone and tools

```bash
git clone https://github.com/NVIDIA/nemoclaw-community.git
cd nemoclaw-community/examples/recipes/nvidia/kubernetes-gpu-autoscaling
source versions.env
uv tool install "openshell==${OPENSHELL_VERSION}"
export PATH="${HOME}/.local/bin:${PATH}"
openshell --version
```

After that clone, stay in this directory. Every later `./scripts/...` command in this README runs from here.

### 2. Confirm GPUs and DCGM

```bash
# Helm GPU Operator: export DCGM_NAMESPACE=gpu-operator
# microk8s enable gpu: default gpu-operator-resources
kubectl get nodes \
  -o jsonpath='{range .items[*]}{.metadata.name}{" GPUs="}{.status.allocatable.nvidia\.com/gpu}{"\n"}{end}'
kubectl get pods -n "${DCGM_NAMESPACE:-gpu-operator-resources}" -l app=nvidia-dcgm-exporter
```

### 3. Install the OpenShell gateway once

Skip this if `kubectl -n nemoclaw-sandboxes get svc openshell` succeeds.


```bash
source versions.env
kubectl apply -f \
  "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/manifest.yaml"
AGENT_SANDBOX_IMAGE=ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:bd935f0198b99889d9479fea123b62a59e3797da13e392dcc2160f114216c1ba \
ALLOW_UNAUTHENTICATED_OPENSHELL=1 \
OPENSHELL_UNAUTHENTICATED_ACK=dedicated-cluster-port-forward-only \
  ./scripts/install-openshell-k8s.sh
```

The default is OIDC: set `OPENSHELL_OIDC_ISSUER` and leave `ALLOW_UNAUTHENTICATED_OPENSHELL=0`. This demo uses the isolated-eval exception instead. `ALLOW_UNAUTHENTICATED_OPENSHELL=1` turns off OIDC and exposes the OpenShell user API without user authentication. Use it only on a dedicated evaluation cluster with `./scripts/openshell-port-forward.sh`. ClusterIP does not block in-cluster pods. `OPENSHELL_UNAUTHENTICATED_ACK=dedicated-cluster-port-forward-only` records that choice.


### 4. Install GPU inference and the Envoy load balancer once

Skip this if `kubectl get gatewayclass eg` succeeds. 

```bash
# MicroK8s GPU addon: DCGM_NAMESPACE=gpu-operator-resources
# Helm GPU Operator: DCGM_NAMESPACE=gpu-operator
DCGM_NAMESPACE=gpu-operator-resources MAX_REPLICAS=8 ENABLE_ENVOY_LB=1 \
  ./scripts/install-hpa.sh
kubectl get gatewayclass eg
```

### 5. Connect the OpenShell CLI

```bash
./scripts/openshell-port-forward.sh
```

Keep this attached for step 6.

kubectl may print `Error copying from remote stream` and `broken pipe` when a sandbox command ends. That line is from kubectl, not a failed OpenShell tunnel. Leave the script running. Stop it only if `openshell status` shows Connection refused.

In another terminal, copy the OpenShell gateway client certs (`openshell-client-tls`) and register the gateway. These files are for `openshell` on `https://127.0.0.1:18080`. After a reinstall, refresh the certs or you get `BadSignature`.

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

`openshell status` must succeed before the e2e test.

### 6. E2E test with multiple end users and sandboxes

 
Scripts of running the examples of agents + inference runtimes are in below table. Validation is on one DGX 8× H100 (80 GB) on-prem. The sandboxes run on the DGX's CPU cores and DRAM. They can run on a different CPU node with more memory. That node can hold more sandboxes and more end users. You can change the number of `E2E_USERS` as far as `E2E_USERS × AGENT_SANDBOX_MEMORY` fits the CPU node. 

Keep inference runtimes and autoscaling on the GPUs. You can switch to other inference runtimes as far as the agents support them. 

| | Agent | Default `INFERENCE_RUNTIME` | Default model | End users | Provision | Client |
|--|-------|------------------------------|---------------|-----------|-----------|--------|
| **6a** | OpenClaw | `ollama` | `llama3.2:3b` | `E2E_USERS=5` | `agentscaling_gpuutil.sh` | `client.sh` |
| **6b** | Hermes | `vllm` | `nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8` | `E2E_USERS=10` | `agentscaling_hermes_gpuutil.sh` | `client_hermes.sh` |
| **6c** | Deep Agents | `nim` | `nvidia/nemotron-3-nano` | `E2E_USERS=10` | `agentscaling_deepagents_gpuutil.sh` | `client_deepagents.sh` |


#### 6a. OpenClaw with Ollama

This example uses `E2E_USERS=5` and `AGENT_SANDBOX_MEMORY=8Gi` sandboxes (1Gi, 2Gi, and 4Gi OOM-kill OpenClaw before `:18789` binds), in total 40Gi CPU RAM. One sandbox per user, one OpenClaw agent per sandbox.
- `INFLIGHT` is the concurrent chats per user on that one agent, default: `INFLIGHT=1`.
- `MAX_TOKENS` is the maximum length of each model reply in tokens, defaults: `MAX_TOKENS=2048`.


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

**GPU utilization** HPA metric `gpu_utilization_percent`, target 40%. Provision keeps current GPUs at 1 replica (`maxReplicas=8`). `client.sh` sends `INFLIGHT=4 MAX_TOKENS=2048` until 8 GPUs, then stops new chats. Successful chats are chats that got a reply; err is chats that were sent and got no reply. kubectl TARGETS like `67500m/40` means **67.5%/40%**. Watch GPU utilization percentages with `get-hpa.sh`.

```bash
# Terminal A: GPU Inference
# Default INFERENCE_RUNTIME=ollama. Do not set vllm/nim unless you intend to override.
E2E_USERS=5 ./scripts/agentscaling_gpuutil.sh
```
<img width="752" height="465" alt="util1" src="https://github.com/user-attachments/assets/00cecc7e-5dfc-4d23-b8f1-b05fbc13977f" />


```bash
# Terminal B: HPA watch
./scripts/get-hpa.sh -n nemoclaw-gpu -w
```
<img width="815" height="996" alt="util2" src="https://github.com/user-attachments/assets/ccd8910b-8230-43ea-af76-9a17e2a749af" />

```bash
# Terminal C: Clients from any remote machine or laptop (HTTP). Set `E2E_CLIENT_HOST=dgx-ip`.
E2E_CLIENT_HOST=dgx-ip INFLIGHT=4 MAX_TOKENS=2048 E2E_USERS=5 ./scripts/client.sh
```

The OpenClaw remote laptop UI is [OpenClaw simple test](#simple-openclaw-test).

```bash
# Or Terminal C: test clients on the DGX instead.
INFLIGHT=4 MAX_TOKENS=2048 E2E_USERS=5 ./scripts/client.sh
```
<img width="665" height="346" alt="util3" src="https://github.com/user-attachments/assets/7117e094-f782-4bd9-8df7-c8c5fd8ee801" />


 
**LLM latency.** HPA uses the metric `latency_avg` (target 3000 ms). `get-hpa.sh` prints milliseconds (`46514/3000`). Successful chats are chats that got a reply. The 30s window and 15s idle 0 are the shared metrics-proxy gauge; see [How is LLM latency calculated for HPA?](#how-is-llm-latency-calculated-for-hpa). 

```bash
# Terminal A: GPU Inference
E2E_USERS=5 ./scripts/agentscaling_latency.sh
```
<img width="780" height="470" alt="latency2" src="https://github.com/user-attachments/assets/713e3642-80c1-4af9-b0c5-ecce644e8a37" />


```bash
# Terminal B: HPA watch
./scripts/get-hpa.sh -n nemoclaw-gpu -w
```

<img width="846" height="425" alt="latency1" src="https://github.com/user-attachments/assets/af597137-2f4a-45d9-a303-86477133dd17" />


```bash
# Terminal C: Clients from any remote machine or laptop (HTTP). Set `E2E_CLIENT_HOST=dgx-ip`.
E2E_CLIENT_HOST=dgx-ip E2E_USERS=5 ./scripts/client.sh

# Or Terminal C: test clients on the DGX instead.
E2E_USERS=5 ./scripts/client.sh
```
<img width="780" height="470" alt="latency2" src="https://github.com/user-attachments/assets/1913698a-dc1e-4a1b-9a73-fcea7a7b9b22" />





#### 6b. Hermes with vLLM


This example uses `E2E_USERS=10` and `AGENT_SANDBOX_MEMORY=4Gi` sandboxes (40Gi CPU RAM in total). One sandbox per user, one Hermes agent per sandbox.


```text
E2E test: Hermes + vLLM
  10 end users send requests to 10 Hermes agents
  10 Hermes agents run in 10 OpenShell sandboxes
  LLM (vLLM NVIDIA-Nemotron-3-Nano-4B-FP8) runs on GPUs
  HPA scales vLLM from 1 to 8 GPUs

        10 end users
            ↓  prompt to the OpenShell sandbox (hermes -z)
        10 OpenShell sandboxes (sandbox 0 … sandbox 9)
            ↓  https://inference.local
        Envoy load balancer — LeastRequest
            ↓
        vLLM on GPUs
            1 GPU  →  demand rises  →  8 GPUs  →  idle  →  1 GPU
```


After steps 1–5 (`openshell status` Connected, `gatewayclass eg` present).

Kubelet pulls the [official NVIDIA vLLM NGC Container](https://catalog.ngc.nvidia.com/orgs/nvidia/-/containers/vllm/-?_lr=1) (`nvcr.io/nvidia/vllm`). This recipe already pins the image. After the image is on the node, vLLM downloads `nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8` from Hugging Face. The default vLLM NGC image and Hugging Face model are public, so no extra Secret is required.

**GPU util** HPA metric `gpu_utilization_percent`, target 40%. Provision keeps **current** GPUs at **1** replica (`maxReplicas=8`). `client_hermes.sh` sends `INFLIGHT=2 MAX_TOKENS=1024` until 8 GPUs, then stops new chats. Set those flags on the client. Successful chats are chats that got a reply; the table prints after HPA is back to 1. The laptop does not set a Hermes API key. The DGX injects it. 

```bash
# Terminal A: GPU Inference
E2E_USERS=10 ./scripts/agentscaling_hermes_gpuutil.sh
```
<img width="752" height="631" alt="util1" src="https://github.com/user-attachments/assets/936d783d-9be3-49a9-a908-2faf52a25aac" />

```bash
# Terminal B: HPA watch
./scripts/get-hpa.sh -n nemoclaw-gpu -w
```
<img width="813" height="557" alt="util2" src="https://github.com/user-attachments/assets/9525c978-b679-453f-90a2-986688b929f0" />

```bash
# Terminal C: Clients from any remote machine or laptop (HTTP). Set `E2E_CLIENT_HOST=dgx-ip`.
# User i uses :8642+i (this demo N=10 → :8642 … :8651).
# If Connection refused on :8642, keep step 5 attached, then on the DGX:
#   E2E_USERS=10 ./scripts/publish-hermes-remote-http.sh
E2E_CLIENT_HOST=dgx-ip INFLIGHT=2 MAX_TOKENS=1024 E2E_USERS=10 ./scripts/client_hermes.sh
```
<img width="727" height="482" alt="util3" src="https://github.com/user-attachments/assets/5e306a05-81dc-423c-9427-07eb8c05275f" />

```bash
# Or Terminal C: test clients on the DGX instead.
INFLIGHT=2 MAX_TOKENS=1024 E2E_USERS=10 ./scripts/client_hermes.sh
```
 

**LLM latency.** Hermes latency is `INFLIGHT=1`, `MAX_TOKENS=2048` in the code.

```bash
# Terminal A: GPU Inference
E2E_USERS=10 ./scripts/agentscaling_hermes_latency.sh
```
<img width="777" height="632" alt="latency3" src="https://github.com/user-attachments/assets/5969f28a-aa24-4b4c-8e33-227cfb58e37e" />

```bash
# Terminal B: HPA watch
./scripts/get-hpa.sh -n nemoclaw-gpu -w
```
<img width="848" height="890" alt="latency2" src="https://github.com/user-attachments/assets/f7523cbd-db7c-4061-bb86-803df7c3fe14" />

```bash
# Terminal C: Clients from any remote machine or laptop (HTTP). Set `E2E_CLIENT_HOST=dgx-ip`.
E2E_CLIENT_HOST=dgx-ip E2E_USERS=10 ./scripts/client_hermes.sh
```
<img width="731" height="480" alt="latency1" src="https://github.com/user-attachments/assets/e0cc260c-dd78-46a9-ac7e-ec624be68e55" />

```bash
# Or Terminal C: test clients on the DGX instead.
E2E_USERS=10 ./scripts/client_hermes.sh
```

 `./scripts/uninstall-e2e.sh` removes the sandboxes when you switch to other agent + inference runtime pairings.


#### 6c. Deep Agents Code with NIM


This example uses `E2E_USERS=10` and `AGENT_SANDBOX_MEMORY=4Gi` sandboxes (40Gi CPU RAM in total). One sandbox per user, one Deep Agents agent per sandbox.

```text
E2E test: Deep Agents Code + NIM
  10 end users send requests to 10 Deep Agents
  10 Deep Agents run in 10 OpenShell sandboxes
  LLM (NIM nvidia/nemotron-3-nano) runs on GPUs
  HPA scales NIM from 1 to 8 GPUs

        10 end users
            ↓  prompt to the OpenShell sandbox (dcode -n)
        10 OpenShell sandboxes (sandbox 0 … sandbox 9)
            ↓  https://inference.local
        Envoy load balancer — LeastRequest
            ↓
        NIM on GPUs
            1 GPU  →  demand rises  →  8 GPUs  →  idle  →  1 GPU
```

After steps 1–5 (`openshell status` Connected, `gatewayclass eg` present). Clients use `dcode -n` (no per-sandbox Deep Agents listener).

This Kubernetes path needs **both** Secrets from one `NGC_API_KEY` before `agentscaling_deepagents_gpuutil.sh`. Create `NGC_API_KEY` at [NGC API keys](https://org.ngc.nvidia.com/account/api-keys) on [NVIDIA NGC](https://org.ngc.nvidia.com). Kubernetes needs two Secret types: kubelet uses `ngc-registry` (`dockerconfigjson`) to pull the NIM image (`nvcr.io/nim/nvidia/nemotron-3-nano`), and the running NIM uses `nim-ngc-key` (Opaque env `NGC_API_KEY`) to pull the model weights. 

`secrets.env` is gitignored. Git has `secrets.env.example` only. Skip `apply-local-secrets.sh` only when **both** Secrets exist in `nemoclaw-gpu`. 

```bash
# If this prints both Secrets, skip apply-local-secrets.sh
kubectl -n nemoclaw-gpu get secret ngc-registry nim-ngc-key
# If either is missing 
cp -n secrets.env.example secrets.env
# edit secrets.env: paste NGC_API_KEY=  
./scripts/apply-local-secrets.sh --replace
```

Put only the **Secret names** in gitignored `local.env`:

```bash
# local.env — names, not key values
export NIM_IMAGE_PULL_SECRET=ngc-registry
export NIM_NGC_API_KEY_SECRET=nim-ngc-key
```



**GPU Utilization.** (target 40%). Default is `INFLIGHT=1 MAX_TOKENS=1024`.
```bash
# Terminal A: GPU Inference
E2E_USERS=10 ./scripts/agentscaling_deepagents_gpuutil.sh
```
<img width="749" height="616" alt="util1" src="https://github.com/user-attachments/assets/2d76dbf6-0322-46ef-aa5d-b772759af72a" />

```bash
# Terminal B: HPA watch
./scripts/get-hpa.sh -n nemoclaw-gpu -w
```
<img width="824" height="647" alt="util2" src="https://github.com/user-attachments/assets/63b58dfa-91c4-45b3-9345-a7aea5cee8d3" />

```bash
# Terminal C: test clients on the DGX. Deep Agents has no remote laptop client.
E2E_USERS=10 ./scripts/client_deepagents.sh
```
<img width="711" height="451" alt="util3" src="https://github.com/user-attachments/assets/32e8e0d1-56d7-452a-b360-42044b6fd775" />

**LLM latency.** Same default. `client_deepagents.sh` sends `dcode -n`. 

```bash
# Terminal A: GPU Inference
E2E_USERS=10 ./scripts/agentscaling_deepagents_latency.sh
```
<img width="776" height="617" alt="latency1" src="https://github.com/user-attachments/assets/f1cdf30c-bd10-4b3c-937f-6cd7766a349b" />

```bash
# Terminal B: HPA watch
./scripts/get-hpa.sh -n nemoclaw-gpu -w
```
<img width="848" height="498" alt="latency2" src="https://github.com/user-attachments/assets/8a31ad79-a9f4-4992-8806-78535ba7952a" />

```bash
# Terminal C: test clients on the DGX. Deep Agents has no remote laptop client.
E2E_USERS=10 ./scripts/client_deepagents.sh
```
<img width="710" height="451" alt="latency3" src="https://github.com/user-attachments/assets/b7881b64-3d3b-4580-b53c-9a7a84d5ee56" />



## Install details

### Scheduling

- Default: do not set `NEMOCLAW_TARGET_NODE`. The scheduler picks any GPU node.
- Optional: `export NEMOCLAW_TARGET_NODE=<node>` keeps GPU pods and Envoy on one node. Use this on a shared cluster or this DGX. The node must be Ready, have the GPU label, and have allocatable GPUs ≥ `MAX_REPLICAS`.
- `MAX_REPLICAS` must not exceed GPUs in that scope (the cluster if unset, that node if pinned). Host `nvidia-smi` processes are not reserved for this chart.

### Ingress security

The Envoy dataplane Service is **ClusterIP** only (`NodePort` / `LoadBalancer` rejected). Use `kubectl port-forward` from outside.

- Gateway Basic auth + inference key as `X-Api-Key`. OpenShell HTTPRoute: Bearer only.
- Auth Secrets use Helm `keep`. Delete to rotate; never commit keys.
- No NetworkPolicy from the chart — add one if the cluster needs it.

### Inference runtimes

`INFERENCE_RUNTIME` / `inference.runtime`: **`ollama`** (default), **`vllm`**, or **`nim`**. Same 1 GPU → 1 pod → local `/v1` pattern.

| Runtime | Default model | Image | Credentials | Min VRAM |
|---------|----------------|-------|-------------|----------|
| **Ollama** | `llama3.2:3b` | `ollama/ollama` | None | ~2 GB |
| **vLLM** | `nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8` | `nvcr.io/nvidia/vllm` | `VLLM_IMAGE_PULL_SECRET` only if nvcr.io requires it; `VLLM_HF_TOKEN_SECRET` only for gated HF | ~5.3 GB |
| **NIM** | `nvidia/nemotron-3-nano` | `nvcr.io/nim/nvidia/nemotron-3-nano` | `apply-local-secrets.sh` then `NIM_IMAGE_PULL_SECRET` + `NIM_NGC_API_KEY_SECRET` | ~8 GB |

These are registry/model credentials, not the chart inference API key. Put **Secret names** in `local.env`, never key values. Public vLLM (6b) needs no NGC key. NIM (6c) needs `./scripts/apply-local-secrets.sh` from gitignored `secrets.env`. Do not put NGC keys on the kubectl command line.

Default models and how to override them (or switch agent) are in [Quick start 6](#6-e2e-test-with-multiple-end-users-and-sandboxes).

#### Persistence

This is the **on-disk cache for downloaded model weights**, not a database. On this single-node DGX the chart writes them to a folder on the GPU node (`/var/lib/nemoclaw-gpu/ollama`, `/vllm`, or `/nim`). The first pod pulls the model once; later HPA replicas on the same node reuse that folder. If you turn persistence off, each new pod downloads the model again.

Portable scheduling (`NEMOCLAW_TARGET_NODE` unset) does not share that cache across nodes. One GPU node: hostPath is enough. Several GPU nodes: use RWX shared storage, or turn persistence off.

### Kubernetes HPA metrics

| Metric | Target | E2E (6a / 6b / 6c) |
|--------|--------|---------------------|
| `gpu_utilization` (default) | avg GPU util **40%** | `./scripts/agentscaling_gpuutil.sh` / `agentscaling_hermes_gpuutil.sh` / `agentscaling_deepagents_gpuutil.sh` |
| `latency_avg` | avg chat proxy latency **3000 ms** | `./scripts/agentscaling_latency.sh` / `agentscaling_hermes_latency.sh` / `agentscaling_deepagents_latency.sh` |

This recipe sets those **targets** only.

Kubernetes HPA uses the ratio of current metric to target. From [Horizontal Pod Autoscaling — algorithm details](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/#algorithm-details):

```text
desiredReplicas = ceil(currentReplicas × currentMetricValue / desiredMetricValue)
```

When a `targetAverageValue` (this chart) or `targetAverageUtilization` is set, `currentMetricValue` is the **average** of that metric across the pods in the HPA scale target (`gpu_utilization_percent` or `nemoclaw_llm_latency_avg_milliseconds`).

Worked example: at 1 replica, current `3706m` and desired `3000m` give `ceil(1 × 3706/3000) = ceil(1.235) = 2` desired replicas.

The control plane **skips** a scale if that ratio is close to 1.0 (within a configurable tolerance, **0.1 by default**, a 10% band). The cluster-wide flag is kube-controller-manager `--horizontal-pod-autoscaler-tolerance`. This recipe does not set that flag in `install-hpa.sh` or `values.yaml`.

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

## Simple HPA-only test

It only checks that Kubernetes HPA can change GPU pod count from synthetic inference load (`files/load-generator.ts`). It does **not** create OpenClaw sandboxes and does **not** use `client.sh`.
The HPA-only test has been verified on DGX 8xH100 on-prem `maxReplicas=8`, and [Brev AWS](https://brev.nvidia.com) **4× L40S** (48 GB), `MAX_REPLICAS=4`.

It needs the same GPU stack as [step 4](#4-install-gpu-inference-and-the-envoy-load-balancer-once) (Prometheus, Envoy, GPU chart, HPA).

If `kubectl get gatewayclass eg` succeeds, skip `install-hpa.sh`. If it fails, run step 4 first. Then run a load-test script below.

Use GPU utilization as a HPA metric

```bash
# 8× H100 on-prem
./scripts/hpa-load-test-dgx-8xh100.sh

# 4× L40S on AWS (Brev)
./scripts/hpa-load-test-brev-4xl40s.sh
```

HPA adds **one** pod per step. After each step a new GPU sits at 0% until the model is loaded, which can drop the **average** under 40% and delay the next replica (~2 min/pod when busy GPUs are only ~50%). Raise in-flight on the already-busy pods so the average stays above 40% without waiting for the new GPU (do not add two pods per step — that dip is worse).

Use LLM latency as a HPA metric:

```bash
# 8× H100 on-prem
HPA_METRIC=latency_avg HPA_TARGET_LATENCY_MS=3000 ./scripts/hpa-load-test-dgx-8xh100.sh

# 4× L40S on AWS (Brev)
HPA_METRIC=latency_avg HPA_TARGET_LATENCY_MS=3000 ./scripts/hpa-load-test-brev-4xl40s.sh
```

## Simple OpenClaw test

Ask **In one sentence, what is an AI agent sandbox?** through authenticated inference. This is the pairing check for OpenClaw (`AGENT_NAME=openclaw`). Keep `./scripts/openshell-port-forward.sh` attached so `openshell status` succeeds.

| Path | Port-forward | Local URL |
|------|----------------|-----------|
| OpenShell (recommended) | `./scripts/openshell-port-forward.sh` | `https://127.0.0.1:18080` |
| Metrics-proxy | `kubectl port-forward -n nemoclaw-gpu service/nemoclaw-gpu-metrics-proxy 8081:8081` | `http://127.0.0.1:8081` |

```bash
export AGENT_NAME=openclaw
./scripts/verify-agent-sandbox.sh
```

A non-empty answer plus the final `OK:` line is a pass. Wording varies; small models may not know product names. Sample output: [`AGENT-SELECTION.md`](AGENT-SELECTION.md#example-verify-output).



**Remote UI test** (from any browser). After [6a](#6a-openclaw-with-ollama) has the five sandboxes up, run `./scripts/publish-openclaw-remote-http.sh` on the DGX. That script binds `0.0.0.0` and serves the page over plain HTTP. Restrict it to a trusted network. Set `E2E_PUBLISH_BIND=127.0.0.1` to keep the ports on the DGX only. Bring-up publishes loopback only. Published HTTP does not return gateway tokens. `/u/0` redirects to `/` with no `#token=`.

Each user is a **different host port**. You do not type a token. Leave Password empty.

| User | Open this in a browser on the remote machine |
|------|-----------------------------------------|
| 0    | `http://dgx-ip:18789/u/0`               |
| 1    | `http://dgx-ip:18790/u/0`               |
| 2    | `http://dgx-ip:18791/u/0`               |
| 3    | `http://dgx-ip:18792/u/0`               |
| 4    | `http://dgx-ip:18793/u/0`               |

Remote laptop UI
<img width="1458" height="854" alt="Screenshot 2026-10-02 at 9 54 48 PM" src="https://github.com/user-attachments/assets/95cac638-145d-4e86-a976-bf80522d4dcc" />



## Simple Hermes test

This is the pairing check for Hermes. It is a one-shot through the in-sandbox
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

### E2E example teardown

Run `uninstall-e2e.sh` to remove all pairing CPU sandboxes (`openclaw-ollama-e2e-*`, `hermes-vllm-e2e-*`, `deepagent-nim-e2e-*`) and OpenShell providers (`onprem-openclaw` / `onprem-hermes` / `onprem-deepagents`). It does **not** uninstall GPU inference (Ollama / vLLM / NIM), OpenShell, Envoy, or Prometheus. 

To leave OpenClaw and start Hermes, stop `client.sh`, keep the OpenShell port-forward, then run the command below. Continue at [6b Hermes + vLLM](#6b-hermes-with-vllm). Do not helm-uninstall OpenShell or `nemoclaw-gpu`. Later OpenClaw runs `./scripts/agentscaling_gpuutil.sh` again on this same stack.

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

Sandboxes first, same as above. Then, run helm uninstall only if you want OpenShell and the GPU chart gone too (keep the port-forward up until `uninstall-e2e.sh` finishes):

```bash
./scripts/uninstall-e2e.sh
openshell gateway remove nemoclaw-k8s
rm -r -- "${XDG_CONFIG_HOME:-${HOME}/.config}/openshell/gateways/nemoclaw-k8s/mtls"
helm uninstall openshell -n nemoclaw-sandboxes
helm uninstall nemoclaw-gpu -n nemoclaw-gpu
```

Shared Prometheus, Adapter, the Envoy load balancer, and Agent Sandbox CRDs are left in place.

## FAQ

### How is LLM latency calculated for HPA?

OpenClaw, Hermes, and Deep Agents share this metric. The **metrics-proxy** on each GPU pod times the in-pod `chat/completions` fetch until the full response (including streams). That duration is not client→Envoy time, and it is not OpenClaw/Hermes agent-gateway time or Deep Agents `dcode` time.

`nemoclaw_llm_latency_avg_milliseconds` is the mean of **completed** samples in the last **30s** (no 128-sample cap). In-flight chats do not count until the reply finishes. A new GPU replica omits the gauge until it completes one chat. Exporting 0 on a new replica would dilute HPA AverageValue.

If a replica has **no new completed sample for 15s**, it publishes **0**. That 0 lets HPA scale down. It does not mean chat latency was 0 ms. If one chat takes longer than 15s, `get-hpa.sh` can jump (for example `36048/3000` then `0/3000`) while replies are still in flight.

Prometheus scrapes `/metrics`. The adapter exposes the same name. HPA uses Pods `AverageValue` **3000** (milliseconds). `kubectl get hpa` TARGETS like `46514/3000` means 46514 ms vs 3000 ms. GPU-util TARGETS like `20666m/40` are `gpu_utilization_percent`. Kubernetes still applies the default **10%** tolerance (`3188/3000` does not scale); see [Kubernetes HPA metrics](#kubernetes-hpa-metrics).

### What port numbers are used?

`kubectl port-forward` is **`LOCAL:REMOTE`**: host port, then the Service port in the cluster.

| Name | Port | Where |
|------|------|-------|
| OpenShell CLI | **18080** | Host. `./scripts/openshell-port-forward.sh`. `openshell status` uses `https://127.0.0.1:18080`. |
| OpenClaw agent | **18789** | Inside each OpenClaw sandbox netns. Host port is `18789+i` for user i. Last port is `18789+N-1`. |
| Hermes gateway | **8642** | Inside each Hermes sandbox. Host API is `8642+i`. Host UI is `18789+i`. Last ports are `8642+N-1` and `18789+N-1`. |
| Envoy load balancer | **80** | Cluster HTTP. Sandboxes still call OpenShell `https://inference.local`. |
| Metrics-proxy | **8081** | Cluster `service/nemoclaw-gpu-metrics-proxy`. Optional host forward `8081:8081`. |
| Ollama | **11434** | Inside each Ollama GPU pod. |
| vLLM / NIM | **8000** | Inside each vLLM or NIM GPU pod. |
| Grafana | **3000** | Host, optional `3000:80` (Service port 80). |
| k3s API | **6443** | Host. Connection refused here means the cluster is down. |
| MicroK8s API | **16443** | Host. Same role as k3s 6443. |
| minikube API | **8443** | Host, when using [minikube](#minikube). |

### How to install Kubernetes?

See the [Kubernetes setup](https://kubernetes.io/docs/setup/) docs. This recipe used [k3s](https://docs.k3s.io/quick-start) on the DGX and [MicroK8s](https://microk8s.io/docs/getting-started) on a [Brev](https://brev.nvidia.com) AWS 4× L40S instance for HPA validation. You may also use [minikube](https://minikube.sigs.k8s.io/docs/start/) with the [minikube NVIDIA GPU tutorial](https://minikube.sigs.k8s.io/docs/tutorials/nvidia/). After install, `kubectl get nodes` must succeed. 



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


