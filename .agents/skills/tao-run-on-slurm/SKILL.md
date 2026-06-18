---
name: tao-run-on-slurm
description: Remote SLURM GPU cluster execution over SSH with sbatch/srun, Pyxis/Enroot containers, and Lustre-backed
  results. Use when running TAO training/eval/inference jobs on an on-prem or DGX SLURM cluster. Trigger phrases include
  "run on SLURM", "submit sbatch", "DGX SLURM cluster", "Pyxis/Enroot container", "Lustre dataset".
license: Apache-2.0
compatibility: Requires SSH access to a SLURM login node (passwordless via key auth) and SLURM_USER + SLURM_HOSTNAME env vars.
  The TAO SDK with the slurm extra (pip install 'nvidia-tao-sdk[slurm]') is needed only if you want Job handles, S3 I/O wrapping,
  or run-folder durability via ActionWorkflow.
metadata:
  author: NVIDIA Corporation
  version: "0.2.0"
allowed-tools: Read Bash
tags:
- platform
- slurm
---

# SLURM

Remote GPU compute platform for clusters managed by SLURM. Jobs are submitted
from the TAO service or SDK host to a login node over SSH, staged on a shared
filesystem, submitted with `sbatch`, and executed with `srun` container support.

Use SLURM when the user has access to a managed GPU cluster, shared Lustre
storage, and scheduler-owned GPU allocation. Do not use SLURM for local files
that exist only on the agent machine; data and outputs must be reachable from
the cluster.

## Preflight

```bash
# 1. SSH to the login node works without a password prompt
SLURM_HOST="${SLURM_HOSTNAME%%,*}"
[ -n "$SLURM_USER" ] && [ -n "$SLURM_HOST" ] || {
  echo "MISSING: set SLURM_USER and SLURM_HOSTNAME (comma-separated for failover) in your env (~/.config/tao/.env)."
  exit 1
}
ssh -o BatchMode=yes -o ConnectTimeout=10 "${SLURM_USER}@${SLURM_HOST}" "true" 2>/dev/null || {
  echo "MISSING: passwordless SSH to ${SLURM_USER}@${SLURM_HOST} not working. See references/ssh-setup.md."
  exit 1
}

# 2. Optional: TAO SDK wrapper for Job handles + S3 wrapping.
# nvidia-tao-sdk is on public PyPI; pin lives in versions.yaml (wheels.tao_sdk_slurm).
PIN=$("${TAO_SKILL_BANK_PATH:?}/scripts/resolve_versions_key.py" wheels.tao_sdk_slurm)
python -c "import tao_sdk" 2>/dev/null || {
  echo "MISSING: nvidia-tao-sdk not installed. Run:"
  echo "  pip install \"$PIN\""
  exit 1
}
```

If a check fails, the agent prompts the user to authorize the install/fix via Bash.

A third preflight step applies only for **private `nvcr.io` images**: Pyxis on
the compute nodes needs persistent enroot credentials in
`~/.config/enroot/.credentials` on the cluster (it does NOT read `NGC_KEY` from
the job env). Without them, auth-gated pulls fail with "Could not process JSON
input" at job startup. This runs once per (cluster, user). See
`references/ssh-setup.md` for the full check and the `printf | ssh` install
pattern that keeps `NGC_KEY` out of history, files, and chat output. Skip it for
public images.

## Prerequisites

Before any job is submitted, the host running the TAO service or SDK must log in
to at least one host from `SLURM_HOSTNAME` over SSH **without an interactive
password prompt**. The handler runs `sbatch`, `squeue`, `sacct`, `scancel`, and
log tails non-interactively, so password or 2FA prompts will fail the job at
submit or status time.

Set this up once per (host, login node, user) tuple: create an SSH keypair,
install the public key on each login host, trust the host key, lock private-key
permissions to `chmod 600`, and verify with `ssh -o BatchMode=yes ...`. See
`references/ssh-setup.md` for the full step-by-step (including the `~/.ssh/config`
alias, the container key-mount note, and the 2FA / `SSH_AUTH_SOCK` fallback). The
same file holds the **SSH failure remediation prompt** to show the user when
passwordless SSH fails.

## Credentials

- **SLURM_USER** (required): SSH username for the login node. In microservices
  workspace metadata this is `cloud_specific_details.slurm_user`.
- **SLURM_HOSTNAME** (required): Comma-separated login hostnames for failover.
  Microservices schema stores this as the list field
  `cloud_specific_details.slurm_hostname`.
- **SLURM_PARTITION** (required): Partition list for GPU job submission. Ask
  for this in the mandatory SLURM intake list. The packaged default is
  `polar,polar3,polar4,grizzly`, which are treated as 4-hour queues.
