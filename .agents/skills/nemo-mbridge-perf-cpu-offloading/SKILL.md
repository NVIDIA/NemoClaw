---
name: nemo-mbridge-perf-cpu-offloading
description: Validate and use CPU offloading in Megatron Bridge, including layer-level activation offloading and fractional optimizer state offloading with HybridDeviceOptimizer.
license: Apache-2.0
when_to_use: Enabling CPU offload to reduce GPU memory, or investigating a commit that changed CPU offloading config and caused OOM or a crash; 'cpu_offloading', 'optimizer_cpu_offload', 'optimizer_offload_fraction', 'HybridDeviceOptimizer', 'move optimizer to CPU'.
---

# CPU Offloading

## References

- Stable docs: @docs/training/cpu-offloading.md
- Structured metadata: @skills/nemo-mbridge-perf-cpu-offloading/card.yaml

## What It Is

Two independent mechanisms to move data from GPU to CPU memory:

| Mechanism | Config namespace | What gets offloaded | PP restriction |
|---|---|---|---|
| Activation offloading | `model.cpu_offloading*` | Activations (and optionally weights) per transformer layer | PP must be 1 |
| Optimizer offloading | `optimizer.optimizer_cpu_offload` | Adam optimizer states (momentum + variance) via `HybridDeviceOptimizer` | None |

## Quick Decision

| Situation | Recommendation |
|---|---|
| Large MoE model (30B+), needs PP > 1 | Optimizer offloading — activation offloading is blocked by PP=1 |
| Small/medium model, PP=1 fits, activation memory dominates | Activation offloading |
| Want tunable memory-speed tradeoff | Optimizer offloading with fractional `optimizer_offload_fraction` |
| Throughput is top priority | Don't enable — offloading always adds overhead |
| CUDA graphs are needed | Only optimizer offloading — activation offloading is incompatible |
| Memory pressure is moderate | Optimizer offload at 25–50% fraction for best efficiency |

## Enablement

### Optimizer CPU offloading (recommended for large models)

```python
cfg.optimizer.optimizer_cpu_offload = True
cfg.optimizer.optimizer_offload_fraction = 1.0
cfg.optimizer.overlap_cpu_optimizer_d2h_h2d = True
```

CLI overrides:

```bash
optimizer.optimizer_cpu_offload=True \
optimizer.optimizer_offload_fraction=0.5 \
optimizer.overlap_cpu_optimizer_d2h_h2d=True
```

### Activation CPU offloading (small/medium models only)

```python
cfg.model.cpu_offloading = True
cfg.model.cpu_offloading_num_layers = 16
cfg.model.cpu_offloading_activations = True
cfg.model.cpu_offloading_weights = False

cfg.model.pipeline_model_parallel_size = 1
cfg.model.recompute_granularity = None
cfg.model.cuda_graph_impl = "none"
```

## Config Parameter Reference

### Optimizer offloading

| Parameter | Default | Description |
|-----------|---------|-------------|
| `optimizer_cpu_offload` | `False` | Master switch |
| `optimizer_offload_fraction` | `0.0` | Fraction of optimizer states on CPU (0.0–1.0) |
| `overlap_cpu_optimizer_d2h_h2d` | `False` | Overlap GPU↔CPU transfers with compute |
| `use_torch_optimizer_for_cpu_offload` | `False` | Use `torch.optim` instead of fused optimizer for CPU portion |

### Activation offloading

| Parameter | Default | Description |
|-----------|---------|-------------|
| `cpu_offloading` | `False` | Master switch |
| `cpu_offloading_num_layers` | `0` | Number of transformer layers to offload (0 to num_layers-1) |
| `cpu_offloading_activations` | `True` | Offload activations |
| `cpu_offloading_weights` | `False` | Offload weights |
| `cpu_offloading_double_buffering` | `False` | Double-buffer across layers while reloading |

## Compatibility And Constraints

### Activation offloading

- `pipeline_model_parallel_size` must be 1
- `recompute_granularity` must be `None`
- Cannot combine with `fine_grained_activation_offloading`
- Cannot combine with CUDA graphs
- `cpu_offloading_num_layers` must be in `[0, num_layers-1)`

### Optimizer offloading

- Requires `use_distributed_optimizer = True` (default in most recipes)
- No PP, recompute, or CUDA graph restrictions
- `optimizer_offload_fraction` must be in `[0.0, 1.0]`

### Practical: large MoE models

Activation offloading is blocked for Qwen3-30B-A3B and similar large MoE
models. The PP=1 constraint means each GPU holds all 48 layers; model
weights + optimizer states alone (~70 GB) exceed H100 80 GB capacity.

## Minimal Runnable Command

```bash
uv run python scripts/training/run_recipe.py \
  --recipe qwen3_30b_a3b_pretrain_config \
  optimizer.optimizer_cpu_offload=True \
  optimizer.optimizer_offload_fraction=0.5 \
  train.train_iters=20 \
  train.global_batch_size=8 \
  train.micro_batch_size=1
```

