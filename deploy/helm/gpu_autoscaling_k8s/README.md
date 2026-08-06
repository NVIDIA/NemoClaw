<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw Kubernetes GPU autoscaling

This Helm chart uses Kubernetes to autoscale NemoClaw and NGINX to balance workloads.
A Kubernetes Horizontal Pod Autoscaler (HPA) scales the pods, and each replica requests one NVIDIA GPU.

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
| Ingress class | `nginx` |
| Ingress host | `nemoclaw.local` |

The chart and load test were validated on a single-node MicroK8s cluster with four NVIDIA L40S GPUs. Set the maximum replica count to the number of allocatable GPUs in your cluster.

<img width="1334" height="920" alt="Screenshot 2026-06-09 at 7 01 28 PM" src="https://github.com/user-attachments/assets/a8380890-4074-43a6-968c-916b523199d2" />

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

For MicroK8s, the installer enables the GPU and Metrics Server add-ons when needed. On other Kubernetes distributions, install those components before running the installer. The installer also installs the ingress-nginx controller when the cluster does not already have an `nginx` IngressClass.

## Install

From the NemoClaw repository, enter the chart directory:

```bash
cd deploy/helm/gpu_autoscaling_k8s
```

Before installing (or after editing the chart), check that the HPA/Deployment/Service/
ServiceMonitor name-and-label contract and the script security contract still hold.
These checks do not require a cluster:

```bash
./scripts/test-render-contract.sh
./scripts/test-script-security-contract.sh
```

The scripts require TLS by default.
Before installation, create the target namespace and its certificate Secret:

```bash
kubectl create namespace nemoclaw-gpu --dry-run=client -o yaml \
  | kubectl apply -f -
kubectl create secret tls nemoclaw-example-tls \
  --namespace nemoclaw-gpu \
  --cert=/path/to/tls.crt \
  --key=/path/to/tls.key \
  --dry-run=client -o yaml \
  | kubectl apply -f -
```

Kubernetes stores the certificate and private key in the `nemoclaw-example-tls` Secret.
The chart does not create, rotate, or delete this Secret.

Copy the GPU HPA values file and add an `ingress` block that references the Secret:

```bash
cp values-step2-hpa.yaml /path/to/hpa-tls-values.yaml
```

Add this configuration to `/path/to/hpa-tls-values.yaml`:

```yaml
ingress:
  host: nemoclaw.example.com
  tls:
    - secretName: nemoclaw-example-tls
      hosts:
        - nemoclaw.example.com
```

Export the values file and hostname in the shell that runs the installation and later operational scripts:

```bash
export HPA_VALUES=/path/to/hpa-tls-values.yaml
export INGRESS_HOST=nemoclaw.example.com
```

The installer creates the ingress-nginx controller Service as `ClusterIP` by default.
Use port forwarding to reach it from outside the cluster.
Set `INGRESS_SERVICE_TYPE=NodePort` or `LoadBalancer` only when the cluster network must expose the controller.
Those types can make the Ingress reachable outside the cluster.
Verify the assigned addresses and network access controls before you send credentials or completion traffic:

```bash
kubectl get service ingress-nginx-controller -n ingress-nginx -o wide
```

Install the chart:

```bash
./scripts/install-hpa.sh
```

The installer:

1. Verifies that the cluster has an allocatable GPU.
2. Waits for Metrics Server to become ready.
3. Installs Prometheus when it is missing.
4. Installs Prometheus Adapter and the GPU metric rule.
5. Installs the ingress-nginx controller when the `nginx` IngressClass is missing.
6. Deploys one Ollama-backed API proxy pod and the NGINX Ingress in front of it.
7. Creates the GPU utilization HPA.
8. Waits for the agent rollout and prints HPA status.

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