- **SSH_KEY_PATH** (preferred and expected before launch): private key path for
  non-interactive public-key auth to the login node. If passwordless SSH fails,
  ask the user for `SSH_KEY_PATH=/path/to/private_key` and show the setup steps
  in `references/ssh-setup.md`; do not bury this behind several alternate choices.
- **SSH_AUTH_SOCK** (advanced fallback): SSH agent socket with an accepted key
  already loaded. Prefer `SSH_KEY_PATH` in user-facing remediation prompts.
- **SLURM_BASE_RESULTS_DIR** (optional): Base shared filesystem path. Default
  convention from `tao-core` is `/lustre/fsw/portfolios/edgeai/<your-dir>`,
  where `<your-dir>` is your per-user directory on the cluster.
- **SLURM_ACCOUNT** (usually required by site policy): Account charged by
  `#SBATCH --account`.

Do not ask for `SLURM_ACCOUNT` or `SLURM_BASE_RESULTS_DIR` in the initial
intake unless the user says their site requires an account, wants a custom
results root, or the workflow cannot proceed without overriding defaults.

## Backend Details

Use `backend_details.backend_type = "slurm"` when routing a job to this
platform. Supported backend details from the microservices schema:

```json
{
  "backend_type": "slurm",
  "partition": "polar,polar3,polar4,grizzly",
  "cluster_name": "optional-name"
}
```

Runtime metadata is stored under `backend_details.slurm_metadata`, especially
`slurm_job_id` and `job_dir`. Do not invent these values. They are written
after `sbatch` returns a scheduler job id.

## Storage

SLURM jobs run on the cluster, so local paths from the API host are not valid
dataset paths. Prefer shared filesystem URIs:

- Use `lustre:///absolute/path` for user-provided datasets on Lustre.
- `slurm://` paths may appear in microservices metadata and are converted to
  actual Lustre paths before the container starts.
- Avoid bare `/local/path` and `file://` dataset URIs for SLURM. Validation in
  `tao-core` rejects local and file paths for remote backends.

Accept either dataset roots or direct spec-key paths:

- Root mode: `/lustre/.../<model>/train`, which model skills map to required
  files such as `<root>/annotations.json` and `<root>` as media path.
- Direct spec mode: exact fields such as
  `custom.train_dataset.annotation_path=/lustre/.../train.json` and
  `custom.train_dataset.media_path=/lustre/.../videos.tar.gz`.

After passwordless SSH succeeds and before generating scripts, validate each
required dataset file/path from the login host:

```bash
ssh -o BatchMode=yes <SLURM_USER>@<working-login-host> \
  'test -e /lustre/.../annotations.json && test -e /lustre/.../media_or_archive'
```

If the remote `test -e` fails, stop and ask for corrected paths or for the data
to be staged onto shared cluster storage. Do not create runner scripts that will
fail inside the first training job.

Results default to:

```text
/lustre/fsw/portfolios/edgeai/<your-dir>/results/<job_id>
```

`<your-dir>` is your per-user directory on the cluster.

The runner sets `TAO_API_RESULTS_DIR` to the parent results directory because
container code appends the job id when writing status and artifacts.

> **Use Lustre, not S3, for SLURM job inputs.** SLURM's scheduler enforces a
> GPU-idle timeout — a long `s3://` download at the top of the script can burn
> the allocation before training begins, and the scheduler may kill the job.
> Stage training data onto Lustre first; S3 / HF / NGC pre-fetch is fine only
> for small auxiliary inputs (checkpoints, configs). See `references/sdk-usage.md`
> for the full rationale.

## Container Execution

`tao-core` uses the SLURM handler to run TAO containers through Pyxis/Enroot:

1. Stage compact JSON files for specs, environment, and cloud metadata under
   `<job_dir>/specs`, `<job_dir>/env`, and `<job_dir>/meta`.
2. Optionally convert the Docker image to a cached SQSH image with
   `srun -n1 -p <conversion_partition> enroot import`.
3. Write an sbatch script under `<job_dir>/sbatch/job_<job_id>.sbatch`.
4. Submit `sbatch --export=ALL <script>`.
5. Run the container with `srun --container-image=<image> --container-mounts=/lustre`.

Image formats accepted by the handler:

- `/path/to/image.sqsh`
- `registry#image:tag`
- `docker://registry#image:tag`
- ordinary `registry/image:tag`, which is converted to Pyxis form when needed

SQSH conversion is cached by image name. For `:latest` images, cached SQSH is
used unless `force_reconvert_latest` is enabled.

## Resource Mapping

Defaults from `tao-core`:

- `num_nodes`: 1
- `num_gpus`: 4
- `max_num_gpus_per_node`: 8
- `cpus_per_task`: 16
- `time_hours`: 4
- `timeout_hours`: 3.8
- `max_time_hours`: 4
- `container_mounts`: `/lustre`
- `use_requeue`: true
- `use_sqsh`: true

