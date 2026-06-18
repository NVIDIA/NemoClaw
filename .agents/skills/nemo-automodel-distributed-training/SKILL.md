---
name: nemo-automodel-distributed-training
description: Guide for selecting and configuring distributed training strategies in NeMo AutoModel, including FSDP2, Megatron FSDP, DDP, and parallelism settings.
when_to_use: Adding or modifying distributed training strategies (FSDP2, HSDP, DDP), debugging multi-GPU or multi-node failures, configuring context or tensor parallelism, or tuning sharding settings.
license: Apache-2.0
metadata:
  author: NVIDIA
  tags:
    - nemo-automodel
    - distributed-training
---

# Distributed Training in NeMo AutoModel

## Purpose

NeMo AutoModel uses PyTorch-native distributed training.
All parallelism is orchestrated through a single `MeshContext` object that
holds device meshes, strategy configs, and axis names.

## Instructions

For conceptual distributed-training questions, answer directly from the quick
patterns in this skill without inspecting the repository. Start with the
strategy choice, then list only the YAML fields and constraints relevant to the
question.

Use direct action verbs in the final answer: recommend the strategy, show the
minimal YAML, state the sizing constraint, and name the unsupported strategies.
Do not discuss model onboarding, recipes, Slurm, SkyPilot, or checkpointing
unless the user asks.

## Examples

### TP plus PP for a large multi-node model

Recommend `strategy: fsdp2`. Mention `tp_size`, `pp_size`, `cp_size`,
`ep_size`, and the `pipeline` sub-config. State that `dp_size` is inferred from
`world_size / (tp_size * pp_size * cp_size)`.

```yaml
distributed:
  strategy: fsdp2
  tp_size: 8
  pp_size: 4
  cp_size: 1
  ep_size: 1
  pipeline:
    pp_schedule: interleaved1f1b
    pp_microbatch_size: 1
```

### MoE expert parallelism

Recommend `strategy: fsdp2` with `ep_size > 1`. Say this creates a separate
`moe_mesh`; include the `moe` sub-config when relevant; state that `ep_size`
must divide `dp_size * cp_size`. Do not recommend `megatron_fsdp` or `ddp`.

```yaml
distributed:
  strategy: fsdp2
  ep_size: 8
  moe:
    reshard_after_forward: false
```

### MegatronFSDP limitations

Say no for pipeline parallelism, expert parallelism, and `sequence_parallel`.
Recommend `fsdp2` for PP, EP, or `sequence_parallel`; mention that DDP is only
simple data parallelism.

## Strategy Selection

Three strategies are available, selected via the `distributed.strategy` YAML key:

| Strategy | YAML value | Best for |
|---|---|---|
| FSDP2 | `fsdp2` | General use, recommended default. Supports TP, PP, CP, EP, HSDP. |
| MegatronFSDP | `megatron_fsdp` | NVIDIA Megatron-style FSDP. No PP, no EP, no sequence_parallel. |
| DDP | `ddp` | Simple data parallelism only. No TP, PP, CP, or EP. |

Decision tree:

- Single GPU: no distributed config needed (FSDP2Manager skips parallelization when world_size=1).
- Multi-GPU single node: `fsdp2` (default). Use `ddp` only if you need the simplest possible setup.
- Multi-node: `fsdp2` with appropriate TP/PP sizing.
- MoE models with expert parallelism: `fsdp2` with `ep_size > 1` (creates a separate `moe_mesh`).
- Large models (70B+): `fsdp2` with PP + TP.
- Long sequences (8K+): add CP (`cp_size > 1`).

When answering strategy-selection questions, state the chosen `distributed.strategy`
first, then enumerate the YAML fields the user must set.

Quick TP + PP answer:

- Use `strategy: fsdp2`; do not use `megatron_fsdp` when pipeline parallelism is required.
- Set `tp_size` for tensor parallelism and `pp_size` for pipeline parallelism.
- Add a `pipeline:` sub-config with `pp_schedule` and `pp_microbatch_size`.
- Leave `dp_size` unset or `none`; it is inferred as `world_size / (tp_size * pp_size * cp_size)`.
- Keep TP inside a fast intra-node domain when possible, and use PP across model depth for 70B+ models.

Quick MoE expert-parallel answer:

