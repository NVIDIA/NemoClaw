# Optimization Playbook


Step-by-step recipes for each performance optimization. Apply ONE per iteration.

---

## Optimization A: Replace Gather/Scatter with TMA

**Impact**: 2-78x
**When**: Kernel uses `ct.gather`/`ct.scatter` for contiguous or block-aligned access patterns.

TMA (`ct.load`/`ct.store`) uses the Tensor Memory Accelerator hardware unit and is dramatically faster than software-computed gather/scatter for regular access.

### Before (gather — slow)
```python
@ct.kernel
def kernel(X, Y, BLOCK: ct.Constant[int]):
    bid = ct.bid(0)
    indices = bid * BLOCK + ct.arange(BLOCK, dtype=ct.int32)
    x = ct.gather(X, indices, check_bounds=True)
    result = compute(x)
    ct.scatter(Y, indices, result, check_bounds=True)
```

### After option 1: Direct TMA (block-aligned access)
```python
@ct.kernel
def kernel(X, Y, BLOCK: ct.Constant[int]):
    bid = ct.bid(0)
    x = ct.load(X, index=(bid,), shape=(BLOCK,), padding_mode=ct.PaddingMode.ZERO)  # index = BLOCK index, NOT element offset
    result = compute(x)
    ct.store(Y, index=(bid,), tile=result)
```

### After option 2: Array.slice for ragged/variable-length
```python
@ct.kernel
def kernel(X, Y, start: int, length: int, BLOCK: ct.Constant[int]):
    bid = ct.bid(0)
    seg = X.slice(axis=0, start=start, stop=start + length)
    x = ct.load(seg, index=(bid,), shape=(BLOCK,), padding_mode=ct.PaddingMode.ZERO)
    result = compute(x)
    seg_out = Y.slice(axis=0, start=start, stop=start + length)
    ct.store(seg_out, index=(bid,), tile=result)
```

### After option 3: ct.gather().item() + TMA for paged/indirect access
```python
@ct.kernel
def kernel(X, block_table, Y, BLOCK: ct.Constant[int]):
    bid = ct.bid(0)
    # Extract scalar page ID, then use TMA
    page_id = ct.gather(block_table, (bid,), padding_value=0).item()
    x = ct.load(X, index=(page_id, 0), shape=(1, BLOCK), allow_tma=True)
    # ... compute and store
```

**Decision**: Use TMA whenever data is contiguous or block-aligned. Use gather only for truly sparse random access.

**Ampere (sm80/sm86) note**: Hardware TMA is not available on this generation. `ct.load`/`ct.store` with `allow_tma=True` falls back to `cp.async` emulation, adding ~8-15% overhead. When running on Ampere, redirect to the non-TMA path and emit a `UserWarning` rather than adding TMA:

```python
if use_tma and torch.cuda.get_device_capability()[0] < 9:
    import warnings
    warnings.warn(
        "use_tma=True has no effect on this GPU — TMA is emulated via cp.async. "
        "Falling back to use_tma=False.",
        UserWarning, stacklevel=3,
    )
    use_tma = False
```

> **⚠️ Ampere (sm80/sm86) correctness (silent-corruption risk)**: if you keep `allow_tma=True` on a code path that may load out-of-bounds (e.g. ragged tails, partial tiles), you **must** pass `padding_mode=ct.PaddingMode.ZERO`. Hardware TMA on SM90+ auto-zero-fills OOB addresses, but the `cp.async` emulation used on Ampere does **not** — OOB lanes read undefined memory and produce wrong results with no error. Either set `padding_mode=ct.PaddingMode.ZERO` on the load, or route Ampere through the non-TMA path as shown above.

---

## Optimization B: Add Persistent Scheduling

**Impact**: +50-300%
**When**: Kernel processes many independent work items (rows, tiles) with `grid = (n_items,)`.

### Before (one block per work item)
```python
@ct.kernel
def kernel(input, output, N: ct.Constant[int]):
    row = ct.bid(0)
    data = ct.load(input, index=(row, 0), shape=(1, N))
    result = compute(data)
    ct.store(output, index=(row, 0), tile=result)

# Launch
grid = (n_rows, 1, 1)
ct.launch(stream, grid, kernel, (input, output, N))
```

