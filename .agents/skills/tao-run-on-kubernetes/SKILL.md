---
name: tao-run-on-kubernetes
description: Kubernetes execution platform — submits TAO container jobs as single-pod k8s Jobs with NVIDIA GPU scheduling.
  Use when running on EKS / GKE / AKS / on-prem clusters with the NVIDIA GPU Operator installed, or when integrating TAO
  into an existing k8s-native ML platform.
license: Apache-2.0
compatibility: Requires GPU worker nodes with NVIDIA driver branch 580, CUDA Toolkit 13.0, and NVIDIA Container Toolkit 1.19.0; the nvidia-tao-sdk Python package with the kubernetes extra (pip install 'nvidia-tao-sdk[kubernetes]'); an authenticated cluster; and the NVIDIA GPU Operator or device plugin.
metadata:
  author: NVIDIA Corporation
  version: "0.1.0"
allowed-tools: Read Bash
tags:
- kubernetes
- k8s
- gpu
- compute
- container
---

# Kubernetes

Submits TAO container jobs as Kubernetes Jobs. Works on any cluster reachable via kubeconfig (EKS / GKE / AKS / on-prem) or in-cluster service account (when the SDK runs inside a pod).

Single-pod by default; opt into multi-node distributed training via `num_nodes > 1` (uses Indexed Job + headless Service, see [Multi-node training](#multi-node-training-distributed) below).

## Preflight

Four checks: GPU host runtime ready, SDK installed, cluster reachable, GPU
Operator/device plugin present.

```bash
# 0. GPU node host runtime.
# Run this on each self-managed GPU worker node or in the node image build.
# Set TAO_K8S_SKIP_NODE_RUNTIME_CHECK=1 only when using managed GPU nodes whose
# driver/toolkit lifecycle is owned by the cloud provider or GPU Operator policy.
if [ "${TAO_K8S_SKIP_NODE_RUNTIME_CHECK:-0}" != "1" ]; then
  TAO_SKILL_BANK_ROOT="${TAO_SKILL_BANK_ROOT:-$PWD}"
  SETUP_SCRIPT="${TAO_SKILL_BANK_ROOT}/skills/tao-setup-nvidia-gpu-host/scripts/setup-nvidia-gpu-host.sh"
  [ -x "$SETUP_SCRIPT" ] || SETUP_SCRIPT="${TAO_SKILL_BANK_ROOT}/platform/tao-setup-nvidia-gpu-host/scripts/setup-nvidia-gpu-host.sh"

  bash "$SETUP_SCRIPT" --backend kubernetes --check-only || {
    echo "MISSING: TAO Kubernetes GPU node runtime is not ready."
    echo "For self-managed GPU nodes, run after user approval:"
    echo "  bash \"$SETUP_SCRIPT\" --backend kubernetes --install --yes"
    echo "For managed clusters, verify the node image/GPU Operator policy installs driver 580 and toolkit 1.19.0, then set TAO_K8S_SKIP_NODE_RUNTIME_CHECK=1."
    exit 1
  }
fi

# 1. SDK + kubernetes extra installed.
# nvidia-tao-sdk is on public PyPI; pin lives in versions.yaml (wheels.tao_sdk_kubernetes).
PIN=$("${TAO_SKILL_BANK_PATH:?}/scripts/resolve_versions_key.py" wheels.tao_sdk_kubernetes)
python -c "import tao_sdk" 2>/dev/null || {
  echo "MISSING: nvidia-tao-sdk not installed. Run:"
  echo "  pip install \"$PIN\""
  exit 1
}
python -c "import kubernetes" 2>/dev/null || {
  echo "MISSING: kubernetes extra not installed. Run:"
  echo "  pip install \"$PIN\""
  exit 1
}

# 2. Cluster reachable (kubeconfig OR in-cluster service account)
python -c "from kubernetes import config; config.load_kube_config()" 2>/dev/null || \
  python -c "from kubernetes import config; config.load_incluster_config()" 2>/dev/null || {
    echo "MISSING: no kubeconfig at ~/.kube/config and not running in a pod."
    echo "Configure kubectl (e.g., 'aws eks update-kubeconfig --name my-cluster') or set \$KUBECONFIG."
    exit 1
  }

# 3. NVIDIA GPU Operator present (soft check — warn if kubectl available, don't fail)
if command -v kubectl >/dev/null 2>&1; then
  gpu=$(kubectl get nodes -o jsonpath='{range .items[*]}{.status.allocatable.nvidia\.com/gpu}{"\n"}{end}' 2>/dev/null | grep -v '^$' | head -1)
  if [ -z "$gpu" ] || [ "$gpu" = "0" ]; then
    echo "WARN: no nvidia.com/gpu allocatable on this cluster."
    echo "Install the NVIDIA GPU Operator before submitting GPU jobs:"
    echo "  https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/getting-started.html"
  fi
fi
```

The GPU node runtime check is mandatory for self-managed nodes. For managed
clusters where the client is not running on a GPU worker, verify the provider
node image or GPU Operator policy and set `TAO_K8S_SKIP_NODE_RUNTIME_CHECK=1`
instead of running the installer on the client. The final GPU capacity check is
a warning rather than a hard fail — `kubectl` isn't always installed. The SDK
does a hard guard inside
`KubernetesSDK.create_job()` that uses the kubernetes Python client to verify
GPU capacity before submitting.

## Credentials & configuration

- **Kubeconfig** (one of):
  - `~/.kube/config` — default discovery path
  - `$KUBECONFIG` — alternate path
  - In-cluster service account — used when running inside a pod (no kubeconfig needed)
- **TAO_K8S_NAMESPACE** (optional): default namespace for Job submission. Defaults to `default`.
- **TAO_K8S_CONTEXT** (optional): kubeconfig context name to switch clusters.
- **NGC_KEY** (optional): for nvcr.io image pulls. If you've pre-created an image-pull secret in the target namespace, pass its name to `create_job` via the `image_pull_secret` argument.
- **ACCESS_KEY / SECRET_KEY / S3_BUCKET_NAME / S3_ENDPOINT_URL** (optional): for S3 dataset I/O via the SDK's `inputs`/`outputs` script_runner wrapping.

Do not ask for Lepton, Brev, or SLURM credentials for Kubernetes runs. Ask for
S3 credentials only when the selected workflow uses `s3://` inputs or outputs,
and ask for model-specific credentials such as `HF_TOKEN` only when the selected
model requires them. Before launch, verify the selected namespace can create
Jobs, dataset/result paths are visible from the pod, and PVC/mounted filesystem
paths are proven to be mounted into the job container; an agent-host local path
is not sufficient proof.

## SDK API

K8s is SDK-only — there is no `kubectl`-only launch path. Read
`tao-skill-bank:tao-run-platform` before drafting `create_job` calls; it covers
`build_entrypoint`, the shared kwarg contract, monitoring, and `ActionWorkflow`.

```python
from tao_sdk.platforms.kubernetes import KubernetesSDK

sdk = KubernetesSDK()  # auto-detects auth
job = sdk.create_job(
    image='nvcr.io/nvidia/tao/tao-toolkit:6.26.3-pyt',
    command='dino train -e /tmp/spec.yaml',
    gpu_count=1,
    env_vars={'NGC_KEY': os.environ['NGC_KEY']},
    inputs={'/data/train.json': 's3://bucket/coco/train.json'},
    outputs=['/results/'],
    namespace='tao-jobs',                       # optional override
    image_pull_secret='ngc-pull-secret',         # optional, pre-created
    node_selector={'gpu-type': 'h100'},          # optional
)
```

The SDK constructs a `V1Job` with:
- `spec.template.spec.containers[0]`: the requested image and `command=["/bin/bash", "-c", <command>]`.
- `resources.limits["nvidia.com/gpu"]: <gpu_count>` — schedules onto GPU nodes via the NVIDIA Device Plugin / GPU Operator.
- `env_vars` flowed through, plus auto-injected S3/NGC/HF credentials for `script_runner`.
- `restart_policy=Never` and `backoff_limit=0` — failures surface to the user instead of silently retrying.
- `ttl_seconds_after_finished=3600` — Job auto-cleans 1 hour after terminal state.

## Status & monitoring

```python
status = sdk.get_job_status(job.id)
# status.status ∈ {"Pending", "Running", "Complete", "Error", "Canceled", "Unknown"}

logs = sdk.get_job_logs(job.id, tail=200)  # concatenates logs from all pods of the Job

# For stuck-Pending jobs — replica diagnostics:
for r in sdk.get_job_replicas(job.id):
    issue = r["status"].get("readiness_issue")
    if issue:
        print(issue["reason"], issue["message"])
        # e.g. "ImagePullBackOff" / "Back-off pulling image..."
        # e.g. "Pending"           / "0/3 nodes available: 3 Insufficient nvidia.com/gpu"

# On failure:
analysis = sdk.get_failure_analysis(job.id)
# {"err_class": "ERR_PROGRAM" | "ERR_INFRA",
#  "suggestion": "Container OOM-killed. Reduce batch size...",
#  "job_failure_by_node_event": [{"node_event_name": "OOMKilled", ...}]}
```

## Cancel & cleanup

```python
sdk.cancel_job(job.id)  # delete_namespaced_job with propagation_policy="Foreground"
```

`ttl_seconds_after_finished=3600` means completed Jobs auto-delete after 1h. To cancel an in-flight Job, `cancel_job` deletes it and its pods immediately.

## GPU Operator dependency

The SDK refuses to submit GPU jobs to a cluster with no `nvidia.com/gpu` allocatable. For self-managed clusters, first run the `tao-setup-nvidia-gpu-host` install action on every GPU worker node or bake the same package set into the node image:

```bash
bash skills/platform/tao-setup-nvidia-gpu-host/scripts/setup-nvidia-gpu-host.sh --backend kubernetes --install --yes
```

Then install the NVIDIA GPU Operator or device plugin:

```bash
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update
helm install --wait gpu-operator -n gpu-operator --create-namespace nvidia/gpu-operator
```

Full guide: https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/getting-started.html

## Multi-node training (distributed)

Pass `num_nodes > 1` to `create_job()` to run distributed training across N pods. The SDK provisions:

1. A **headless Service** named after the Job (selector: `job-name=<job-name>`, `clusterIP: None`, `publishNotReadyAddresses: true` so pods can rendezvous before they're all Ready).
2. An **Indexed Job** with `parallelism = completions = num_nodes`, `completionMode: Indexed`. Each pod gets `JOB_COMPLETION_INDEX` injected by k8s automatically (= the node rank).
3. A **command wrapper** that exports the rendezvous env vars before invoking the user command. Two naming conventions are exported simultaneously:

   | Env var | Value | Read by |
   |---|---|---|
   | `WORLD_SIZE` | `num_nodes` | TAO PyTorch container's `nvidia_tao_pytorch/core/entrypoint.py` (uses this to mean *node count*, even though PyTorch's own convention is *total processes*) |
   | `NUM_GPU_PER_NODE` | `gpu_count` | TAO PyTorch container's entrypoint |
   | `NNODES` | `num_nodes` | `torchrun` and PyTorch-standard rendezvous |
   | `NPROC_PER_NODE` | `gpu_count` | `torchrun` |
   | `NODE_RANK` | `$JOB_COMPLETION_INDEX` | both |
   | `MASTER_ADDR` | `<job-name>-0.<job-name>` (pod-0's DNS) | both |
   | `MASTER_PORT` | `29500` | both (TAO's default) |

   Both naming conventions are set so TAO entrypoints (`dino train`, etc.) and raw `torchrun` commands work without modification.

```python
job = sdk.create_job(
    image='nvcr.io/nvidia/tao/tao-toolkit:6.26.3-pyt',
    command='dino train -e /tmp/spec.yaml',  # TAO entrypoint reads spec.train.num_nodes; env vars are wired by the container
    gpu_count=8,           # GPUs per node
    num_nodes=4,           # 4 × 8 = 32 GPUs total
    inputs={'/data/train.json': 's3://bucket/coco/train.json'},
    outputs=['/results/'],
)
```

For raw `torchrun`-based commands (non-TAO containers):

```python
job = sdk.create_job(
    image='nvcr.io/nvidia/pytorch:25.08-py3',
    command='torchrun --nnodes=$NNODES --nproc-per-node=$NPROC_PER_NODE --node-rank=$NODE_RANK '
            '--master-addr=$MASTER_ADDR --master-port=$MASTER_PORT train.py',
    gpu_count=8,
    num_nodes=4,
)
```

The capacity check sums across nodes: `gpu_count × num_nodes` ≤ cluster's allocatable `nvidia.com/gpu`.

### Cluster requirements for multi-node

- **k8s 1.28+** is required for stable pod hostnames in Indexed Jobs (the `PodIndexLabel` feature). On older clusters the `MASTER_ADDR=<job>-0.<svc>` DNS lookup fails. Verify with `kubectl version`.
- **Pod-to-pod networking** must be open on port 29500 (PyTorch default; configurable via `MASTER_PORT` env var). Most CNIs (Calico, Cilium, AWS VPC CNI) allow this by default; restrictive NetworkPolicies must be relaxed.
- **NCCL** in the container talks GPU-to-GPU; if the cluster has multi-NIC nodes or RDMA, set `NCCL_SOCKET_IFNAME` / `NCCL_IB_HCA` via `env_vars`.

### Reference reading

- Kubernetes Indexed Job: <https://kubernetes.io/docs/concepts/workloads/controllers/job/#completion-mode>
- Indexed Job for batch ML: <https://kubernetes.io/blog/2022/06/01/indexed-jobs-mpi/>
- PyTorch distributed (env-var rendezvous): <https://pytorch.org/docs/stable/elastic/run.html>
- NCCL networking tuning (NCCL_SOCKET_IFNAME, NCCL_IB_HCA): <https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/env.html>

### When to use a Kubernetes operator instead

For more sophisticated topologies (gang scheduling, PyTorch elastic / fault-tolerant training, MPI / Horovod, RDMA setup), reach for an operator instead of plain Indexed Job:

- **MPI Operator** — <https://github.com/kubeflow/mpi-operator> — for MPI / Horovod workloads.
- **Kubeflow Training Operator** (`PyTorchJob`, `TFJob`) — <https://www.kubeflow.org/docs/components/training/> — for elastic PyTorch training with built-in restart logic.
- **Volcano** — <https://volcano.sh/> — gang scheduling, queues, fair-share. Useful in shared multi-tenant clusters.
- **Kueue** — <https://kueue.sigs.k8s.io/> — quota / queue layer on top of any of the above.

The TAO SDK's Indexed Job path is intentionally simple and dependency-free; if you need elastic restart or gang scheduling, layer one of these on top and submit jobs through the operator's CRD instead.

## Common error patterns

**`No nvidia.com/gpu resources allocatable on the cluster`** — the GPU Operator (or NVIDIA Device Plugin) isn't installed. Install per the link above; verify with `kubectl get nodes -o jsonpath='{.items[*].status.allocatable}'`.

**`ImagePullBackOff` / `ErrImagePull`** — the cluster can't pull the image. For nvcr.io: pre-create an image-pull secret in the namespace and pass its name via the `image_pull_secret` argument:
```bash
kubectl create secret docker-registry ngc-pull-secret \
  --docker-server=nvcr.io \
  --docker-username='$oauthtoken' \
  --docker-password=$NGC_KEY -n tao-jobs
```

**Pod stays `Pending` forever** — `get_job_replicas(job_id)` will show the readiness_issue. Common causes: insufficient GPU capacity (`Insufficient nvidia.com/gpu`), no node matches `node_selector`, missing image-pull secret, or PVC mount failure.

**`OOMKilled` (exit 137)** — container exceeded memory. Reduce batch size, lower max_length, or add a memory request/limit and target a larger node.

**`CredentialError: Could not authenticate to a Kubernetes cluster`** — neither kubeconfig nor in-cluster auth worked. Run `kubectl get nodes` to verify your config, or set `$KUBECONFIG` to the right path.

## What this skill does NOT support (yet)

- **Elastic / fault-tolerant training.** Indexed Job has `backoff_limit=0` — failures fail the whole training run. For elastic restart (e.g., resume from checkpoint after a node death), use Kubeflow's `PyTorchJob` operator instead.
- **Gang scheduling.** Indexed Job pods are scheduled independently — no all-or-nothing. Multi-node training will *partially* start if only some pods can be scheduled (rank-0 will hang waiting for peers). For all-or-nothing scheduling on shared clusters, use Volcano or Kueue.
- **MPI / Horovod.** Use the MPI Operator. The Indexed Job path here is PyTorch-distributed-shaped (env-var rendezvous on `MASTER_ADDR:MASTER_PORT`).
- **Persistent volumes for shared storage.** S3 only via the script_runner. PVC support is a follow-up.
- **Auto-creating image-pull secrets from `$NGC_KEY`.** You pre-create the secret in the target namespace and pass the name. Lepton does this auto; we don't here because k8s namespace conventions vary widely.
