---
name: nemo-mbridge-perf-activation-recompute
description: Validate and use selective and full activation recompute in Megatron Bridge to reduce GPU memory usage at the cost of extra compute.
license: Apache-2.0
when_to_use: Reducing GPU memory via activation recompute, or investigating a commit that changed recompute settings and caused OOM or a regression; 'recompute_granularity', 'recompute_num_layers', 'recompute_modules', 'recompute_method', 'selective recompute', 'full recompute', 'activation memory OOM'.
---

# Activation Recompute

Stable docs: @docs/training/activation-recomputation.md
Card: @skills/nemo-mbridge-perf-activation-recompute/card.yaml

<!-- NVSkills CI refresh: 2026-06-15. No instruction changes. -->

## What It Is

Activation recompute trades GPU compute for memory by discarding intermediate
activations during the forward pass and recomputing them during backward.
Megatron Bridge supports two granularities:

| Granularity | What you specify | What gets recomputed | Memory savings | Compute cost |
|---|---|---|---|---|
| `selective` | `recompute_modules` list (e.g. `core_attn`, `mlp`) | specific submodules within each layer | moderate (module-dependent) | low to high |
| `full` | `recompute_num_layers` + `recompute_method` | entire transformer layers (N layers) | strongest | highest |

Note: MCore names these "selective" (submodule-level) vs "full" (layer-level).
"Full" means recomputing full layers, not the full model — you still choose
how many layers via `recompute_num_layers`.

## Quick Decision

1. Rule out allocator fragmentation first with
   `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`; see
   @skills/nemo-mbridge-perf-memory-tuning/SKILL.md.
2. For activation pressure, start with selective recompute:
   `recompute_granularity="selective"` and `recompute_modules=["core_attn"]`.
3. Add modules by cost: `"layernorm"` is cheap but saves little, while `"mlp"`
   saves much more memory at a clear throughput cost.
4. Use full-layer recompute only when selective recompute does not fit, and set
   all required fields: `recompute_granularity="full"`, `recompute_method`, and
   `recompute_num_layers`.
5. With FP8 or TE-scoped CUDA graphs, avoid full-layer recompute unless graph
   scope is `full_iteration`; otherwise use selective recompute or disable TE
   graph capture.

CPU offloading (`cpu_offloading=True`) is an alternative that avoids recompute
cost entirely, but it is **incompatible with PP > 1**.

## Enablement

### Selective recompute

```python
cfg.model.recompute_granularity = "selective"
cfg.model.recompute_modules = ["core_attn"]  # add "layernorm", "mlp", or other valid modules as needed
```

### Full-layer recompute

```python
cfg.model.recompute_granularity = "full"
cfg.model.recompute_method = "uniform"
cfg.model.recompute_num_layers = 4
```

### Available recompute_modules

| Module | What it recomputes | Compute cost | Memory savings |
|---|---|---|---|
| `core_attn` | attention softmax/dropout/QKV dot product | low (Flash Attention already recomputes internally) | moderate |
| `layernorm` | layer normalization | negligible (~0%) | negligible |
| `mlp` | full FFN block | high (~16% on Llama3 70B, hidden=28672) | ~3 GB |
| `moe` | MoE expert dispatch | varies | varies |
| `moe_act` | MoE activation functions | low | small |
| `shared_experts` | shared expert layers | moderate | moderate |
| `mla_up_proj` | Multi-Latent Attention up projection | moderate | moderate |

### Performance harness CLI

```bash
uv run python scripts/performance/run_script.py \
  -m llama \
  -mr llama3_8b \
  --task pretrain \
  -g h100 \
  -c bf16 \
  -ng 8 \
  --recompute_modules core_attn,layernorm \
  ...
```

## Compatibility and Constraints

- `recompute_granularity=selective` requires a non-empty `recompute_modules` list
- `recompute_granularity=full` requires `recompute_method` and `recompute_num_layers`
- **Layer-level recompute (`recompute_granularity="full"` +
  `recompute_num_layers`) is incompatible with TE-scoped CUDA graphs.**
  MCore calls this "full" granularity — the name refers to recomputing
  full transformer layers, not the full model. Even though you're selecting
  how many layers to recompute, MCore treats it differently from submodule
  recompute. Any TE-scoped scope (`attn`, `mlp`, `moe_router`, etc.) will
  assert. This commonly hits FP8 configs that enable TE-scoped graphs by
  default (e.g. `LLAMA3_70B_SFT_CONFIG_H100_FP8_CS_V1` sets
  `cuda_graph_impl="transformer_engine"`, `cuda_graph_scope="mlp"`). Options:
  - use submodule recompute (`recompute_granularity="selective"` +
    `recompute_modules`) — compatible with TE-scoped graphs
  - disable CUDA graphs (`cuda_graph_impl="none"`) and use layer-level recompute
  - switch to `cuda_graph_impl="local"`, `cuda_graph_scope="full_iteration"`
