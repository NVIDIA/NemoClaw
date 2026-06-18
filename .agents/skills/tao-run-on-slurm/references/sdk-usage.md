# Running SLURM Jobs via the TAO SDK

The SDK install is `pip install 'nvidia-tao-sdk[slurm]'`. Use it when you want
Job handles, the sbatch/`squeue`/`sacct` plumbing handled for you, run-folder
durability via `ActionWorkflow`, **or convenient cloud-storage I/O** (the SDK's
`build_entrypoint` inlines `script_runner` and dispatches `s3://`,
`hf_model://`, and `ngc://` URIs to the right downloader; without the SDK you
either pre-stage the data on Lustre or call `fsspec` / `huggingface-cli`
yourself).

When the SDK is in scope, read `tao-skill-bank:tao-run-platform` for the `SlurmSDK`
kwarg reference (`num_nodes`, `partition`, `account`), `build_entrypoint`,
and `ActionWorkflow`.

> **Use Lustre, not S3, for SLURM job inputs.** SLURM's scheduler enforces a
> GPU-idle timeout: the GPU allocation starts the moment your job is
> dispatched, and a long `s3://` download at the top of the script will burn
> minutes (or tens of minutes for large datasets) before training begins. The
> scheduler can kill the job for being GPU-idle, and the cluster bills you for
> the wasted allocation either way. Stage data onto the cluster's shared
> filesystem first and reference it as `lustre:///...` (or a plain absolute
> path the compute nodes can read). S3 / HF / NGC pre-fetch is fine for *small*
> auxiliary inputs (model checkpoints, configs); avoid it for training
> datasets. Lepton/K8s/Brev don't have this constraint because they don't
> share SLURM's scheduler-idle policy.

```python
from tao_sdk.platforms.slurm import SlurmSDK
from tao_sdk.script_runner import build_entrypoint

ep = build_entrypoint(
    command='dino train -e {config_path}',
    specs=specs,                                           # config-mode (spec rewriting)
    job_id='dino-train-1',
)

sdk = SlurmSDK()  # reads SLURM_USER, SLURM_HOSTNAME, SLURM_BASE_RESULTS_DIR from env
job = sdk.create_job(
    image='nvcr.io/nvidia/tao/tao-toolkit:6.26.3-pyt',
    command=ep['command'],
    gpu_count=8,
    num_nodes=2,                                           # multi-node supported
    partition='batch',                                     # optional override
    account='myproject',                                   # optional override
)

status = sdk.get_job_status(job.id)
logs = sdk.get_job_logs(job.id, tail=200)
```

The SDK takes care of staging the entrypoint script to Lustre, generating the
`sbatch` script with Pyxis `srun --container-image`, and parsing
`squeue`/`sacct` for status. Without the SDK, drive `sbatch` and `srun`
yourself.

## Auto-retry for infrastructure failures

Auto-retry is **fully automatic** — submit once, the SDK handles the rest. A
background `JobMonitor` thread (started in `SlurmSDK.__init__`) polls
`squeue`/`sacct` every `poll_interval` seconds (default 30s). When it sees an
*infrastructure-looking* failure it re-`sbatch`'s the already-staged remote
script and keeps watching, up to `MAX_JOB_RETRIES = 10` retries. The
user-facing `Job.id` is stable across retries; only the underlying SLURM job
id rotates. There is no `Job.retry()` / `Job.wait()` API to call — polling
and resubmission both happen in the background.

A failure is classified as retriable when:

- SLURM reports `NODE_FAIL` or `BOOT_FAIL`, **or**
- The job's logs match one of the retriable patterns (NCCL transport timeouts,
  CUDA driver init failures, GPU/IB link-down, OOM-killer reaping the node, et
  cetera — see `RETRIABLE_ERROR_PATTERNS` in the handler).

Plain training failures (`FAILED` with no matching pattern) are surfaced
immediately — no retry — so a broken spec doesn't silently consume 10 GPU
allocations.

State is persisted to `tao_session_state.db`, so if the user's process exits
between submit and completion, a later `SlurmSDK(state_file=...)` rehydrates
the job and resumes monitoring (and retrying) from where the previous process
left off.

In addition, `#SBATCH --requeue` is set by default (controlled by the
`SLURM_USE_REQUEUE` env var, defaults to `true`), so SLURM itself will
re-queue the job on `NODE_FAIL` or pre-emption *before* the handler-level
retry loop ever sees it. Set `SLURM_USE_REQUEUE=false` to opt out.