- Start with `strategy: fsdp2` and `ep_size > 1`.
- Include a `moe:` sub-config only when `ep_size > 1`; it maps to `MoEParallelizerConfig`.
- Expect a separate `moe_mesh` for expert parallelism in addition to the main `device_mesh`.
- Do not recommend `megatron_fsdp` or `ddp` for expert parallelism; `megatron_fsdp` has no EP support.
- Before finishing an MoE EP answer, explicitly state that `ep_size` must divide `dp_size * cp_size` and that `megatron_fsdp` does not support EP, PP, or `sequence_parallel`.

## YAML Config Structure

The `distributed` section in the recipe YAML maps directly to
`parse_distributed_section()` in `recipes/_dist_setup.py`:

```yaml
distributed:
  strategy: fsdp2           # fsdp2 | megatron_fsdp | ddp
  dp_size: none             # auto-calculated from world_size / (tp * pp * cp)
  dp_replicate_size: none   # FSDP2-only, for HSDP
  tp_size: 1
  pp_size: 1
  cp_size: 1
  ep_size: 1

  # Strategy-specific flags (forwarded to the strategy dataclass):
  sequence_parallel: false
  activation_checkpointing: false
  defer_fsdp_grad_sync: true   # FSDP2 only

  # Sub-configs (optional):
  pipeline:
    pp_schedule: 1f1b
    pp_microbatch_size: 1
    # ... see PipelineConfig fields

  moe:
    reshard_after_forward: false
    # ... see MoEParallelizerConfig fields
```

The `dp_size` is always inferred:

```
dp_size = world_size / (tp_size * pp_size * cp_size)
```

## Infrastructure Flow

```
YAML distributed section
    -> parse_distributed_section()          [recipes/_dist_setup.py]
    -> setup_distributed()                  [recipes/_dist_setup.py]
        -> create_device_mesh()             [components/distributed/device_mesh.py]
        -> MeshContext(...)                  [components/distributed/mesh.py]
    -> instantiate_infrastructure()         [_transformers/infrastructure.py]
        -> _instantiate_distributed()       -> FSDP2Manager / MegatronFSDPManager / DDPManager
        -> _instantiate_pipeline()          -> AutoPipeline (if pp_size > 1)
        -> parallelize_fn                   -> MoE parallelizer (if ep_size > 1) or PP wrapper
    -> apply_model_infrastructure()         [_transformers/infrastructure.py]
        -> _shard_pp() or _shard_ep_fsdp()  (applies sharding to the model)
```

## FSDP2 Configuration

### Basic FSDP2 (data parallelism only)

```yaml
distributed:
  strategy: fsdp2
  tp_size: 1
  cp_size: 1
```

This auto-calculates `dp_size = world_size` and applies `fully_shard()` per
transformer block via DTensor-based sharding.

### FSDP2 with Tensor Parallelism

Keep TP within a single NVLink domain (typically one node):

```yaml
distributed:
  strategy: fsdp2
  tp_size: 4        # 2, 4, or 8 -- must divide GPUs per node
  sequence_parallel: true
```

The TP plan is auto-selected based on the model type. Pass a custom plan via
the Python API if needed:

```python
config = FSDP2Config(sequence_parallel=True, tp_plan=my_custom_plan)
```

### FSDP2 with Pipeline Parallelism

```yaml
distributed:
  strategy: fsdp2
  pp_size: 2
  pipeline:
    pp_schedule: interleaved1f1b   # 1f1b, gpipe, interleaved_1f1b, etc.
    pp_microbatch_size: 4
    scale_grads_in_schedule: false
```

The model must have a `_pp_plan` attribute (set on the HF model class) for
`AutoPipeline` to know how to split layers across stages. Models without
`_pp_plan` are not compatible with PP.

### FSDP2 with HSDP (Hybrid Sharded Data Parallel)

Intra-node full sharding + inter-node replication via a 2D DeviceMesh:

```yaml
distributed:
  strategy: fsdp2
  dp_replicate_size: 2   # must divide dp_size
```

Constraint: `dp_replicate_size < dp_size` (pure replication with no sharding
is not supported by FSDP2).

### Activation Checkpointing

Trades compute for memory by recomputing activations during backward:

```yaml
distributed:
  activation_checkpointing: true
```

This is forwarded to the strategy config for non-EP models, or read from
`MeshContext.activation_checkpointing` for EP models.

### Gradient Sync Deferral

