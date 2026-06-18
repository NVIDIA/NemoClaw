# Multi-Node Slurm Templates

## Full Template

```bash
#!/bin/bash
# ==============================================================================
# <MODEL_NAME> <pretrain|sft> — <Framework: MLM | Megatron Bridge>
#
# Default: TP<X> PP<Y> EP<Z>, NNODES=<N> (<N*8> GPUs), MBS=<M>, GBS=<G>
#
# Usage:
#   sbatch <script_name>.sh
# ==============================================================================

#SBATCH --job-name=<job-name>
#SBATCH --nodes=<NNODES>
#SBATCH --ntasks-per-node=1
#SBATCH --gpus-per-node=8
#SBATCH --time=00:30:00
#SBATCH --account=<YOUR_ACCOUNT>
#SBATCH --partition=batch
#SBATCH --output=<SHARED_FS>/logs/<job_name>_%j.log
#SBATCH --exclusive

# ── Container ────────────────────────────────────────────────────────────
CONTAINER_IMAGE="<PATH_TO_YOUR_CONTAINER>.sqsh"
CONTAINER_MOUNTS="<SHARED_FS>:<SHARED_FS>,<PATH_TO_MEGATRON_BRIDGE>:/opt/Megatron-Bridge,<PATH_TO_DATA>:/opt/data"

# ── Paths ────────────────────────────────────────────────────────────────
WORKDIR="/opt/Megatron-Bridge"
LOGDIR="<SHARED_FS>/logs/<logdir_name>"
DATA_PATH="<PATH_TO_PREPROCESSED_DATA>/dclm_01_01_text_document"

# ── Parallelism ──────────────────────────────────────────────────────────
TP=1; PP=1; EP=1

# ── Training ─────────────────────────────────────────────────────────────
MBS=1; GBS=256
SEQ=4096
SEED=1234
TRAIN_ITERS=20

# ── Tokens / Caches ──────────────────────────────────────────────────────
# Provide tokens through the scheduler environment or a chmod 600 secrets file.
# Never hardcode token values in this script or write them to logs.
: "${HF_TOKEN:?Set HF_TOKEN in the secure job environment before submitting}"
export HF_HOME=<SHARED_FS>/HF_HOME
export UV_CACHE_DIR="<SHARED_FS>/uv_cache"
export NEMO_HOME="<SHARED_FS>/cache/nemo"

# ── Build training command ───────────────────────────────────────────────
TRAIN_CMD="
export CUDA_DEVICE_MAX_CONNECTIONS=1 && \
export NVTE_ALLOW_NONDETERMINISTIC_ALGO=1 && \
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True && \
export NCCL_NVLS_ENABLE=0 && \
export HF_HOME=$HF_HOME && \
export UV_CACHE_DIR=$UV_CACHE_DIR && \
export NEMO_HOME=$NEMO_HOME && \
wandb login \$WANDB_API_KEY && \
mkdir -p $LOGDIR && \
cd $WORKDIR && \
uv sync && \
<TRAINING_COMMAND_HERE>
"

echo \"======================================\"
echo \"<MODEL_NAME> <Framework> Pretrain\"
echo \"Job: \$SLURM_JOB_ID | Nodes: \$SLURM_JOB_NUM_NODES\"
echo \"TP=\$TP PP=\$PP EP=\$EP MBS=\$MBS GBS=\$GBS\"
echo \"======================================\"

# Phase 1: Single-process uv sync to build/populate the shared cache
srun --mpi=pmix -N 1 --ntasks=1 \
  --container-image="$CONTAINER_IMAGE" \
  --container-mounts="$CONTAINER_MOUNTS" \
  --no-container-mount-home \
  bash -c "cd $WORKDIR && uv sync"

# Phase 2: Full multi-node run (uv sync in TRAIN_CMD is a fast no-op)
srun --mpi=pmix --no-kill \
  --container-image="$CONTAINER_IMAGE" \
  --container-mounts="$CONTAINER_MOUNTS" \
  --no-container-mount-home \
  bash -c "$TRAIN_CMD" 2>&1 | tee "$LOGDIR/<prefix>_${SLURM_JOB_ID}.log"

echo ""
echo "======================================"
echo "Done. Losses:"
echo "======================================"
grep -E "iteration\s+" "$LOGDIR/<prefix>_${SLURM_JOB_ID}.log" | grep -iE "lm loss|reduced_train_loss" | head -25
```

## Bridge-Specific TRAIN_CMD Body

```bash
rm -rf nemo_experiments && \
uv run python -m torch.distributed.run \
  --nproc_per_node=8 \
  --nnodes=\${SLURM_JOB_NUM_NODES} \
  --node_rank=\${SLURM_NODEID} \
  scripts/training/run_recipe.py \
  --recipe <recipe_name> \
  model.tensor_model_parallel_size=$TP \
  model.pipeline_model_parallel_size=$PP \
  ...overrides...
```

## MLM-Specific TRAIN_CMD Body

```bash
PYTHONPATH=${WORKDIR}/3rdparty/Megatron-LM:\${PYTHONPATH:-} \
uv run python -m torch.distributed.run \
  --nproc_per_node=8 \
  --nnodes=\${SLURM_JOB_NUM_NODES} \
  --node_rank=\${SLURM_NODEID} \
  3rdparty/Megatron-LM/pretrain_gpt.py \
  --tensor-model-parallel-size $TP \
  --pipeline-model-parallel-size $PP \
  ...args...
```