### After (persistent — fewer blocks, each processes multiple rows)
```python
@ct.kernel
def kernel(input, output, n_rows: ct.Constant[int], N: ct.Constant[int]):
    pid = ct.bid(0)
    num_programs = ct.num_blocks(0)
    for row_idx in range(pid, n_rows, num_programs):
        data = ct.load(input, index=(row_idx, 0), shape=(1, N))
        result = compute(data)
        ct.store(output, index=(row_idx, 0), tile=result)

# Launch
NUM_SM = torch.cuda.get_device_properties(device).multi_processor_count
occupancy = 4  # or from autotune cfg.occupancy
num_programs = min(NUM_SM * occupancy, n_rows)
grid = (num_programs, 1, 1)
ct.launch(stream, grid, kernel, (input, output, n_rows, N))
```

**Heuristic**: Use persistent scheduling when `n_work_items > NUM_SM * 2`.

---

## Optimization C: Add Autotune with Wide Config Space

**Impact**: +10-50%
**When**: Kernel uses fixed occupancy/num_ctas/tile sizes, or has no autotune at all.

### Template (Recommended: `ct.tune.exhaustive_search`)
```python
from types import SimpleNamespace
import cuda.tile as ct

def _my_kernel_autotune_configs():
    """Generate autotune search space — be generous with range."""
    gpu_cap = torch.cuda.get_device_capability()

    if gpu_cap >= (10, 0):   # Blackwell datacenter (sm100+) and consumer (sm120)
        tile_sizes = [128, 256, 512, 1024]
        occupancies = [1, 2, 4, 8, 16]
        num_ctas_list = [1, 2, 4]
    elif gpu_cap >= (9, 0):  # Hopper (H100 / H200)
        tile_sizes = [64, 128, 256, 512]
        occupancies = [1, 2, 4, 8]
        num_ctas_list = [1]
    else:                    # Ampere (sm80/sm86)
        tile_sizes = [64, 128, 256]
        occupancies = [1, 2, 4]
        num_ctas_list = [1]

    configs = []
    for tile in tile_sizes:
        for occ in occupancies:
            for ncta in num_ctas_list:
                configs.append(SimpleNamespace(
                    TILE_SIZE=tile, occupancy=occ, num_ctas=ncta
                ))
    return configs

def launch_my_kernel(stream, input, output, N):
    NUM_SM = torch.cuda.get_device_properties(input.device).multi_processor_count

    result = ct.tune.exhaustive_search(
        search_space=_my_kernel_autotune_configs(),  # must be a Sequence (list), not a generator
        stream=stream,
        grid_fn=lambda cfg: (min(NUM_SM * cfg.occupancy, N), 1, 1),
        kernel=my_kernel,
        args_fn=lambda cfg: (input, output, cfg.TILE_SIZE, N),
        hints_fn=lambda cfg: {
            "num_ctas": cfg.num_ctas,
            "occupancy": cfg.occupancy,
        },
    )
    # result.best_config, result.best_time_us, result.timings available
```

> **Note**: The legacy API `ct_experimental.autotune_launch()` still works but emits a `DeprecationWarning`.
> Key differences: `ct.tune.exhaustive_search` takes `search_space` as a `Sequence` (first positional arg),
> not an `Iterable | Callable` keyword arg. Convert generators to lists.

**Key**: Do NOT hardcode `occupancy=N` in `@ct.kernel()` when using autotune — pass it via `hints_fn`.

---

## Optimization D: Add TF32 Dtype Guard for MMA

**Impact**: ~2x for FP32 MMA operations
**When**: Kernel uses `ct.mma()` with FP32 inputs without casting to TF32 first.

cuTile's `ct.mma` does NOT auto-cast FP32 to TF32. You must explicitly cast.

### Before
```python
a = ct.load(A, index=(bid_m, k), shape=(TILE_M, TILE_K))
b = ct.load(B, index=(k, bid_n), shape=(TILE_K, TILE_N))
acc = ct.mma(a, b, acc=acc)
```

