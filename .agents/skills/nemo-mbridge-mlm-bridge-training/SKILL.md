---
name: nemo-mbridge-mlm-bridge-training
description: Run Megatron-LM (MLM) and Megatron Bridge training with mock or real data. Covers correlation testing, available recipes, and multi-GPU examples.
license: Apache-2.0
when_to_use: Running training, comparing MLM vs Bridge loss curves, translating MLM CLI args to Bridge config, or investigating why loss curves diverged after a commit; 'how do I run training', 'MLM vs Bridge', 'correlation test'.
---

# MLM vs Bridge Training

For how they differ, the arg mapping tables, gotchas, and translation script, see:

- @docs/megatron-lm-to-megatron-bridge.md

## First Answer Checklist

For MLM-vs-Bridge correlation questions, always name these items up front:

1. Bridge recipe: `vanilla_gpt_pretrain_config`.
2. Bridge entry point: `scripts/training/run_recipe.py`.
3. MLM entry point: `3rdparty/Megatron-LM/pretrain_gpt.py`.
4. Launch wrapper for both: `uv run python -m torch.distributed.run`.
5. Fresh-run cleanup: `rm -rf nemo_experiments` before the Bridge run.

Also state that MLM needs
`PYTHONPATH=3rdparty/Megatron-LM:$PYTHONPATH`, matched Bridge and MLM losses
should agree within BF16 rounding, and files under `3rdparty/Megatron-LM/`
should not be modified from this repo.

## Correlation Testing

Use `vanilla_gpt_pretrain_config` for loss-correlation testing. This recipe uses
bare `GPTModelProvider` defaults (LayerNorm, GeLU, learned_absolute position
embeddings, `vocab_size` inherited from tokenizer) — matching MLM
`pretrain_gpt.py` defaults with no args.

### MLM Correlation Run (2L/256H, 1 GPU)

```bash
PYTHONPATH=3rdparty/Megatron-LM:$PYTHONPATH \
uv run python -m torch.distributed.run --nproc_per_node=1 \
  3rdparty/Megatron-LM/pretrain_gpt.py \
  --num-layers 2 --hidden-size 256 --num-attention-heads 4 \
  --ffn-hidden-size 1024 --seq-length 512 --max-position-embeddings 512 \
  --micro-batch-size 4 --global-batch-size 32 \
  --train-iters 10 --eval-iters 2 --eval-interval 10 \
  --mock-data --bf16 --use-mcore-models \
  --tokenizer-type NullTokenizer --vocab-size 32000 \
  --lr 3e-4 --min-lr 3e-5 --seed 1234 --log-interval 1
```

### Bridge Correlation Run (same config, 1 GPU)

```bash
rm -rf nemo_experiments && \
uv run python -m torch.distributed.run --nproc_per_node=1 \
  scripts/training/run_recipe.py \
  --recipe vanilla_gpt_pretrain_config \
  model.num_layers=2 model.hidden_size=256 \
  model.num_attention_heads=4 model.ffn_hidden_size=1024 \
  model.seq_length=512 dataset.sequence_length=512 \
  train.train_iters=10 train.global_batch_size=32 train.micro_batch_size=4 \
  validation.eval_interval=10 validation.eval_iters=2 \
  optimizer.lr=3e-4 optimizer.min_lr=3e-5 \
  scheduler.lr_warmup_iters=1 scheduler.lr_decay_iters=10 \
  rng.seed=1234 logger.log_interval=1
```

### Verification

With matched parameters the LM losses should be nearly identical at each
iteration. Compare `lm loss` values from both logs — they should agree to
within BF16 rounding.

## Multi-GPU Examples

### MLM 2-GPU with TP=2

```bash
PYTHONPATH=3rdparty/Megatron-LM:$PYTHONPATH \
uv run python -m torch.distributed.run --nproc_per_node=2 \
  3rdparty/Megatron-LM/pretrain_gpt.py \
  --tensor-model-parallel-size 2 --sequence-parallel \
  --num-layers 4 --hidden-size 256 --num-attention-heads 4 \
  --seq-length 1024 --max-position-embeddings 1024 \
  --micro-batch-size 2 --global-batch-size 16 \
  --train-iters 10 --eval-iters 2 --eval-interval 10 \
  --mock-data --bf16 --use-mcore-models \
  --tokenizer-type NullTokenizer --vocab-size 1024 \
  --lr 1e-4 --log-interval 1
```

### Bridge 2-GPU with TP=2

```bash
rm -rf nemo_experiments && \
uv run python -m torch.distributed.run --nproc_per_node=2 \
  scripts/training/run_recipe.py \
  --recipe vanilla_gpt_pretrain_config \
  model.tensor_model_parallel_size=2 model.sequence_parallel=true \
  model.num_layers=4 model.hidden_size=256 \
  model.num_attention_heads=4 model.ffn_hidden_size=1024 \
  model.seq_length=1024 dataset.sequence_length=1024 \
  train.train_iters=10 train.global_batch_size=16 train.micro_batch_size=2 \
  validation.eval_interval=10 validation.eval_iters=2 \
  scheduler.lr_warmup_iters=2 scheduler.lr_decay_iters=10 \
  logger.log_interval=1
```

## Available Recipes

Common recipes (use with `--recipe`):

- `vanilla_gpt_pretrain_config` — Minimal GPT (bare GPTModelProvider defaults,
  ideal for correlation testing and custom configs)
- `llama32_1b_pretrain_config` — Llama 3.2 1B (16L, 2048H, GBS=512, seq=8192)
- `llama3_8b_pretrain_config` — Llama 3 8B
- `qwen3_8b_pretrain_config` — Qwen3 8B
- `deepseek_v2_lite_pretrain_config` — DeepSeek-V2-Lite 16B MoE

SFT/PEFT variants use `_sft_config` / `_peft_config` suffix.

## Megatron-Core Submodule

For what the submodule is and why two versions exist, see
@docs/megatron-lm-to-megatron-bridge.md.

### Check current version

```bash
./scripts/switch_mcore.sh status
```

### Switch to dev for testing newer MCore features

```bash
./scripts/switch_mcore.sh dev

# uv sync (without --locked) since lockfile is for main
uv sync
```

### Switch back to main

```bash
./scripts/switch_mcore.sh main
```

### After pulling latest main

When you pull the latest Bridge main branch, the submodule pointer may have
been updated. Re-sync the submodule:

```bash
git submodule update --init 3rdparty/Megatron-LM
```

## Pitfalls

1. **Always `rm -rf nemo_experiments`** before a fresh correlation run. Bridge
   auto-resumes from stale checkpoints silently.

2. **`uv run` required**: Always use `uv run python -m torch.distributed.run`
   (not bare `torchrun` or `python`).

3. **MLM PYTHONPATH**: Must include `3rdparty/Megatron-LM` so `gpt_builders.py`
   is importable.

4. **Scheduler overrides**: When overriding `train.train_iters` to a small
   value, also set `scheduler.lr_warmup_iters` and `scheduler.lr_decay_iters`
   or you get an assertion error.

5. **Use `dataset.sequence_length`** in CLI overrides, not `dataset.seq_length`.

6. **MoE OOM**: Large MoE models require full activation recomputation and
   typically multi-node EP. TP does NOT reduce per-GPU expert memory.

7. **`uv sync --locked` fails after switching to dev**: The lockfile is generated
   against the main MCore commit. Use `uv sync` (without `--locked`) when on dev.
