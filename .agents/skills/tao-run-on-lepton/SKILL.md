---
name: tao-run-on-lepton
description: DGX Cloud Lepton managed GPU compute platform with run/status/cancel interface. Use when submitting TAO jobs
  to DGX Cloud, dispatching training/eval/inference to Lepton GPU resources, or managing Lepton workspace deployments.
  Trigger phrases include "run on Lepton", "submit to DGX Cloud", "Lepton job", "managed GPU on DGX Cloud".
license: Apache-2.0
compatibility: Requires the tao-sdk Python package with the lepton extra (pip install 'tao-sdk[lepton]') plus LEPTON_WORKSPACE_ID
  and LEPTON_AUTH_TOKEN.
metadata:
  author: NVIDIA Corporation
  version: "0.1.0"
allowed-tools: Read Bash
tags:
- dgx-cloud
- gpu
- compute
- lepton
---

# Lepton

Managed GPU compute platform on DGX Cloud. Jobs are submitted as container workloads that run on dedicated or shared GPU node groups. Lepton handles scheduling, image pulling, log collection, and job lifecycle.

Use Lepton when you need cloud-based GPU compute without managing Kubernetes or SLURM infrastructure directly.

## Preflight

Lepton is API-first — no docker-run alternative. This skill needs the TAO SDK with the Lepton extra. `nvidia-tao-sdk` is on public PyPI; the pinned version lives in `versions.yaml` (`wheels.tao_sdk_lepton`), resolved via `scripts/resolve_versions_key.py`:

```bash
PIN=$("${TAO_SKILL_BANK_PATH:?}/scripts/resolve_versions_key.py" wheels.tao_sdk_lepton)
python -c "import tao_sdk" 2>/dev/null || {
  echo "MISSING: nvidia-tao-sdk not installed. Run:"
  echo "  pip install \"$PIN\""
  exit 1
}
python -c "import leptonai" 2>/dev/null || {
  echo "MISSING: lepton extra not installed. Run:"
  echo "  pip install \"$PIN\""
  exit 1
}
```

If missing, the agent prompts the user to authorize the install via Bash, then re-runs the preflight before continuing.

## Credentials

- **LEPTON_WORKSPACE_ID** (required): Determines which cluster and billing account the job runs under.
- **LEPTON_AUTH_TOKEN** (required): API token for authenticating with the Lepton control plane.
- **NGC_KEY** (optional): Used to create image pull secrets for pulling TAO container images from nvcr.io.
- **ACCESS_KEY** / **SECRET_KEY** (optional): S3-compatible storage keys for dataset and checkpoint URIs.
- **S3_ENDPOINT_URL** (optional): Custom S3 endpoint (e.g., for MinIO or non-AWS S3).
- **S3_BUCKET_NAME** (optional): Bucket for job output artifacts.
- **CLOUD_REGION** (optional): Storage region (e.g., us-east-1).

## Launch Preflight

Before generating scripts or submitting jobs:

1. Verify `LEPTON_WORKSPACE_ID` and `LEPTON_AUTH_TOKEN` are set.
2. Verify the workspace API is reachable with the packaged helper:
   `scripts/check_tao_launch_preflight.py --platform lepton ...`.
3. For `s3://` datasets/results, verify `ACCESS_KEY` and `SECRET_KEY` are set
   and the exact paths are readable with `aws s3 ls`.
4. For NFS/Lustre mounted paths, require proof from Lepton volume/storage
   permissions that the path will be mounted into the job. Do not treat a local
   filesystem `test -e` on the agent host as proof for Lepton jobs.
5. Verify model-specific credentials such as `HF_TOKEN` before launch.

## Backend Details

`LeptonSDK.create_job` accepts these Lepton-specific kwargs (in addition to the platform-agnostic ones — `image`, `command`, `gpu_count`, `env_vars`, `inputs`, `outputs`, `hooks`):

