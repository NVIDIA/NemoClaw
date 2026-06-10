<img width="1450" height="336" alt="Screenshot 2026-06-09 at 7 39 36 PM" src="https://github.com/user-attachments/assets/df1602fd-5f75-4be3-b0c3-fed6a304508b" />
# NemoClaw Kubernetes deployment — GPU (HPA)

**Main deployment path** for NemoClaw on Kubernetes: **GPU agent pods** with **Horizontal Pod Autoscaler (HPA)**. Each pod uses **one GPU** and runs **local Ollama inference** (same pattern as NemoClaw GPU onboard / E2E).

**Index:** [deploy/README.md](README.md) · **Models (CPU vs GPU):** [helm/README.md](helm/README.md)

This document is the **GPU deployment guide** — install, operate, load-test, architecture, HPA metrics, ports, and troubleshooting. Optional CPU chart: [README-cpu.md](README-cpu.md).

**Reference hardware:** **4× L40S** on single-node **MicroK8s** — one agent pod per GPU, HPA `MAX_REPLICAS=4`. Other GPU counts work; set `MAX_REPLICAS` to your allocatable `nvidia.com/gpu`.

**Not the VM NemoClaw sandbox** (Telegram, OpenShell). The VM bot and cluster agents are separate deployments.

**Default GPU HPA autoscaling metric name:** `gpu_utilization_percent`  
(Prometheus source: `DCGM_FI_DEV_GPU_UTIL` from nvidia-dcgm-exporter → prometheus-adapter → custom.metrics.k8s.io)

## Contents

