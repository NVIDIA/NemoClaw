---
name: nemo-mbridge-recipe-recommender
license: Apache-2.0
description: Recommend and customize Megatron Bridge recipes for a user's model, GPU count, and training goal. Indexes library recipes (pretrain/SFT/PEFT) and performance recipes.
when_to_use: User wants a starting recipe or training config; 'which recipe', 'recommend recipe', 'how to train Llama', 'starting config for X GPUs', 'what recipe for SFT'.
---

# Auto Recipe — Recipe Index & Recommendation

This skill indexes every shipped recipe and helps users pick the right starting
config, adjust parallelism, and avoid common pitfalls.

## How to Use This Skill

1. Ask the user for: **model name/size**, **GPU count & type**, **training goal**
   (pretrain / SFT / PEFT), and **sequence length** (if non-default).
2. Look up the best-match recipe in the index below.
3. Recommend the recipe function name + entry-point command.
4. Provide adjustment advice (parallelism resizing, batch tuning, pitfalls).

## First Answer Checklist

When recommending recipes, always include these distinctions before the long
index details:

1. **Library recipes** under `src/megatron/bridge/recipes/` are for functional
   training and use `scripts/training/run_recipe.py`.
2. **Performance recipes** under `scripts/performance/` are for upper-bound
   throughput benchmarks. They use mock data and should not be presented as
   production training recipes.
3. For a first-time Bridge smoke test, recommend `llama3_8b_sft_config` with
   mock data via `--dataset llm-pretrain-mock`. Do not use `llm-finetune` for
   the setup-only tryout unless the user specifically asks for an SFT data path.
4. For normal SFT recommendations, use `--dataset llm-finetune`; for pretrain
   and mock validation recommendations, use `--dataset llm-pretrain-mock`.
5. After the recipe and dataset, give the required resizing rules: TP must
   divide `num_key_value_heads`, keep TP within one node unless using
   NVL72-class interconnect, enable SP when TP > 1, configure CP for long
   context, DP is implicit, and reduce `micro_batch_size` first on OOM.

---

## Entry Points

### Library recipes (functional training)

```bash
# Pretrain with mock data
uv run python -m torch.distributed.run --nproc_per_node=8 scripts/training/run_recipe.py \
    --recipe <recipe_function_name> \
    --dataset llm-pretrain-mock

# SFT with SQuAD
uv run python -m torch.distributed.run --nproc_per_node=8 scripts/training/run_recipe.py \
    --recipe <recipe_function_name> \
    --dataset llm-finetune

# Override any field via CLI
uv run python -m torch.distributed.run --nproc_per_node=8 scripts/training/run_recipe.py \
    --recipe llama3_8b_pretrain_config \
    --dataset llm-pretrain-mock \
    'model.tensor_model_parallel_size=2' \
    'training.global_batch_size=64'
```

### Performance recipes (throughput benchmarks)

```bash
python scripts/performance/run_script.py \
    --recipe <model_family> \
    --gpu_type h100 \
    --num_gpus 64 \
    --data mock
```

See the Performance Recipe Index for important caveats before using these for anything beyond throughput benchmarking.

---

## Recipe Unification (Coming Soon — PR #2803)

