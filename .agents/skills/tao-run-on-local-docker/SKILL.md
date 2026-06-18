---
name: tao-run-on-local-docker
description: Local Docker execution for TAO SDK job containers using the host Docker daemon and NVIDIA GPU runtime. Use
  when running TAO jobs on the current machine or a directly attached Docker host. Trigger phrases include "run locally",
  "local Docker", "use my GPU", "run on my machine", "host Docker daemon".
license: Apache-2.0
compatibility: Requires NVIDIA driver branch 580, CUDA Toolkit 13.0, Docker, and NVIDIA Container Toolkit 1.19.0. The TAO SDK with the docker extra (pip install 'nvidia-tao-sdk[docker]') is needed only if you want Job handles, S3 I/O wrapping, or run-folder durability via ActionWorkflow.
metadata:
  author: NVIDIA Corporation
  version: "0.2.0"
allowed-tools: Read Bash
tags:
- platform
- local
- docker
---

# Local Docker

Single-node execution platform that runs TAO jobs as named Docker containers on
the local Docker daemon. It is useful for development, debugging, small runs,
and machines where the agent host already has the required GPUs, NVIDIA driver,
Docker, and NVIDIA Container Toolkit.

Use local Docker when the data is local to the Docker host or accessible through
mounted volumes/cloud credentials. Do not use it for remote cluster scheduling,
multi-node training, or jobs that need SLURM queueing.

## Preflight

The workflow must verify the host GPU runtime before starting Docker jobs. If
the check fails, prompt the user to approve the install, run the printed install
command, and rerun the preflight.

```bash
# Host GPU runtime: NVIDIA driver 580, CUDA 13.0, NVIDIA Container Toolkit 1.19.0.
TAO_SKILL_BANK_ROOT="${TAO_SKILL_BANK_ROOT:-$PWD}"
SETUP_SCRIPT="${TAO_SKILL_BANK_ROOT}/skills/tao-setup-nvidia-gpu-host/scripts/setup-nvidia-gpu-host.sh"
[ -x "$SETUP_SCRIPT" ] || SETUP_SCRIPT="${TAO_SKILL_BANK_ROOT}/platform/tao-setup-nvidia-gpu-host/scripts/setup-nvidia-gpu-host.sh"

bash "$SETUP_SCRIPT" --backend docker --check-only || {
  echo "MISSING: TAO GPU host runtime is not ready."
  echo "After user approval, run:"
  echo "  bash \"$SETUP_SCRIPT\" --backend docker --install --yes"
  exit 1
}

# Mode 1 — direct docker (no Python). All you need is docker + the GPU runtime.
docker info >/dev/null 2>&1 || { echo "MISSING: docker daemon not reachable. Start Docker."; exit 1; }
docker run --rm --runtime=nvidia --gpus all ubuntu nvidia-smi >/dev/null 2>&1 || {
  echo "MISSING: NVIDIA Container Toolkit not installed/configured. See:"
  echo "  bash \"$SETUP_SCRIPT\" --backend docker --install --yes"
  exit 1
}

# Mode 2 — TAO SDK wrapper. Adds Job handles, S3 I/O wrapping, ActionWorkflow.
# Skip this block if Mode 1 is sufficient for the user's request.
# When Mode 2 is in scope, read `tao-skill-bank:tao-run-platform` for the DockerSDK
# kwarg contract, build_entrypoint, and monitoring patterns.
# nvidia-tao-sdk is on public PyPI; pin lives in versions.yaml (wheels.tao_sdk_docker).
PIN=$("${TAO_SKILL_BANK_PATH:?}/scripts/resolve_versions_key.py" wheels.tao_sdk_docker)
python -c "import tao_sdk" 2>/dev/null || {
  echo "MISSING: nvidia-tao-sdk not installed. Run:"
  echo "  pip install \"$PIN\""
  exit 1
}
python -c "import docker" 2>/dev/null || {
  echo "MISSING: docker Python client not installed. Run:"
  echo "  pip install \"$PIN\""
  exit 1
}

# DockerSDK attaches every job container to ${DOCKER_NETWORK:-tao_default}. If
# the network does not exist, container start fails instantly with
# `network <name> not found` for every create_job.
DOCKER_NETWORK_NAME="${DOCKER_NETWORK:-tao_default}"
docker network ls --format '{{.Name}}' | grep -qx "$DOCKER_NETWORK_NAME" || {
  echo "MISSING: docker network '$DOCKER_NETWORK_NAME' not found. After user approval, run:"
  echo "  docker network create $DOCKER_NETWORK_NAME"
  exit 1
}
```

If a check fails, the agent prompts the user to authorize the install/fix via Bash before proceeding.

## Credentials

There are no platform credentials required beyond access to the Docker daemon.

Optional environment:

- **DOCKER_HOST**: Optional Docker daemon URL. If unset, the SDK uses the
  Docker Python client's normal environment/default socket resolution.
- **DOCKER_NETWORK**: Docker network for job containers. Default is
  `tao_default`.
- **DOCKER_USERNAME**: Registry username. Default is `$oauthtoken` for NGC.
- **NGC_KEY**: Used when pulling private images from `nvcr.io`.
- **HOST_SSH_PATH**: Mounted into AutoML brain containers when they need SSH keys
  to monitor remote SLURM child jobs.
- **ACCESS_KEY**, **SECRET_KEY**, **S3_ENDPOINT_URL**, **S3_BUCKET_NAME**:
  Optional S3-compatible storage settings for jobs that still read/write cloud
  storage from a local container.

