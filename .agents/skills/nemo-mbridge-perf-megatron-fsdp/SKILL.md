---
name: nemo-mbridge-perf-megatron-fsdp
description: Operational guide for enabling Megatron FSDP in Megatron-Bridge, including config knobs, code anchors, pitfalls, and verification.
license: Apache-2.0
when_to_use: Using FSDP-based data parallelism instead of DDP, or tracing an OOM or regression to a FSDP config change; 'use_megatron_fsdp', 'data_parallel_sharding_strategy', 'sharded data parallel', 'Megatron FSDP'.
---

# Megatron FSDP Skill

For stable background and recommendation level, see:

- @docs/training/megatron-fsdp.md
- @skills/nemo-mbridge-perf-megatron-fsdp/card.yaml

## Enablement

Minimal Megatron FSDP override in Bridge:

```python
cfg.dist.use_megatron_fsdp = True
cfg.ddp.use_megatron_fsdp = True
cfg.ddp.data_parallel_sharding_strategy = "optim_grads_params"
cfg.ddp.average_in_collective = False
cfg.checkpoint.ckpt_format = "fsdp_dtensor"
```

Example recipe fixup:

```python
cfg = llama3_8b_pretrain_config()
cfg.dist.use_megatron_fsdp = True
cfg.ddp.use_megatron_fsdp = True
cfg.ddp.data_parallel_sharding_strategy = "optim_grads_params"
cfg.ddp.average_in_collective = False
cfg.checkpoint.ckpt_format = "fsdp_dtensor"
cfg.checkpoint.save = "/tmp/fsdp_ckpts"
cfg.checkpoint.load = None
```

Performance harness note:

```bash
python scripts/performance/launch.py --use_megatron_fsdp true
```

## Code Anchors

Bridge config definition:

```148:154:src/megatron/bridge/training/config.py
use_megatron_fsdp: bool = False
"""Use Megatron's Fully Sharded Data Parallel. Cannot be used together with use_torch_fsdp2."""

use_torch_fsdp2: bool = False
"""Use the torch FSDP2 implementation. FSDP2 is not currently working with Pipeline Parallel.
It is still not in a stable release stage, and may therefore contain bugs or other
potential issues."""
```

Bridge validation:

```1533:1578:src/megatron/bridge/training/config.py
if self.dist.use_megatron_fsdp and self.dist.use_torch_fsdp2:
    raise ValueError(...)
...
assert not self.dist.use_tp_pp_dp_mapping, "use_tp_pp_dp_mapping is not supported with Megatron FSDP"
...
assert self.checkpoint.ckpt_format == "fsdp_dtensor", (
    "Megatron FSDP only supports fsdp_dtensor checkpoint format"
)
```

Runtime wrapper selection:

```217:243:src/megatron/bridge/models/common/unimodal.py
if use_megatron_fsdp:
    DP = FullyShardedDataParallel
elif use_torch_fsdp2:
    DP = TorchFullyShardedDataParallel
else:
    DP = DistributedDataParallel
...
DP(
    config=get_model_config(model_chunk),
    ddp_config=ddp_config,
    module=model_chunk,
    ...
    pg_collection=pg_collection,
)
```

Perf harness overrides:

```74:98:scripts/performance/utils/overrides.py
recipe.ddp.use_megatron_fsdp = True
recipe.ddp.data_parallel_sharding_strategy = "optim_grads_params"
recipe.ddp.keep_fp8_transpose_cache = False
recipe.ddp.average_in_collective = False
...
recipe.checkpoint.load = None
```

## Pitfalls

1. Public recipes often expose `use_megatron_fsdp` but still default to `ckpt_format="torch_dist"`. If save/load is enabled, switch to `fsdp_dtensor`.
2. `use_torch_fsdp2` exists, but on the validated branch Bridge still fails before training because `_ddp_wrap` passes `pg_collection`.
3. CPU offloading is only valid when `pipeline_model_parallel_size == 1` and activation recomputation is disabled.
4. Upstream warns that FSDP and TP/CP can want different `CUDA_DEVICE_MAX_CONNECTIONS` settings on Hopper and earlier.
5. Megatron FSDP and FSDP2 are mutually exclusive.

## Verification

Use the existing 2-GPU functional smoke test:

```bash
CUDA_VISIBLE_DEVICES=0,1 uv run python -m torch.distributed.run --nproc_per_node=2 \
  -m pytest tests/functional_tests/training/test_megatron_fsdp.py::TestMegatronFSDP::test_fsdp_pretrain_basic -v -s
```

Success criteria:

- Pytest reports `1 passed`
- The log shows finite loss at the last iteration
- The run finishes without a checkpoint format assertion