### After
```python
a = ct.load(A, index=(bid_m, k), shape=(TILE_M, TILE_K))
b = ct.load(B, index=(k, bid_n), shape=(TILE_K, TILE_N))

# Cast FP32 → TF32 for tensor core utilization
dtype = ct.tfloat32 if a.dtype == ct.float32 else a.dtype
a = ct.astype(a, dtype)
b = ct.astype(b, dtype)

acc = ct.mma(a, b, acc=acc)  # Now uses tensor cores
```

---

## Optimization E: Add Latency Hints

**Impact**: +2-5%
**When**: Kernel has `ct.load`/`ct.store` calls without `latency=` parameter.

Latency hints tell the compiler about expected DRAM traffic intensity, enabling better prefetching.

### Recipe
```python
# On ct.load — higher values = more aggressive prefetch
ct.load(X, index=(bid, 0), shape=(M, N), latency=10)   # +2% in rms_norm

# On ct.store — moderate values
ct.store(Y, index=(bid, 0), tile=y, latency=3)          # +3% in rms_norm

# On ct.gather/ct.scatter
ct.gather(x, (row, offs), latency=1)
ct.scatter(out, (row, offs), yj, latency=1)
```

**Sweep strategy**: Try latency values {1, 2, 3, 6, 10} on the hottest loads. Benchmark each.

---

## Optimization F: Disable TMA on Store

**Impact**: +10-30%
**When**: Kernel uses `ct.store()` without `allow_tma=False`.

For some kernels, disabling TMA on the store path gives a significant boost. This was discovered in rms_norm (+30%).

### Recipe
```python
# Before
ct.store(Y, index=(bid, 0), tile=result)

# After — try both and benchmark
ct.store(Y, index=(bid, 0), tile=result, allow_tma=False)  # +30% in rms_norm!
```

**Caution**: Does NOT always help. Must benchmark to verify.

---

## Optimization G: Tile Size Tuning

**Impact**: +5-50% depending on mismatch
**When**: Current tile sizes are suboptimal for the workload or GPU architecture.

For per-architecture tile size constraints and recommended search spaces, see `tilegym-cutile-autotuning` skill.

---

## Optimization H: Numerical Shortcuts

**Impact**: +1-5%
**When**: Kernel has many `ct.exp2`, `ct.truediv`, or similar math ops, and slight precision loss is acceptable.

> **Note**: `ct.exp()` does NOT accept `flush_to_zero`. Only `ct.exp2`, `ct.rsqrt`, and `ct.truediv` support it.

### flush_to_zero
```python
# Skip denormal number handling
# ct.exp() does NOT support flush_to_zero — use ct.exp2() instead
ct.exp2(qk, flush_to_zero=True)
ct.rsqrt(variance, flush_to_zero=True)
```

### Approximate division
```python
ct.truediv(1.0, denom, flush_to_zero=True, rounding_mode=ct.RoundingMode.APPROX)
```

**Caution**: May cause correctness failures with tight tolerances. Loosen atol/rtol if needed, but only after confirming the precision loss is acceptable for the use case.

---

## Optimization I: GROUP_SIZE_M (2D Block Swizzling)

**Impact**: +5-15% for large 2D tiled kernels
**When**: Kernel uses 2D tile grid (matmul, attention, bmm) without block swizzling.

### Recipe
```python
def swizzle_2d(M, N, TILE_SIZE_M, TILE_SIZE_N, GROUP_SIZE_M):
    bid = ct.bid(0)
    num_bid_m = ct.cdiv(M, TILE_SIZE_M)
    num_bid_n = ct.cdiv(N, TILE_SIZE_N)
    num_bid_in_group = GROUP_SIZE_M * num_bid_n
    group_id = bid // num_bid_in_group
    first_bid_m = group_id * GROUP_SIZE_M
    group_size_m = min(num_bid_m - first_bid_m, GROUP_SIZE_M)
    bid_m = first_bid_m + (bid % group_size_m)
    bid_n = (bid % num_bid_in_group) // group_size_m
    return bid_m, bid_n
```

Try GROUP_SIZE_M in {4, 8, 16}. The optimal value depends on matrix shape and L2 cache size.

---

## Optimization J: Token Dependency Mitigation

**Impact**: Variable (sometimes significant)
**When**: IR analysis shows cuTile has unnecessary token chains.

