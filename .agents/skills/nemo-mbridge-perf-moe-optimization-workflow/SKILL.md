---
name: nemo-mbridge-perf-moe-optimization-workflow
description: Systematic workflow for MoE training optimization in Megatron Bridge, based on the Megatron-Core MoE paper. Covers the Three Walls framework, parallel folding, recompute strategy, dispatcher choice, and CUDA-graph bring-up.
license: Apache-2.0
when_to_use: Full MoE throughput tuning sweep, or diagnosing a MoE throughput regression after a commit or config change; 'optimize MoE throughput', 'MoE perf tuning', 'Three Walls', 'memory wall', 'communication wall', 'compute wall'.
---

# MoE Training Optimization Workflow

Stable docs: @docs/training/moe-optimization.md
Card: @skills/nemo-mbridge-perf-moe-optimization-workflow/card.yaml
Source: [Scalable Training of MoE Models with Megatron Core](https://arxiv.org/abs/2603.07685)

## Quick Reference

Think in terms of the paper's Three Walls:

- memory wall
- communication wall
- compute and host-overhead wall

MoE tuning is iterative. Fixing one wall usually exposes the next one, so the
best workflow is: fit first, scale second, profile third, then retune.

## First Answer Checklist

For MoE optimization workflow prompts, present the response in this order:

1. **Fit**: make the model memory-feasible first. Use the smallest model
   parallelism that fits, prefer selective recompute before full recompute, add
   offloading only after recompute and parallelism are insufficient, and use
   `--fake-init-process-group` to sanity-check large layouts.
2. **Scale**: maximize DP after the model fits, keep hot communication inside
   the fastest interconnect, use PP plus VPP for multi-node scaling, prefer EP
   over extra TP for expert layers, and add CP when long context makes attention
   memory dominant.
3. **Profile**: identify the dominant wall: memory, communication, host
   overhead, or compute.
4. **Retune**: change dispatcher, overlap, FP8 mode, CUDA graphs, or recompute
   based on the profiled bottleneck.
5. Include the exact Parallel Folding meshes: `Attention: TP x CP x DP x PP`
   and `MoE: ETP x EP x EDP x PP`.
6. Include the default mappings: `alltoall` for safe bring-up,
   `flex` + `deepep` for H100/B200-style systems, `flex` + `hybridep` for
   GB200/GB300/NVL72 systems, Hopper to FP8 blockwise, Blackwell to MXFP8, and
   dropless MoE TE-scoped CUDA graphs over `attn`, `moe_router`, and
   `moe_preprocess`.

## Phase 1: Make The Run Memory-Feasible

Start with a configuration that fits reliably before chasing throughput.

Recommended order:

1. Use the smallest amount of model parallelism that still fits.
2. Turn on selective recompute before falling back to full recompute.
3. Add offloading only when recompute and parallelism are still insufficient.
4. Use `--fake-init-process-group` to sanity-check large parallel layouts on a
   single GPU before burning cluster time.

### Recompute guidance

Prefer selective recompute for MoE runs:

- good first choices: `layernorm`, `core_attn`, `moe_act`, `mlp`, or
  model-specific modules (`shared_experts`, `mla_up_proj`)
- use full recompute only when the run still does not fit
- revisit recompute after enabling CUDA graphs, because some graph scopes and
  full recompute paths do not mix well

As a rule of thumb, fine-grained recompute often recovers most of the needed
memory while keeping throughput much closer to the non-recompute baseline than
full-layer recompute does.

## Phase 2: Choose Parallelism For Scale

Priority order:

1. Maximize DP once the model fits.
2. Keep the hot communication path inside the fast interconnect when possible.
3. Use PP, plus VPP if needed, for multi-node scaling.
4. Prefer EP over extra TP for expert layers.
5. Add CP for long context once sequence length makes attention memory dominant.

### Parallel Folding

Parallel Folding decouples attention and MoE parallelism so you do not have to
pick a single compromise layout:

```text
Attention: TP × CP × DP × PP
MoE:       ETP × EP × EDP × PP
```

Key knobs:

- `--expert-model-parallel-size`
- `--expert-tensor-parallel-size`

Use it when attention prefers some TP or CP, but expert layers benefit from a
larger EP degree than the dense layers can tolerate.

## Phase 3: Profile The Dominant Bottleneck

| Bottleneck | What it looks like | Primary fixes |
|---|---|---|
| Memory | Run fits only with aggressive full recompute or OOMs during warmup | selective recompute, FP8, offloading, better PP layout |
| Communication | Nsight shows large all-to-all or collective blocks | DeepEP or HybridEP, EP overlap, DP/TP overlap, better PP layout |
| Host overhead | GPU gaps, launch-bound traces, Python overhead | CUDA graphs, `--manual-gc`, higher MBS, CPU affinity tuning |
| Compute | Low SM utilization after comm and host issues are addressed | grouped GEMM, fusion work, FP8, dispatcher-specific kernel tuning |

## Dispatcher And Overlap Guidance

Use dispatcher choice as a bottleneck fix, not as the first tuning knob.

- `moe_token_dispatcher_type="alltoall"`: safest bring-up path, fine for
  smaller EP sizes
- `moe_token_dispatcher_type="flex"` + `moe_flex_dispatcher_backend="deepep"`:
  strong default for H100 and B200 style deployments
- `moe_token_dispatcher_type="flex"` + `moe_flex_dispatcher_backend="hybridep"`:
  strongest starting point on GB200 or GB300 NVL72 systems

If the all-to-all path is visible in profiles, combine dispatcher tuning with:

- `--overlap-moe-expert-parallel-comm`
- `--overlap-grad-reduce`
- `--tp-comm-overlap`

## FP8 Recipe Quick Decision

| Platform | Recommended starting recipe |
|---|---|
| Hopper | FP8 blockwise |
| Blackwell | MXFP8 |
| Blackwell, speed-first exploration | NVFP4 after the BF16 or FP8 path is stable |

Keep the router in FP32. The largest wins usually come from expert GEMMs and
other heavy matrix math, not from trying to quantize every small MoE component.

## CUDA Graphs For MoE

For dropless MoE, start with partial TE-scoped graphs:

- `attn`
- `moe_router`
- `moe_preprocess`

That path usually gives a meaningful step-time win while keeping the dynamic
expert work outside the graph. Expect a moderate speedup when launch overhead is
visible, but budget several extra GB of memory and verify that shapes remain
static.

Use full-iteration graphs only for graph-friendly workloads such as drop-and-pad
or tightly controlled static-shape experiments.

Related references:

- @skills/nemo-mbridge-perf-cuda-graphs/SKILL.md
- @docs/training/cuda-graphs.md
- @docs/training/activation-recomputation.md

## Pitfalls

1. **Do not optimize in the wrong order**: fitting the model and selecting sane
   parallelism matter more than micro-optimizations.

2. **Platform changes the limiting wall**: H100-class runs often feel more
   communication-bound, while GB200 or GB300 runs often expose CPU or launch
   overhead earlier.

3. **FP8 MFU can look misleadingly low**: compare absolute throughput as well as
   MFU when switching precision modes.

4. **CUDA graphs and recompute interact**: TE-scoped graphs are usually paired
   with selective recompute, not blanket full recompute.

5. **Parallel Folding is not optional at large scale**: once attention and expert
   layers want clearly different layouts, a single shared TP or EP plan becomes
   a tax on both.
