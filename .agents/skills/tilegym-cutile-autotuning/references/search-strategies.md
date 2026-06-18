# Search Strategies

How to search the autotune space efficiently and validate that the selected config is actually optimal.

## Strategy 1: Exhaustive Search (Default)

Use `exhaustive_search` from `cuda.tile.tune` to compile and benchmark every config in the search space, then cache the result and launch with `ct.launch`.

**When to use**: Search space <= 30 configs (all elementwise, most matmul, most FMHA). This is the recommended strategy for all well-designed search spaces.

**Pattern: tune-once / cache / launch**:
```python
from cuda.tile.tune import exhaustive_search, TuningResult
import cuda.tile as ct

# 1. Generate all configs
configs = list(my_config_generator())

# 2. Tune once (exhaustive search over all configs)
result = exhaustive_search(
    configs,
    stream,
    grid_fn=my_grid_fn,
    kernel=my_kernel,
    args_fn=my_args_fn,
    hints_fn=my_hints_fn,
)
best_cfg = result.best.config

# 3. Cache BOTH the config and tuned kernel (Pitfall #7: avoid replace_hints on hot path)
tuned_kernel = my_kernel.replace_hints(occupancy=best_cfg.occupancy)
_tuning_cache[cache_key] = (best_cfg, tuned_kernel)

# 4. Launch with the cached tuned kernel
best_cfg, tuned_kernel = _tuning_cache[cache_key]
grid = my_grid_fn(best_cfg)
ct.launch(stream, grid, tuned_kernel, my_args_fn(best_cfg))
```

**Timing behavior**:
- Each config: ~0.3-1s compilation + warmup(2) + measurement(rep=10) via CUDA events
- 4 configs (occupancy only): ~2-4s total
- 12 configs (occ x num_ctas): ~5-12s total
- 24 configs (block_m x occ x swap_ab): ~10-24s total

