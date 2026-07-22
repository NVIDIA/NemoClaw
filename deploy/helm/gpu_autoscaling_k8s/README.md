<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw Kubernetes GPU autoscaling

This Helm chart runs an OpenAI-compatible Node.js proxy beside local Ollama inference for NemoClaw workloads. A Kubernetes Horizontal Pod Autoscaler (HPA) scales the pods, and each replica requests one NVIDIA GPU.

The HPA reads the per-pod `gpu_utilization_percent` custom metric. The metric pipeline is:

```text
NVIDIA GPU
  → DCGM Exporter: DCGM_FI_DEV_GPU_UTIL
  → Prometheus
  → Prometheus Adapter: gpu_utilization_percent
  → custom.metrics.k8s.io
  → Horizontal Pod Autoscaler
```

The default deployment uses:

| Setting | Default |
|---------|---------|
| Namespace | `nemoclaw-gpu` |
| Release | `nemoclaw-gpu` |
| Service port | `8081` |
| Ollama model | `llama3.2:3b` |
| GPUs per pod | `1` |
| Minimum replicas | `1` |
| Maximum replicas | `4` |
| GPU utilization target | `40%` |

The chart and load test were validated on a single-node MicroK8s cluster with four NVIDIA L40S GPUs. Set the maximum replica count to the number of allocatable GPUs in your cluster.

## Architecture

```text
┌───────────────────────────────────────────────────────────┐
│ Kubernetes GPU node                                       │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Agent pod                                           │  │
│  │                                                     │  │
│  │  ┌──────────────────┐    ┌───────────────────────┐ │  │
│  │  │ Ollama           │◄───│ Node.js API proxy    │ │  │
│  │  │ GPU inference    │    │ :8081                │ │  │
│  │  │ :11434           │    │ health/API/metrics   │ │  │
│  │  └──────────────────┘    └───────────────────────┘ │  │
│  │                1 × nvidia.com/gpu                  │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  HPA scales agent pods between 1 and 4 replicas           │
└───────────────────────────────────────────────────────────┘
```

Ollama port `11434` is available only inside each pod. Clients use the agent Service on port `8081`.

## Prerequisites

- Kubernetes 1.25 or newer
- One or more allocatable `nvidia.com/gpu` resources
- GPU nodes labeled `nvidia.com/gpu.present=true`
- NVIDIA GPU Operator with DCGM Exporter running
- Metrics Server
- Helm 3
- `kubectl` configured for the cluster

Check the cluster before installation:

```bash
kubectl get nodes
kubectl get nodes \
  -o jsonpath='{range .items[*]}{.metadata.name}{" GPUs="}{.status.allocatable.nvidia\.com/gpu}{"\n"}{end}'
kubectl get nodes -l nvidia.com/gpu.present=true
kubectl get pods -n gpu-operator-resources \
  -l app=nvidia-dcgm-exporter
```

For MicroK8s, the installer enables the GPU and Metrics Server add-ons when needed. On other Kubernetes distributions, install those components before running the installer.

## Install

From the NemoClaw repository:

```bash
cd deploy/helm/gpu_autoscaling_k8s
./scripts/install-hpa.sh
```

The installer:

1. Verifies that the cluster has an allocatable GPU.
2. Waits for Metrics Server to become ready.
3. Installs Prometheus when it is missing.
4. Installs Prometheus Adapter and the GPU metric rule.
5. Deploys one Ollama-backed API proxy pod.
6. Creates the GPU utilization HPA.
7. Waits for the agent rollout and prints HPA status.

Set the maximum replica count to the number of available GPUs:

```bash
MAX_REPLICAS=4 ./scripts/install-hpa.sh
```

The first startup downloads the Ollama model and can take several minutes. Increase the rollout timeout when needed:

```bash
ROLLOUT_TIMEOUT=1200 \
INFERENCE_MODEL=llama3.2:3b \
MAX_REPLICAS=4 \
./scripts/install-hpa.sh
```

## Verify the deployment