## Verification

### Unit tests

```bash
uv run python -m pytest \
  tests/unit_tests/models/test_gpt_full_te_layer_autocast_spec.py -k "cpu_offload" \
  tests/unit_tests/peft/test_utils.py -k "cpu_offload" -q
```

### Success criteria

- Config validation passes for the selected offloading mode
- Training completes without OOM or NCCL errors
- Loss matches the non-offloaded baseline (max delta < 0.001)
- Memory usage drops proportionally to offload fraction

## Code Anchors

### MCore activation offload constraints

```1296:1310:3rdparty/Megatron-LM/megatron/core/transformer/transformer_config.py
        if self.cpu_offloading and (
            self.cpu_offloading_num_layers < 0 or self.cpu_offloading_num_layers >= self.num_layers
        ):
            raise ValueError(...)

        if self.cpu_offloading and self.pipeline_model_parallel_size > 1:
            raise ValueError(
                "Currently there is no support for Pipeline parallelism with CPU offloading"
            )

        if self.cpu_offloading and self.recompute_granularity is not None:
            raise ValueError(
                "CPU offloading does not work when activation recomputation is enabled"
            )
```

### MCore CUDA graph incompatibility

```1943:1944:3rdparty/Megatron-LM/megatron/core/transformer/transformer_config.py
            if self.cpu_offloading:
                raise ValueError("CUDA graphs not supported with CPU offloading.")
```

### MCore fine-grained offloading mutual exclusion

```1427:1430:3rdparty/Megatron-LM/megatron/core/transformer/transformer_config.py
        if self.fine_grained_activation_offloading:
            assert (
                not self.cpu_offloading
            ), "fine_grained_activation_offloading cannot be enabled with cpu_offloading."
```

### MCore HybridDeviceOptimizer instantiation

```480:518:3rdparty/Megatron-LM/megatron/core/optimizer/__init__.py
        if config.optimizer_cpu_offload:
            # ... setup cpu/gpu optimizer classes ...
            optimizer = HybridDeviceOptimizer(
                param_groups,
                offload_fraction=config.optimizer_offload_fraction,
                cpu_optimizer_cls=cpu_optimizer_cls,
                gpu_optimizer_cls=gpu_optimizer_cls,
                overlap_cpu_optimizer_d2h_h2d=config.overlap_cpu_optimizer_d2h_h2d,
                pin_cpu_grads=config.pin_cpu_grads,
                pin_cpu_params=config.pin_cpu_params,
            )
```

### Bridge CUDA graph guard

```232:234:src/megatron/bridge/models/gpt_full_te_layer_autocast_spec.py
        assert not config.cpu_offloading and config.recompute_granularity is None, "Cudagraphs not supported"
```

### Bridge activation offloading in PEFT

```621:631:src/megatron/bridge/peft/utils.py
        if self.config.cpu_offloading and self.config.cpu_offloading_activations:
            x.activation_offloading = True
        x, _ = self.linear_in(x)
        x = self.activation(x)
        if self.config.cpu_offloading and self.config.cpu_offloading_activations:
            x.activation_offloading = True
        x, _ = self.linear_out(x)
```

## Failure Diagnosis

| Symptom | Likely Cause | How To Confirm | Fix |
|---|---|---|---|
| `Currently there is no support for Pipeline parallelism with CPU offloading` | Activation offload + PP > 1 | Check `pipeline_model_parallel_size` | Set PP=1 or use optimizer offloading |
| `CPU offloading does not work when activation recomputation is enabled` | Activation offload + recompute | Check `recompute_granularity` | Set `recompute_granularity=null` |
| `fine_grained_activation_offloading cannot be enabled with cpu_offloading` | Both offloading modes enabled | Check both flags | Use one or the other |
| `CUDA graphs not supported with CPU offloading` | CUDA graphs + activation offload | Check `cuda_graph_impl` | Set `cuda_graph_impl="none"` |
| OOM with activation offloading | Model too large for PP=1 | Check allocated memory vs 80 GB | Use optimizer offloading with PP > 1 |
| Extreme slowdown (>4x) | 100% optimizer offload, CPU Adam bottleneck | Compare iter time at different fractions | Reduce fraction or enable `overlap_cpu_optimizer_d2h_h2d` |
| OOM at partial optimizer offload | Insufficient offload for this config | Check memory at different fractions | Increase fraction or add PP |

## Known Limitations

- Activation offloading requires PP=1, making it impractical for large models
  (30B+ MoE) that need pipeline parallelism.
- Optimizer offloading throughput penalty scales linearly (~1.9x at 25%,
  ~4.2x at 100% for Qwen3-30B-A3B).
- D2H/H2D overlap provides only ~7% speedup because CPU Adam compute is
  the dominant bottleneck.
- `fine_grained_activation_offloading` is a separate module-level approach
  that works with PP > 1 but cannot be combined with layer-level
  `cpu_offloading`.