## Launch Preflight

Before generating scripts or starting containers:

1. Verify the Docker daemon is reachable and the NVIDIA runtime can see GPUs.
2. Verify every local/file dataset annotation and media path exists on the
   Docker host.
3. For `s3://` datasets/results, verify `ACCESS_KEY` and `SECRET_KEY` are set
   and the exact paths are readable with `aws s3 ls`.
4. Verify model-specific credentials such as `HF_TOKEN` before launch.

## Multi-GPU and multi-node

**Multi-node is not supported on local Docker.** One job runs on the local Docker daemon's host with no cross-host coordination.

Multi-GPU **on the local host** is supported via the NVIDIA Container Toolkit's `--gpus` flag (`--gpus all` or `--gpus '"device=0,1,2,3"'`). `DockerSDK.create_job(gpu_count=N)` plumbs through to `--gpus`. Single-host distributed init uses `localhost`; `torchrun --nproc-per-node=N` or PyTorch DDP work as usual.

## Backend Details

Use the SDK backend value `local-docker`. The local backend schema has no extra
backend details, so most routing is controlled by environment and job
parameters:

```json
{
  "backend_type": "local-docker",
  "num_gpu": 1
}
```

Following the Lepton/Brev SDK design, platform/control-plane values stay in SDK
state and Docker labels. The SDK does not inject `BACKEND`, `HOST_PLATFORM`,
`MONGOSECRET`, `DOCKER_HOST`, or `DOCKER_NETWORK` into the training container.

## Container Execution

The TAO SDK local Docker handler starts containers through the Docker Python
client:

- Backend job name uses the `tao-job-<job_id>` form used by SDK handlers.
- Command is usually `["/bin/bash", "-c", "<job command>"]`.
- Containers run detached. The SDK keeps containers by default so status and
  logs remain inspectable, unless `DOCKER_AUTO_REMOVE=true`.
- `/dev/shm` is mounted as tmpfs.
- The configured Docker network is applied by the Docker daemon for the job
  container; it is not passed through as a process environment variable.
- Existing containers with the same job id are stopped and removed before a
  replacement starts.

For GPU access, the handler auto-detects the host type:

- Tegra or Jetson hosts use `runtime="nvidia"` plus
  `NVIDIA_VISIBLE_DEVICES` and `NVIDIA_DRIVER_CAPABILITIES=all`.
- Standard x86 hosts use Docker `device_requests` with GPU capabilities.

If `num_gpus` is `0`, no GPUs are assigned. If `num_gpus` is `-1`, all visible
GPUs are requested. Prefer explicit GPU counts for shared development machines.

## Storage

Local Docker accepts local and `file://` paths because the container runs on the
same Docker host. Make sure every path in the spec is either:

- mounted into the container by the handler or surrounding service,
- reachable from inside the container already, or
- a cloud URI with matching credentials.

For remote/shared filesystems, prefer the platform that owns that filesystem.
For example, use SLURM plus `lustre:///...` for Lustre paths on a cluster.

## Monitoring

- The SDK handler maps Docker container state directly: created -> Pending,
  running/restarting -> Running, paused -> Paused, exit code 0 -> Complete,
  nonzero exit -> Error.
- Logs come directly from the named container through the Docker Python client
  (`docker logs tao-job-<job_id>`).

If the container has exited, died, is being removed, or cannot be found, status
reconciliation treats the backend process as terminated.

## Cancellation

Cancellation stops the named container. GPU ownership is managed by Docker /
the NVIDIA runtime, not by TAO Core's local GPU manager.

## Optional: via the TAO SDK

If you want Job handles, S3 I/O wrapping via the SDK's `script_runner`, or
durability across sessions:

```python
from tao_sdk.platforms.docker import DockerSDK

sdk = DockerSDK()  # reads DOCKER_HOST, NGC_KEY, S3 creds from env
job = sdk.create_job(
    image='nvcr.io/nvidia/tao/tao-toolkit:6.26.3-pyt',
    command='dino train -e /tmp/spec.yaml',
    gpu_count=1,
    inputs={'/data/train.json': 's3://bucket/coco/train.json'},
    outputs=['/results/'],
)

status = sdk.get_job_status(job.id)
logs = sdk.get_job_logs(job.id, tail=200)
```

This wraps the same `docker run` invocation under a `Job` handle and routes
the entrypoint through `script_runner` so `inputs`/`outputs` get downloaded
from / uploaded to S3 automatically. If you don't need those, just use
`docker run` directly — no SDK install required.

## Failure Modes

**Docker client not initialized**: Verify the Docker Python package is installed,
set `DOCKER_HOST` if you are not using the default local socket, and confirm the
process can talk to the daemon.

**GPU assignment failed**: Requested GPUs are unavailable, the NVIDIA Container
Toolkit is not configured, or the Docker daemon cannot create GPU device
requests. Use fewer GPUs, wait for another job to finish, or verify
`docker run --gpus ...` works on the host.

**Image pull auth failed**: Set a valid `NGC_KEY` for private `nvcr.io` images
or run `docker login nvcr.io -u '$oauthtoken'` on the Docker host.

**Container exited unexpectedly**: Check `docker logs tao-job-<job_id>`, the
configured `DOCKER_NETWORK`, and the command produced by the SDK action runner.

**Path missing inside container**: A local path on the host is not necessarily
mounted into the job container. Use a path convention supported by the action
runner or configure an explicit volume through the surrounding service.