- `distribute_saved_activations=True` cannot be combined with `sequence_parallel=True`
- Combining `mlp` + `core_attn` recompute is slightly worse than `mlp` alone
  due to double recompute overhead

## Measured Results

Llama3 70B SFT on 32x H100 80GB, FP8 (Current Scaling):
- Baseline: TP=4, PP=4, VPP=5, DP=2, MBS=1, GBS=32, seq_len=4096
- Golden GPU utilization: 709.93 TFLOP/s/GPU
- Regression threshold: 5%

| Experiment | recompute_modules | TFLOP/s/GPU | vs Golden | Peak Mem (GB) | Result |
|---|---|---|---|---|---|
| Baseline | [core_attn] | ~704 | -0.8% | 58.8 (OOM rank0) | OOM |
| Exp 1 | [mlp] | 593.6 | -16.4% | 55.6 | Perf regression |
| Exp 2 | [mlp, core_attn] | 586.8 | -17.3% | 55.6 | Perf regression |
| Exp 3 | [core_attn, layernorm] | ~702 | -1.1% | 59.6 (OOM rank0) | OOM |

Key takeaways:

- `layernorm` recompute is nearly free compute-wise but saves negligible memory
- `mlp` recompute saves ~3 GB peak but costs ~16% because the Llama3 70B FFN
  (hidden=28672) is expensive to recompute
- Combining `mlp` + `core_attn` is slightly worse than `mlp` alone
- For this workload, the actual OOM fix was `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`
  (memory fragmentation, not capacity). See @skills/nemo-mbridge-perf-memory-tuning/SKILL.md.

## Code Anchors

### Recompute modules enum and selective checkpoint logic

```python
# 3rdparty/Megatron-LM/megatron/core/transformer/transformer_block.py
# _checkpointed_forward() applies selective recompute based on recompute_modules
```

### Recompute config validation

```python
# 3rdparty/Megatron-LM/megatron/core/transformer/transformer_config.py
# Validates recompute_granularity, recompute_method, recompute_num_layers
```

### Llama3 recipe defaults

```99:103:src/megatron/bridge/recipes/llama/llama3.py
    # Memory saving (recompute & offloading)
    cfg.model.recompute_granularity = None
    cfg.model.recompute_modules = None
    cfg.model.fine_grained_activation_offloading = False
    cfg.model.offload_modules = None
```

### Full recompute + CUDA graph assertion (MCore)

```2001:2005:3rdparty/Megatron-LM/megatron/core/transformer/transformer_config.py
            if self.recompute_granularity:
                if self.recompute_granularity != "selective":
                    assert self.cuda_graph_scope == [
                        CudaGraphScope.full_iteration
                    ], "full recompute is only supported with full iteration CUDA graph."
```

### CPU offloading PP incompatibility (MCore)

```1303:1306:3rdparty/Megatron-LM/megatron/core/transformer/transformer_config.py
        if self.cpu_offloading and self.pipeline_model_parallel_size > 1:
            raise ValueError(
                "Currently there is no support for Pipeline parallelism with CPU offloading"
            )
```

## Failure Diagnosis

| Symptom | Cause | Confirm | Fix |
|---|---|---|---|
| >15% GPU utilization drop | `mlp` recompute on a large FFN | check whether `recompute_modules` includes `mlp` | remove `mlp`, lower micro batch size, or use CPU offload if PP=1 |
| Still OOM after adding layernorm | layernorm activations are too small to move the peak materially | compare peak memory before/after | switch to a higher-impact module or full-layer recompute |
| `AssertionError: full recompute is only supported with full iteration CUDA graph` | layer-level recompute with TE-scoped graph capture | check `cuda_graph_impl` and `cuda_graph_scope` | use `selective`, set `cuda_graph_impl=none`, or use `local` + `full_iteration` |
| ValueError: PP + CPU offloading | `cpu_offloading=True` with `pipeline_model_parallel_size > 1` | check PP config | disable CPU offloading or set PP=1 |
| mlp+core_attn worse than mlp alone | double recompute overhead | compare Exp 1 vs Exp 2 | use mlp alone |

## Known Limitations

- Per-module memory savings vary significantly by model architecture and hidden
  dimension
- No automatic module selection — users must choose which modules to recompute
- `layernorm` recompute is almost never worth it as a standalone fix
- CPU offloading (the zero-compute-cost alternative) is blocked when PP > 1

## Verification

```bash
uv run python -m pytest \
  tests/unit_tests/training/test_config.py -k "recompute" -q
```

Success criteria:
- Unit tests pass for recompute config validation
- No assertion errors from config validation
