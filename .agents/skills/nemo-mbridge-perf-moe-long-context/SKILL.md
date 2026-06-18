---
name: nemo-mbridge-perf-moe-long-context
description: Long-context MoE training guidance for Megatron Bridge. Covers CP sizing, selective recompute, dispatcher choices, and practical patterns from DSV3, Qwen3, and Qwen3-Next long-context experiments.
license: Apache-2.0
when_to_use: Training MoE at long sequence lengths, or investigating a commit that caused long-context MoE OOM or degraded throughput; 'long context MoE', '128k tokens', 'CP sizing for long sequences', 'selective recompute long context', 'MoE long-context OOM'.
---

# MoE Long-Context Training

Stable docs: @docs/training/moe-optimization.md
Card: @skills/nemo-mbridge-perf-moe-long-context/card.yaml

## What Changes At Long Context

Once sequence length moves well past the 4K-class regime, attention memory and
activation residency become the dominant constraints. For MoE models, that
usually means you need some combination of:

- context parallelism
- selective recompute
- lower precision
- CPU offload for optimizer state
- a dispatcher and PP layout that do not waste the smaller remaining DP budget

## Rounded Scaling Patterns

### DSV3 on H100

The DSV3 long-context runs show a stable pattern:

- selective recompute works better than full recompute once you move past the
  shortest contexts
- throughput stays in a fairly narrow band from mid-length through very long
  contexts if CP is increased appropriately
- the trade shifts from "memory fit" to "GPU-count feasibility" as CP grows

In other words, long context does not immediately collapse utilization if the
layout is chosen well, but it does consume the DP budget very quickly.

### Qwen3-Next on GB200

Qwen3-Next behaves more like a memory-sensitive medium-scale model:

- 8K and 32K remain practical with moderate CP
- 64K is possible, but the throughput drop is noticeable and memory becomes
  much tighter
- pipeline layout and grouped-GEMM improvements matter almost as much as CP

### Qwen3 235B on GB200

Qwen3 235B shows that long context can still be efficient on NVL72 systems when
TP, CP, and HybridEP are coordinated. The best 128K-class configurations are
not just "fit-only" recipes; they can remain highly efficient if routing,
parallelism, and recompute are balanced.

## CP Sizing Rules Of Thumb

1. **Start from a 4K shard target**: a good first guess is
   `CP ~= seq_len / 4096`, then round to a practical power-of-two layout.

2. **Keep DP alive if possible**: long-context scaling becomes brittle once CP,
   EP, TP, and PP together squeeze DP down to the floor.

3. **Prefer selective recompute**: recompute modules such as `up_proj`, `norm`,
   `moe`, `moe_act`, or `mlp` before reaching for full recompute.

4. **Avoid SDPA-heavy recompute at very long context**: recomputing attention
   internals can add a lot of work for less memory benefit than recomputing
   smaller MoE and MLP-side modules.

5. **Use TP as another lever on NVL72 systems**: GB200 and GB300 runs can
   sometimes trade some CP for TP while still staying efficient.

6. **Assume GBS will need to shrink**: as CP rises and DP falls, you may need
   to reduce global batch size or accept higher GA.

## Representative Config Families

### DSV3 at 128K on H100

```text
TP=1  CP=32  EP=32  PP=8  VPP=4
Precision: FP8-class
Dispatcher: DeepEP
Recompute: up_proj, norm, moe, mlp
Extra memory help: optimizer CPU offload
```

### DSV3 at 256K on H100

```text
TP=1  CP=64  EP=32  PP=8  EDP=2  VPP=4
Precision: FP8-class
Dispatcher: DeepEP
Recompute: up_proj, norm, moe, mlp
Extra memory help: optimizer CPU offload
```

### Qwen3 235B at 128K on GB200

```text
TP=4  CP=4  EP=32  PP=4  VPP=12
Precision: BF16 or MXFP8
Dispatcher: HybridEP
Recompute: moe_act, norm
CUDA Graph: attn + moe_router + moe_preprocess
```

## Recompute And CUDA Graph Guidance

For long-context MoE training:

- start with selective recompute
- add CUDA graphs only after the shapes and routing path are stable
- keep sequence length and MBS fixed when using CUDA graphs
- if the run depends on highly dynamic batches, prefer eager execution

Useful references:

- @docs/training/activation-recomputation.md
- @skills/nemo-mbridge-perf-cuda-graphs/SKILL.md

## Pitfalls

1. **CP does not replace EP or PP**: it adds another dimension; it does not make
   the others disappear.

2. **A good 4K baseline can still be a bad long-context baseline**: routing mode,
   recompute choice, and offload strategy often need to change.

3. **GPU-count feasibility becomes the real constraint**: very long context can
   look fine in a single recipe, then become impossible once EP and PP are added
   honestly across the full model.

4. **CUDA graphs need static shapes**: variable-length batches and opportunistic
   padding strategies can silently break the path.

5. **Container and kernel support matters more at 128K+**: long-context paths
   tend to rely on newer kernels and bug fixes than short-context bring-up does.