- [Reference environment (4× L40S)](#reference-environment-4-l40s)
- [New users (one command)](#new-users-one-command)
- [Port-forward](#port-forward)
- [Comparison (CPU vs GPU)](#comparison-cpu-vs-gpu)
- [Scripts](#scripts)
- [Architecture](#architecture)
- [Pod resources (`gpuScaling`)](#pod-resources-gpuscaling--why-ollama-has-cpu-on-a-gpu-pod)
- [HPA metrics (GPU utilization)](#hpa-metrics-gpu-utilization)
- [Load balancer](#load-balancer)
- [Prerequisites](#prerequisites)
- [Readiness](#readiness)
- [Troubleshooting](#troubleshooting)
- [Directory layout](#directory-layout)
- [Uninstall](#uninstall)

---

## Reference environment (4× L40S)

This guide is written and load-tested on **4× NVIDIA L40S**. Default install and HPA bounds assume **one agent pod per GPU** (`MAX_REPLICAS=4`).


<img width="1334" height="920" alt="Screenshot 2026-06-09 at 7 01 28 PM" src="https://github.com/user-attachments/assets/a8380890-4074-43a6-968c-916b523199d2" />


| Property | Value |
|----------|--------|
| **GPUs** | **4× L40S** |
| **Kubernetes** | Single-node **MicroK8s** |
| **HPA** | `MIN_REPLICAS=1`, `MAX_REPLICAS=4` |

If you have fewer or more GPUs, set `MAX_REPLICAS` to match allocatable `nvidia.com/gpu`.

---

## New users (one command)

```bash
cd ~/NemoClaw/deploy/helm/nemoclaw-gpu

# Prerequisites (MicroK8s example)
microk8s enable gpu metrics-server
microk8s status --wait-ready

./scripts/install-hpa.sh
```

Set `MAX_REPLICAS` to the number of allocatable GPUs on your node (**4** on the reference **4× L40S** node):

```bash
MAX_REPLICAS=4 ./scripts/install-hpa.sh   # 4× L40S
```

First startup pulls the Ollama model — allow **5–15 minutes**:

```bash
ROLLOUT_TIMEOUT=1200 INFERENCE_MODEL=llama3.2:3b ./scripts/install-hpa.sh
```

Confirm idle state:

```bash
kubectl get hpa -n nemoclaw-gpu
# HPA metric: gpu_utilization_percent
# TARGETS column: current/target (may show milli-units, e.g. 33500m/40 = 33.5%/40)

kubectl get pods -n nemoclaw-gpu -l component=gpu-agent
```

Expect **1 Running pod** (`2/2` containers: Ollama + agent) and HPA **REPLICAS 1**.

**Watch HPA live** (recommended):

```bash
kubectl get hpa -n nemoclaw-gpu -w
```

Optional second terminal — per-pod GPU % (not the HPA average):

```bash
./scripts/get-agent-pods.sh -n nemoclaw-gpu -w
```

---

## Port-forward

GPU agent listens on **8081** (Service, pod, and local port-forward):

```bash
kubectl port-forward -n nemoclaw-gpu svc/nemoclaw-gpu-agent 8081:8081
```

Ollama runs on **11434** inside the pod only (not exposed on the Service).

**Verify** (run port-forward in one terminal):

```bash
curl -s http://127.0.0.1:8081/healthz
curl -s http://127.0.0.1:8081/readyz
curl -s http://127.0.0.1:8081/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Hi"}],"max_tokens":16}'
```

Override host port: `LOCAL_PORT=8082 ./scripts/install-hpa.sh`

Optional autoscaling demo:


<img width="1888" height="826" alt="Screenshot 2026-06-09 at 7 02 00 PM" src="https://github.com/user-attachments/assets/4aa98eb1-58bd-4256-8539-df6f617d3016" />

<img width="1450" height="336" alt="Screenshot 2026-06-09 at 7 39 36 PM" src="https://github.com/user-attachments/assets/a3ed1f62-256b-4b97-9c11-e01a74e5912b" />


```bash
./scripts/hpa-load-test.sh

./scripts/hpa-reset.sh
```





If install keeps failing:

```bash
./scripts/cluster-recover.sh
```

Chart: [helm/nemoclaw-gpu/](helm/nemoclaw-gpu/) · **Models (CPU vs GPU):** [helm/README.md](helm/README.md)



---

## Comparison (CPU vs GPU)

See [deploy/README.md](README.md) and [helm/README.md](helm/README.md). This guide covers **GPU only** — install with `./scripts/install-hpa.sh` in this chart directory.

---

## Scripts

All scripts live under `deploy/helm/nemoclaw-gpu/scripts/`. Run from the chart directory.

| Script | What it does | When to use |
|--------|----------------|-------------|
| **`install-hpa.sh`** | Enables **GPU plugin + DCGM**; installs **Prometheus + prometheus-adapter**; chart with **GPU utilization HPA** (`DCGM_FI_DEV_GPU_UTIL`, default target **70%**). | **First install** or refresh. |
| **`hpa-reset.sh`** | Deletes load-test Jobs; force-deletes pods; **helm upgrade** to idle baseline. | After load test or stuck pods. |
| **`cluster-recover.sh`** | Full uninstall, namespace cleanup, optional MicroK8s restart, reinstall. | Repeated rollout failures. |
| **`hpa-load-test.sh`** | Chat load against local Ollama; watches HPA scale up/down. | Prove autoscaling only. |
| **`get-agent-pods.sh`** | Agent pods with per-pod **GPU UTIL %** (optional `-w` refresh). | Second terminal while `kubectl get hpa -w`. |
| **`get-hpa.sh`** | One-shot HPA with readable **GPU UTIL %** column. | Quick check without milli-units. |
| **`hpa-watch.sh`** | Alias for `kubectl get hpa -n nemoclaw-gpu -w`. | Same as kubectl watch. |
| **`hpa-common.sh`** | Shared helpers (not run directly). | — |

### Workflow

```text
First time:              install-hpa.sh
After load test / tidy:  hpa-reset.sh
Rollout keeps failing:   cluster-recover.sh
Prove autoscaling:       hpa-load-test.sh
Watch HPA:               kubectl get hpa -n nemoclaw-gpu -w
Per-pod GPU (optional):  ./scripts/get-agent-pods.sh -w
After load test:         hpa-reset.sh
```

### Load test tuning (4× L40S)

`hpa-load-test.sh` auto-detects allocatable GPUs and defaults for the reference **4× L40S** node:

| Setting | Default | Purpose |
|---------|---------|---------|
| `TARGET_PODS` | allocatable GPUs (**4** on L40S node) | HPA max + load target |
| `CONCURRENCY_PER_POD` | **64** | Base concurrency tuning knob |
| `JOB_PARALLELISM` | **8** | Eight load-generator pods |
| `LOAD_MULTIPLIER` | **4** (4× L40S) | **4096** in-flight requests per agent GPU at peak |
| `INFLIGHT_PER_GPU` | **1024** | Base per-GPU in-flight before multiplier |
| `MAX_TOKENS` | **512** | Longer generations = more GPU compute per request |
| `HPA_TARGET_GPU` | **50** | Scale when average GPU util > 50% (load test only; production default is 70%) |
| Load model | **direct to each Running pod IP** + **HPA compensation** | When HPA=2 but only 1 pod ready, 2× load on ready pod keeps avg above 50% |

**Why 84% → 42% at 2 replicas:** HPA averages GPU % across all replicas. A new pod at **0%** while starting pulls the average to ~half. Compensation + hitting Running pods (not only Service endpoints) fixes this.

```bash
./scripts/hpa-load-test.sh
```

Watch while it runs:

```bash
kubectl get hpa -n nemoclaw-gpu -w
```

Optional second terminal:

```bash
./scripts/get-agent-pods.sh -w
```

### Environment variables

| Variable | Scripts | Effect |
|----------|---------|--------|
| `MIN_REPLICAS` / `MAX_REPLICAS` | install, reset, load-test | HPA bounds (default 1 / 4) |
| `CONCURRENCY_PER_POD` / `MAX_TOKENS` / `JOB_PARALLELISM` | load-test | GPU load intensity (defaults tuned for **4× L40S**) |
| `HPA_TARGET_GPU` | load-test | GPU util target during test (default **50**) |
| `ROLLOUT_TIMEOUT` | install, reset | Seconds to wait for rollout (default 900) |
| `INFERENCE_MODEL` | install | Ollama model tag (default `llama3.2:3b`) |
| `GPU_TARGET` | install, reset | HPA target GPU util % (default **70**) |
| `PROM_HELM_TIMEOUT` | install | Prometheus helm wait (default 25m) |
| `LOCAL_PORT` | install | Host port for port-forward hints (default **8081**) |
| `DELETE_DEPLOYMENT=1` | `hpa-reset.sh` | Delete Deployment before reinstall |
| `DELETE_HPA=1` | `hpa-reset.sh` | Delete HPA before reinstall |
| `SKIP_HELM=1` | `hpa-reset.sh` | kubectl cleanup only |
| `RESTART_MICROK8S=0` | `cluster-recover.sh` | Skip MicroK8s restart |

---

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│  GPU node — 4× L40S — nemoclaw-gpu                          │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Pod (1× nvidia.com/gpu = 1× L40S)                       │ │
│  │  ┌──────────────┐    ┌─────────────────────────────┐   │ │
│  │  │ Ollama       │◄───│ agent (Node.js) :8081       │   │ │
│  │  │ :11434 GPU   │    │ /healthz /readyz /metrics   │   │ │
│  │  └──────────────┘    └─────────────────────────────┘   │ │
│  └────────────────────────────────────────────────────────┘ │
│  HPA scales 1 … 4 pods (one pod per L40S)                    │
└─────────────────────────────────────────────────────────────┘
              ▲
              │ DCGM_FI_DEV_GPU_UTIL (Prometheus ← nvidia-dcgm-exporter)
              │ same signal family as nvidia-smi GPU utilization %
```

## Pod resources (`gpuScaling`) — why Ollama has CPU on a GPU pod

`values-step2-hpa.yaml` (and `values.yaml`) define two sections that are easy to confuse:

| Section | Purpose |
|---------|---------|
| **`autoscaling:`** | HPA — *when* to scale (GPU util %, min/max replicas) |
| **`gpuScaling:`** | Pod sizing — *how big* each pod is (CPU, memory, GPU per container) |

The **`perPodCpuRequest`** / **`perPodCpuLimit`** fields under `gpuScaling` are **not** the HPA scale signal. They do not drive scale-up when `autoscaling.mode=gpu` (HPA uses DCGM GPU utilization instead).

Each agent pod runs **two containers**:

```text
┌─────────────────────────────────────────────┐
│  pod: nemoclaw-gpu-agent-…                  │
│  ┌──────────────────┐  ┌─────────────────┐  │
│  │ ollama (1 GPU)   │  │ agent (no GPU)  │  │
│  │ perPodCpu*       │  │ agentCpu*       │  │
│  │ perPodMemory*    │  │ agentMemory*    │  │
│  │ nvidia.com/gpu:1 │  │                 │  │
│  └──────────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────┘
```

| Field | Applies to | Role |
|-------|------------|------|
| `perPodCpuRequest` / `perPodCpuLimit` | **Ollama** | Host CPU reservation and cap for the inference container |
| `perPodMemory` / `perPodMemoryLimit` | **Ollama** | Host RAM (model cache, buffers — not VRAM) |
| `perPodGpu` | **Ollama** | GPUs per pod (default **1**) |
| `agentCpuRequest` / `agentCpuLimit` | **Node.js agent** | Small proxy sidecar (health, `/metrics`, chat API) |

### Why Ollama still needs CPU

GPU inference does not run with zero host CPU. Ollama uses CPU for:

- HTTP/API handling and request parsing
- Tokenization and preprocessing before GPU work
- Loading and unpacking model weights into GPU memory
- Runtime overhead around the CUDA kernels

Kubernetes also **requires** CPU and memory **requests** on every container so the scheduler can place pods and enforce QoS. Without them, the cluster cannot reserve node capacity reliably.

Default sizing (e.g. **2** CPU request / **4** limit for Ollama on **4× L40S**) is a **scheduling guardrail**, not “scale when CPU hits 65%.” Four pods × 2 CPU request ≈ 8 vCPUs for Ollama, plus ~1 vCPU for agents, leaving headroom for kube-system, DCGM, Prometheus, and load-test Jobs.

`targetCPUUtilizationPercentage` in `values.yaml` is only used when `autoscaling.mode=resource` (CPU-based HPA via metrics-server). It is **ignored** in the default GPU HPA mode.

Example from `values-step2-hpa.yaml`:

```yaml
gpuScaling:
  perPodCpuRequest: "2"
  perPodCpuLimit: "4"
  perPodMemory: "16Gi"
  agentCpuRequest: "250m"
  agentCpuLimit: "1"

autoscaling:
  mode: gpu
  targetGPUUtilizationPercentage: 70   # HPA signal — not perPodCpu*
```

## HPA metrics (GPU utilization)

**HPA autoscaling metric name:** `gpu_utilization_percent`

| Layer | What |
|-------|------|
| **HPA reads** | **`gpu_utilization_percent`** (custom.metrics.k8s.io, per pod) |
| **Prometheus source** | `DCGM_FI_DEV_GPU_UTIL` (nvidia-dcgm-exporter) |
| **Adapter alias** | `gpu_utilization_percent` (prometheus-adapter rule) |
| **Source** | `nvidia-dcgm-exporter` (GPU operator / `microk8s enable gpu`) |
| **Pipeline** | DCGM → Prometheus → prometheus-adapter → HPA custom metrics API |
| **Target** | Default **70%** average GPU util per pod (`GPU_TARGET=70`) |

**Watch HPA** (primary):

```bash
kubectl get hpa -n nemoclaw-gpu -w
```

The **TARGETS** column shows current/target. Kubernetes may display milli-units (`33500m/70` = 33.5%/70%) — same numbers, different format. Scale-up happens when **current** stays above **target** (e.g. average `84%/50%` across pods → add replicas).

**Per-pod GPU %** (HPA averages across all agent pods — use this to see each pod):

```bash
./scripts/get-agent-pods.sh -n nemoclaw-gpu -w
```

**One-shot readable HPA** (optional):

```bash
./scripts/get-hpa.sh -n nemoclaw-gpu
# prints GPU UTIL % as 33.5%/70% instead of milli-units
```

(Prometheus source: `DCGM_FI_DEV_GPU_UTIL` from nvidia-dcgm-exporter — same family as **nvidia-smi** GPU util %.)

```bash
kubectl describe hpa -n nemoclaw-gpu | grep nemoclaw.ai/hpa-metric
```

(not `cpu: …/65%`). Metrics may show `<unknown>` for 1–2 minutes after install until Prometheus scrapes DCGM.

**Fallback modes** (not default): `autoscaling.mode=performance` (inflight HTTP), `latency` (LLM p95 ms), or `resource` (CPU %) via helm `--set`.

### Agent `/metrics` (LLM response time)

Each agent pod exposes Prometheus metrics at `GET /metrics`. LLM latency is measured **inside the chat/completions proxy** (time from outbound request to Ollama until the response body is received).

| Metric | Type | Use |
|--------|------|-----|
| `nemoclaw_llm_request_duration_seconds` | histogram | Full latency distribution (Prometheus/Grafana) |
| `nemoclaw_llm_latency_p95_milliseconds` | gauge | Rolling **p95** over recent requests (default window: 128); **HPA-friendly** |
| `nemoclaw_llm_latency_p50_milliseconds` | gauge | Rolling median latency |
| `nemoclaw_llm_latency_avg_milliseconds` | gauge | Rolling average latency |
| `nemoclaw_llm_requests_total{result=…}` | counter | Success/error counts |
| `nemoclaw_http_inflight_requests` | gauge | Concurrent requests (queue/backpressure) |

After port-forward, inspect locally:

```bash
kubectl port-forward -n nemoclaw-gpu svc/nemoclaw-gpu-agent 8081:8081
curl -s http://127.0.0.1:8081/metrics | grep nemoclaw_llm
```

**Latency-based HPA** (optional — needs ServiceMonitor + adapter rules from `install-hpa.sh`):

```bash
helm upgrade nemoclaw-gpu . -n nemoclaw-gpu \
  -f values-step2-hpa-latency.yaml \
  --set autoscaling.performance.latencyP95Milliseconds=2000
```

HPA scales up when average pod p95 exceeds the target (e.g. `2500/2000` ms). Tune window size with env `LLM_LATENCY_WINDOW_SIZE` on the agent container if needed.

---

## Load balancer

### AWS instance

See [Reference environment (4× L40S)](#reference-environment-4-l40s). This chart targets **one agent pod per L40S** on the node, not multi-node autoscaling groups (yet).

### What we use today (in-cluster only)

There is **no AWS Application/Network Load Balancer** in this chart. Traffic uses a **ClusterIP** Service:

| Resource | Type | Role |
|----------|------|------|
| `nemoclaw-gpu-agent` | **ClusterIP** | In-cluster VIP; kube-proxy spreads **new TCP connections** across Ready pods |
| `kubectl port-forward` | Local tunnel | Debug only (`8081` → Service); not production routing |
| Load-test Job | In-cluster HTTP client | Hits `http://nemoclaw-gpu-agent:8081` → Service → pods |

```text
In-cluster client (load-test Job, another pod)
    → Service nemoclaw-gpu-agent:8081 (ClusterIP)
    → kube-proxy (iptables / IPVS)
    → agent pod 1 … agent pod N  (one GPU each)

Your laptop
    → kubectl port-forward :8081  (debug path only)
```

**HPA** adds or removes pods; the Service **automatically** picks up new endpoints when pods become Ready. No separate LB configuration is required for that.

### Even distribution — limits of ClusterIP

Kubernetes Service balancing is **connection-level** (rough round-robin), not GPU-aware:

- Long **Ollama chat** requests can leave one pod hot while others are idle.
- HPA scales **replica count** from **GPU utilization**; it does not reshuffle an existing queue.
- For dev/demo and `./scripts/hpa-load-test.sh`, ClusterIP is enough to fan out load as replicas grow.

### Next step (not implemented yet): smarter ingress routing

Planned follow-up — **not in this chart today**:

- **NGINX Ingress Controller** (or similar) in front of the Service for HTTP routing, timeouts, and optional rate limits.
- **AWS Load Balancer Controller** / `type: LoadBalancer` for external clients (NLB/ALB) when running on EKS with a cloud controller.
- **Queue- or latency-aware** routing (e.g. least-connections, custom metrics) so inference spreads more evenly than default kube-proxy.

Until then, use **in-cluster Service DNS** for load tests and **port-forward** only for manual checks. Track ingress/LB work as a separate install step when you need external traffic or fairer GPU scheduling.

---

## Prerequisites

| Item | Notes |
|------|--------|
| **Reference GPUs** | **4× L40S** — see [Reference environment](#reference-environment-4-l40s) |
| MicroK8s or K8s 1.25+ | `microk8s status --wait-ready` |
| NVIDIA device plugin | `microk8s enable gpu` (DCGM for L40S util metrics) |
| metrics-server | `microk8s enable metrics-server` |
| `helm` 3, `kubectl` | |
| Allocatable GPUs | `kubectl describe node \| grep nvidia.com/gpu` — expect **4** on reference node |

---

## Readiness

| Probe | Path | Used for |
|-------|------|----------|
| Liveness | `/healthz` | Agent process up |
| Readiness | `/readyz` | Ollama model pulled and ready |
| Startup | `/readyz` | Long window for first `ollama pull` |

**`/readyz` may return 503 for several minutes** on first install while the model downloads.

---

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| `Insufficient nvidia.com/gpu` | Lower `MAX_REPLICAS`; check allocatable GPUs |
| Service not found | Use `nemoclaw-gpu-agent`, not `nemoclaw-gpu-nemoclaw-gpu-agent` |
| Port-forward fails | Check nothing else is bound to local port **8081** |
| `/readyz` 503 for minutes | Normal during model pull; `kubectl logs -c ollama` |
| HPA stays at 1 on 1-GPU node | Expected — need multiple GPUs for scale-up (reference node has **4× L40S**) |
| HPA TARGETS `<unknown>/70` | Metrics pipeline broken — re-run `MAX_REPLICAS=4 GPU_TARGET=70 ./scripts/install-hpa.sh` on **4× L40S** node; verify adapter points at Prometheus (not Grafana) and custom metric exists: `kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/nemoclaw-gpu/pods/*/gpu_utilization_percent"` |
| HPA `ScalingActive: False` | Same as above — HPA cannot scale until `gpu_utilization_percent` is readable |
| Rollout failed | `ROLLOUT_TIMEOUT=1200 ./scripts/install-hpa.sh` or `cluster-recover.sh` |

---

## Directory layout

```text
deploy/
├── README.md                 ← deploy index (links here)
├── README-gpu.md             ← this file (GPU how-to)
├── README-cpu.md             ← optional CPU how-to
└── helm/
    ├── README.md             ← model comparison only
    ├── nemoclaw-gpu/
    │   ├── values-step2-hpa.yaml
    │   ├── values-step2-hpa-performance.yaml
    │   ├── values-step2-hpa-latency.yaml
    │   └── scripts/
    │       ├── install-hpa.sh
    │       ├── hpa-reset.sh
    │       ├── cluster-recover.sh
    │       ├── hpa-load-test.sh
    │       ├── get-agent-pods.sh
    │       ├── get-hpa.sh
    │       └── hpa-watch.sh      # → kubectl get hpa -w
    └── nemoclaw-cpu/
```

---

## Uninstall

```bash
helm uninstall nemoclaw-gpu -n nemoclaw-gpu
kubectl delete namespace nemoclaw-gpu --ignore-not-found
```

---

## Further reading

- [helm/README.md](helm/README.md) — model comparison (CPU vs GPU)
- [README-cpu.md](README-cpu.md) — optional pre-GPU / Inference Hub deployment
- [Kubernetes HPA](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/)