Check the workload and HPA:

```bash
kubectl get pods,service,hpa -n nemoclaw-gpu
```

The idle state should have:

- One `Running` agent pod
- Two ready containers in the pod
- One HPA replica
- HPA bounds matching the configured GPU count
- A `current/40` GPU utilization target

Confirm that the custom metric API returns a value for each agent pod:

```bash
kubectl get --raw \
  '/apis/custom.metrics.k8s.io/v1beta1/namespaces/nemoclaw-gpu/pods/*/gpu_utilization_percent'
```

Inspect readable HPA and per-pod GPU utilization:

```bash
./scripts/get-hpa.sh -n nemoclaw-gpu
./scripts/get-agent-pods.sh -n nemoclaw-gpu
```

Metrics can remain unknown for one or two minutes while Prometheus discovers DCGM Exporter and Prometheus Adapter publishes the custom metric.

## Call the inference service

Forward the agent Service to the local machine:

```bash
kubectl port-forward \
  -n nemoclaw-gpu \
  service/nemoclaw-gpu-agent \
  8081:8081
```

In another terminal:

```bash
curl -s http://127.0.0.1:8081/healthz
curl -s http://127.0.0.1:8081/readyz
curl -s http://127.0.0.1:8081/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "messages": [{"role": "user", "content": "Say hello."}],
    "max_tokens": 16,
    "stream": false
  }'
```

`/readyz` can return `503` during the initial model download.

## Watch GPU autoscaling

Watch the HPA:

```bash
kubectl get hpa -n nemoclaw-gpu -w
```

In another terminal, watch every agent pod and its GPU utilization:

```bash
./scripts/get-agent-pods.sh -n nemoclaw-gpu -w
```

The HPA adds replicas when average GPU utilization remains above the configured target. It removes replicas after load stops and the scale-down stabilization window expires.

## Test scale-up and scale-down

The load test sends chat-completion requests across running GPU pods, verifies the HPA replica count increases, removes the load, and verifies the HPA returns to one replica.

Use at least two allocatable GPUs and set `TARGET_PODS` and `SCALE_UP_TARGET` to at least `2`. A one-GPU run cannot validate scale-up. HPA replica-count success confirms autoscaler behavior, but it does not by itself prove that every new replica completed inference successfully.

Run the full test:

```bash
./scripts/hpa-load-test.sh
```

By default, `TARGET_PODS` is the number of allocatable GPUs. The test temporarily sets the HPA maximum to that value.

Run a shorter two-GPU validation:

```bash
TARGET_PODS=2 \
SCALE_UP_TARGET=2 \
DURATION_SEC=180 \
SCALE_UP_WAIT_LOOPS=36 \
SCALE_DOWN_WAIT_LOOPS=28 \
MAX_TOKENS=64 \
./scripts/hpa-load-test.sh
```

A successful run reports:

```text
Scale-up OK: 2/2 replicas
Load test complete: scaled to 2/2 GPU replicas and back to 1
```

The script exits with a nonzero status if it does not reach the scale-up target or does not return to one replica.

Restore the normal one-to-four bounds after every load test, including successful runs:

```bash
./scripts/hpa-reset.sh
```

## Load-test settings

| Variable | Default | Purpose |
|----------|---------|---------|
| `TARGET_PODS` | Allocatable GPUs | Temporary HPA maximum and test target |
| `SCALE_UP_TARGET` | `TARGET_PODS` | Replica count required for scale-up success |
| `HPA_TARGET_GPU` | `40` | GPU utilization target during the test |
| `DURATION_SEC` | `720` | Load duration |
| `MAX_TOKENS` | `128` | Maximum generated tokens per request |
| `INFLIGHT_PER_GPU` | `64` | Base concurrent load per GPU |
| `LOAD_MULTIPLIER` | `2` | Load multiplier |
| `MAX_INFLIGHT_PER_POD` | `512` | Per-pod concurrency cap |
| `WARMUP_SEC` | `90` | Warm-up period |
| `SCALE_UP_WAIT_LOOPS` | `60` | Scale-up polling limit |
| `SCALE_DOWN_WAIT_LOOPS` | `40` | Scale-down polling limit |