- **`resource_shape`**: explicit GPU resource shape ID (e.g., `"gpu.8xh100-sxm"`). When set, skips the auto-resolution from `gpu_count`. The format is opaque (whatever Lepton's API returns as instance metadata.id) — discover valid IDs via `sdk.list_resource_shapes()`.
- **`dedicated_node_group`**: node group ID for guaranteed GPU allocation (no preemption). Omit for shared resources.
- **`num_nodes`**: number of nodes for distributed training. Default 1. When > 1, enables intra-job communication and PyTorch distributed initialization (see [Multi-node training](#multi-node-training-distributed)).
- **`mounts`**: pre-built `Mount` objects for NFS / Lustre. Auto-detected from the node group when not set.

### Discovering the workspace's shapes / volumes

```python
shapes = sdk.list_resource_shapes()
# {<platform_id>: {"cluster": ..., "gpu_type": "gpu.8xh100-sxm",
#                   "gpu_count": 8, "instance_type": ..., ...}, ...}

volumes = sdk.get_volumes(node_group_id="my-h100-pool")
# [{"name": "lustre", "from_path": "/lustre", "type": "Lustre"}, ...]

prefixes = sdk.get_storage_permissions("lustre", "my-h100-pool")
# ["/lustre/fsw/portfolios/edgeai/...", ...]
```

## Multi-node training (distributed)

Pass `num_nodes > 1` to `create_job` for multi-node distributed training. The Lepton handler (`tao_sdk/platforms/lepton/handler.py`) configures the underlying `LeptonJob` by setting `intra_job_communication=True` (opens pod-to-pod networking), `parallelism=num_nodes` and `completions=num_nodes` (Lepton schedules N replicas), and exports `WORLD_SIZE=num_nodes` as a container env var.

Lepton's native per-replica env vars use Lepton-specific names (`LEPTON_JOB_WORKER_INDEX`, `LEPTON_JOB_TOTAL_WORKERS`, `LEPTON_JOB_WORKER_PREFIX`, `LEPTON_SUBDOMAIN`), so the handler prepends a bootstrap that sources Lepton's official translation script:

```bash
wget -O init.sh https://raw.githubusercontent.com/leptonai/scripts/main/lepton_env_to_pytorch.sh
chmod +x init.sh
source init.sh
# user command runs here
```

After sourcing, the following env vars are set:

| Env var | Source | Value |
|---|---|---|
| `MASTER_ADDR` | script | `${LEPTON_JOB_WORKER_PREFIX}-0.${LEPTON_SUBDOMAIN}` |
| `MASTER_PORT` | script | `29400` |
| `NNODES` | script | `${LEPTON_JOB_TOTAL_WORKERS}` |
| `NODE_RANK` | script | `${LEPTON_JOB_WORKER_INDEX}` |
| `WORKER_ADDRS` | script | comma-separated list of non-master worker hostnames |
| `WORLD_SIZE` | TAO SDK handler | `num_nodes` (TAO container's convention — same value as `NNODES`) |
| `NUM_GPU_PER_NODE` | TAO SDK handler | `gpu_count` (read by TAO container's entrypoint) |

```python
job = sdk.create_job(
    image='nvcr.io/nvidia/tao/tao-toolkit:6.26.3-pyt',
    command='dino train -e /tmp/spec.yaml',  # TAO entrypoint reads WORLD_SIZE + NUM_GPU_PER_NODE
    gpu_count=8,                          # GPUs per node
    num_nodes=4,                          # 4 × 8 = 32 GPUs total
    dedicated_node_group='my-h100-pool',
    inputs={'/data/train.json': 's3://bucket/coco/train.json'},
    outputs=['/results/'],
)
```

For raw `torchrun`-based commands (non-TAO containers):

```python
command='torchrun --nnodes=$NNODES --nproc-per-node=8 --node-rank=$NODE_RANK '
        '--master-addr=$MASTER_ADDR --master-port=$MASTER_PORT train.py'
```

### Two ways to run distributed jobs on Lepton

| Path | When to use |
|---|---|
| **TAO SDK `create_job(num_nodes=N)`** (this skill) | Programmatic submission from agent code; you want the SDK's S3 wrapping, monitoring, failure analysis, and JobStore. |
| **Lepton "Torchrun" job type** (Lepton UI / lep CLI) | Hand-crafted submission via the Lepton console. Lepton's UI has a first-class "Torchrun" mode that wires up the rendezvous for you — no bootstrap script needed. See the [official example](https://docs.nvidia.com/dgx-cloud/lepton/examples/batch-job/distributed-training-with-pytorch/). |

### Reference reading

- NVIDIA's Lepton multi-node PyTorch example (UI / Torchrun mode): <https://docs.nvidia.com/dgx-cloud/lepton/examples/batch-job/distributed-training-with-pytorch/>
- The translation script the SDK sources: <https://github.com/leptonai/scripts/blob/main/lepton_env_to_pytorch.sh>
- PyTorch distributed (env-var rendezvous): <https://pytorch.org/docs/stable/elastic/run.html>
- NCCL networking tuning: <https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/env.html>

### Notes

- Prefer `dedicated_node_group` for multi-node to keep replicas on the same low-latency interconnect (NVLink / InfiniBand).
- If a replica is preempted on a shared node group, the whole job fails — Lepton doesn't elastically restart in v1. Use a dedicated node group for long runs.
- For Lustre-backed datasets, the same mount is exposed to every replica — no per-replica I/O wrapping needed.

## Cloud Storage

Even though the platform is Lepton, the storage layer is S3-compatible. Always use `aws` as the `cloud_metadata` key and `s3://` as the URI protocol for both datasets and `results_dir`.

- Correct: `s3://bucket-name/path`
- Incorrect: `lepton://bucket-name/path`

The container's `get_cloud_storage_class_object()` parses the URI protocol to look up credentials in `CLOUD_METADATA[protocol][bucket]`.

## Shared Storage (NFS/Lustre)

Node groups can have NFS or Lustre volumes attached. The SDK auto-detects these and mounts them into containers for persistent cross-job data sharing.

### SDK Functions

- `sdk.get_volumes(node_group_id=None)` — returns available volumes (name, from_path, type) from node group spec
- `sdk.get_storage_permissions(volume_name, node_group_id)` — returns allowed path prefixes for a volume

`LeptonSDK.create_job()` calls these automatically to detect mounts and build the appropriate `Mount` objects for job specs.

### How the script runner uses mounts

When a Lustre mount is available:
- **Inputs**: S3 paths are mapped to Lustre (`s3://bucket/path` → `/mnt/lustre/bucket/path`). If the file exists on Lustre, it's used directly (zero download). If missing, it's downloaded from S3 to Lustre and persists for future jobs.
- **Outputs**: Results write to Lustre first (fast, persistent), then upload to S3 (durable). Downstream jobs (e.g., gap analysis) can read results directly from Lustre without an S3 round-trip.

### Volume preference order

lustre > filestore > first available

### Lustre Cache Invalidation

Lustre caches files persistently across jobs. There is no built-in invalidation. If upstream data changes but the S3 path stays the same, Lustre serves the stale cached version. To force a cache miss:

- **Rename the file** on S3 (e.g., `prompt_v2.txt` instead of overwriting `prompt.txt`)
- **Use a new storage_root** between iterations to avoid cross-iteration staleness
- **Use a new path** for any regenerated artifacts

## Monitoring

### Job Status
Use `sdk.get_job_status(job_id)` for high-level status (Pending, Running, Complete, Error).

### Replica Status
Use `sdk.get_job_replicas(job_id)` during startup for detailed replica-level info. Each replica is a dict:

```python
replicas = sdk.get_job_replicas(job_id)
for r in replicas:
    node = r["status"]["node"]["name"]           # e.g., "node-ip-10-50-111-24"
    node_group = r["status"]["node"]["node_group_id"]
    cpu = r["status"]["cpu"]                      # e.g., 2
    memory_mb = r["status"]["memory_in_mb"]       # e.g., 8192
    readiness = r["status"].get("readiness_issue")
    if readiness:
        reason = readiness["reason"]   # "InProgress", "Failed", "ConfigError"
        message = readiness["message"] # "Pulling image", "Mount point not found", etc.
```

Key readiness_issue patterns:
- `reason="InProgress"`, `message="Pulling image"` — image pull in progress (normal for large images)
- `reason="Failed"` — image pull failed (check NGC_KEY)
- `reason="ConfigError"` — node issue (mount failure, GPU error)
- No `readiness_issue` — replica is running

Replica status is especially useful when a job is stuck in Pending — it reveals whether the issue is image pulling, resource scheduling, or node health.

### Job Logs
Use `sdk.get_job_logs(job_id, tail=N)` for the most recent N log lines. Logs are fetched from Lepton's log collection service.

### Parallel Jobs
For workflow stages that run in parallel (e.g., video generation x8):

1. **Launch:** Call `execute_step(plan, step_id, extra_args={"split_id": i})` for each split. Each call returns immediately with a job_id.
2. **Monitor:** Poll all jobs: `sdk.get_job_status(job_id)` for each. Use `get_job_replicas(job_id)` for startup diagnostics.
3. **Completion:** All jobs done when every status is `Complete` or `Error`.
4. **Partial failure:** Retry only failed splits — successful splits don't need re-running. Pass the same `split_id` to `execute_step`.

## Failure Analysis

When a job fails, use `sdk.get_failure_analysis(job_id)` for automatic root cause detection:

```python
analysis = sdk.get_failure_analysis(job_id)
if analysis:
    print(analysis["err_class"])    # e.g., "ERR_PROGRAM"
    print(analysis["suggestion"])   # Human-readable fix
    for event in analysis.get("job_failure_by_node_event", []):
        print(event["node_event_name"], event["message"])
        # e.g., "OOM", "OOM encountered, victim process: cosmos-rl-evalu, pid: 3368483"
```

Returns:
- `err_class`: Error classification (`ERR_PROGRAM`, `ERR_INFRA`, etc.)
- `suggestion`: What likely went wrong and how to fix it
- `job_failure_by_node_event`: Node-level events (OOM kills, GPU errors, mount failures)
- `log_streams`: Relevant log snippets with error context

Always call this on failed jobs before retrying — it distinguishes user errors (bad config, OOM) from infrastructure issues (node failure, eviction).

## Failure Modes

**OOM killed**: Container exceeded GPU or system memory. Detection: `get_failure_analysis()` returns `node_event_name: "OOM"`. Common causes: `evaluation.batch_size` too high, `max_length` too large for available KV cache. Recovery: reduce batch_size, add GPUs with tensor parallelism, or reduce max_length.

**Image pull failure**: The TAO container image cannot be pulled from nvcr.io. Usually caused by a missing or expired image pull secret. The SDK auto-provisions the secret from NGC_KEY, but if NGC_KEY is invalid, the job will fail. Detection: check `get_job_replicas()` — `readiness_issue.reason` will show `InProgress` with `message = "Pulling image"` for extended periods, or `Failed` if the pull fails. Recovery: verify NGC_KEY is valid.

**Resource unavailable**: The requested GPU shape is not available. Job enters Queueing state indefinitely. Detection: Pending > 15 minutes, replicas show no node assignment. Recovery: try a different resource_shape or dedicated_node_group, or wait for resources.

**Auth failure**: Invalid or expired LEPTON_AUTH_TOKEN. All API calls fail with 401/403. Detection: job creation raises an exception immediately. Recovery: refresh the token and reinitialize the SDK.

**Unhealthy node**: The assigned node has infrastructure issues (mount failures, GPU errors, network problems). Detection: check `get_job_replicas()` — `readiness_issue.reason = "ConfigError"` with messages like `"Mount point not found"`. The job stays Pending indefinitely on the bad node. Recovery: cancel the job and resubmit — Lepton will schedule on a different node. If the issue recurs, try a different `dedicated_node_group` or `resource_shape`.

**Job eviction**: On shared node groups, Lepton may evict jobs under resource pressure. Detection: job unexpectedly transitions from Running to Error. Recovery: retry, or use a dedicated_node_group.