PR [#2803](https://github.com/NVIDIA-NeMo/Megatron-Bridge/pull/2803) is
unifying performance recipes into the same **Python function** format used by
library recipes. Key changes:

- Perf recipes move from `scripts/performance/configs/` → `src/megatron/bridge/recipes/<family>/<model>_perf.py`
- Each perf recipe becomes a **self-contained Python function** (e.g. `llama3_8b_h100_bf16_pretrain_config()`)
- The old `WorkloadBaseConfig` → `set_workload_base_configs` → `get_perf_optimized_recipe` pipeline is removed
- Shared helpers: `_benchmark_common()` (50 iters, timing, TE RNG), `_perf_precision()` (bf16 / fp8_cs / fp8_mx / nvfp4)

**Why Python, not YAML?** Previous YAML-based approaches had problems:
recipe logic was split across multiple indirection layers, configs were not
self-contained, and the two-level pipeline made maintenance and debugging
difficult. Python functions are explicit, greppable, and composable.

After #2803 lands, both library and perf recipes will be invocable through the
same `run_recipe.py` entry point.

---

## Library Recipe Index

All recipes live under `src/megatron/bridge/recipes/`. Each function returns a
`ConfigContainer` with model, training, optimizer, and data settings.

### Llama

| Recipe | Mode | TP | PP | CP | SP | GPUs (min) | Seq Len |
|--------|------|----|----|----|----|------------|---------|
| `llama2_7b_pretrain_config` | Pretrain | 2 | 1 | — | — | 2 | 4K |
| `llama3_8b_pretrain_config` | Pretrain | 2 | 1 | — | ✓ | 2 | 8K |
| `llama3_8b_16k_pretrain_config` | Pretrain | 2 | 1 | 2 | ✓ | 4 | 16K |
| `llama3_8b_64k_pretrain_config` | Pretrain | 2 | 1 | 4 | ✓ | 8 | 64K |
| `llama3_8b_128k_pretrain_config` | Pretrain | 2 | 1 | 8 | ✓ | 16 | 128K |
| `llama3_70b_pretrain_config` | Pretrain | 8 | 4 | — | ✓ | 32 | 8K |
| `llama3_70b_16k_pretrain_config` | Pretrain | 8 | 4 | 2 | ✓ | 64 | 16K |
| `llama3_70b_64k_pretrain_config` | Pretrain | 8 | 4 | 4 | ✓ | 128 | 64K |
| `llama31_405b_pretrain_config` | Pretrain | 8 | 16 | — | ✓ | 128 | 8K |
| `llama3_8b_sft_config` | SFT | 2 | 1 | — | ✓ | 2 | 8K |
| `llama3_70b_sft_config` | SFT | 4 | 4 | — | ✓ | 16 | 8K |
| `llama31_405b_sft_config` | SFT | 8 | 8 | — | ✓ | 64 | 8K |
| `llama3_8b_peft_config` | PEFT | 1 | 1 | — | — | 1 | 8K |
| `llama3_70b_peft_config` | PEFT | 2 | 4 | — | ✓ | 8 | 8K |
| `llama31_405b_peft_config` | PEFT | 4 | 8 | — | ✓ | 32 | 8K |

### Qwen2 / Qwen2.5

| Recipe | Mode | TP | PP | Sizes |
|--------|------|----|----|-------|
| `qwen2_*_{pretrain,sft,peft}_config` | All | 1–8 | 1–4 | 500M, 1.5B, 7B, 14B, 32B, 72B |
| `qwen25_*_{pretrain,sft,peft}_config` | All | 1–8 | 1–4 | 500M, 1.5B, 3B, 7B, 14B, 32B, 72B |

### Qwen3 (Dense)

| Recipe | Mode | TP | PP | CP | Sizes |
|--------|------|----|----|-----|-------|
| `qwen3_*_pretrain_config` | Pretrain | 1–8 | 1–2 | — | 600M–32B |
| `qwen3_*_sft_config` | SFT | 1–8 | 1–2 | — | 600M–32B |
| `qwen3_600m_sft_128k_config` | SFT | 1 | 1 | 8 | 600M (128K seq) |
| `qwen3_*_peft_config` | PEFT | 1 | 1 | — | 600M–32B |

### Qwen3 MoE

| Recipe | Mode | TP | PP | EP | CP | GPUs |
|--------|------|----|----|----|----|------|
| `qwen3_30b_a3b_pretrain_config` | Pretrain | 1 | 1 | 8 | — | 8 |
| `qwen3_30b_a3b_sft_config` | SFT | 1 | 1 | 8 | — | 8 |
| `qwen3_30b_a3b_peft_config` | PEFT | 1 | 1 | 1 | — | 1 |
| `qwen3_235b_a22b_pretrain_config` | Pretrain | 4 | 16 | 8 | 2 | 512+ |
| `qwen3_235b_a22b_sft_config` | SFT | 4 | 8 | 8 | — | 256 |
| `qwen3_235b_a22b_peft_config` | PEFT | 1 | 4 | 4 | — | 16 |

### Qwen3-Next

| Recipe | Mode | TP | PP | EP |
|--------|------|----|----|-----|
| `qwen3_next_80b_a3b_pretrain_config` | Pretrain | 1 | 4 | 8 |
| `qwen3_next_80b_a3b_sft_config` | SFT | 1 | 2 | 8 |
| `qwen3_next_80b_a3b_peft_config` | PEFT | 1 | 1 | 4 |

### DeepSeek

| Recipe | Mode | TP | PP | EP | GPUs |
|--------|------|----|----|-----|------|
| `deepseek_v2_lite_pretrain_config` | Pretrain | 1 | 1 | 8 | 8 |
| `deepseek_v2_pretrain_config` | Pretrain | 1 | 4 | 32 | 128 |
| `deepseek_v3_pretrain_config` | Pretrain | 2 | 16 | 64 | 2048 |
| `deepseek_v3_pretrain_config_32nodes` | Pretrain | 2 | 8 | 32 | 256 |

### GLM-4.5

| Recipe | Mode | TP | PP | EP | GPUs |
|--------|------|----|----|-----|------|
| `glm45_355b_pretrain_config` | Pretrain | 2 | 8 | 16 | 256 |
| `glm45_air_106b_pretrain_config` | Pretrain | 1 | 4 | 8 | 32 |
| `glm45_355b_sft_config` | SFT | 2 | 8 | 16 | 256 |
| `glm45_air_106b_sft_config` | SFT | 1 | 4 | 8 | 32 |
| `glm45_355b_peft_config` | PEFT | 2 | 4 | 4 | 32 |
| `glm45_air_106b_peft_config` | PEFT | 1 | 2 | 4 | 8 |

### Gemma

| Recipe | Mode | TP | PP | Sizes |
|--------|------|----|----|-------|
| `gemma2_*_{pretrain,sft,peft}_config` | All | 2–8 | 1–2 | 2B, 9B, 27B |
| `gemma3_1b_{pretrain,sft,peft}_config` | All | 1 | 1 | 1B (32K seq) |

### NemotronH / Nemotron

| Recipe | Mode | TP | PP | EP | Notes |
|--------|------|----|----|-----|-------|
| `nemotronh_{4b,8b,47b,56b}_*_config` | P/S/PEFT | 1–8 | 1–4 | — | Dense SSM-hybrid |
| `nemotron_3_nano_*_config` | P/S/PEFT | varies | 1 | 8 | MoE + Mamba |
| `nemotron_3_super_*_config` | P/S/PEFT | 4 | 1 | 8 | MoE + Mamba, ~40% CUDA graph gain |
| `nemotron_nano_{9b,12b}_v2_*_config` | P/S/PEFT | varies | 1 | — | Dense |

### Other Models

| Recipe | Mode | Notes |
|--------|------|-------|
| `moonlight_16b_{pretrain,sft,peft}_config` | All | MoE EP=8 |
| `olmoe_7b_{pretrain,sft,peft}_config` | All | MoE EP=8 |
| `ministral3_{3b,8b,14b}_{sft,peft}_config` | SFT/PEFT | Dense |
| `gpt_oss_20b_*_config` | All | MoE + FP8/MXFP8 variants |
| `gpt_oss_120b_*_config` | All | MoE |
| `vanilla_gpt_pretrain_config` | Pretrain | MLM/Bridge parity baseline |
| `gpt3_175b_pretrain_config` | Pretrain | TP=4, PP=8, VP=6 |
| `kimi_k2_pretrain_config` | Pretrain | 1T MoE, TP=2 PP=16 EP=32 |

### VLM Recipes

| Recipe | Mode | TP | PP | EP | GPUs |
|--------|------|----|----|-----|------|
| `gemma3_vl_{4b,12b,27b}_{sft,peft}_config` | SFT/PEFT | 1–8 | 1–2 | — | 1–16 |
| `qwen25_vl_{3b,7b,32b,72b}_{sft,peft}_config` | SFT/PEFT | 1–8 | 1–4 | — | 1–32 |
| `qwen3_vl_{8b,30b_a3b,235b_a22b}_{sft,peft}_config` | SFT/PEFT | 1–4 | 1–8 | 1–32 | 1–512 |
| `qwen35_vl_*_{sft,peft}_config` | SFT/PEFT | varies | varies | varies | varies |
| `glm_45v_{sft,peft}_config` | SFT/PEFT | 1 | 8 | 4–16 | 64–512 |
| `nemotron_nano_v2_vl_12b_{sft,peft}_config` | SFT/PEFT | 2–4 | 1 | — | 8 |

### Diffusion Recipes

| Recipe | Mode | TP | CP |
|--------|------|----|----|
| `wan_1_3B_{pretrain,sft}_config` | P/SFT | 1 | 8 |
| `wan_14B_{pretrain,sft}_config` | P/SFT | 2 | 4 |
| `flux_12b_{pretrain,sft}_config` | P/SFT | 2 | 1 |

---

## Performance Recipe Index

All perf recipes live under `scripts/performance/`. They are invoked via
`run_script.py` and use `WorkloadBaseConfig` presets per GPU type.

> **Important:** Perf recipes are designed for **upper-bound throughput
> benchmarks**, not production training. They run **50 iterations** on **mock
> data** by default. Throughput numbers are aspirational targets, not validated
> convergence configs.

### Llama 3 / 3.1

| Model | GPUs | GPU Types | Key Features |
|-------|------|-----------|--------------|
| Llama 3 8B | 8 | H100, B200, B300, GB200, GB300, R100 | CUDA graphs (local), FSDP on GB variants |
| Llama 3 70B | 64 | H100, B200, B300, GB200, GB300 | TP comm overlap (userbuffers), FSDP, CUDA graphs |
| Llama 3.1 405B | 128–1024 | H100, B200, B300, GB200, GB300 | TP+CP comm overlap (userbuffers), FSDP, heavy PP/VP |

SFT/LoRA variants also exist (e.g. 8B SFT with packed sequences, 70B SFT on 32 GPUs).

### DeepSeek V3

| Model | GPUs | GPU Types | Key Features |
|-------|------|-----------|--------------|
| DeepSeek V3 (671B MoE) | 256–1024 | H100, B200, B300, GB200, GB300 | HybridEP dispatcher, MLA recompute, CUDA graphs (TE scoped) |

### Qwen3 MoE

| Model | GPUs | GPU Types | Key Features |
|-------|------|-----------|--------------|
| Qwen3 30B-A3B | 8–16 | H100, B200, B300, GB200, GB300 | MoE alltoall/flex dispatcher |
| Qwen3 235B-A22B | 64–256 | H100, B200, B300, GB200, GB300 | TP comm overlap, CUDA graphs, MoE a2a overlap |
| Qwen3-Next 80B-A3B | 64–128 | H100, B200, B300, GB200, GB300 | EP 64–128 |

### Qwen3-VL

| Model | GPUs | GPU Types | Key Features |
|-------|------|-----------|--------------|
| Qwen3-VL 30B-A3B | 8–16 | H100, B200, B300, GB200, GB300 | VLM + MoE |
| Qwen3-VL 235B-A22B | 64–256 | H100, B200, B300, GB200, GB300 | VLM + MoE, TP comm overlap |

### Kimi K2

| Model | GPUs | GPU Types | Key Features |
|-------|------|-----------|--------------|
| Kimi K2 (1T MoE) | 256–1024 | H100, B200, B300, GB200, GB300 | Muon/Adam optimizer, HybridEP, pipeline layout helpers |

### NemotronH

| Model | GPUs | GPU Types | Key Features |
|-------|------|-----------|--------------|
| Nemotron 3 Nano (30B MoE+Mamba) | 8–16 | H100, B200, B300, GB200, GB300 | TE CUDA graphs (attn+mamba+moe), HybridEP |
| Nemotron 3 Super | 64 | H100, B200, B300, GB200, GB300 | TE CUDA graphs, EP=64 |
| NemotronH 56B | 64 | H100, B200, B300 | TP=2–8, TE graphs (mamba+attn) |

### GPT-OSS

| Model | GPUs | GPU Types | Key Features |
|-------|------|-----------|--------------|
| GPT-OSS 120B | 64 | H100, B200, GB200 | EP=64, HybridEP on GB200 |

---

## Recommendation Decision Tree

```text
User wants to train a model
│
├─ Know the model name?
│   ├─ Yes → Look up in Library Recipe Index above
│   │   ├─ Has a recipe for their size + mode? → Use it directly
│   │   └─ No exact match? → Use closest size, adjust parallelism
│   └─ No → Ask for model name, size, and HF model ID
│
├─ What's the training goal?
│   ├─ Pretrain → Use *_pretrain_config
│   ├─ SFT (full fine-tune) → Use *_sft_config
│   └─ PEFT (LoRA/DoRA) → Use *_peft_config (lowest GPU requirement)
│
├─ How many GPUs?
│   ├─ 1 GPU → Only PEFT recipes work (TP=1, PP=1)
│   ├─ 8 GPUs (1 node) → Most 8B–16B models, small MoE (EP=8)
│   ├─ 16–64 GPUs → 70B dense, medium MoE
│   └─ 128+ GPUs → 405B+, large MoE (DeepSeek V3, Kimi K2)
│
├─ Want throughput benchmarks?
│   ├─ Yes → Use perf recipes (scripts/performance/)
│   │   └─ ⚠️ These run on mock data for upper-bound perf only
│   └─ No → Use library recipes (scripts/training/run_recipe.py)
│
└─ Long context?
    ├─ > 8K → Need CP (context parallelism), check *_16k / *_64k / *_128k variants
    └─ ≤ 8K → Default recipes work
```

---

## Adjustment Advice (When Recommending)

### Parallelism Resizing Rules

When the user's GPU count differs from the recipe default:

1. **TP must divide `num_key_value_heads`** (GQA constraint). E.g. if
   `num_key_value_heads=8`, valid TP = {1, 2, 4, 8}.
2. **TP should stay within a single node** (NVLink). TP > 8 requires
   inter-node NVLink (e.g., GB200 NVL72).
3. **PP adds pipeline bubbles.** Minimize PP; only increase when TP alone can't
   fit the model. Use VP (virtual pipeline) to mitigate bubble overhead.
4. **EP doesn't reduce dense-layer memory.** Only expert parameters shard with
   EP. Shared attention/embeddings are replicated. For "OOM with MoE", increase
   EP first, not TP.
5. **SP should be True whenever TP > 1.** It eliminates redundant activation
   copies and is essentially free.
6. **CP requires all-to-all or ring attention.** Check `cp_comm_type`. For
   GQA models, `a2a+p2p` hierarchical CP allows CP > num_kv_heads.
7. **world_size = DP × TP × PP × CP × EP.** DP is implicit. Make sure the
   product of explicit parallelisms divides your total GPU count.

### Batch Size Tuning

- Start with the recipe's `micro_batch_size`. If OOM, reduce to 1.
- `global_batch_size` determines learning dynamics. Scale with DP:
  `GBS = micro_batch_size × DP × gradient_accumulation_steps`.
- For MoE, `micro_batch_size=1` is typical at scale.

### Common Pitfalls to Warn About

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| TP > num_kv_heads | Crash: "TP must divide num_query_groups" | Reduce TP to a divisor of num_kv_heads |
| PP without VP | Poor throughput (large bubble) | Set `virtual_pipeline_model_parallel_size` |
| EP too low for large MoE | OOM on expert params | Increase EP; each expert lives on EP/num_experts ranks |
| CUDA graphs + packed sequences | Assert: "CUDA graph accepts only Tensor inputs" | Disable packing or use `local` full-iteration graphs |
| CUDA graphs + full recompute | Assert: "full recompute only with full iteration CUDA graph" | Disable recompute or switch to `local` impl |
| `use_te_rng_tracker` not set | Assert on provider init when CUDA graphs enabled | Set `cfg.model.use_te_rng_tracker = True` and `cfg.rng.te_rng_tracker = True` |
| FSDP + TP > 1 on H100 | Possible comm bottleneck | Prefer FSDP with TP=1 or TP=2 on H100; FSDP shines on GB/B-series |
| Long context without CP | OOM on activations | Add CP=2/4/8; use `*_16k`, `*_64k`, or `*_128k` recipe variants |
| MoE `overlap_grad_reduce` on H100 | May hurt perf (False in many H100 presets) | Set `overlap_grad_reduce=False` for MoE on H100 |
| VLM SFT missing image data | Runs but produces garbage | Provide actual multimodal dataset or use mock VLM data |
| Qwen35-VL MoE FSDP | Tested on Blackwell only | May not work on H100; validate first |

### Recipe Override Examples

```bash
# Scale Llama3 8B from 2 GPUs to 8 GPUs (increase DP)
uv run python -m torch.distributed.run --nproc_per_node=8 scripts/training/run_recipe.py \
    --recipe llama3_8b_pretrain_config \
    --dataset llm-pretrain-mock

# Reduce parallelism for Qwen3-MoE 30B to fit on 4 GPUs
uv run python -m torch.distributed.run --nproc_per_node=4 scripts/training/run_recipe.py \
    --recipe qwen3_30b_a3b_sft_config \
    --dataset llm-finetune \
    'model.expert_model_parallel_size=4'

# Add long context to an existing recipe
uv run python -m torch.distributed.run --nproc_per_node=8 scripts/training/run_recipe.py \
    --recipe llama3_8b_pretrain_config \
    --dataset llm-pretrain-mock \
    'model.seq_length=32768' \
    'model.context_parallel_size=4'

# Enable CUDA graphs on any recipe
uv run python -m torch.distributed.run --nproc_per_node=8 scripts/training/run_recipe.py \
    --recipe qwen3_30b_a3b_pretrain_config \
    --dataset llm-pretrain-mock \
    'model.cuda_graph_impl=transformer_engine' \
    'model.cuda_graph_scope=[attn,moe_router,moe_preprocess]' \
    'model.use_te_rng_tracker=True' \
    'rng.te_rng_tracker=True'
```

---

## Quick Reference: Which Recipe for My Situation?

| I want to... | Start with | GPUs needed |
|---|---|---|
| Try Bridge for the first time | `llama3_8b_sft_config` + mock data | 2 |
| Fine-tune a 7-8B model | `llama3_8b_sft_config` or `qwen3_8b_sft_config` | 2–8 |
| LoRA on 1 GPU | `llama3_8b_peft_config` or `qwen3_8b_peft_config` | 1 |
| Pretrain a dense 70B | `llama3_70b_pretrain_config` | 32–64 |
| Train a small MoE | `qwen3_30b_a3b_pretrain_config` | 8 |
| Train a large MoE (235B+) | `qwen3_235b_a22b_pretrain_config` | 256–512 |
| Benchmark throughput | Perf recipes via `run_script.py` | Varies |
| Long-context training | `llama3_8b_128k_pretrain_config` or add CP override | 16+ |
| VLM fine-tuning | `qwen3_vl_8b_sft_config` or `gemma3_vl_*_sft_config` | 4–8 |
| Diffusion training | `wan_1_3B_pretrain_config` or `flux_12b_pretrain_config` | 8 |

---

## Code Anchors

| What | Path |
|------|------|
| Library recipes root | `src/megatron/bridge/recipes/` |
| Recipe `__init__.py` (all exports) | `src/megatron/bridge/recipes/__init__.py` |
| Common recipe helpers | `src/megatron/bridge/recipes/common.py` |
| Training entry point | `scripts/training/run_recipe.py` |
| Perf recipes root | `scripts/performance/` |
| Perf entry point | `scripts/performance/run_script.py` |
| Perf workload configs | `scripts/performance/configs/<family>/` |
| Perf overrides (benchmark defaults) | `scripts/performance/utils/overrides.py` |