Override a setting by placing it before the command:

```bash
TARGET_PODS=4 MAX_TOKENS=256 DURATION_SEC=600 \
  ./scripts/hpa-load-test.sh
```

## Scripts

All commands below are run from `deploy/helm/gpu_autoscaling_k8s`.

| Script | Purpose |
|--------|---------|
| `scripts/install-hpa.sh` | Install or refresh the monitoring pipeline, chart, and GPU HPA |
| `scripts/hpa-load-test.sh` | Verify GPU-driven scale-up and scale-down |
| `scripts/hpa-reset.sh` | Remove test resources and restore the idle HPA configuration |
| `scripts/cluster-recover.sh` | Recover from repeated rollout or namespace failures |
| `scripts/get-agent-pods.sh` | Show agent pods with per-pod GPU utilization |
| `scripts/get-hpa.sh` | Show readable HPA GPU utilization |
| `scripts/hpa-watch.sh` | Watch HPA changes |
| `scripts/hpa-common.sh` | Shared script helpers |

Typical workflow:

```text
Install:             ./scripts/install-hpa.sh
Watch HPA:           ./scripts/hpa-watch.sh
Watch GPU pods:      ./scripts/get-agent-pods.sh -w
Test autoscaling:    ./scripts/hpa-load-test.sh
Restore idle state:  ./scripts/hpa-reset.sh
Recover cluster:     ./scripts/cluster-recover.sh
```

## Configuration files

| File | Purpose |
|------|---------|
| `values.yaml` | Base GPU workload and resource settings |
| `values-step2-hpa.yaml` | GPU utilization HPA settings |
| `values-load-test-hpa.yaml` | Faster scale-up policy used by the load test |
| `monitoring/dcgm-servicemonitor.yaml` | Prometheus discovery for DCGM Exporter |
| `monitoring/kube-prometheus-microk8s.yaml` | Prometheus settings for MicroK8s |
| `monitoring/prometheus-adapter-gpu-values.yaml` | Custom GPU metric mapping |
| `templates/hpa.yaml` | HPA resource |
| `templates/deployment.yaml` | Ollama and agent pod |
| `templates/service.yaml` | Agent ClusterIP Service |
| `templates/ingress.yaml` | Optional ingress-nginx route |

Change the GPU HPA policy in `values-step2-hpa.yaml`:

```yaml
autoscaling:
  enabled: true
  minReplicas: 1
  maxReplicas: 4
  mode: gpu
  targetGPUUtilizationPercentage: 40
```

The maximum replica count should not exceed the total allocatable GPU count when every pod requests one GPU.

## GPU metric details

| Layer | Value |
|-------|-------|
| DCGM metric | `DCGM_FI_DEV_GPU_UTIL` |
| HPA metric | `gpu_utilization_percent` |
| Kubernetes API | `custom.metrics.k8s.io/v1beta1` |
| HPA target type | `AverageValue` |
| Default target | `40` |
| Scope | One value per agent pod |

Inspect the HPA conditions and recent events:

```bash
kubectl describe hpa nemoclaw-gpu-agent -n nemoclaw-gpu
```

`ScalingActive=True` and `ValidMetricFound` confirm that the HPA can calculate a desired replica count from GPU utilization.

## Grafana workload allocation

Grafana can compare request traffic and GPU utilization across the HPA replicas.

Enable scraping of the agent `/metrics` endpoint while preserving the installed release settings:

```bash
helm upgrade nemoclaw-gpu . \
  --namespace nemoclaw-gpu \
  --reset-then-reuse-values \
  --set metrics.serviceMonitor.enabled=true
```

Forward the Grafana Service:

```bash
kubectl port-forward \
  -n monitoring \
  service/kube-prometheus-grafana \
  3000:80
```

Open `http://127.0.0.1:3000`. Get the login credentials when needed:

