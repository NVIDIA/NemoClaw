# nemoclaw-cpu Helm chart

> **Overview (K8s + HPA):** see [../../README.md](../../README.md)

CPU-only **agent replicas** on Kubernetes. **Nemotron Ultra runs on [NVIDIA Inference Hub](https://inference-api.nvidia.com)** (`sk-*` key) — no GPU in the cluster, matching your current NemoClaw VM setup.

This chart is a **Kubernetes packaging layer** for scaling agent pods. Full OpenClaw + OpenShell sandbox per pod is a later step; today you get health, metrics, and replica/HPA control.

---

## One-command install (recommended)

**CPU HPA** via metrics-server (no Prometheus). One Nemoclaw pod per CPU; min **1**, max **7**.

```bash
cd deploy/helm/nemoclaw-cpu
source ~/.nemoclaw/secrets.env

./scripts/install-hpa.sh
kubectl get hpa -n nemoclaw && kubectl get pods -n nemoclaw
```

Rollout keeps failing: `./scripts/cluster-recover.sh`

Load test, then return to idle:

```bash
./scripts/hpa-load-test.sh
./scripts/hpa-reset.sh
```

**Optional** (Prometheus + inflight-metric HPA, heavier): `./scripts/install-performance-hpa.sh` — see [observability.md](observability.md).

**Script guide:** [../../README.md#scripts](../../README.md#scripts)

---

## Prerequisites

- Kubernetes 1.25+ (MicroK8s OK)
- `helm` 3, `kubectl`
- Inference Hub API key in `~/.nemoclaw/secrets.env` (`NVIDIA_INFERENCE_HUB_API_KEY`, `sk-*`)

The default install (`install-hpa.sh`) uses **metrics-server** only — no Prometheus. See [Step 2a](#2a--cpu-based-hpa-default--use-one-command-install).

Prior art: [Autoscaling NVIDIA Riva with Kubernetes (HPA + Grafana)](https://developer.nvidia.com/blog/autoscaling-nvidia-riva-deployment-with-kubernetes-for-speech-ai-in-production/) — same pattern (metrics → HPA → dashboards).

---

## One replica per CPU (default)

With `cpuScaling.oneReplicaPerCpu: true` (default):

| You want | Set | Result |
|----------|-----|--------|
| **4 CPUs** | `cpuScaling.count=4` | **4 pods**, each requests **1 CPU** |
| **1 CPU** | `cpuScaling.count=1` | **1 pod**, **1 CPU** |

Total requested CPUs ≈ **`cpuScaling.count`** (when `perPodRequest: "1"`).

## Step 1 — Install and manual scale

```bash
cd deploy/helm/nemoclaw-cpu

helm install nemoclaw . \
  --namespace nemoclaw \
  --create-namespace \
  --set inference.apiKey='sk-YOUR-INFERENCE-HUB-KEY' \
  --set cpuScaling.count=1

kubectl get pods -n nemoclaw -w
```

### Scale up / down (change number of CPUs)

**Helm (recommended — keeps 1 CPU per pod)**

```bash
# 4 CPUs → 4 replicas
helm upgrade nemoclaw . -n nemoclaw --set cpuScaling.count=4

# 2 CPUs → 2 replicas
helm upgrade nemoclaw . -n nemoclaw --set cpuScaling.count=2

# 1 CPU → 1 replica
helm upgrade nemoclaw . -n nemoclaw --set cpuScaling.count=1
```

**kubectl (same thing: replicas == CPUs)**

```bash
kubectl scale deployment -n nemoclaw -l app.kubernetes.io/name=nemoclaw-cpu --replicas=4
```

After `kubectl scale`, run `helm upgrade` with the same `cpuScaling.count` so Helm state stays in sync.

### Non-uniform CPU per pod (optional)

Set `cpuScaling.oneReplicaPerCpu: false` and use `replicaCount` + `resources` instead.

### Verify

```bash
kubectl port-forward -n nemoclaw svc/nemoclaw-cpu-agent 8080:8080
curl -s http://127.0.0.1:8080/healthz
curl -s http://127.0.0.1:8080/readyz    # checks Inference Hub /models
curl -s http://127.0.0.1:8080/metrics
```

---

## Step 2 — HPA autoscaling

Each **agent pod** runs one Nemoclaw CPU worker (`node agent-server.mjs`) with **1 CPU request/limit** when `cpuScaling.oneReplicaPerCpu` is true.

When HPA is on, Helm sets `spec.replicas` to `minReplicas` (≥ 1); the HPA controller scales between **min** and **max**.

| Overlay | Use case |
|---------|----------|
| `values-step2-hpa.yaml` | **Recommended** — CPU % (metrics-server; `install-hpa.sh`) |
| `values-step2-hpa-performance.yaml` | Prometheus metric `nemoclaw_http_inflight_requests` |
| `values-step2-hpa-saturate.yaml` | CPU HPA load tests on 8-vCPU nodes (400m request/pod) |

### 2a — CPU-based HPA (default — use one-command install)

```bash
./scripts/install-hpa.sh
```

Or manually:

```bash
microk8s enable metrics-server
helm upgrade --install nemoclaw . -n nemoclaw --create-namespace \
  -f values-step2-hpa.yaml \
  --set inference.apiKey="${NVIDIA_INFERENCE_HUB_API_KEY}"
```

### 2b — Performance HPA (optional)

```bash
./scripts/install-performance-hpa.sh
```

Or manually after Prometheus + adapter are installed:

```bash
helm upgrade nemoclaw . -n nemoclaw \
  -f values-step2-hpa-performance.yaml \
  --set inference.apiKey="${NVIDIA_INFERENCE_HUB_API_KEY}" \
  --set metrics.serviceMonitor.labels.release=kube-prometheus
```

### Reset before a new load test

```bash
source ~/.nemoclaw/secrets.env
./scripts/hpa-reset.sh
./scripts/hpa-load-test.sh
```

### HPA load test (Nemotron questions → scale up / down)

**Important:** HPA watches **CPU on these agent pods**, not your VM NemoClaw sandbox. The test sends many chat questions through `POST /v1/chat/completions` on each agent pod (same **Inference Hub** model as NemoClaw). Telegram / OpenShell on the VM does not affect this HPA.

Prerequisites: metrics-server enabled (`microk8s enable metrics-server`), HPA enabled (above).

```bash
cd deploy/helm/nemoclaw-cpu
source ~/.nemoclaw/secrets.env

# Default: one load-generator pod, 7×40 in-flight /bench, saturate overlay (8-vCPU node)
./scripts/hpa-load-test.sh

# Push toward HPA max 7 (may get Pending pods if node is full)
CONCURRENCY_PER_POD=50 BENCH_MS=500 HPA_TARGET_CPU=45 SCALE_UP_TARGET=7 \
  ./scripts/hpa-load-test.sh
```

**Watch in another terminal:**

```bash
kubectl get hpa -n nemoclaw -w
kubectl top pods -n nemoclaw
less /tmp/nemoclaw-hpa-watch.log
```

**What the script does**

1. Sets `loadTest.cpuSpinMs` and rolls agent pods (adds CPU per request for HPA).
2. Runs an in-cluster Job that asks Nemotron many questions from `files/questions-sample.txt`.
3. Waits for HPA scale-up (`SCALE_UP_TARGET`, default **6** on an 8-vCPU node; use **7** if the node has headroom).
4. Stops the Job and waits for scale-down (~2–8 min; see `autoscaling.behavior.scaleDown`).

**After the test**, reset spin:

```bash
helm upgrade nemoclaw . -n nemoclaw --reuse-values --set loadTest.cpuSpinMs=0
```

**Troubleshooting:** Do not `kubectl scale ... --replicas=0` while HPA is enabled (leaves the Deployment stuck). If pods vanish or HPA shows `0/0 desired`, run:

```bash
helm upgrade nemoclaw . -n nemoclaw -f values-step2-hpa.yaml --reuse-values \
  --set inference.apiKey="$NVIDIA_INFERENCE_HUB_API_KEY"
kubectl delete hpa nemoclaw-nemoclaw-cpu-agent -n nemoclaw --ignore-not-found
helm upgrade nemoclaw . -n nemoclaw -f values-step2-hpa.yaml --reuse-values ...
```

**Performance metrics exposed by each pod**

| Metric | Meaning |
|--------|---------|
| `nemoclaw_http_inflight_requests` | Backpressure / load |
| `nemoclaw_http_requests_total` | Total requests |
| `nemoclaw_inference_hub_reachable` | 1 if Inference Hub OK |

Tune HPA thresholds in Grafana (same workflow as the [Riva autoscaling blog](https://developer.nvidia.com/blog/autoscaling-nvidia-riva-deployment-with-kubernetes-for-speech-ai-in-production/)).

**Example prometheus-adapter rule** (add to adapter config):

```yaml
rules:
  custom:
    - seriesQuery: 'nemoclaw_http_inflight_requests{namespace!="",pod!=""}'
      resources:
        overrides:
          namespace: { resource: "namespace" }
          pod: { resource: "pod" }
      name:
        matches: "^(.*)$"
        as: "nemoclaw_http_inflight_requests"
      metricsQuery: 'avg(<<.Series>>{<<.LabelMatchers>>}) by (<<.GroupBy>>)'
```

---

## Configuration

| Value | Description |
|-------|-------------|
| `replicaCount` | Step 1 manual replicas |
| `resources.*` | CPU/memory per pod |
| `inference.baseUrl` | `https://inference-api.nvidia.com/v1` |
| `inference.model` | Nemotron Ultra model id |
| `inference.apiKey` | `sk-*` (or `inference.existingSecret`) |
| `autoscaling.enabled` | Step 2 HPA |
| `autoscaling.mode` | `resource` or `performance` |

---

## Architecture

```text
                    ┌─────────────────────────────────────┐
  kubectl scale /   │  nemoclaw-cpu-agent pods (CPU)     │
  HPA               │  /healthz  /metrics                 │
                    └──────────────┬──────────────────────┘
                                   │ HTTPS (sk-*)
                                   ▼
                    ┌─────────────────────────────────────┐
                    │  NVIDIA Inference Hub (Nemotron Ultra) │
                    │  (GPUs in NVIDIA cloud, not your cluster) │
                    └─────────────────────────────────────┘
```

---

## Uninstall

```bash
helm uninstall nemoclaw -n nemoclaw
kubectl delete namespace nemoclaw   # if created by chart
```