When generating launchers or wrapper scripts for SLURM, set the wall-time
defaults explicitly from the packaged platform resource defaults:

```bash
export SLURM_TIME_HOURS="${SLURM_TIME_HOURS:-4}"
export SLURM_TIMEOUT_HOURS="${SLURM_TIMEOUT_HOURS:-3.8}"
```

Do not default to 12 hours on SLURM. If the user supplies a longer
`SLURM_TIME_HOURS`, verify that the selected partition supports it before
submitting. For the packaged default partition list
`polar,polar3,polar4,grizzly`, reject requests above 4 hours and ask for a
different partition only if the user actually wants a longer wall time.

When `num_gpus` is greater than or equal to `max_num_gpus_per_node`, the
handler treats the request as exclusive per node and computes additional nodes
from total GPU count when necessary.

For multi-node jobs (`num_nodes > 1`), the sbatch script exports `WORLD_SIZE`,
`MASTER_ADDR`, `MASTER_PORT`, `NODE_RANK`, and `NUM_GPU_PER_NODE`, and Cosmos-RL
has special multi-node role handling for controller, policy, and rollout
workers. See `references/multi-node.md` for the full sbatch directives, the
rendezvous env-var table and contract, and cluster requirements.

## Monitoring

- Scheduler status comes from the stored SLURM job id via `squeue` or `sacct`.
- TAO terminal status comes from `status.json` in the shared results folder.
- If the user enabled chat monitoring, continue polling at the requested
  interval while the job is `PENDING`, `RUNNING`, or otherwise non-terminal.
  Do not stop after a fixed elapsed time such as 30 minutes; long queue waits
  are normal on shared GPU partitions.
- Do not send a final response for a non-terminal SLURM job when chat
  monitoring is enabled. A final response is a detach action; use it only if
  the user asked to detach/stop or the job reached terminal state.
- Logs are read over SSH from:

```text
<job_dir>/slurm-logs/<slurm_job_name>-<slurm_job_id>/main.out
<job_dir>/slurm-logs/<slurm_job_name>-<slurm_job_id>/main.err
```

Status mapping:

- `PENDING` -> `Pending`
- `RUNNING` or `COMPLETING` -> `Running`
- `COMPLETED` -> check `status.json`
- `FAILED`, `BOOT_FAIL`, `DEADLINE`, `OUT_OF_MEMORY`, `NODE_FAIL` -> retry if
  logs match retriable infrastructure patterns, otherwise `Error`
- `CANCELLED`, `PREEMPTED`, `REVOKED` -> `Canceled`
- `TIMEOUT` -> `Error`
- `SUSPENDED`, `STOPPED` -> `Paused`

## Cancellation

Cancel by looking up `backend_details.slurm_metadata.slurm_job_id` and running
`scancel <slurm_job_id>` over SSH. Treat missing or already terminated SLURM
jobs as successful cancellation.

## Multi-node training (distributed)

SLURM is the platform of choice for large multi-node runs — pass `num_nodes > 1`
and the SDK handles the sbatch directives and PyTorch-distributed env vars
automatically. See `references/multi-node.md` for a worked `create_job` example,
the generated sbatch directives, the rendezvous env-var table (`WORLD_SIZE`,
`NUM_GPU_PER_NODE`, `NODE_RANK`, `MASTER_ADDR`, `MASTER_PORT`), the Cosmos-RL
role note, cluster requirements (Pyxis/Enroot, InfiniBand/NVLink, Lustre), and
upstream reference links.

## Running via the TAO SDK

The SDK install is covered in Preflight — `pip install 'nvidia-tao-sdk[slurm]'`.
Use it when you want Job handles, the sbatch/`squeue`/`sacct` plumbing handled
for you, run-folder durability via `ActionWorkflow`, or convenient cloud-storage
I/O (`s3://`, `hf_model://`, `ngc://`). Without the SDK, drive `sbatch` and
`srun` yourself.

Auto-retry is **fully automatic**: a background monitor polls `squeue`/`sacct`
and re-`sbatch`'s the staged script on infrastructure-looking failures up to
`MAX_JOB_RETRIES = 10`, while plain training failures surface immediately. In
addition, `#SBATCH --requeue` is set by default (`SLURM_USE_REQUEUE`, defaults
to `true`). See `references/sdk-usage.md` for the `SlurmSDK` / `build_entrypoint`
code example, the Lustre-not-S3 rule, the retriable-failure classification, and
the full auto-retry and requeue behavior.

## Failure Modes

Common failures: SSH auth failure, local dataset path rejected, SQSH conversion
timeout, Pyxis/Enroot unavailable, and bad-node / transient GPU failures (which
the handler retries up to the configured limit). See
`references/troubleshooting.md` for the diagnosis and remediation of each.