```bash
kubectl get secret kube-prometheus-grafana -n monitoring \
  -o jsonpath='{.data.admin-user}' | base64 -d; echo

kubectl get secret kube-prometheus-grafana -n monitoring \
  -o jsonpath='{.data.admin-password}' | base64 -d; echo
```

In Grafana:

1. Select **Explore** in the left navigation.
2. Select the **Prometheus** data source.
3. Select **Code** at the upper-right of query row `A`.
4. Paste a PromQL query from below.
5. Select the blue **Run queries** button at the upper-right.
6. Use a time range such as **Last 15 minutes**.

PromQL is entered in Grafana Explore, not in a shell.

### GPU utilization by pod

```promql
avg by (exported_pod) (
  DCGM_FI_DEV_GPU_UTIL{
    exported_namespace="nemoclaw-gpu",
    exported_pod=~"nemoclaw-gpu-agent-.*"
  }
)
```

### Successful inference requests by pod

```promql
sum by (pod) (
  rate(nemoclaw_llm_requests_total{
    namespace="nemoclaw-gpu",
    result="success"
  }[5m])
)
```

### Inference errors by pod

```promql
sum by (pod) (
  rate(nemoclaw_llm_requests_total{
    namespace="nemoclaw-gpu",
    result="error"
  }[5m])
)
```

### Rolling p95 inference latency by pod

```promql
avg by (pod) (
  nemoclaw_llm_latency_p95_milliseconds{
    namespace="nemoclaw-gpu"
  }
)
```

### Requested GPUs by pod

```promql
sum by (pod) (
  kube_pod_container_resource_requests{
    namespace="nemoclaw-gpu",
    resource="nvidia_com_gpu"
  }
)
```

Add the request-rate and GPU-utilization queries to the same Explore view to see whether traffic and GPU work are distributed across replicas. When the HPA scales up, a new pod should appear after it becomes ready. A `rate(...)` result requires at least two Prometheus scrapes.

If a query returns no data:

1. Wait for at least two Prometheus scrape intervals.
2. Generate inference traffic.
3. Confirm the Grafana time range includes the traffic.
4. Confirm the ServiceMonitor exists:

   ```bash
   kubectl get servicemonitor nemoclaw-gpu-agent -n nemoclaw-gpu
   ```

5. Try the raw metric name first:

   ```promql
   nemoclaw_llm_requests_total
   ```

## Traffic distribution

The chart always creates a `ClusterIP` Service:

```text
In-cluster client
  → nemoclaw-gpu-agent:8081
  → ready agent pod
  → local Ollama container
  → assigned NVIDIA GPU
```

The Service automatically adds new endpoints when HPA-created pods become ready. Kubernetes balances new connections; it does not route based on GPU utilization.

### Optional NGINX ingress

The optional Ingress adds Layer-7 HTTP routing in front of the Service. ingress-nginx watches Kubernetes endpoints and adds newly ready HPA replicas to its upstream pool.

```text
HTTP client
  → ingress-nginx
  → nemoclaw-gpu-agent:8081
  → ready GPU pod
  → local Ollama container
```

