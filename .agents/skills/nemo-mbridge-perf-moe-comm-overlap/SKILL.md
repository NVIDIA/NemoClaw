---
name: nemo-mbridge-perf-moe-comm-overlap
description: MoE expert-parallel communication overlap in Megatron Bridge. Covers dispatch/combine overlap, flex dispatcher backends, and expert wgrad scheduling.
license: Apache-2.0
when_to_use: Tuning MoE communication overlap, or tracing a MoE throughput regression to a comm-overlap config change; 'overlap_moe_expert_parallel_comm', 'MoE dispatch overlap', 'flex dispatcher', 'DeepEP overlap', 'expert wgrad scheduling'.
---

# MoE Communication Overlap

For the higher-level overview, see:

- @docs/training/communication-overlap.md
- @skills/nemo-mbridge-perf-moe-comm-overlap/card.yaml

## Quick Decision

Use MoE communication overlap when:

- `EP > 1`
- token dispatch or combine time is visible in the profile
- the run is already correct and you are now tuning throughput

Avoid turning it on as an early bring-up step. It is easier to validate after
the dispatcher, routing mode, and recompute plan are already stable.

## Enablement

```python
cfg.comm_overlap.overlap_moe_expert_parallel_comm = True

# Optional: delayed wgrad for additional overlap
cfg.comm_overlap.delay_wgrad_compute = True

# IMPORTANT: disable shared expert overlap when using dispatch overlap
cfg.model.moe_shared_expert_overlap = False
```

### Prerequisites

- `expert_model_parallel_size > 1`
- `num_moe_experts > 1`
- `moe_token_dispatcher_type` must be `"alltoall"` or `"flex"`
- Precision: BF16 or FP16
- If PP is used, VPP (`virtual_pipeline_model_parallel_size`) must be set (non-`None`)

### Flex dispatcher activation

Setting `moe_flex_dispatcher_backend` alone does **not** activate flex dispatch.
You must also set `moe_token_dispatcher_type = "flex"`.

## Recompute And CUDA Graph Interaction

- Full recompute is not a good companion for the overlap path.
- `delay_wgrad_compute` adds further constraints if CUDA-graph scopes include
  attention or MoE-router work.
- In practice, selective recompute is the safer pairing when overlap is enabled.

## Measured Short-Run Caveat

A 2026-05-18 current-main H100 x16 smoke on Qwen3 30B-A3B mock pretraining
used `EP=16`, `alltoall`, global batch size 1024, CUDA graphs disabled, and
`moe_permute_fusion=false` because the PyTorch 25.11 / TE / Triton stack failed
in Transformer Engine fused permutation in prior bring-up.

Results were directional rather than release-grade:

- no EP overlap: 41.25s steady-state mean over iterations 3-8
- EP overlap: 31.31s steady-state mean over iterations 3-8
- EP overlap plus `delay_wgrad_compute`: 31.20s steady-state mean over
  iterations 3-8

Treat this as evidence that EP overlap can help an inter-node `alltoall` MoE
shape when communication is exposed. It is not proof that delayed wgrad is a
separate win, and it does not validate the fused permutation path. An earlier
2026-05-16 short smoke on the same shape showed the same pattern.

## Code Anchors

- Overlap validation: `src/megatron/bridge/training/comm_overlap.py`
- Flex dispatcher backend: `src/megatron/bridge/training/flex_dispatcher_backend.py`
- Config: `src/megatron/bridge/training/config.py`
- Unit tests: `tests/unit_tests/training/test_comm_overlap.py`
- DeepEP tests: `tests/unit_tests/training/test_deepep.py`

## Pitfalls

1. **Shared expert overlap conflict**: `moe_shared_expert_overlap` and
   `overlap_moe_expert_parallel_comm` can conflict. Disable shared expert
   overlap when using the dispatch overlap path.

2. **PP without VPP**: MoE overlap requires VPP when pipeline parallelism is
   active. Without it, the overlap scheduling cannot interleave correctly.

3. **Flex != backend flag**: `moe_flex_dispatcher_backend="deepep"` alone
   does nothing if `moe_token_dispatcher_type` is still `"alltoall"`.

4. **Conservative recipe defaults**: Most public recipes leave MoE overlap
   disabled. You need to explicitly enable it via overrides.

5. **Performance gains are workload-dependent**: overlap helps most when dispatch
   communication is already a visible slice of step time. It is not guaranteed
   to help every small or lightly loaded EP run.

## Verification

Look for overlap-related log messages during initialization. The comm overlap
validation in `comm_overlap.py` will raise if prerequisites are not met, so a
clean startup confirms the feature is active.

For a short performance-harness smoke, keep the command shape explicit and vary
only one overlap knob at a time:

```bash
uv run python scripts/performance/run_script.py \
  -m qwen \
  -mr qwen3_30b_a3b \
  --task pretrain \
  -g h100 \
  -c bf16 \
  -ng 16 \
  -gn 8 \
  --max_steps 8 \
  --config_variant v1 \
  --cuda_graph_impl none \
  --moe_flex_dispatcher_backend None \
  --moe_a2a_overlap false \
  --tokenizer_type NullTokenizer \
  comm_overlap.overlap_moe_expert_parallel_comm=true \
  comm_overlap.delay_wgrad_compute=false \
  model.moe_shared_expert_overlap=false
```

If fused MoE permutation fails during bring-up, add
`model.moe_permute_fusion=false` to separate overlap timing from runtime-stack
validation, then retest with the matched production container.
