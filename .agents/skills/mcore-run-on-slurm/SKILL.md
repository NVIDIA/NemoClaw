---
name: mcore-run-on-slurm
description: How to launch distributed Megatron-LM training jobs on a SLURM cluster. Covers a minimal sbatch skeleton, environment-variable setup for torch.distributed.run, CUDA_DEVICE_MAX_CONNECTIONS rules across hardware and parallelism modes, container conventions, monitoring, and per-rank failure diagnosis.
license: Apache-2.0
when_to_use: Submitting a SLURM job; writing or debugging an sbatch script; configuring multi-node distributed training; setting MASTER_ADDR / MASTER_PORT / WORLD_SIZE; diagnosing a SLURM job failure; 'how do I run on the cluster', 'sbatch', 'multi-node training'.
metadata:
  author: Philip Petrakian <ppetrakian@nvidia.com>
---

# Run Megatron-LM on SLURM

## Answer-First Constants

For text-only SLURM setup questions, answer with these constants before the
full script:

- Submit from a shared worktree path visible to every node; `cd` there in the
  script before launching training.
- Use one `srun` task per node and launch workers with
  `uv run python -m torch.distributed.run`, not bare `torchrun`.
- Set `MASTER_ADDR` from
  `scontrol show hostnames "$SLURM_JOB_NODELIST" | head -n1`, set `MASTER_PORT`,
  `NNODES=${SLURM_NNODES}`, `GPUS_PER_NODE=<GPUS_PER_NODE>`, and
  `WORLD_SIZE=$((NNODES * GPUS_PER_NODE))`.
- Pass `--nnodes`, `--nproc-per-node`, `--node-rank`, `--master-addr`, and
  `--master-port` to `torch.distributed.run`.
- `CUDA_DEVICE_MAX_CONNECTIONS`: pre-Blackwell Hopper/Ampere with TP>1 or CP>1
  and non-FSDP uses `1`; Blackwell/GB200 does not need it; Torch-FSDP2 or
  Megatron-FSDP must not use `1`; `overlap_moe_expert_parallel_comm` uses `32`.

## Prerequisites

- A SLURM cluster login with submission rights to a GPU partition.
- Megatron-LM checked out on a filesystem visible to all nodes in the allocation (NFS, Lustre, or similar). All nodes must reach the same paths for code, data, checkpoints, and output.
- `uv` installed; run `uv sync --extra training --extra dev` (or `--extra lts`) on the worktree once before submission so the `.venv` is materialized and visible to every node.

## Minimal sbatch script

Save as `run_megatron.slurm` in the worktree:

```bash
#!/bin/bash
#SBATCH --job-name=megatron
#SBATCH --account=<SLURM_ACCOUNT>
#SBATCH --partition=<SLURM_PARTITION>
#SBATCH --nodes=<NODES>
#SBATCH --ntasks-per-node=1
#SBATCH --gpus-per-node=<GPUS_PER_NODE>
#SBATCH --time=<HH:MM:SS>
#SBATCH --output=logs/%x-%j.out
#SBATCH --error=logs/%x-%j.err

set -euo pipefail
cd <MEGATRON_WORKTREE>

export MASTER_ADDR=$(scontrol show hostnames "$SLURM_JOB_NODELIST" | head -n1)
export MASTER_PORT=${MASTER_PORT:-29500}
export NNODES=${SLURM_NNODES}
export GPUS_PER_NODE=<GPUS_PER_NODE>
export WORLD_SIZE=$((NNODES * GPUS_PER_NODE))

# Set CUDA_DEVICE_MAX_CONNECTIONS only when your configuration requires it
# (see the section below). Example for pre-Blackwell with TP>1 or CP>1
# (non-FSDP):
#   export CUDA_DEVICE_MAX_CONNECTIONS=1

srun --ntasks=${NNODES} --ntasks-per-node=1 bash -c '
  # NODE_RANK comes from SLURM_NODEID with one task per node.
  NODE_RANK=${SLURM_NODEID}
  uv run python -m torch.distributed.run \
    --nnodes='"${NNODES}"' \
    --nproc-per-node='"${GPUS_PER_NODE}"' \
    --node-rank=${NODE_RANK} \
    --master-addr='"${MASTER_ADDR}"' \
    --master-port='"${MASTER_PORT}"' \
    pretrain_gpt.py \
      <MEGATRON_ARGS>
'
```