This follows the endpoint-discovery and Layer-7 load-balancing approach described in [Deploying NVIDIA Triton at Scale with MIG and Kubernetes](https://developer.nvidia.com/blog/deploying-nvidia-triton-at-scale-with-mig-and-kubernetes/). The older example used a dedicated NGINX Plus deployment and a headless Service. This chart uses a standard Kubernetes Ingress and keeps the application Service as `ClusterIP`.

The application chart does not install a cluster-wide ingress controller. Verify that ingress-nginx and its `nginx` IngressClass exist:

```bash
kubectl get pods -n ingress-nginx
kubectl get ingressclass nginx
```

If your cluster does not already have ingress-nginx:

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update ingress-nginx
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace
```

Enable the Ingress after installing the GPU HPA:

```bash
helm upgrade nemoclaw-gpu . \
  --namespace nemoclaw-gpu \
  --reset-then-reuse-values \
  --set ingress.enabled=true \
  --set ingress.host=nemoclaw.local
```

`--reset-then-reuse-values` adds the new Ingress defaults while retaining the installed GPU replica cap, model, and other release overrides.

The default NGINX annotations allow long inference requests and streaming responses:

```yaml
ingress:
  enabled: true
  className: nginx
  host: nemoclaw.local
  path: /
  annotations:
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "60"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "600"
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
    nginx.ingress.kubernetes.io/proxy-request-buffering: "off"
```

Verify the route without requiring an external load balancer:

```bash
kubectl port-forward \
  -n ingress-nginx \
  service/ingress-nginx-controller \
  8080:80
```

In another terminal:

```bash
curl -s -H 'Host: nemoclaw.local' \
  http://127.0.0.1:8080/healthz
```

Rate limiting is disabled by default because it can suppress the load that drives autoscaling. Enable it only when the limit is intentionally part of the deployment policy:

```yaml
ingress:
  annotations:
    nginx.ingress.kubernetes.io/limit-rps: "20"
    nginx.ingress.kubernetes.io/limit-burst-multiplier: "5"
```

The Ingress does not add authentication or TLS automatically. Do not expose the endpoint publicly until you configure both.

NGINX selects a ready backend for each request. It cannot move an inference request that is already running when the HPA adds a new pod, so long-lived requests may still produce temporary utilization differences between GPUs.

## Troubleshooting

### No allocatable GPU

```bash
kubectl describe nodes
kubectl get pods -n gpu-operator-resources
```

Verify that the NVIDIA device plugin is running and that node capacity includes `nvidia.com/gpu`.

### HPA target is unknown

Check each stage of the metric pipeline:

```bash
kubectl get pods -n gpu-operator-resources \
  -l app=nvidia-dcgm-exporter
kubectl get pods -n monitoring
kubectl get apiservice v1beta1.custom.metrics.k8s.io
kubectl get --raw \
  '/apis/custom.metrics.k8s.io/v1beta1/namespaces/nemoclaw-gpu/pods/*/gpu_utilization_percent'
```

Re-run the installer after all components are ready:

```bash
./scripts/install-hpa.sh
```

### Agent pod is not ready

The first model pull can take several minutes:

```bash
kubectl get pods -n nemoclaw-gpu
kubectl logs -n nemoclaw-gpu \
  deployment/nemoclaw-gpu-agent \
  -c ollama
```

Retry with a longer timeout:

```bash
ROLLOUT_TIMEOUT=1200 ./scripts/install-hpa.sh
```

### HPA does not scale up

Verify that:

1. More than one GPU is allocatable.
2. `maxReplicas` is greater than one.
3. The custom metric returns a value.
4. GPU utilization exceeds the target.
5. New pods can request another GPU.

```bash
kubectl describe hpa nemoclaw-gpu-agent -n nemoclaw-gpu
kubectl get events -n nemoclaw-gpu --sort-by=.lastTimestamp
```

### HPA does not scale down

The default scale-down stabilization window is 180 seconds. Wait for the window to expire after load stops:

```bash
kubectl get hpa -n nemoclaw-gpu -w
```

Use the reset script if a load test was interrupted:

```bash
./scripts/hpa-reset.sh
```

### Repeated rollout failures

```bash
./scripts/cluster-recover.sh
```

Review the script before running it because recovery removes and recreates workload resources.

## Directory layout

```text
deploy/helm/gpu_autoscaling_k8s/
├── Chart.yaml
├── README.md
├── values.yaml
├── values-step2-hpa.yaml
├── values-load-test-hpa.yaml
├── files/
├── monitoring/
├── scripts/
└── templates/
```

## Uninstall

Remove the NemoClaw release and namespace:

```bash
helm uninstall nemoclaw-gpu -n nemoclaw-gpu
kubectl delete namespace nemoclaw-gpu --ignore-not-found
```

The Prometheus and Prometheus Adapter releases are shared monitoring components and are not removed by these commands.
