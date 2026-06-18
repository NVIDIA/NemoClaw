# exhaustive_search API Reference

> **⚠️ Deprecated API**: `cuda.tile_experimental.autotune_launch()` (aka `ct_experimental.autotune_launch`) is deprecated and should NOT be used. It combines search + launch in one call with random sampling, which produces less reproducible results and worse config selection compared to `exhaustive_search`. Always use `cuda.tile.tune.exhaustive_search` (the current API below) with explicit caching and `ct.launch`.

## Current API (`cuda.tile.tune`)

```python
from cuda.tile.tune import exhaustive_search, TuningResult

result: TuningResult = exhaustive_search(
    search_space,   # Sequence[T] — list or tuple of configs (NOT a generator)
    stream,         # torch.cuda.current_stream()
    grid_fn,        # callable(cfg) → tuple[int, ...]
    kernel,         # @ct.kernel decorated function
    args_fn,        # callable(cfg) → tuple of kernel args
    hints_fn=None,  # callable(cfg) → {"occupancy": int, "num_ctas": int}
    *,
    quiet=False     # suppress output
)
```

## TuningResult

```python
@dataclass
class TuningResult[T]:
    best: Measurement       # best config + timing (mean_us, error_margin_us, num_samples)
    successes: Sequence[Measurement]   # all successful configs (sorted by performance)
    failures: Sequence[tuple[T, str, str]]  # (config, exception_type, message)
```

Key properties:
- **Exhaustive**: evaluates ALL configs in order — no random sampling, no skipped configs
- **Search only**: does not perform the final production launch — it executes trial runs internally for benchmarking, but you call `ct.launch` separately for the actual production invocation
- **No built-in cache**: you manage caching explicitly (see tune-once/cache/launch pattern)
- **Deterministic**: same search space always produces the same evaluation order

## Tune-Once / Cache / Launch Pattern

This is the **recommended pattern** for all autotuned kernels. It ensures:
- First call: runs `exhaustive_search` to find the best config (~2-30s depending on space size)
- Subsequent calls: uses cached config with `ct.launch` — zero overhead (identical to a fixed `ct.launch`)

```python
_cache = {}

def run_kernel_autotuned(x, ...):
    stream = torch.cuda.current_stream()
    cache_key = (x.shape, x.dtype, str(x.device))

    if cache_key not in _cache:
        configs = list(_my_autotune_configs())
        result = exhaustive_search(
            configs, stream,
            grid_fn=lambda cfg: ...,
            kernel=my_kernel,
            args_fn=lambda cfg: ...,
            hints_fn=lambda cfg: {"occupancy": cfg.occupancy},
        )
        best_cfg = result.best.config
        tuned_kernel = my_kernel.replace_hints(occupancy=best_cfg.occupancy)
        _cache[cache_key] = (best_cfg, tuned_kernel)  # cache BOTH config and compiled kernel

    cfg, tuned_kernel = _cache[cache_key]
    grid = compute_grid(cfg)
    ct.launch(stream, grid, tuned_kernel, (x, ...))
```

**Why this pattern matters**: The `ct.launch` call in the fast path is identical to what you'd write for a fixed-config kernel. There is zero per-call overhead — no lock, no hash lookup, no lambda invocation. The only cost is the Python dict lookup for `_cache[cache_key]`.

> **⚠️ Critical: always cache the tuned kernel object, not just the config.** `replace_hints()` returns a **new** kernel object with its own independent JIT cache. Calling it on every invocation triggers recompilation each time, degrading performance by 100–500×. Call `replace_hints()` once after `exhaustive_search`, store the returned kernel in the cache alongside the config, and reuse it directly on the fast path. See Pitfall #7.

## replace_hints

After finding the best config, use `kernel.replace_hints()` to create a kernel variant with the optimal hints:

```python
# For occupancy-only:
tuned_kernel = my_kernel.replace_hints(occupancy=cfg.occupancy)

# For occupancy + num_ctas:
tuned_kernel = my_kernel.replace_hints(occupancy=cfg.occupancy, num_ctas=cfg.num_ctas)
```

`replace_hints` accepts only `occupancy` and `num_ctas` — these are the only compiler hints controllable via the autotune API.

**`ByTarget` wrapping for cross-architecture portability**: When creating tuned kernel variants via `ct.kernel()`, prefer wrapping hint values in `ct.ByTarget` for portability across GPU architectures:

```python
# Preferred: explicit architecture targeting (portable)
tuned_kernel = ct.kernel(
    my_kernel._pyfunc,
    occupancy=ct.ByTarget(sm_100=best_cfg.occupancy),
    num_ctas=ct.ByTarget(sm_100=best_cfg.num_ctas, default=1),
)

# Also acceptable: plain integers (when targeting a single architecture)
tuned_kernel = ct.kernel(my_kernel._pyfunc, occupancy=best_cfg.occupancy)
```

When targeting only the current GPU (the common case in autotuning), plain integers work fine. Use `ByTarget` when the code may run on multiple architectures or when following production conventions (TileGym production code consistently uses `ByTarget`).

## Kernel Hints

CuTile kernel performance is controlled by two compile-time hints:

- **`occupancy`**: Number of CTAs per SM. Higher occupancy = more parallelism but less shared memory per CTA.
- **`num_ctas`**: Number of CTAs in a CGA (Cooperative Group Array). Used for multi-CTA cooperation (e.g., TMA multicast). Only supported on sm90+.

Three ways to set hints:

```python
# 1. Fixed value in decorator (no autotune needed)
@ct.kernel(occupancy=2, num_ctas=1)
def my_kernel(...): ...

# 2. Architecture-specific fixed value (no autotune needed)
@ct.kernel(num_ctas=ct.ByTarget(sm_100=2, sm_120=1, default=1))
def my_kernel(...): ...

# 3. Runtime autotune via exhaustive_search + replace_hints
# IMPORTANT: Remove fixed hints from decorator first!
@ct.kernel
def my_kernel(...): ...

# Then in the host wrapper:
tuned_kernel = my_kernel.replace_hints(occupancy=best_occ, num_ctas=best_ctas)
ct.launch(stream, grid, tuned_kernel, args)
```

**Important**: `replace_hints` correctly overrides decorator hints (it uses `dataclasses.replace()` internally). However, if you forget to call `replace_hints`, the decorator's fixed values are used instead of the autotuned values. To avoid this confusion, always remove fixed hints from the `@ct.kernel(...)` decorator before adding autotuning — this makes it explicit that hints come only from the autotune path.

## search_space Design

The search space is a list of `SimpleNamespace` objects. Each namespace holds config fields that `grid_fn`, `args_fn`, and `hints_fn` can read.

```python
from types import SimpleNamespace

# Occupancy-only (elementwise kernels)
def autotune_configs():
    for occ in [1, 2, 4, 8]:
        yield SimpleNamespace(occupancy=occ)

# Full matmul search space — see parameter-space-design.md for complete per-architecture configs
# Pattern: yield SimpleNamespace(TILE_SIZE_M=..., TILE_SIZE_N=..., TILE_SIZE_K=..., num_ctas=..., occupancy=...)
```

**Note**: `exhaustive_search` requires a `Sequence` (list/tuple), not a generator. Always convert with `list()`:
```python
configs = list(autotune_configs())
result = exhaustive_search(configs, ...)
```

## grid_fn Patterns

```python
from math import ceil

# Pattern A: Simple tile coverage (matmul, elementwise)
grid_fn=lambda cfg: (ceil(M / cfg.TILE_SIZE_M) * ceil(N / cfg.TILE_SIZE_N), 1, 1)

# Pattern B: Persistent matmul (static_persistent_matmul_kernel)
NUM_SMS = torch.cuda.get_device_properties("cuda").multi_processor_count
grid_fn=lambda cfg: (
    min(NUM_SMS // cfg.num_ctas, ceil(M / cfg.TILE_M) * ceil(N / cfg.TILE_N)) * cfg.occupancy,
    1, 1,
)

# Pattern C: 2D grid (FMHA — one dim for seq tiles, one for batch*heads)
grid_fn=lambda cfg: (ceil(q_len / cfg.TILE_M), batch_size * num_heads, 1)

# Pattern D: 1D elementwise (cdiv = math.ceil(a/b), from ct_ops.py)
grid_fn=lambda cfg: (cdiv(n_elements, BLOCK_SIZE),)

# Pattern E: Grouped GEMM persistent (grid fixed at NUM_SMS, occupancy via hints_fn only)
grid_fn=lambda cfg: (NUM_SMS, 1, 1)
```