Submit:

```bash
mkdir -p logs && JOB_ID=$(sbatch --parsable run_megatron.slurm)
echo "Submitted ${JOB_ID}"
```

## Multi-node rules

- Submit from the worktree you intend to run, or `cd` to it in the script. All nodes must reach the same path on a shared filesystem (NFS, Lustre, or similar) — node-local paths will not be visible to peer ranks.
- Use one `torchrun` worker group across all nodes; do not start independent single-node jobs.
- `--nproc-per-node` should equal the number of visible GPUs per node.
- Write checkpoints, tensorboard data, and structured logs to shared storage.

## CUDA_DEVICE_MAX_CONNECTIONS

The right value depends on your hardware and parallelism mode. Do not export it unconditionally:

- **Pre-Blackwell (Hopper, Ampere) with TP>1 or CP>1, non-FSDP:** set to `1`. The relevant code path asserts on this — you will get an assertion error if it is not `1`, not a silent deadlock.
- **Blackwell:** not required; setting it has no effect.
- **Torch-FSDP2 or Megatron-FSDP:** must NOT be `1`. Leave the env var unset, or set it to a value greater than `1`.
- **`overlap_moe_expert_parallel_comm` enabled:** set to `32`.

Set it explicitly in the sbatch script when your configuration calls for it.

## Containers

Many sites run Megatron-LM inside a container (enroot/pyxis on some clusters, singularity on others). If you do, the uv-managed `.venv` must live on a path that is visible from inside the container, and the container image must provide the CUDA / NCCL / torch versions the repo expects (see `docker/.ngc_version.dev` and `.ngc_version.lts`). The skeleton above stays the same; wrap the `srun` invocation with your scheduler's container flags (`--container-image=…`, `--container-mounts=…`, etc.).

## Monitor and collect

```bash
squeue -j "$JOB_ID" -o "%.10i %.8T %.10M %.6D %R"
sacct -j "$JOB_ID" --format=JobID,State,ExitCode,Elapsed
scancel "$JOB_ID"
```

If your training script writes a result artifact (a JSON metrics file from rank 0, a final checkpoint, etc.), poll for the artifact rather than waiting only on `squeue` state. Useful output usually appears before SLURM marks the job complete, and polling on the artifact lets you cancel the job as soon as it lands instead of holding the allocation until the timeout.

## Failure diagnosis

Scan stderr from every rank, not just rank 0. The earliest non-NCCL Python traceback is usually the root cause; later NCCL timeouts on other ranks are downstream symptoms of the first crash.

Classify quickly:

- **OOM**: record rank, phase (forward / backward / optimizer), batch size, sequence length, parallelism (TP/DP/CP/PP), and peak memory before adjusting.
- **Shape / divisibility error**: check `WORLD_SIZE = TP × DP × CP × PP` and head-count divisibility (`num_attention_heads % TP == 0`).
- **Import error**: wrong worktree, missing `uv sync`, or stale `PYTHONPATH`. Confirm `cd <MEGATRON_WORKTREE>` before launch.
- **NCCL failure** with no Python traceback: verify allocation, port reachability, `MASTER_ADDR` resolution, and command consistency across ranks.

## Common pitfalls

- Forgetting `uv sync` before the first submission. If the venv is missing, every job rebuilds it from inside `srun`, costing minutes per job.
- Writing logs to a node-local path that disappears at job exit. Always write to the shared filesystem.
- Setting `CUDA_DEVICE_MAX_CONNECTIONS=1` blindly. The right value depends on hardware and parallelism mode (see the dedicated section above). Setting it to `1` with FSDP causes a different problem; on Blackwell it has no effect; on pre-Blackwell with TP>1 or CP>1 (non-FSDP) the code asserts, it does not deadlock.
- Running bare `torchrun` instead of `uv run python -m torch.distributed.run`. Bare `torchrun` may dispatch through a python interpreter that does not see venv packages, depending on how the venv is set up.