FSDP2 defers gradient sync to the final micro-batch by default for
communication overlap:

```yaml
distributed:
  defer_fsdp_grad_sync: true   # default
```

### Mixed Precision

FSDP2Config defaults to bfloat16 for all three precision knobs via
`MixedPrecisionPolicy(param_dtype=bf16, reduce_dtype=bf16, output_dtype=bf16,
cast_forward_inputs=True)`. Override via the Python API:

```python
from torch.distributed.fsdp import MixedPrecisionPolicy
config = FSDP2Config(
    mp_policy=MixedPrecisionPolicy(param_dtype=torch.float16, reduce_dtype=torch.float32),
)
```

## Pipeline Parallelism

### Requirements

1. Model class must define `_pp_plan` (a dict mapping module FQNs to stages).
2. `pp_size > 1` in the distributed section.
3. A `pipeline` sub-config with schedule and microbatch size.

### Supported schedules

Defined in `PipelineConfig.pp_schedule`:

- `1f1b` (one-forward-one-backward, default)
- `gpipe`
- `interleaved_1f1b` / `interleaved1f1b`
- `looped_bfs`
- `dfs`
- `v_schedule`
- `zero_bubble`

### Example (8B model on 8 GPUs, PP=2 + DP=4)

```yaml
distributed:
  strategy: fsdp2
  pp_size: 2

  pipeline:
    pp_schedule: interleaved1f1b
    pp_microbatch_size: 4
    scale_grads_in_schedule: false

checkpoint:
  model_save_format: safetensors
  save_consolidated: true
```

### How it works

`AutoPipeline.build()` calls `pipeline_model()` which splits the model into
stages using the model's `_pp_plan`, creates `PipelineStage` objects, and
builds the schedule. During training, `schedule.step()` drives forward and
backward through the pipeline.

## Context Parallelism

Use CP for long sequences (8K+). CP shards Q/K/V on the sequence dimension
as DTensors.

### Config

```yaml
distributed:
  strategy: fsdp2
  cp_size: 2   # or 4, 8
```

### Requirements

- SDPA (Flash Attention or Efficient Attention backend) or Transformer Engine
  attention. SDPBackend.MATH is not compatible with DTensor.
- Attention masks are automatically stripped; `is_causal=True` is set via
  forward pre-hooks registered by `attach_context_parallel_hooks()`.

### How it works

1. After model sharding, `apply_model_infrastructure()` calls
   `attach_context_parallel_hooks()` on each model part (for non-TE models).
2. At each training step, `make_cp_batch_and_ctx()` creates a CP context
   manager that shards the batch along the sequence dimension and sets up
   `context_parallel()` from `torch.distributed.tensor.experimental`.
3. For TE attention models, `make_cp_batch_for_te()` uses THD format and
   TE's `thd_get_partitioned_indices` for sharding.

### CP with Sequence Packing

CP works with packed sequences. The `packed_sequence_size` must be divisible
by `cp_size`. When using TE, chunks are sharded per-chunk via
`_shard_thd_chunk_for_te()`.

## Sequence Packing

Packing multiple sequences into a single training sample for efficiency.

### Config

```yaml
packed_sequence:
  packed_sequence_size: 4096   # 0 = disabled

step_scheduler:
  local_batch_size: 1          # must be 1 for packed sequences
```

When `packed_sequence_size > 0`, the dataset collator packs sequences up to
that length. `local_batch_size` must be 1 because each "sample" is already a
packed batch.

## MoE Distributed Training

### Expert Parallelism

Set `ep_size > 1` to distribute experts across GPUs. This creates a separate
`moe_mesh` alongside the main `device_mesh`:

```yaml
distributed:
  strategy: fsdp2
  ep_size: 8
  activation_checkpointing: true
```

The `moe_mesh` shape is `(pp_size, ep_shard_size, ep_size)` with dimension
names `("pp", "ep_shard", "ep")`.

Constraint: `dp_cp_size` (= `dp_size * cp_size`) must be divisible by
`ep_size`.

### MoE sub-config

```yaml
distributed:
  strategy: fsdp2
  ep_size: 8
  activation_checkpointing: true

  moe:
    reshard_after_forward: false
    ignore_router_for_ac: false
    wrap_outer_model: true
```

The `moe` sub-section maps to `MoEParallelizerConfig` and is only
instantiated when `ep_size > 1`.

