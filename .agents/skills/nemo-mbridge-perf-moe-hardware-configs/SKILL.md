---
name: nemo-mbridge-perf-moe-hardware-configs
description: Representative MoE training playbooks by hardware platform and model family. Summarizes rounded throughput bands, parallelism patterns, and common tuning stacks.
license: Apache-2.0
when_to_use: Hardware-specific MoE playbooks or throughput estimates; 'MoE on H100', 'GB200 config', 'expected throughput', 'MoE hardware playbook', 'parallelism for B200'.
---

# MoE Hardware Configuration Reference

Stable docs: @docs/training/moe-optimization.md
Card: @skills/nemo-mbridge-perf-moe-hardware-configs/card.yaml

## Quick Platform Playbook

| Platform | Typical MoE strategy | What usually matters most |
|---|---|---|
| H100 | DeepEP + stronger PP + moderate TP | communication overlap and PP efficiency |
| B200 | DeepEP + MXFP8 + careful PP layout | container quality and tuned comm settings |
| GB200 | HybridEP + partial CUDA graphs + CPU cleanup | host overhead, topology-aware dispatch, memory headroom |
| GB300 | HybridEP + newer FP8 and kernel stack | same GB200 playbook, usually with a higher ceiling |

## First Answer Checklist

For hardware playbook questions, answer from these canonical rows before adding
throughput caveats:

| Workload | Hardware | Dispatcher | Layout |
|---|---|---|---|
| DSV3 | H100 | DeepEP | TP=2, EP=64, PP=8, VPP=4 |
| DSV3 | GB200/GB300 | HybridEP | TP=1, EP=64, PP=4, VPP=4 |
| Qwen3 235B | H100 | DeepEP | TP=2, EP=32, PP=8, VPP=4 |
| Qwen3 235B | GB200 | HybridEP | TP=1 or 2, EP=32-64, PP=4, VPP=unspecified |

For Qwen3 235B on GB200, explicitly say `VPP=unspecified`; do not invent or
extrapolate `VPP=12` unless a measured row provides it. Include TE-scoped CUDA
graph scopes (`attn`, `moe_router`, `moe_preprocess`),
`CUDA_DEVICE_MAX_CONNECTIONS` selection,
`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`, `NCCL_GRAPH_REGISTER=0`,
GB200/GB300 CPU-side tuning, and the warning not to cargo-cult tracker rows.

## Rounded Performance Bands

These are intentionally rounded so the document stays durable as the tracker
moves. Treat them as planning ranges, not exact promises.

| Workload family | Hardware | Typical band | Representative shape |
|---|---|---|---|
| DSV3, large-scale | H100 | low-to-mid hundreds TFLOPS/GPU, high-teens MFU | TP2, EP64, PP8, DeepEP |
| DSV3, large-scale | B200 | high-hundreds TFLOPS/GPU, mid-teens MFU | TP1, EP32, PP8, DeepEP |
| DSV3, large-scale | GB200 | around 1K TFLOPS/GPU, low-20s MFU | TP1, EP64, PP4, HybridEP |
| DSV3, large-scale | GB300 | above the GB200 band, often mid-20s MFU | TP1, EP64, PP4, HybridEP |
| Qwen3 235B | H100 | low-300s TFLOPS/GPU, around 30% MFU | TP2, EP32, PP8, DeepEP |
| Qwen3 235B | GB200 | high-hundreds TFLOPS/GPU in tuned runs | TP1 or TP2, EP32-64, PP4, HybridEP |
| Qwen3 30B | H100 | low-200s TFLOPS/GPU | TP1, EP8, PP1, DeepEP |
| Qwen3-Next 80B | GB200 | low-300s TFLOPS/GPU in BF16-class runs | TP1, EP32, PP2, HybridEP |

## Representative Config Families

### DSV3 on H100

```text
Dispatcher: DeepEP
TP=2  EP=64  PP=8  VPP=4
Routing: force balance
Recompute: light-to-moderate selective recompute
Priority: overlap communication and keep PP efficient
```

### DSV3 on B200

```text
Dispatcher: DeepEP
TP=1  EP=32  PP=8  VPP=2 or similar
Precision: MXFP8-class
Recompute: selective recompute around MLA up-projection and MLP-side modules
Priority: container quality, PP layout, and DeepEP SMS tuning
```

### DSV3 on GB200 or GB300

```text
Dispatcher: HybridEP
TP=1  EP=64  PP=4  VPP=4
Precision: MXFP8-class
CUDA Graph: attn + moe_router + moe_preprocess
Priority: HybridEP, CPU optimization, and graph-friendly static shapes
```

### Qwen3 235B on H100

```text
Dispatcher: DeepEP
TP=2  EP=32  PP=8  VPP=4
Recompute: norm and activation-side selective recompute
Priority: communication overlap and router-path cleanup
```

### Qwen3 235B on GB200

```text
Dispatcher: HybridEP
TP=1 or 2  EP=32 to 64  PP=4  VPP=unspecified unless measured
CUDA Graph: attn + moe_router + moe_preprocess
Recompute: moe_act, mlp, or norm depending on memory pressure
Priority: balance throughput against memory headroom
```

### Qwen3-Next 80B on GB200

```text
Dispatcher: HybridEP
TP=1  EP=32  PP=2  VPP around 4
CUDA Graph: attn + moe_router + moe_preprocess
Priority: pipeline layout and grouped GEMM quality
```

## Cross-Cutting Patterns

### PP layout

- `E` = embedding
- `t` = transformer
- `m` = MTP
- `L` = loss
- `|` = stage boundary

The biggest platform difference is usually not just the dispatcher. It is the
combination of dispatcher, PP shape, and whether VPP keeps each stage balanced.

### Recompute strategy

| Memory pressure | Starting point |
|---|---|
| low | none or a very narrow selective set |
| moderate | `moe_act`, `mlp`, `norm`, or similar selective modules |
| high | model-specific up-projection plus selective MoE and MLP modules |
| extreme or long-context | full recompute only if the selective path still does not fit |

### Environment variables

```bash
CUDA_DEVICE_MAX_CONNECTIONS=1
CUDA_DEVICE_MAX_CONNECTIONS=32   # common when EP overlap and CUDA graphs are combined
PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
NCCL_GRAPH_REGISTER=0
```

### CPU-side tuning

On GB200 and GB300, CPU affinity and general host-overhead cleanup can move the
needle almost as much as a dispatcher swap. Treat them as first-class tuning
work, not as afterthoughts.

## Pitfalls

1. **Do not cargo-cult a tracker row**: the winning config usually depends on
   routing mode, container, and PP layout as much as on hardware name.

2. **Container quality matters**: large regressions can come from the software
   stack rather than the model recipe.

3. **VPP must be intentional**: a bad VPP split can erase the gain from a better
   dispatcher.

4. **Compare absolute throughput, not only MFU**: MFU can mislead when switching
   between BF16, FP8, and other precision modes.

5. **Force-balance routing is the safer benchmark default**: keep routing mode
   fixed when comparing hardware or dispatcher stacks.