**Cache behavior**: `exhaustive_search` itself does not cache results. The caller must implement caching (e.g., a dict keyed by shapes/dtypes). Cache both the best config AND the tuned kernel as a `(best_cfg, tuned_kernel)` tuple — this avoids calling `replace_hints` on every launch (Pitfall #7). On cache hit, skip `exhaustive_search` entirely and go straight to `ct.launch` with the cached tuned kernel. This gives zero overhead on subsequent calls, proven by A/B testing.

**Power-of-2 cache key optimization**: For GEMM-class kernels with many possible input shapes, round dimensions to the next power of 2 in the cache key to reduce unique key count:
```python
def _next_pow2(n):
    return 1 << (n - 1).bit_length() if n > 0 else 1

cache_key = (_next_pow2(M), _next_pow2(N), _next_pow2(K), dtype, str(device))
```
This avoids re-tuning for similar shapes (e.g., M=4000 and M=4096 share the same key). The optimal config for a power-of-2-rounded shape is typically optimal for nearby sizes as well.

## Strategy 2: Profile-Guided Tuning

When autotune alone isn't enough -- use NCU profiling to understand why a kernel is slow, then design a targeted search space.

### Workflow

```
Step 1: Baseline profiling
  -> DISABLE_AUTOTUNE=1 ncu --set full -o baseline.ncu-rep python my_benchmark.py
  -> Identify bottleneck: compute, memory, or latency

Step 2: Classify bottleneck
  -> Compute-bound (SM throughput > 80% SOL) -> Tune tile sizes
  -> Memory-bound (DRAM bandwidth > 80% SOL) -> Proceed with occupancy-only autotune;
      expect <2% gain; note bottleneck to user; suggest codegen fixes (see "Further Optimization Suggestions" in SKILL.md)
  -> Latency-bound (low occupancy, low utilization) -> Tune occupancy

Step 3: Design targeted search space
  -> Based on bottleneck, add/remove parameters from the search

Step 4: Implement and run exhaustive_search
  -> exhaustive_search(configs, stream, grid_fn, kernel, args_fn, hints_fn)

Step 5: Re-profile with best config
  -> DISABLE_AUTOTUNE=1 ncu ... (with best config hardcoded)
  -> Verify improvement in the target metric

Step 6: Iterate or accept
  -> If improved -> accept
  -> If not improved -> the bottleneck is elsewhere (codegen, algorithm)
```

### NCU + Autotune Interaction

**Problem**: NCU profiles all kernel launches, including autotune trial runs. This clutters the trace and makes profiling slow.

**Solution 1**: Disable autotune for profiling:
```bash
DISABLE_AUTOTUNE=1 ncu --set full -o profile.ncu-rep python my_test.py
```

**Solution 2**: Run tuning separately, then profile with the cached best config:
```python
# Step 1: Run exhaustive_search to find optimal config (outside NCU)
result = exhaustive_search(configs, stream, grid_fn, kernel, args_fn, hints_fn)
best_cfg = result.best.config
print(f"Best config: {best_cfg}")  # note down for hardcoding

# Step 2: Profile with hardcoded best config under NCU
# ncu --set full -o profile.ncu-rep python my_test.py --config <best_cfg>
```

## Search Space Size Guidelines

Keep total configs <= 30 so exhaustive search covers every candidate without excessive tuning time.

| Search Space Size | Action |
|-------------------|--------|
| 1-30 configs | Exhaustive search -- pass all configs to `exhaustive_search` |
| >30 configs | Prune via arch filter, tile size filter, or pruning rules until <= 30 |

## A/B Test Methodology

Validate that the tune-once/cache/launch pattern works correctly. Three tests, in order of importance:

### Test 1: Cached Config vs Fixed Config (Overhead Test)

Compare `ct.launch` with cached tuned config vs `ct.launch` with a manually chosen fixed config. Run each with warmup(5) + timed(100) iterations using CUDA events. Verified on B200 LayerNorm: zero overhead on cache hit, and up to 24% improvement when autotune selects a better occupancy.

### Test 2: Config Selection Correctness

Run kernel with each config manually, measure time, compare with `exhaustive_search`'s choice. Verified on B200 LayerNorm: `exhaustive_search` correctly selected the optimal config in all 7 tested shapes.

### Test 3: Tuning Time Budget

| Configs | Expected Time | Acceptable? |
|---------|-------------|-------------|
| 4 | 2-4s | Yes |
| 12 | 5-12s | Yes |
| 24 | 10-24s | Yes, if justified |
| 32+ | >60s (compilation-bound) | No — reduce space |

**Why 32+ configs exceed 60s**: Each config triggers JIT compilation (~0.5-2s each). Configs that exceed shared memory limits fail during compilation, compounding overhead.

## DISABLE_AUTOTUNE Testing Pattern

Every kernel with exhaustive_search should support a fallback path for CI:

```python
import os
import cuda.tile as ct
from cuda.tile.tune import exhaustive_search

def _should_disable_autotune():
    return os.environ.get("DISABLE_AUTOTUNE", "0") == "1"

def my_operation(x, y):
    stream = torch.cuda.current_stream()
    configs = list(_my_autotune_configs())

    if _should_disable_autotune():
        # Use first config without tuning
        cfg = configs[0]
        kernel = my_kernel.replace_hints(occupancy=cfg.occupancy)
        grid = my_grid_fn(cfg)
        ct.launch(stream, grid, kernel, my_args_fn(cfg))
    else:
        # Tune once, cache (best_cfg, tuned_kernel), then launch
        cache_key = _make_cache_key(x, y)
        if cache_key not in _tuning_cache:
            result = exhaustive_search(
                configs,
                stream,
                grid_fn=my_grid_fn,
                kernel=my_kernel,
                args_fn=my_args_fn,
                hints_fn=my_hints_fn,
            )
            best_cfg = result.best.config
            tuned_kernel = my_kernel.replace_hints(occupancy=best_cfg.occupancy)
            _tuning_cache[cache_key] = (best_cfg, tuned_kernel)
        cfg, kernel = _tuning_cache[cache_key]
        grid = my_grid_fn(cfg)
        ct.launch(stream, grid, kernel, my_args_fn(cfg))
```

This pattern is used in `ops/cutile/attention.py` (`cutile_autotune_fmha`).

## Warm-Up Best Practices

### Process-Level Warm-Up

First process run is always slower due to driver/JIT caches:

| Run | LayerNorm (512, 4096) | Cause |
|-----|----------------------|-------|
| 1st pytest run | 0.0103ms | Driver cold start |
| 2nd run (cache cleared) | 0.0082ms | JIT cache warm |
| 3rd+ runs | 0.0082ms | Stable |

**Rule**: Never use first-process timing for autotune validation. Always run a warm-up process first.

### In-exhaustive_search Warm-Up

`exhaustive_search` internally uses `warmup=2, rep=10` per config with CUDA event timing. This ensures compilation overhead doesn't affect config selection.

### Benchmark Warm-Up

For external benchmarking (outside autotune), use:
```python
# Warm-up: 5 untimed iterations
for _ in range(5):
    result = my_op(x)
torch.cuda.synchronize()

# Timed: 100 iterations with CUDA events
start = torch.cuda.Event(enable_timing=True)
end = torch.cuda.Event(enable_timing=True)
start.record()
for _ in range(100):
    result = my_op(x)
end.record()
torch.cuda.synchronize()
ms = start.elapsed_time(end) / 100
```

**Additional best practices for reliable benchmarking**:
- **Lock GPU frequency**: Use `nvidia-smi -lgc <freq>` to lock GPU clock to a fixed frequency during benchmarking. Frequency scaling causes variance between runs.
- **Outlier removal**: Discard the first 1-2 iterations (even after warmup) and use the minimum or trimmed mean of the remaining samples. Outliers from OS scheduling or GC pauses can skew results.