`hpa-reset.sh` does not persist the release's current Ingress host — it re-applies whatever
`INGRESS_HOST` is set in its own environment (default: unset, which falls back to
`values.yaml`'s `nemoclaw.local`). If you set a custom host, pass the same `INGRESS_HOST`
and `HPA_VALUES` to later script invocations.

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

`hpa-load-test.sh` generates a synthetic chat-completion workload to verify that the HPA actually autoscales the pod count, rather than relying on organic traffic. The load test sends chat-completion requests across running GPU pods, verifies the HPA replica count increases, removes the load, and verifies the HPA returns to one replica.

Run the test with `TARGET_PODS` and `SCALE_UP_TARGET` set to your full allocatable GPU count (4 on the reference node). A one-GPU run cannot validate scale-up, and validating at a lower replica count (for example, 2) does not confirm the HPA and load generator can also reach the full count. HPA replica-count success confirms autoscaler behavior, but it does not by itself prove that every new replica completed inference successfully.

Run the full test:

```bash
HPA_VALUES=/path/to/hpa-tls-values.yaml \
INGRESS_HOST=nemoclaw.example.com \
./scripts/hpa-load-test.sh
```

By default, `TARGET_PODS` is the number of allocatable GPUs, so the test already targets your full GPU count without overrides.

A successful run reports:

```text
Scale-up OK: 4/4 replicas
Load test complete: scaled to 4/4 GPU replicas and back to 1
```

<img width="1888" height="826" alt="Screenshot 2026-06-09 at 7 02 00 PM" src="https://github.com/user-attachments/assets/4aa98eb1-58bd-4256-8539-df6f617d3016" />

<img width="1450" height="336" alt="Screenshot 2026-06-09 at 7 39 36 PM" src="https://github.com/user-attachments/assets/a3ed1f62-256b-4b97-9c11-e01a74e5912b" />

The script exits with a nonzero status if it does not reach the scale-up target or does not return to one replica.

Restore the normal one-to-four bounds after every load test, including successful runs:

```bash
HPA_VALUES=/path/to/hpa-tls-values.yaml \
INGRESS_HOST=nemoclaw.example.com \
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
HPA_VALUES=/path/to/hpa-tls-values.yaml \
INGRESS_HOST=nemoclaw.example.com \
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
| `scripts/test-render-contract.sh` | Static `helm template` check: HPA/Deployment/Service/ServiceMonitor names and labels agree |
| `scripts/test-script-security-contract.sh` | Static recovery-selector and cleartext-ingress security regression check |

Export the TLS configuration before you run operational scripts:

```bash
export HPA_VALUES=/path/to/hpa-tls-values.yaml
export INGRESS_HOST=nemoclaw.example.com
```

Run these commands as separate activities:

```text
Install:             ./scripts/install-hpa.sh
Watch HPA:           ./scripts/hpa-watch.sh
Watch GPU pods:      ./scripts/get-agent-pods.sh -w
Test autoscaling:    ./scripts/hpa-load-test.sh
Restore idle state:  ./scripts/hpa-reset.sh
```

Run `./scripts/cluster-recover.sh` only when the selected release needs the destructive recovery described in the next section.

## Recover the Chart Workload

`cluster-recover.sh` deletes and recreates the selected release's workload resources during recovery.
It restricts pod cleanup to the selected Helm release and the named load-test Job.
It preserves Helm resources that have the `helm.sh/resource-policy: keep` annotation, including the generated Basic auth Secret.

The default load-test Job is `nemoclaw-gpu-hpa-load-test`.
Set `JOB_NAME` when the load test used a different name:

```bash
NAMESPACE=nemoclaw-gpu \
RELEASE=nemoclaw-gpu \
JOB_NAME=nemoclaw-gpu-hpa-load-test \
HPA_VALUES=/path/to/hpa-tls-values.yaml \
INGRESS_HOST=nemoclaw.example.com \
./scripts/cluster-recover.sh
```

The script performs these destructive operations in `NAMESPACE`:

- Deletes the Deployment, Service, Horizontal Pod Autoscaler, ReplicaSets, and pods that have the selected release's chart ownership labels.
- Deletes only the Job named by `JOB_NAME` and pods with `job-name=${JOB_NAME}`.
- Clears finalizers only from pods in those two groups before force deletion.
- Uninstalls only the Helm release named by `RELEASE`.

The script does not delete other Jobs or pods that have a different `job-name` value.

The script does not restart MicroK8s by default.
Set `RESTART_MICROK8S=1` only when the cluster runtime must restart.
That setting stops every workload in the MicroK8s cluster before recovery continues:

```bash
RESTART_MICROK8S=1 ./scripts/cluster-recover.sh
```

After an opt-in restart, verify all namespaces before you treat the cluster as restored:

```bash
kubectl get pods --all-namespaces
```

After recovery, verify that unrelated resources remain and the selected release is available:

```bash
kubectl get jobs,pods -n nemoclaw-gpu --show-labels
./scripts/get-agent-pods.sh -n nemoclaw-gpu
./scripts/get-hpa.sh -n nemoclaw-gpu
```

The recovery boundary is correct when nonmatching Jobs and pods remain and the selected release reports its agent pods and HPA.

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
| `templates/ingress.yaml` | NGINX ingress route (always created) |

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

Scale-up adds one pod per reconcile (`scaleUp.policies: [{type: Pods, value: 1}]`) instead of jumping straight to the replica count the raw GPU-utilization ratio (`ceil(currentReplicas * current/target)`) would otherwise allow in a single step. Increase `value` in `scaleUp.policies` to allow larger jumps.

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

## Traffic distribution

NGINX is the load balancer for this chart — every install creates an Ingress in front of the agent Service, and `install-hpa.sh` installs the ingress-nginx controller automatically when the cluster does not already have one. There is no toggle to disable it.

```text
HTTPS client
  → ingress-nginx
  → Service nemoclaw-gpu-agent:8081 (ClusterIP)
  → ready agent pod
  → local Ollama container
  → assigned NVIDIA GPU
```

ingress-nginx watches Kubernetes endpoints and adds newly ready HPA replicas to its upstream pool. This chart uses a standard Kubernetes Ingress and keeps the application Service as `ClusterIP`.

### NGINX ingress

Verify that ingress-nginx and its `nginx` IngressClass are running after `install-hpa.sh` completes:

```bash
kubectl get pods -n ingress-nginx
kubectl get ingressclass nginx
kubectl get ingress -n nemoclaw-gpu
```

Set a custom hostname at install time, or rerun on an existing release:

```bash
HPA_VALUES=/path/to/hpa-tls-values.yaml \
INGRESS_HOST=nemoclaw.example.com \
./scripts/install-hpa.sh
```

The default NGINX annotations allow long inference requests and streaming responses:

```yaml
ingress:
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
  8443:443
```

In another terminal, retrieve the auto-generated Basic auth password.
Send an HTTPS request with the configured hostname and the certificate authority file that verifies your certificate:

```bash
PASSWORD=$(kubectl get secret nemoclaw-gpu-agent-ingress-auth -n nemoclaw-gpu \
  -o jsonpath='{.data.password}' | base64 -d)
curl --fail --show-error --silent \
  --cacert /path/to/ca.crt \
  --resolve 'nemoclaw.example.com:8443:127.0.0.1' \
  -u "admin:${PASSWORD}" \
  https://nemoclaw.example.com:8443/healthz
```

Rate limiting is disabled by default because it can suppress the load that drives autoscaling. Enable it only when the limit is intentionally part of the deployment policy:

```yaml
ingress:
  annotations:
    nginx.ingress.kubernetes.io/limit-rps: "20"
    nginx.ingress.kubernetes.io/limit-burst-multiplier: "5"
```

### Ingress security

The completion proxy (`agent-server.ts`) has no authentication of its own, so the chart
enforces two things at the Ingress level:

- **Basic auth is on by default** (`ingress.auth.enabled: true`). The chart auto-generates a
  random password on first install and reads it back from the existing Secret (via Helm's
  `lookup`) on every later `helm upgrade`, so it doesn't rotate every time
  `install-hpa.sh`/`hpa-load-test.sh`/`hpa-reset.sh` re-runs. Retrieve it with:

  ```bash
  kubectl get secret nemoclaw-gpu-agent-ingress-auth -n nemoclaw-gpu \
    -o jsonpath='{.data.password}' | base64 -d
  ```

  Set `ingress.auth.password` yourself, or `ingress.auth.existingSecret` to point at your
  own `kubernetes.io/basic-auth`-style secret (must contain an `auth` key in htpasswd
  format), to use a specific credential instead.

  The generated credential is in the `nemoclaw-gpu-agent-ingress-auth` Secret in the
  `nemoclaw-gpu` namespace. A Kubernetes subject that can read Secrets in that namespace
  can retrieve it. The Secret has the Helm `keep` policy, so `helm uninstall` and
  `cluster-recover.sh` preserve it for a later reinstall. Delete it explicitly to remove
  the credential or force the next install to generate a new value:

  ```bash
  kubectl delete secret nemoclaw-gpu-agent-ingress-auth -n nemoclaw-gpu
  ```

  Deleting the namespace also deletes the generated credential. The TLS Secret is
  operator-owned and remains until the operator deletes the Secret or its namespace.

- **TLS is required by default.** The chart refuses to render the Ingress unless
  `ingress.tls` references a certificate Secret or you explicitly opt in to cleartext HTTP.
  The scripts do not set `ingress.allowInsecureHttp` during the normal workflow.

Cleartext HTTP exposes the reusable Basic auth credential and completion traffic to interception on any network path that can observe the request.
Use the cleartext exception only after a firewall, VPN, or equivalent access control restricts the cluster nodes to trusted clients:

```bash
ALLOW_INSECURE_HTTP=1 ./scripts/install-hpa.sh
```

`ALLOW_INSECURE_HTTP=1` acknowledges that Kubernetes cannot verify the surrounding network boundary.
Each script invocation also runs a Kubernetes exposure preflight before it sets `ingress.allowInsecureHttp=true`.
The preflight requires all of these conditions:

- At least one cluster node has an `InternalIP` address.
- Every node `InternalIP` address is private, loopback, or link-local.
- No cluster node has an `ExternalIP` address.
- At least one managed ingress-nginx controller Service exists.
- Every matching controller Service uses `ClusterIP`, has no `externalIPs`, and has no entry in `.status.loadBalancer.ingress`.
- Managed ingress-nginx controller pods do not use `hostNetwork` or `hostPort`.

These checks reject Kubernetes-reported exposure paths.
They do not prove that other hosts on a private network cannot reach the cluster.
If the preflight cannot verify every condition, the script exits before enabling cleartext and instructs you to configure TLS.
Set `ALLOW_INSECURE_HTTP=1` separately for each install, reset, recovery, or load-test command that must preserve cleartext operation.

Do not expose the endpoint on a public network until you've confirmed both of the above are
configured the way you intend.

NGINX selects a ready backend for each request. It cannot move an inference request that is already running when the HPA adds a new pod, so long-lived requests may still produce temporary utilization differences between GPUs.

## Grafana workload allocation

Grafana can compare request traffic and GPU utilization across the HPA replicas. Scraping of the agent `/metrics` endpoint is enabled by default (`metrics.serviceMonitor.enabled: true`), so no extra setup is needed after `install-hpa.sh`.

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

Add the request-rate and GPU-utilization queries to the same Explore view to see whether traffic and GPU work are distributed across replicas. When the HPA scales up, a new pod should appear after it becomes ready. A `rate(...)` result requires at least two Prometheus scrapes.

If the request-rate graph shows only one pod (or stops updating) while GPU utilization shows all pods, check `kubectl get servicemonitor -n nemoclaw-gpu`. Anything that runs a plain `helm upgrade` without `--reuse-values` (custom scripts, manual re-installs) resets `metrics.serviceMonitor.enabled` to the chart default, which is `true`; if it was manually forced to `false` re-run `install-hpa.sh` or `helm upgrade` with `--set metrics.serviceMonitor.enabled=true` to restore it.

## Uninstall

Remove the NemoClaw release and namespace:

```bash
helm uninstall nemoclaw-gpu -n nemoclaw-gpu
kubectl delete namespace nemoclaw-gpu --ignore-not-found
```

The Prometheus and Prometheus Adapter releases are shared monitoring components and are not removed by these commands.
