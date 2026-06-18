---
name: nemo-mbridge-perf-memory-tuning
description: Techniques for reducing peak GPU memory in Megatron Bridge — expandable segments, parallelism resizing, activation recompute, CPU offloading constraints, and common OOM fixes.
license: Apache-2.0
when_to_use: GPU OOM errors, reducing peak memory, or tracing an OOM regression to a specific commit or config change; 'out of memory', 'OOM', 'memory fragmentation', 'expandable_segments', 'reduce GPU memory', 'PYTORCH_CUDA_ALLOC_CONF'.
---

# Memory Tuning

Stable docs: @docs/parallelisms.md
Card: @skills/nemo-mbridge-perf-memory-tuning/card.yaml

## What It Is

GPU OOM failures during training often stem from memory **fragmentation** rather
than raw capacity.  PyTorch's default CUDA allocator can leave unusable gaps
between allocations.  The single most effective fix is:

```bash
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
```

This tells PyTorch to use expandable (non-fixed-size) memory segments, which
dramatically reduces fragmentation and often eliminates borderline OOM without
any model or parallelism changes.

Beyond fragmentation, actual peak memory is determined by:

- **Parameter + optimizer state memory** — controlled by TP, PP, DP sharding
  (distributed optimizer, FSDP)
- **Activation memory** — controlled by activation recompute, sequence length,
  micro-batch size
- **Temporary / workspace memory** — CUDA kernels, NCCL buffers, CUDA graphs

For configuration planning, use the Bridge theoretical estimator before launching
large jobs:

```python
from megatron.bridge.training.utils.theoretical_memory_utils import estimate_training_memory

estimate = estimate_training_memory(cfg, num_microbatches=num_microbatches)
```

The estimator reports the most-loaded GPU shard and separates dense/embedding,
routed MoE expert, and activation components. It does not include allocator
fragmentation, CUDA/NCCL workspace, CUDA graph buffers, token imbalance, or
dispatcher workspace, so validate final configs with runtime memory metrics.

## Quick Decision

When a training run OOMs or is close to the memory limit:

1. **Set `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` first.** This fixes
   fragmentation-induced OOM with zero performance cost. Most Slurm launch
   templates already include it.
2. **Add selective activation recompute** (`recompute_modules=[core_attn]`) if
   not already enabled. See @skills/nemo-mbridge-perf-activation-recompute/SKILL.md.
3. **Avoid increasing TP** as a memory fix — doubling TP dramatically increases
   NVLink all-reduce volume and often kills throughput (-28% on Llama3 70B).
4. **Avoid increasing PP at the cost of DP** — halving DP doubles gradient
   accumulation steps and hurts throughput (~6%).
5. Consider `mlp` recompute if still OOM. Saves ~3 GB but costs ~16% GPU
   utilization on large dense models (Llama3 70B).
6. CPU offloading is **blocked when PP > 1**.

## Enablement

### Expandable segments (recommended first step)

Set in the job's environment before launching:

```bash
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
```

In Slurm scripts this is typically placed alongside other env vars:

```bash
export CUDA_DEVICE_MAX_CONNECTIONS=1
export NVTE_ALLOW_NONDETERMINISTIC_ALGO=1
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
```

No model config changes needed. Zero throughput cost.

### Parallelism resizing

If the model genuinely does not fit (not fragmentation), adjust parallelism:

| Strategy | Memory effect | Throughput cost | Notes |
|---|---|---|---|
| Increase PP (keeping DP) | Fewer layers per stage | Moderate (~6% if DP halved) | Only if GPU count allows |
| Increase TP | Fewer params per GPU | Severe (-28% on 70B) | Last resort |
| Distributed optimizer | Shards optimizer state across DP ranks | ~1-2% | Recommended for large models |
| FSDP | Shards params + grads + optimizer | Varies | See @skills/nemo-mbridge-perf-megatron-fsdp/SKILL.md |

### Activation recompute

See @skills/nemo-mbridge-perf-activation-recompute/SKILL.md for full details.

### CPU offloading

```python
cfg.model.cpu_offloading = True
```

**Incompatible with PP > 1.** Only usable when `pipeline_model_parallel_size = 1`.

## A Note on VPP

Virtual pipeline parallelism (VPP) is primarily a **throughput** optimization
that reduces pipeline bubble overhead by interleaving smaller model chunks. Its
effect on peak memory is minimal — changing VPP does not meaningfully change
the total activation, parameter, or optimizer memory on a GPU.

In earlier experiments we incorrectly attributed an OOM fix to VPP tuning
(VPP 5→10). The actual fix was `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`
which eliminated memory fragmentation. The VPP=10 run actually used slightly
**more** peak memory (60.2 GB vs 58.8 GB) but did not OOM because expandable
segments prevented fragmentation.

VPP should be tuned for pipeline bubble reduction (see @docs/parallelisms.md),
not as a memory fix.

## Compatibility and Constraints

- `expandable_segments:True` is incompatible with `--use-nccl-ub` (NCCL
  user-buffer registration). See Megatron-FSDP docs.
- When using CUDA graphs with `expandable_segments:True`, set
  `NCCL_GRAPH_REGISTER=0` (required on pre-Blackwell GPUs, enforced by MCore
  `CudaGraphManager`).
- CPU offloading requires `pipeline_model_parallel_size = 1`.
- Distributed optimizer requires `use_distributed_optimizer = True` in the
  optimizer config.

