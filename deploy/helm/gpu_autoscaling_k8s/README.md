<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw Kubernetes GPU autoscaling

This experimental community recipe demonstrates a cost-efficient architecture that runs a single AI agent securely inside a CPU-only OpenShell sandbox while independently autoscaling GPU-backed inference. Because GPU inference is the primary compute and cost bottleneck, Kubernetes HPA dynamically adjusts inference capacity from one to multiple replicas as demand changes—maintaining responsiveness during traffic spikes while releasing idle GPU resources when demand falls.

The sandboxed agent is swappable — **OpenClaw** (default), **Hermes**, or **Deep Agents Code** — see [`AGENT-SELECTION.md`](AGENT-SELECTION.md). The inference container is also swappable — **Ollama** (default), **vLLM**, or **NVIDIA NIM** — via `inference.runtime`; see [Inference runtimes](#inference-runtimes). Every combination keeps the same 1 GPU → 1 pod → local OpenAI-compatible `/v1` server pattern, so the rest of the architecture (metrics-proxy, HPA, Envoy) is unaffected by either choice.

Kubernetes HPA scales only those GPU inference pods (1 GPU each) using a Pods **`AverageValue`** metric (average across Ready pods). Example HPA metrics: **GPU utilization** (scale out when average per-pod util is **above 40%**) and **LLM latency** (scale out when average per-pod latency is **above 3000 ms**).

**Envoy Gateway is optional.** When enabled (default), Envoy sits in front of the GPU replicas and load-balances with **LeastRequest**: each new request is sent to a Ready backend that currently has the fewest outstanding requests, so busy GPUs get less new traffic than idle ones. Skip Envoy when the metrics-proxy ClusterIP Service is enough (round-robin / kube-proxy only — no LeastRequest):

| Choice | Install command |
|--------|-----------------|
| With Envoy LeastRequest (default) | `./scripts/install-hpa.sh` |
| Without Envoy (metrics-proxy Service only) | `ENABLE_ENVOY_LB=0 ./scripts/install-hpa.sh` |

**New here?** Start with [Quick start](#quick-start). Teardown: [Uninstall](#uninstall).

**Want to just try it end to end?** `./scripts/try-it.sh` runs the whole Quick start below
in one script — edit the `AGENT_NAME` / `INFERENCE_RUNTIME` block at its top (or pass them
as env vars) and go. It defaults to the isolated-eval shortcuts (`ALLOW_INSECURE_HTTP=1`,
unauthenticated OpenShell) — fine for a dedicated single-user cluster, not for shared/prod.

Keep the versions in `versions.env` align with NemoClaw blueprint: NemoClaw `v0.0.104`, OpenShell `0.0.85`, Agent Sandbox `v0.5.0`. NemoClaw blueprint only accepts a specific OpenShell range, and OpenShell’s K8s path pins Agent Sandbox. When upstream NemoClaw moves on: bump all three together in `versions.env`, rebuild/push a new sandbox image tag, re-apply Agent Sandbox if needed, reinstall/restart OpenShell, recreate the sandbox, then re-run verify + HPA checks to `MAX_REPLICAS` (allocatable GPUs).

## Architecture

```text
OpenShell CLI → port-forward → OpenShell gateway → CPU-only NemoClaw sandbox
```

Runtime inference path (HPA scales to **N** inference pods, 1 GPU each). Envoy is optional: LeastRequest when enabled; metrics-proxy ClusterIP Service when `ENABLE_ENVOY_LB=0`. Set both `MAX_REPLICAS` and `TARGET_PODS` to your allocatable GPU count (**N**) — not fixed to 4 (or 8 on an 8-GPU node like `dgx02`; see [Validated hardware](#validated-hardware)).

Each GPU pod is **2/2 Ready** when healthy: an inference container (`ollama`, `vllm`, or `nim`, whichever `inference.runtime` selects) + container `metrics-proxy` (auth, `/v1` proxy, health, Prometheus `/metrics`). The metrics-proxy is **not** the sandboxed AI agent — that runs only in the CPU OpenShell sandbox (see [`AGENT-SELECTION.md`](AGENT-SELECTION.md) for OpenClaw / Hermes / Deep Agents Code).

```text
CPU-only OpenShell sandbox (AGENT_NAME=openclaw | hermes | deepagents — see AGENT-SELECTION.md)
        ↓
Envoy Gateway — LeastRequest  (or metrics-proxy Service when ENABLE_ENVOY_LB=0)
        ↓
Authenticated inference endpoints
├─ Inference pod (ollama|vllm|nim) → GPU 1
├─ Inference pod (ollama|vllm|nim) → GPU 2
├─ …
└─ Inference pod (ollama|vllm|nim) → GPU N
        ↑
HPA (examples: GPU util >40% or latency >3000 ms)
```

**Inference API key.** Chart-generated local Secret for Bearer auth on `/v1/models` and chat completions; users do not supply a cloud key. OpenShell injects it for the sandbox — not for Ollama model pulls, and not OpenAI/`NVIDIA_API_KEY`.

**Kubernetes HPA metrics.** Two documented examples (both live-validated on the reference hardware). The HPA uses `type: Pods` + `target.type: AverageValue`: it averages the metric across Ready pods, then scales out when that average is **above** the target.

| Example metric | Scale out when… | Default target |
|----------------|-----------------|----------------|
| **GPU utilization** (`gpu_utilization`) | average per-pod GPU util **above 40%** | `HPA_TARGET_GPU=40` |
| **LLM latency** (`latency_avg`) | average per-pod chat proxy latency **above 3000 ms** | `HPA_TARGET_LATENCY_MS=3000` (**milliseconds**; script output `46514/3000` means 46514 ms / 3000 ms) |

These two are the **built-in** HPA modes (`gpu_utilization` | `latency_avg`). Operators can add other Prometheus → Adapter metrics by extending `monitoring/prometheus-adapter-gpu-values.yaml` and the `nemoclaw-gpu.hpaMetric` helpers.

**What “latency” measures.** `nemoclaw_llm_latency_avg_milliseconds` is the metrics-proxy’s **chat/completions proxy duration** on that pod:

- **Starts** when the metrics-proxy has accepted the request body and is about to call the in-pod inference server (`POST …/chat/completions`, typically Ollama).
- **Ends** when the full upstream response has been written back to the client (includes stream time when `"stream": true`).

It does **not** include earlier client→Envoy/Service hop time or request-body read time. Each pod exposes a rolling average over recent completions (default window 128; `LLM_LATENCY_WINDOW_SIZE`). After **60s with no new samples** (`LLM_LATENCY_IDLE_EXPIRE_MS` / `metrics.llmLatencyIdleExpireMs`), the gauge resets to **0** so HPA can scale down once load stops. HPA takes the **Pods `AverageValue`** of that gauge across Ready pods.


### Validated hardware

Live-tested on [**Brev: AWS Instance**](https://brev.nvidia.com) with a single-node **MicroK8s** cluster:

| Item | Value |
|------|-------|
| Platform | [Brev: AWS Instance](https://brev.nvidia.com) |
| GPUs | **4× NVIDIA L40S** (48 GB GDDR6 each) |
| Scheduling | One node; one Ollama pod per GPU (both `MAX_REPLICAS` and `TARGET_PODS` default to allocatable **N**) |
| Model used in validation | `llama3.2:3b` |
| Sandbox image registry | MicroK8s local registry `localhost:32000` (also any registry nodes can pull) |

<img width="647" height="463" alt="Reference 4× L40S MicroK8s node used for validation" src="https://github.com/user-attachments/assets/80cb397b-d2e3-4b0d-933e-3b8dd1dfdb80" />

**4× L40S is an example platform**, not a hard limit. Set both `MAX_REPLICAS` and `TARGET_PODS` to your allocatable GPU count (**N** — any number you have); install and load-test default to that same N. Covered on the example hardware: chart deploy, optional Envoy LeastRequest, authenticated inference, Kubernetes HPA scale-up when average per-pod **GPU util > 40%** or average per-pod **latency > 3000 ms** (and scale-down after load stops), Envoy distribution across Ready GPU pods, and OpenShell sandbox → `https://inference.local/v1`.

#### 8× H100 example (e.g. `dgx02`) — not yet independently validated

The same pattern is designed to scale to a single 8-GPU DGX-class node with no chart changes — just raise the ceiling. This configuration has not yet been run through the full validation pass above; re-run [Install details](#install-details)'s static checks and the [Test autoscaling](#test-autoscaling-and-load-balancing) steps against your own 8-GPU cluster before relying on it.

```bash
export MAX_REPLICAS=8   # install-hpa.sh
export TARGET_PODS=8    # hpa-load-test.sh
./scripts/install-hpa.sh
```

`MAX_REPLICAS`/`TARGET_PODS` default to the allocatable GPU count already, so on an 8×H100 node with all GPUs schedulable you can usually omit both and let the scripts detect **N=8** automatically. Any `inference.runtime` (Ollama, vLLM, or NIM — see [Inference runtimes](#inference-runtimes)) works the same way; H100's 80 GB HBM3 comfortably fits every default model in this recipe with headroom to spare.

## Prerequisites

- Kubernetes 1.25+ with `kubectl` (1.28+ preferred with Envoy / Gateway API)
- Helm 3
- Allocatable `nvidia.com/gpu`; nodes labeled `nvidia.com/gpu.present=true`
- NVIDIA GPU Operator + DCGM Exporter (MicroK8s: `install-hpa.sh` can `microk8s enable gpu`)
- Metrics Server (MicroK8s: installer can enable)
- OpenShell path only: Docker Buildx + a registry nodes can pull (MicroK8s: [local registry](#microk8s-local-registry) on `:32000`); OpenShell CLI matching `versions.env`; Agent Sandbox CRDs (apply the pinned manifest yourself); OIDC **or** the unauthenticated eval exception

```bash
kubectl get nodes \
  -o jsonpath='{range .items[*]}{.metadata.name}{" GPUs="}{.status.allocatable.nvidia\.com/gpu}{"\n"}{end}'
kubectl get nodes -l nvidia.com/gpu.present=true
kubectl get pods -n gpu-operator-resources -l app=nvidia-dcgm-exporter
```

Do not paste kubeconfig, registry credentials, OIDC secrets, or inference API keys into issues or PRs.

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

### 3. Install GPU inference + Kubernetes HPA

TLS is required by default when Envoy is on (see [TLS values](#tls-values)). Isolated eval only: `ALLOW_INSECURE_HTTP=1`.

**Cluster-local settings:** copy `local.env.example` → `local.env` (gitignored) and point `HPA_VALUES` at your TLS overlay. Scripts auto-source `local.env` from the recipe directory, so you can run them from any cwd without re-exporting. Already-exported env vars still win.

```bash
# Once per cluster clone — see [TLS values](#tls-values)
cp local.env.example local.env
cp values.yaml ./hpa-tls-values.yaml
# Edit hpa-tls-values.yaml (ingress.host + ingress.tls) and local.env (INGRESS_HOST)

# Optional: export NEMOCLAW_TARGET_NODE=<gpu-node-name>
# Optional: export INFERENCE_MODEL=<ollama-tag>  # default llama3.2:3b; use nemotron-3-nano:30b to switch to Nemotron on L40S
# MAX_REPLICAS defaults to allocatable GPU count N
./scripts/install-hpa.sh
# Or without Envoy: ENABLE_ENVOY_LB=0 ./scripts/install-hpa.sh
```

Wait for the first Ollama model pull (`ROLLOUT_TIMEOUT` if needed). The metrics-proxy Service listens on **port 8081**. Then:

```bash
kubectl get pods,service,hpa -n nemoclaw-gpu
./scripts/get-hpa.sh -n nemoclaw-gpu
```

Optional example test: [Example test](#example-test).

### 4. Agent Sandbox, image, OpenShell

Pick your agent once here — everything below (and step 5) reuses the same `AGENT_NAME`. See [`AGENT-SELECTION.md`](AGENT-SELECTION.md#comparison) for how OpenClaw, Hermes, and Deep Agents Code differ.

```bash
source versions.env
kubectl apply -f \
  "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/manifest.yaml"

export AGENT_NAME=openclaw   # or hermes | deepagents

# MicroK8s local registry (validated path) — see [MicroK8s local registry](#microk8s-local-registry)
microk8s enable registry   # if not already on
export AGENT_SANDBOX_IMAGE=localhost:32000/nemoclaw-${AGENT_NAME}-k8s:${NEMOCLAW_VERSION}
# Or any registry nodes can pull: export AGENT_SANDBOX_IMAGE=registry.example.com/team/nemoclaw-${AGENT_NAME}-k8s:v0.0.104
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
export AGENT_SANDBOX_IMAGE=localhost:32000/nemoclaw-${AGENT_NAME}-k8s:${NEMOCLAW_VERSION}
export INFERENCE_MODEL=llama3.2:3b   # must match the GPU chart model
./scripts/create-agent-sandbox.sh
./scripts/verify-agent-sandbox.sh   # example: "In one sentence, what is an AI agent sandbox?" — see [Example test](#example-test)

# OpenClaw / Hermes — long-running gateway, keep this terminal in the foreground:
./scripts/run-agent-sandbox.sh
# Deep Agents Code — no gateway; run one-shot prompts instead:
# ./scripts/run-agent-prompt.sh "Explain this repository in one sentence."
```

Users do not paste an inference API key; the chart generates it and OpenShell injects Bearer auth.

### 6. HPA and Envoy check

Scales to **all** allocatable GPUs (both `TARGET_PODS` and `SCALE_UP_TARGET` default to **N**), then back to 1. Default metric is GPU utilization (scale out when average per-pod util is **above 40%**). Pass `HPA_METRIC=latency_avg HPA_TARGET_LATENCY_MS=3000` to exercise latency instead (scale out when average per-pod latency is **above 3000 ms**). When Envoy is enabled, the script also checks that LeastRequest spreads chat traffic across Ready replicas.

Reuse the **same** `local.env` / TLS overlay you used for install (no re-export needed if `local.env` exists):

```bash
# If this is a fresh clone without local.env yet:
# cp local.env.example local.env   # then edit

# GPU util (default): average per-pod util > 40%
./scripts/hpa-load-test.sh

# Latency: average per-pod latency > 3000 ms
HPA_METRIC=latency_avg HPA_TARGET_LATENCY_MS=3000 ./scripts/hpa-load-test.sh
# Same ceiling as install: both MAX_REPLICAS and TARGET_PODS default to N
```

While it runs, watch HPA with `./scripts/hpa-watch.sh` or `./scripts/get-metrics-proxy-pods.sh -n nemoclaw-gpu`. For load balancing without Grafana: with Envoy enabled, `hpa-load-test.sh` prints an **Envoy LeastRequest** check (`Envoy LeastRequest OK: <pod>:+<delta>, …`) showing chat completions landed on multiple Ready pods. You can also compare per-pod success counters:

```bash
# After scale-up (≥2 Ready pods), sample request counters on each metrics-proxy pod
kubectl get pods -n nemoclaw-gpu -l component=gpu-metrics-proxy -o wide
kubectl exec -n nemoclaw-gpu deploy/nemoclaw-gpu-metrics-proxy -c metrics-proxy -- \
  wget -qO- http://127.0.0.1:8081/metrics | grep nemoclaw_llm_requests_total
```

Optional Grafana views: [Grafana: watch workload balancing](#grafana-watch-workload-balancing).

When finished: [Uninstall](#uninstall).

## Install details

Installer side effects: may install/upgrade Prometheus (if missing), Prometheus Adapter (always, with this recipe’s GPU/latency custom-metric rules), Envoy Gateway (when `ENABLE_ENVOY_LB=1`), DCGM ServiceMonitor, and MicroK8s GPU/Metrics add-ons. Review shared-cluster impact before reuse of release names.

Static checks (no cluster):

```bash
./scripts/test-render-contract.sh
./scripts/test-script-security-contract.sh
node ./scripts/test-inference-auth-contract.mjs
node ./scripts/test-metrics-proxy-metrics-contract.mjs
./scripts/test-nemoclaw-k8s-contract.sh
```

### TLS values

When Envoy is enabled (`ENABLE_ENVOY_LB=1`, the default), **every** `helm upgrade` from the recipe scripts needs a values overlay that sets `ingress.tls`. Chart `values.yaml` alone is not enough.

1. Create the TLS Secret (once).
2. Copy/edit an overlay that points at that Secret (`./hpa-tls-values.yaml`).
3. Copy `local.env.example` → `local.env` so scripts pick up `HPA_VALUES` / `INGRESS_HOST` automatically (any cwd).

```bash
# Run from the recipe directory (or any cwd — scripts resolve the recipe via their own path)
kubectl create namespace nemoclaw-gpu --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret tls nemoclaw-example-tls \
  --namespace nemoclaw-gpu \
  --cert=/path/to/tls.crt --key=/path/to/tls.key \
  --dry-run=client -o yaml | kubectl apply -f -
cp values.yaml ./hpa-tls-values.yaml
cp local.env.example local.env
# Edit ./hpa-tls-values.yaml and local.env (INGRESS_HOST) as needed
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

`local.env` resolves paths from **its own directory**, so scripts work from any cwd. To set the overlay by hand instead (from the recipe directory), use `$PWD` — never a machine-specific absolute path:

```bash
export HPA_VALUES="$PWD/hpa-tls-values.yaml"
export INGRESS_HOST=nemoclaw.example.com
```

An explicit export wins over `local.env`.

If you see `ingress.tls is empty and ingress.allowInsecureHttp is false`, `local.env` / `HPA_VALUES` is missing or the overlay has no `ingress.tls`. Fix that — do not use `ALLOW_INSECURE_HTTP=1` unless this is an isolated eval cluster.

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

### Inference runtimes

`inference.runtime` (Helm field) / no dedicated env var beyond `INFERENCE_RUNTIME` for the scripts below selects which container the chart renders for GPU inference: **`ollama`** (default), **`vllm`**, or **`nim`**. All three keep the same **1 GPU → 1 pod → local OpenAI-compatible `/v1` server** pattern, so the metrics-proxy, HPA, and Envoy layers are unchanged — only the `values.yaml` block matching the runtime name (`ollama:`, `vllm:`, `nim:`) applies.

| Runtime | Best for | Default model | Image | Min VRAM (default model) |
|---------|----------|----------------|-------|---------------------------|
| **Ollama** (default) | Fast pulls, small demo models, simplest quantized-GGUF workflow | `llama3.2:3b` | `ollama/ollama` | ~2 GB |
| **vLLM** | Higher-throughput OpenAI-compatible serving, Hugging Face model catalog | `nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8` | `nvcr.io/nvidia/vllm` | ~5.3 GB |
| **NIM** | Prebuilt, NVIDIA-optimized inference microservice, no serving flags to tune | `nvidia/nemotron-3-nano` | `nvcr.io/nim/nvidia/nemotron-3-nano` | ~8 GB |

Every default here fits comfortably on a single L40S (48 GB) or H100 (80 GB) with room for a much larger `inference.maxModelLen`/context if you raise `vllm.maxModelLen` or switch models.

#### Switching runtimes

```bash
# vLLM — Hugging Face model id as inference.model
export INFERENCE_RUNTIME=vllm
export INFERENCE_MODEL=nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8
./scripts/install-hpa.sh

# NIM — requires an NGC API key (see below)
export INFERENCE_RUNTIME=nim
export INFERENCE_MODEL=nvidia/nemotron-3-nano
export NIM_NGC_API_KEY=nvapi-...
./scripts/install-hpa.sh

# Sandbox must use the same model id OpenShell will request (AGENT_NAME from step 4; see AGENT-SELECTION.md)
./scripts/create-agent-sandbox.sh   # recreate if the sandbox already exists
./scripts/verify-agent-sandbox.sh
```

Notes:

- `install-hpa.sh` / `hpa-reset.sh` / `hpa-load-test.sh` all forward `NIM_NGC_API_KEY` (plaintext, `--set-string nim.ngcApiKey.value=...`) or `NIM_NGC_API_KEY_SECRET` (name of a pre-created `Secret` with key `NGC_API_KEY`, `--set-string nim.ngcApiKey.existingSecret=...`) when set. Prefer `NIM_NGC_API_KEY_SECRET` in a real deployment, since plaintext `--set` values are visible in `helm get values` / shell history.
- vLLM's default `extraArgs` (`--trust-remote-code --async-scheduling --kv-cache-dtype=fp8`) are specific to the Nemotron-3-Nano-4B-FP8 family — clear or replace `vllm.extraArgs` when switching to a different Hugging Face model.
- NIM env vars (`NGC_API_KEY`, `NIM_CACHE_PATH`, `NIM_HTTP_API_PORT`) follow NVIDIA's generic NIM container contract; verify against the specific NIM image's own docs if you swap in a different catalog entry, and use `nim.extraEnv` for anything image-specific.
- The `ollama`/`vllm`/`nim` container security contexts are separate values (`ollamaSecurityContext`, `vllmSecurityContext`, `nimSecurityContext`) in case one runtime's image tolerates stricter settings than another.

#### Ollama model tags

Example Ollama tags (any tag that fits GPU memory is fine; recipe default `llama3.2:3b`):

| Ollama tag (examples) | Typical VRAM headroom | Notes |
|-----------------------|----------------------|--------|
| `llama3.2:3b` | small (~2 GB) | **Recipe default** (fast pull / HPA demos) |
| `nemotron-3-nano:30b` | ~24–40 GB | **Nemotron on L40S** — switch when you want NVIDIA’s Nano locally |
| `qwen3.5:9b` | ~12 GB | Mid-size alternative |
| `qwen3.6:35b` | ~30 GB | High-VRAM starter (tight on 48 GB with long context) |

Other Ollama tags (for example `llama3.1:8b`, `mistral`, …) are fine if they fit into GPU memory.

```bash
# Stay on the small default (optional — already the chart default)
export INFERENCE_MODEL=llama3.2:3b
./scripts/install-hpa.sh

# Switch GPU pods to Nemotron 3 Nano (pull may take several minutes; raise ROLLOUT_TIMEOUT)
export INFERENCE_MODEL=nemotron-3-nano:30b
./scripts/install-hpa.sh

# Sandbox must use the same model id OpenShell will request (AGENT_NAME from step 4; see AGENT-SELECTION.md)
export INFERENCE_MODEL=nemotron-3-nano:30b
./scripts/create-agent-sandbox.sh   # recreate if the sandbox already exists
./scripts/verify-agent-sandbox.sh
```

Helm fields: `inference.runtime` (ollama|vllm|nim) and `inference.model` in `values.yaml` / `HPA_VALUES`. Env for scripts: `INFERENCE_RUNTIME`, `INFERENCE_MODEL`.

#### Persistence

All three runtimes persist their model cache the same way, each via its own `values.yaml` block: `ollama.persistence` (`/var/lib/nemoclaw-gpu/ollama`, the default runtime), `vllm.persistence` (`/var/lib/nemoclaw-gpu/vllm`), `nim.persistence` (`/var/lib/nemoclaw-gpu/nim`). Default persistence for all three is single-node hostPath. Multi-node: clear `hostPath` and use an RWX StorageClass, or disable persistence (`emptyDir` per pod → re-pull/re-download on replace).

### Kubernetes HPA metrics

Two built-in HPA metrics are live-validated in this recipe: **`gpu_utilization`** and **`latency_avg`**. Both use Pods **`AverageValue`** (average across Ready pods). Default install uses **GPU utilization**; pass `HPA_METRIC=latency_avg` to use latency instead.

Operators can add other Prometheus → Adapter metrics by extending `monitoring/prometheus-adapter-gpu-values.yaml` and the `nemoclaw-gpu.hpaMetric` helpers (built-in chart modes remain only `gpu_utilization` and `latency_avg`).

**Example 1 — GPU utilization (default).** Scale out when average per-pod GPU util is **above 40%** (`HPA_TARGET_GPU=40`), up to `MAX_REPLICAS` (defaults to allocatable **N**).

```bash
./scripts/install-hpa.sh
kubectl get --raw \
  '/apis/custom.metrics.k8s.io/v1beta1/namespaces/nemoclaw-gpu/pods/*/gpu_utilization_percent'
./scripts/get-hpa.sh -n nemoclaw-gpu
```

**Example 2 — latency_avg (milliseconds).** Scale out when average per-pod chat latency is **above 3000 ms** (`HPA_TARGET_LATENCY_MS=3000`; `3000` = 3 s).

Latency is the metrics-proxy **proxy duration** for `/v1/chat/completions`: from just before the in-pod inference `fetch` until the full upstream response has been written to the client (includes streaming). It excludes client→Gateway/Service network time. Each pod reports a rolling average of recent requests; after **60s idle** the gauge resets to 0 so HPA can scale down. HPA averages that gauge across Ready pods. `./scripts/get-hpa.sh` / `hpa-watch.sh` print plain millisecond numbers (for example `46514/3000` means 46514 ms current / 3000 ms target).

```bash
# 3000 ms (3 seconds) average latency target
HPA_METRIC=latency_avg HPA_TARGET_LATENCY_MS=3000 ./scripts/install-hpa.sh
kubectl get --raw \
  '/apis/custom.metrics.k8s.io/v1beta1/namespaces/nemoclaw-gpu/pods/*/nemoclaw_llm_latency_avg_milliseconds'
./scripts/get-hpa.sh -n nemoclaw-gpu
```

## Verify

```bash
kubectl get pods,service,hpa -n nemoclaw-gpu
kubectl get --raw \
  '/apis/custom.metrics.k8s.io/v1beta1/namespaces/nemoclaw-gpu/pods/*/gpu_utilization_percent'
# Prefer script output over raw kubectl Quantity suffixes (3k / 3099666m).
# Latency current/target are milliseconds: 46514/3000 means 46514 ms / 3000 ms.
./scripts/get-hpa.sh -n nemoclaw-gpu
./scripts/hpa-watch.sh   # live watch
./scripts/get-metrics-proxy-pods.sh -n nemoclaw-gpu
```

Idle expectation: one Running inference pod (two containers), HPA at one replica. Default GPU-util HPA targets `current/40` (percent). Latency HPA targets `current/3000` (**milliseconds**).

## Example test

Ask a real question — **In one sentence, what is an AI agent sandbox?** — through the authenticated inference path. Prefer the sandbox verifier after OpenShell is up; the metrics-proxy port-forward curl path works earlier (GPU inference only).

Ports (do not mix them up):

| Path | Port-forward | Local URL |
|------|----------------|-----------|
| OpenShell gateway (sandbox verify) | `kubectl -n nemoclaw-sandboxes port-forward service/openshell 8080:8080` | `https://127.0.0.1:8080` |
| Metrics-proxy (direct curl) | `kubectl port-forward -n nemoclaw-gpu service/nemoclaw-gpu-metrics-proxy 8081:8081` | `http://127.0.0.1:8081` |

### From the OpenShell sandbox (recommended)

With the OpenShell port-forward on **8080** running and the sandbox Ready for the
`AGENT_NAME` you created in step 4:

```bash
./scripts/verify-agent-sandbox.sh
```

Example printout (`openclaw` shown; `hermes` and `deepagents` print a slightly different
health-check step — see [`AGENT-SELECTION.md`](AGENT-SELECTION.md#example-verify-output)):

```text
[verify] Inspecting nemoclaw plugin (timeout 90s)...
Plugin inspect OK.
[verify] GET https://inference.local/v1/models (timeout 120s)...
models: llama3.2:3b
[verify] POST https://inference.local/v1/chat/completions
[verify] Example query: In one sentence, what is an AI agent sandbox?
[verify] Answer: An AI agent sandbox is a simulated environment where an AI agent
can interact and learn in a safe, controlled space.
OK: sandbox nemoclaw-onprem reached https://inference.local for models and a real prompt (llama3.2:3b).
Runtime (optional foreground): AGENT_NAME=openclaw ./scripts/run-agent-sandbox.sh
```

Exact assistant wording varies by model and sampling; a non-empty answer plus the final `OK:` line means the example path passed. Small models (for example `llama3.2:3b`) may not know product-specific names like “NemoClaw”.

### From the metrics-proxy Service (operator port-forward)

Operator port-forward bypasses Gateway TLS/Basic; Bearer still required. Do not bind to a non-loopback address. Use **8081** (metrics-proxy Service port) — not OpenShell’s **8080**.

```bash
kubectl port-forward -n nemoclaw-gpu service/nemoclaw-gpu-metrics-proxy 8081:8081
```

```bash
curl -s http://127.0.0.1:8081/healthz
INFERENCE_API_KEY="$(kubectl get secret nemoclaw-gpu-metrics-proxy-inference-api \
  -n nemoclaw-gpu -o jsonpath='{.data.api-key}' | base64 -d)"
curl -s http://127.0.0.1:8081/v1/models \
  -H "Authorization: Bearer ${INFERENCE_API_KEY}"
curl -s http://127.0.0.1:8081/v1/chat/completions \
  -H "Authorization: Bearer ${INFERENCE_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"model":"llama3.2:3b","messages":[{"role":"user","content":"In one sentence, what is an AI agent sandbox?"}],"max_tokens":256,"stream":false}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["choices"][0]["message"]["content"])'
unset INFERENCE_API_KEY
```

Example printout:

```text
ok
{"object":"list","data":[{"id":"llama3.2:3b","object":"model",...}]}
An AI agent sandbox is a simulated environment where an AI agent can interact
and learn in a safe, controlled space.
```

`/healthz`, `/readyz`, `/metrics` are unauthenticated. `/readyz` may be `503` during the initial model download.

## OpenShell details

### MicroK8s local registry

Validated on MicroK8s with the built-in registry (NodePort **32000**). Nodes pull `localhost:32000/...` over plain HTTP.

```bash
microk8s enable registry
# Docker must allow the insecure registry (daemon.json insecure-registries:
# ["localhost:32000","127.0.0.1:32000"] — then restart Docker).

source versions.env
export AGENT_NAME=openclaw   # or hermes | deepagents — see AGENT-SELECTION.md#comparison
export AGENT_SANDBOX_IMAGE=localhost:32000/nemoclaw-${AGENT_NAME}-k8s:${NEMOCLAW_VERSION}
./scripts/build-agent-sandbox-image.sh

# If a node cannot pull, pre-load into containerd:
# microk8s ctr images pull --plain-http "${AGENT_SANDBOX_IMAGE}"
```

Use the same `AGENT_SANDBOX_IMAGE` (and `AGENT_NAME`) for `scripts/create-agent-sandbox.sh`. Any other registry works the same way if every node can pull the tag (private registry credentials are outside this recipe).

### Gateway and sandbox

- Agent Sandbox CRDs are cluster-scoped; `install-openshell-k8s.sh` never installs them — apply the pinned manifest yourself.
- Build image: `AGENT_NAME=… AGENT_SANDBOX_IMAGE=… ./scripts/build-agent-sandbox-image.sh` (versioned, non-`latest` tag; no API key in the image; see [`AGENT-SELECTION.md`](AGENT-SELECTION.md#comparison) for the three `AGENT_NAME` values). Prefer [MicroK8s local registry](#microk8s-local-registry) on MicroK8s.
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

- `scripts/create-agent-sandbox.sh` stores the chart inference key in the OpenShell provider, strips `integrate.api.nvidia.com` from policy (where the selected agent's upstream policy grants it — see [`AGENT-SELECTION.md`](AGENT-SELECTION.md#shared-policy-notes)), and runs an example chat (`In one sentence, what is an AI agent sandbox?`).
- OpenShell `0.0.85` leaves sandboxes idle (`sleep infinity`); `scripts/run-agent-sandbox.sh` (OpenClaw/Hermes) must stay attached and does not auto-restart — Deep Agents Code has no such gateway to keep running (see [`AGENT-SELECTION.md`](AGENT-SELECTION.md)). Combined topology may require powerful capabilities (`SYS_ADMIN`, `NET_ADMIN`, …) — check admission policy.

## Test autoscaling and load balancing

`install-hpa.sh` only installs/configures monitoring, the chart, and HPA (and optional Envoy). It does **not** generate load. `hpa-load-test.sh` starts chat load generators to drive the selected HPA metric above target, verifies scale-up (and Envoy LeastRequest when enabled), then stops load so the cluster can scale back to 1.

`hpa-load-test.sh` defaults to a full-**N** run: both `TARGET_PODS` and `SCALE_UP_TARGET` match allocatable GPUs (same ceiling as install `MAX_REPLICAS`). Override those only if you intentionally want a lower ceiling. Once HPA holds max replicas for a few seconds, generators stop creating new load so replicas can return to 1 (GPU util drops with traffic; `latency_avg` idle-expires to 0 after `LLM_LATENCY_IDLE_EXPIRE_MS`).

Always use the **same** TLS overlay as install. Prefer `local.env` (auto-sourced). Or export with `$PWD` from the recipe directory:

```bash
# cp local.env.example local.env   # once per clone — see [TLS values](#tls-values)
# Or: export HPA_VALUES="$PWD/hpa-tls-values.yaml" INGRESS_HOST=nemoclaw.example.com

# GPU util (default): scale out when average per-pod util > 40%
./scripts/hpa-load-test.sh

# Latency: scale out when average per-pod latency > 3000 ms
# (script current/target values are milliseconds, e.g. 46514/3000)
HPA_METRIC=latency_avg HPA_TARGET_LATENCY_MS=3000 ./scripts/hpa-load-test.sh

./scripts/hpa-reset.sh
```

Example from the validated 4× L40S run — HPA scale-up when average per-pod GPU utilization > 40%

<img width="1480" height="569" alt="HPA scaling to four GPU replicas under load (GPU utilization)" src="https://github.com/user-attachments/assets/6c37e52e-48fa-44a1-8ab6-878d90347bb9" />

Example from the validated 4× L40S run — HPA scale-up when average per-pod latency > 3000 ms

<img width="1484" height="557" alt="HPA scaling to four GPU replicas under load (latency_avg)" src="https://github.com/user-attachments/assets/c8cc50cd-455f-4348-9347-f45acc2e264b" />

These two screenshots are the built-in HPA examples (`gpu_utilization` and `latency_avg`).

Load balancing without Grafana: `hpa-load-test.sh` (with Envoy enabled) runs a LeastRequest distribution check and logs per-pod success deltas. During or after scale-up, use `./scripts/get-metrics-proxy-pods.sh -n nemoclaw-gpu` for per-pod GPU util, or scrape each pod’s `/metrics` for `nemoclaw_llm_requests_total{result="success"}`. Optional Grafana views: [Grafana: watch workload balancing](#grafana-watch-workload-balancing).


## Grafana: watch workload balancing

Optional. Use Grafana while `./scripts/hpa-load-test.sh` (or other chat load) is running to watch the same two example HPA signals (GPU utilization and LLM latency) and how work spreads across replicas.

### Open Grafana

```bash
kubectl port-forward -n monitoring service/kube-prometheus-grafana 3000:80
```

Open http://127.0.0.1:3000. Login:

```bash
kubectl get secret kube-prometheus-grafana -n monitoring \
  -o jsonpath='{.data.admin-user}' | base64 -d; echo
kubectl get secret kube-prometheus-grafana -n monitoring \
  -o jsonpath='{.data.admin-password}' | base64 -d; echo
```

In Grafana: **Explore** → data source **Prometheus** → **Code** → paste a query → **Run queries** → time range **Last 15 minutes**.

### Queries

**GPU utilization by pod** (HPA example: scale out when average per-pod util is above 40%):

```promql
avg by (exported_pod) (
  DCGM_FI_DEV_GPU_UTIL{
    exported_namespace="nemoclaw-gpu",
    exported_pod=~"nemoclaw-gpu-metrics-proxy-.*"
  }
)
```

**LLM latency by pod (ms)** (HPA example: scale out when average per-pod latency is above 3000 ms):

```promql
avg by (pod) (
  nemoclaw_llm_latency_avg_milliseconds{
    namespace="nemoclaw-gpu",
    pod=~"nemoclaw-gpu-metrics-proxy-.*"
  }
)
```
<img width="1505" height="847" alt="Screenshot 2026-08-12 at 5 01 21 PM" src="https://github.com/user-attachments/assets/7b20b03f-fe4a-4d9c-8c04-722dd8863c70" />


Optional — **successful inference requests by pod** (Envoy LeastRequest / Service distribution, not an HPA scale metric in the two examples above):

```promql
sum by (pod) (
  rate(nemoclaw_llm_requests_total{
    namespace="nemoclaw-gpu",
    result="success"
  }[5m])
)
```
<img width="1502" height="852" alt="Screenshot 2026-08-12 at 4 48 41 PM" src="https://github.com/user-attachments/assets/9858911e-73cf-4d60-87b6-70972df6d90c" />


After scale-up you should see multiple pod series. metrics-proxy `/metrics` scraping is on by default (`metrics.serviceMonitor.enabled: true`) after `install-hpa.sh`. If latency graphs stay empty while GPU util still moves, check `kubectl get servicemonitor -n nemoclaw-gpu` and re-run `install-hpa.sh` if the ServiceMonitor was disabled.

## Scripts

| Script | Purpose |
|--------|---------|
| `try-it.sh` | Runs the whole Quick start end to end, `AGENT_NAME` / `INFERENCE_RUNTIME` at the top |
| `install-hpa.sh` | Monitoring + chart + HPA (+ Envoy if enabled) |
| `hpa-load-test.sh` / `hpa-reset.sh` | Autoscaling (+ Envoy) test / restore idle |
| `get-metrics-proxy-pods.sh` / `get-hpa.sh` / `hpa-watch.sh` | Inspect / watch |
| `install-openshell-k8s.sh` | OpenShell gateway |
| `test-*-contract.*` | Static / local contract checks |

Sandbox agent lifecycle scripts — `build-agent-sandbox-image.sh`, `create-agent-sandbox.sh`,
`verify-agent-sandbox.sh`, `run-agent-sandbox.sh` / `run-agent-prompt.sh` — pick their agent
(`openclaw`, `hermes`, or `deepagents`, mirroring [`NVIDIA/NemoClaw/agents`](https://github.com/NVIDIA/NemoClaw/tree/main/agents))
via a single `AGENT_NAME` flag; see [`AGENT-SELECTION.md`](AGENT-SELECTION.md) for the
comparison table and per-agent env vars.


### Upgrade from pre-metrics-proxy releases

Older chart revisions misnamed the GPU front door Deployment/Service/HPA/Gateway with a `…-agent` suffix (labels `component=agent` or `gpu-agent`). That object was **never** the OpenClaw/NemoClaw AI agent. Current revisions use `…-metrics-proxy` / `component=gpu-metrics-proxy` only.

`install-hpa.sh`, `hpa-reset.sh`, and `hpa-load-test.sh` call `hpa_common_migrate_pre_metrics_proxy_resources` **before** Helm upgrade: they detect those historical leftovers (by old basename and label) and delete them—including orphaned keep-policy Secrets—so an upgrade cannot leave both workloads competing for GPUs. A fresh install of this head only creates `…-metrics-proxy` names.

## Uninstall

Stop the running agent (`scripts/run-agent-sandbox.sh` for OpenClaw/Hermes; Deep Agents Code exits after each `run-agent-prompt.sh` call — nothing to stop). With OpenShell port-forward still up (substitute your agent's sandbox/provider name — `nemoclaw-onprem`/`onprem-ollama` for OpenClaw, `hermes-onprem`/`onprem-hermes` for Hermes, `deepagents-onprem`/`onprem-deepagents` for Deep Agents Code):

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

Shared Prometheus, Adapter, Envoy, and Agent Sandbox CRDs are left in place on purpose.

Third-party notices: [THIRD-PARTY-NOTICES](../../../../THIRD-PARTY-NOTICES).
