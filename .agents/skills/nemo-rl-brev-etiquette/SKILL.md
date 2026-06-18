---
name: nemo-rl-brev-etiquette
license: Apache-2.0
description: Brev instance operating guidance for NeMo-RL agents working in /home/ubuntu/RL with limited workspace disk, a larger /ephemeral volume, and optional /home/ubuntu/RL/.env secrets. Use when running nemo-rl-auto-research campaigns, experiments, training jobs, model or dataset downloads, shared cache-heavy commands, log-producing runs, checkpoint generation, W&B or Hugging Face authenticated workflows, or any workflow that may create large files on Brev.
when_to_use: Running on a Brev instance; launching nemo-rl-auto-research campaigns or long jobs; managing large logs, checkpoints, caches, datasets, Ray temp files, W&B files, or Hugging Face auth on Brev.
---

# Brev Etiquette

Operate as though `/home/ubuntu/RL` is the source checkout and `/ephemeral` is the working storage for generated experiment state. Keep the repo small, reproducible, and easy to inspect. Move bulky run outputs to `/ephemeral` before launching anything expensive.

## Storage Rules

- Keep code edits, small config changes, committed experiment hypotheses, and concise reproducibility records under `/home/ubuntu/RL`.
- Put generated experiment assets under `/ephemeral`, including checkpoints, run logs, Ray temp directories, W&B offline files, profiler traces, evaluation dumps, rollout samples, and per-experiment artifacts.
- Keep reusable caches under one shared `/ephemeral` cache root per user, not under each experiment. This includes Hugging Face models, dataset caches, PyTorch caches, Triton caches, `uv` caches, and pip caches.
- Before a campaign or long run, check capacity with `df -h /home/ubuntu/RL /ephemeral` and avoid starting if `/ephemeral` is missing or nearly full.
- Create a campaign root such as `/ephemeral/nemo-rl/${USER:-ubuntu}/nemo-rl-auto-research/<campaign>` and use one subdirectory per experiment.
- Do not leave large files, cache directories, or generated outputs in the git checkout. If a tool defaults to the repo, override its output/cache path before running it.

## Environment Secrets

- Treat `/home/ubuntu/RL/.env` as the local secret store. It may contain keys such as `WANDB_API_KEY`, `HF_TOKEN`, or `HUGGING_FACE_HUB_TOKEN`.
- Before any run that may need external auth, load `/home/ubuntu/RL/.env` when it exists. Never print, `cat`, log, commit, or summarize secret values.
- If `/home/ubuntu/RL/.env` is absent, or a required key is still unset after loading it, remind the user to add the needed key to that file before launching authenticated work.

```bash
if [ -f /home/ubuntu/RL/.env ]; then
  set -a
  . /home/ubuntu/RL/.env
  set +a
else
  echo "Missing /home/ubuntu/RL/.env; add required keys such as WANDB_API_KEY or HF_TOKEN before authenticated runs."
fi
```

## Auto-Research Pattern

When using `nemo-rl-auto-research`, keep the git ledger in the repo and heavy evidence on `/ephemeral`.

```bash
if [ -f /home/ubuntu/RL/.env ]; then
  set -a
  . /home/ubuntu/RL/.env
  set +a
fi

BREV_ROOT=/ephemeral/nemo-rl/${USER:-ubuntu}
CACHE_ROOT=$BREV_ROOT/cache
CAMPAIGN_ROOT=$BREV_ROOT/nemo-rl-auto-research/<campaign>
EXP_DIR=$CAMPAIGN_ROOT/<experiment>
mkdir -p "$EXP_DIR"/{logs,checkpoints,artifacts,ray,tmp,wandb}
mkdir -p "$CACHE_ROOT"/{huggingface,torch,triton,uv,pip,xdg,wandb}

export HF_HOME=$CACHE_ROOT/huggingface
export HF_HUB_CACHE=$HF_HOME/hub
export HF_DATASETS_CACHE=$HF_HOME/datasets
export TRANSFORMERS_CACHE=$HF_HOME/transformers
export TORCH_HOME=$CACHE_ROOT/torch
export TRITON_CACHE_DIR=$CACHE_ROOT/triton
export UV_CACHE_DIR=$CACHE_ROOT/uv
export PIP_CACHE_DIR=$CACHE_ROOT/pip
export XDG_CACHE_HOME=$CACHE_ROOT/xdg
export WANDB_CACHE_DIR=$CACHE_ROOT/wandb
export RAY_TMPDIR=$EXP_DIR/ray
export TMPDIR=$EXP_DIR/tmp
export WANDB_DIR=$EXP_DIR/wandb
```

Record the absolute `/ephemeral` paths in the nemo-rl-auto-research TSV fields for log path, checkpoint path, artifacts, shared cache root, and command. If the TSV itself may grow large, store the full TSV in `/ephemeral` and keep a small pointer file or summary in the repo.

## Launch Checklist

- Inspect disk first: `df -h /home/ubuntu/RL /ephemeral`.
- Choose a unique `/ephemeral` run root before editing recipes or launching jobs.
- Reuse a shared cache root such as `/ephemeral/nemo-rl/${USER:-ubuntu}/cache` across experiments unless a run explicitly requires a clean cache.
- Override recipe output paths, logger paths, checkpoint paths, and temp paths to point under the experiment directory.
- Override cache paths to point under the shared cache root.
- Stream stdout/stderr to `$EXP_DIR/logs/run.log` or an equivalent file under `/ephemeral`.
- Periodically check disk during long runs with `df -h /ephemeral` and stop gracefully if the volume is approaching exhaustion.
- At the end, summarize the important metrics and paths in the repo ledger; do not copy bulky artifacts back into `/home/ubuntu/RL`.

## Cleanup

- Clean only files that belong to the current campaign or experiment.
- Prefer pruning clearly named experiment directories under `/ephemeral/nemo-rl/...`; never remove shared caches or another user's run directory without an explicit instruction.
- Preserve enough small metadata in the repo to reproduce a result after `/ephemeral` is cleaned.