### Full MoE example (Qwen3-30B-A3B on 8 GPUs)

```yaml
distributed:
  strategy: fsdp2
  tp_size: 1
  cp_size: 1
  pp_size: 1
  ep_size: 8
  sequence_parallel: false
  activation_checkpointing: true
```

### MegatronFSDP limitations

Despite its name, `megatron_fsdp` does **not** support expert parallelism
(`ep_size > 1`), pipeline parallelism (`pp_size > 1`), or
`sequence_parallel`. Use `fsdp2` for these features.

## Parallelism Sizing Guidelines

### Dense models

| Model size | TP | PP | CP | Strategy |
|---|---|---|---|---|
| < 3B | 1 | 1 | 1 | FSDP2 (DP only) |
| 3-13B | 2-4 | 1 | 1 | FSDP2 + TP |
| 13-70B | 4-8 | 2-4 | 1 | FSDP2 + TP + PP |
| 70B+ | 8 | 4-8 | 1 | FSDP2 + TP + PP |
| Any + long seq (8K+) | as above | as above | 2-8 | add CP |

### MoE models

MoE models need less TP than dense models of similar total parameter count
because only a fraction of parameters are active per token. EP is the primary
scaling dimension:

| Model | TP | PP | EP | Notes |
|---|---|---|---|---|
| Small MoE (<10B total) | 1 | 1 | 8 | EP only |
| Medium MoE (10-30B total) | 1-2 | 1 | 8 | small TP for shared layers |
| Large MoE (100B+ total) | 1-2 | 4+ | 8-64 | PP for depth, EP for experts |

### Hardware topology rules

- TP must stay within a single NVLink domain (one node, typically 8 GPUs).
- Use PP or DP for cross-node scaling.
- TP across InfiniBand degrades throughput severely.

## Code Anchors

- `components/distributed/config.py`: FSDP2Config, MegatronFSDPConfig, DDPConfig.
- `components/distributed/mesh.py`: MeshContext, strategy map, and mesh sizes.
- `components/distributed/device_mesh.py`: device mesh and `moe_mesh` creation.
- `components/distributed/pipelining/config.py`: PipelineConfig fields.
- `components/moe/config.py`: MoEParallelizerConfig and MoEConfig.
- `recipes/_dist_setup.py`: YAML parsing and distributed setup.

## Pitfalls

1. **TP across nodes destroys throughput.** Always keep TP within a single
   NVLink domain. Use PP or DP for cross-node scaling.

2. **PP requires `_pp_plan` on the model class.** Not all HF models have this.
   Check `validate_hf_model_for_pipeline_support()` before enabling PP.

3. **PP bubbles reduce GPU utilization.** Use interleaved schedules
   (`interleaved_1f1b`) and smaller microbatches to reduce bubble time.

4. **FSDP2 requires DTensor-aware state dict saving.** Use `safetensors` with
   `save_consolidated: true` for checkpoint compatibility.

5. **CP requires compatible attention.** SDPA (Flash Attention or Efficient
   Attention) or TE attention only. `SDPBackend.MATH` is not compatible with
   DTensor.

6. **MoE EP size must evenly divide `dp_size * cp_size`.** The device mesh
   creation asserts `dp_cp_size % ep_size == 0`.

7. **MegatronFSDP is more limited than FSDP2.** It does not support PP
   (`pp_size > 1`), EP (`ep_size > 1`), or `sequence_parallel`. The
   `MeshContext` validation raises on these combinations.

8. **DDP supports nothing beyond data parallelism.** No TP, PP, CP, EP, or
   HSDP. Validation raises on any of these.

9. **Activation checkpointing increases compute.** It saves memory by
   recomputing activations during backward, but adds ~30% compute overhead.

10. **Mixed precision policy must match model expectations.** The default
    bfloat16 policy works for most models. FP16 models may need a custom
    `MixedPrecisionPolicy`.

11. **`packed_sequence_size` must be divisible by `cp_size`** when using CP
    with packed sequences.

12. **`dp_replicate_size` is FSDP2-only.** Passing it with `megatron_fsdp`
    or `ddp` raises a `ValueError`.

## Verification

Run the smallest recipe that exercises the requested strategy. Success means
exit code 0, finite loss, no NCCL timeout, and log output matching the expected
TP/PP/CP/EP sizes.