### Detect
dump cuTile bytecode (`CUDA_TILE_DUMP_BYTECODE=/tmp/cutile_bytecode`) and TileIR (`CUDA_TILE_DUMP_TILEIR=/tmp/cutile_tileir`)
```bash
# Check token operations in cuTile IR
grep -i "token" /tmp/cutile_tileir/*.cuda_tile.mlir
```

### Mitigate
```bash
CUDA_TILE_TESTING_DISABLE_TOKEN_ORDER=1 \
  python -m pytest tests/suites/<suite>/test_<op>.py -k "test_op and cutile" --timeout=120
```

**CRITICAL**: Always verify correctness after disabling tokens. If correctness fails, the tokens are required.

---

## Optimization K: Batch Small Copy Kernels

**Impact**: +10-70% when launch overhead dominates
**When**: An op launches one similar cuTile copy kernel per input/segment, each
copy is regular enough to use `ct.load`/`ct.store`, and each individual launch
does relatively little work.

Group several independent copies into one fixed-slot kernel and use one grid
dimension to select the active slot.

### Recipe

1. Sweep a small fixed slot count, e.g. {2, 4, 8}, and keep the best result.
2. Define the kernel signature with one input view and metadata tuple per slot.
3. Branch on `ct.bid(2)` to select the active slot.
4. Keep the actual `ct.load`/`ct.store` tile shape fixed after the branch.
5. On the host, pack up to `KERNEL_SLOTS` entries per launch, pad unused slots
   with a valid dummy view, and launch the slot grid dimension with only the
   real entry count.

### Preserve Store Vectorization

After batching, inspect SASS for store-width regressions such as `STG.E.128`
becoming scalar stores like `STG.E.U16`. Dynamic output slices may lose scalar
alignment/divisibility facts that the original single-copy kernel kept.

If the host can prove the runtime slice bounds are divisible by the needed
alignment, pass that fact as a constant divisor and materialize it before the
dynamic `Array.slice`:

```python
SLICE_DIVISOR = 16 if all_slice_bounds_are_divisible_by_16 else 1
start = (start // SLICE_DIVISOR) * SLICE_DIVISOR
stop = (stop // SLICE_DIVISOR) * SLICE_DIVISOR
```

This is semantics-preserving only when the host passes the larger divisor for
runtime bounds that are actually divisible by it; otherwise pass `1`. Benchmark
both with and without the divisor expression. Launch reduction can be canceled
out by scalarized stores.

**Compatibility note**: Branch-selecting views can expose type-compatibility
checks. If needed, split incompatible cases into host buckets while preserving
original output offsets.

---

## Optimization L: Customized Creative Optimization Plan (Last Resort)

**Impact**: Variable — depends on kernel characteristics
**When**: All standard optimizations (A–K) have been exhausted or are inapplicable, and further performance gains are still desired. This is a last-resort creative pass.

### Recipe

Carefully inspect the kernel code, its access patterns, computation graph, and profiling data (`ncu` / `nsys`). Then **generate a custom optimization plan** with ~20 items tailored to the specific kernel. Each item should be a concrete, actionable change.

**Step 1: Deep analysis**
- Re-read the kernel source and all profiling results collected so far
- Identify any remaining inefficiencies: redundant loads, suboptimal memory access patterns, unnecessary synchronization, under-utilized hardware features, suboptimal data types, etc.

**Step 2: Generate the plan**

Produce a numbered list of ~20 optimization items. Examples of what items might look like (these are illustrative — your plan should be kernel-specific):

1. Fuse adjacent elementwise ops into the main loop body to reduce memory round-trips
2. Reorder loop dimensions to improve L2 cache hit rate for the dominant access pattern
3. Replace scalar reductions with warp-shuffle-based tree reductions
4. Pre-compute invariant expressions outside the inner loop
5. Split the kernel into two specialized variants for small-N vs large-N cases

**Step 3: Execute iteratively**

Apply each item ONE at a time, following the same experiment loop protocol:
- Apply change → verify correctness → benchmark → commit → record → decide keep/revert

### Guidelines

- Each item must be self-contained and independently testable
- Prioritize items by expected impact (highest first)
- If an item fails correctness or regresses performance, revert and move to the next
- Document the rationale for each item in the commit message and perf_results.md