## Measured Results

Llama3 70B SFT on 32x H100 80GB, FP8 (Current Scaling):
- Baseline: TP=4, PP=4, VPP=5, DP=2, MBS=1, GBS=32, seq_len=4096
- Golden GPU utilization: 709.93 TFLOP/s/GPU
- Regression threshold: 5%

### Strategy comparison: parallelism changes for memory reduction

| Experiment | TP | PP | VPP | DP | TFLOP/s/GPU | vs Golden | Peak Mem (GB) | Result |
|---|---|---|---|---|---|---|---|---|
| Baseline | 4 | 4 | 5 | 2 | ~704 | -0.8% | 58.8 | OOM (fragmentation) |
| More PP | 4 | 8 | 5 | 1 | 668.0 | -5.9% | 53.2 | Borderline perf |
| More TP | 8 | 4 | 5 | 1 | 508.7 | -28.4% | 50.2 | Severe regression |
| Baseline + expandable_segments | 4 | 4 | 5 | 2 | ~704 | -0.8% | ~59 | **Passed** |

Key takeaways:

- **`expandable_segments:True` is the winner.** The baseline OOM was caused by
  memory fragmentation, not insufficient capacity. Setting this env var
  eliminated the OOM with zero throughput cost and no parallelism changes.
- **PP=8 works for memory but loses DP** (2→1), meaning 32 gradient accumulation
  steps per batch, which hurts throughput by ~6%.
- **TP=8 is catastrophic** (-28%) because doubling TP increases all-reduce
  communication volume proportionally across NVLink, and DP=1 means no
  micro-batch overlap.

### CPU offloading: blocked

| Experiment | offload_layers | Result |
|---|---|---|
| Exp 4 | 2 | Incompatible (PP > 1) |
| Exp 5 | 4 | Incompatible (PP > 1) |
| Exp 6 | 6 | Incompatible (PP > 1) |

`ValueError: Currently there is no support for Pipeline parallelism with CPU
offloading.` This approach is blocked for any model using PP > 1.

### Activation recompute: expensive alternative

Selective activation recompute with `mlp` saved ~3 GB peak memory but cost
~16% GPU utilization on this workload. See
@skills/nemo-mbridge-perf-activation-recompute/SKILL.md for full results.

## Code Anchors

### CPU offloading PP incompatibility (MCore)

```1303:1306:3rdparty/Megatron-LM/megatron/core/transformer/transformer_config.py
        if self.cpu_offloading and self.pipeline_model_parallel_size > 1:
            raise ValueError(
                "Currently there is no support for Pipeline parallelism with CPU offloading"
            )
```

### VPP config and layer divisibility validation (MCore)

```1581:1592:3rdparty/Megatron-LM/megatron/core/transformer/transformer_config.py
            if pipeline_parallel_size and self.virtual_pipeline_model_parallel_size is not None:
                num_layers_per_middle_pipeline_rank = num_layers // pipeline_parallel_size
                if (
                    not num_layers_per_middle_pipeline_rank
                    % self.virtual_pipeline_model_parallel_size
                    == 0
                ):
                    raise ValueError(
                        f"number of layers on each middle pipeline rank:"
                        f"{num_layers_per_middle_pipeline_rank} must be divisible by virtual"
                        f"pipeline parallel degree {self.virtual_pipeline_model_parallel_size}"
                    )
```

### Parallelism docs on interleaved pipeline schedule

```116:124:docs/parallelisms.md
To minimize the pipeline bubble, the computation on each GPU can be divided into multiple subsets of layers (referred to as model chunks), rather than a single contiguous block. Enable this by setting `virtual_pipeline_model_parallel_size`:

model_config = GPTModelProvider(
    pipeline_model_parallel_size=4,
    virtual_pipeline_model_parallel_size=2,  # 2 model chunks per pipeline stage
    # ... other model parameters
)
```

## Failure Diagnosis

| Symptom | Cause | Confirm | Fix |
|---|---|---|---|
| OOM on a single rank despite headroom on others | Memory fragmentation | check if `expandable_segments:True` is set | set `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` |
| OOM with `expandable_segments` already set | Genuine capacity limit | check `nvidia-smi` for param/optimizer memory | increase PP, use distributed optimizer, or add recompute |
| Estimated memory exceeds GPU capacity before launch | model state or activations genuinely too large | run `estimate_training_memory` and inspect the largest component | adjust PP/TP/CP/EP, distributed optimizer, or recompute before launching |
| `ValueError: PP + CPU offloading` | using cpu_offloading with PP > 1 | check PP config | disable CPU offloading or set PP=1 |
| `RuntimeError` with `--use-nccl-ub` + expandable segments | NCCL UB incompatible with expandable allocator | check env vars | remove `expandable_segments:True` or disable `--use-nccl-ub` |

## Known Limitations

- CPU offloading is blocked when PP > 1
- Parallelism resizing (TP/PP) often has significant throughput costs
- The theoretical estimator is formula-based and does not replace runtime
  profiling or CUDA memory reports

## Verification

Quick check that `expandable_segments:True` is active:

```python
import os
assert "expandable_segments:True" in os.environ.get("PYTORCH_CUDA_ALLOC_CONF", "")
```

For Slurm jobs, verify the env var is exported before the training command
in the launch script.
