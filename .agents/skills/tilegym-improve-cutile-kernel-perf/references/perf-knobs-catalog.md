# cuTile Performance Knobs Catalog


Comprehensive reference for all performance tuning parameters available in cuTile kernels.
For API details, see [`references/cutile-api-reference.md`](cutile-api-reference.md).

---

## 1. TMA vs Gather/Scatter

**The single most impactful choice.** TMA uses hardware-accelerated memory copies (2-78x faster).

| Feature | TMA (`ct.load/ct.store`) | Gather/Scatter |
|---------|-------------------------|----------------|
| Access pattern | Block-aligned, contiguous tiles | Arbitrary element indices |
| Performance | Hardware-accelerated | Software-computed |
| Padding | `padding_mode=ct.PaddingMode.*` | `padding_value=`, `check_bounds=True`, `mask=` |
| HW limit | ~16K elements per load | No limit |
| Index semantics | Block index (which tile) | Element offset |

**Rule**: Always TMA-first. Fall back to gather only for truly sparse/random access.

**Special pattern**: `ct.gather().item()` + `ct.load(allow_tma=True)` for indirect/paged access.

---

## 2. Persistent Scheduling

**What**: Launch fewer blocks than work items; each block processes multiple items via grid-stride loop.

| Aspect | Simple Grid | Persistent |
|--------|-------------|------------|
| Grid size | `(n_items,)` | `(NUM_SM * occupancy,)` |
| Kernel pattern | `bid = ct.bid(0)` | `for i in range(bid, n_items, ct.num_blocks(0))` |
| SM utilization | Poor if n_items >> NUM_SM | Optimal |
| Best for | n_items < NUM_SM | n_items > NUM_SM * 2 |

**Expected gain**: +50-300% for memory-bound ops with many work items.

---

## 3. Occupancy

**What**: Number of concurrent thread blocks per SM.

The occupancy hint accepts an integer N from 1 to 32, indicating that the programmer expects N active thread blocks to run simultaneously per SM. This hint is 1 by default and is worth tuning for many SIMT compute-intensive kernels.

---

## 4. num_ctas (Cooperative Thread Arrays)

**What**: Setting num_ctas=2 is critical for dense dot-related workloads on specific hardware, for example, it enables 2CTA mode MMA on Blackwell architecture.

---

## 5. Tile Sizes
**What**: The tile size parameters (e.g., `TILE_M`, `TILE_N`, `TILE_K`, or similar) determine the size of each program's work assignment—how much of the input/output tensor each thread block processes. Adjusting tile sizes is the primary way to tune data granularity, register/SR memory utilization, and memory transaction efficiency.

- Larger tile sizes usually increase per-block work, raising register pressure but reducing launch overhead and sometimes improving memory coalescing.
- Smaller tile sizes allow for more blocks in parallel, reducing per-block resource usage but potentially increasing overall launch overhead.

**Tuning rule**: Always benchmark several plausible tile/block sizes. Optimal values are hardware- and kernel-specific. On Blackwell, try tile shapes covering a range from 16x16 up to 128x128 for 2D problems.

**Where**: As kernel template parameters, function arguments, or autotune config values:
```python
@ct.kernel
def my_kernel(..., TILE_M: ct.constexpr, TILE_N: ct.constexpr):
    ...
```
or via `ct.tune.exhaustive_search()` to autotune tile sizes:
```python
search_space = {
    "TILE_M": [32, 64, 128],
    "TILE_N": [32, 64, 128],
}
result = ct.tune.exhaustive_search(search_space, kernel_fn, ...)
```
**Impact**: This is often the most powerful lever for both performance and resource tuning in cuTile kernels.

**The most versatile tuning knob.** Determines data per block, register usage, and memory transaction granularity.

---

## 6. Latency Hints

**What**: Compiler hints for expected DRAM traffic intensity, enabling better prefetch scheduling.

**Where**: `latency=N` on `ct.load()`, `ct.store()`, `ct.gather()`, `ct.scatter()`.

| Value | Meaning | Typical Use |
|-------|---------|-------------|
| 1 | Low traffic | gather/scatter with few elements |
| 2-3 | Moderate | Standard loads, stores |
| 6 | Above average | Attention key/value loads |
| 10 | High traffic | Main input tensor loads |

---

## 7. allow_tma on Store

**What**: `ct.store(..., allow_tma=False)` disables TMA for the store operation.

**Impact**: +10-30% for some kernels (measured +30% in rms_norm).

**Why**: The TMA store path has overhead for certain access patterns. Disabling it falls back to a faster non-TMA store.

**Rule**: Benchmark both `allow_tma=True` (default) and `allow_tma=False`. Keep whichever is faster.

---

## 8. Flush to Zero & Approximate Math

**What**: Trade precision for speed on math operations.

| Parameter | Where | Effect |
|-----------|-------|--------|
| `flush_to_zero=True` | `ct.exp2`, `ct.rsqrt`, `ct.truediv`, `ct.sqrt`, `ct.add`, `ct.sub`, `ct.mul` | Skip denormal number handling |
| `rounding_mode=RoundingMode.APPROX` | `ct.truediv`, `ct.tanh` | Use HW approximation |

**Impact**: +1-5% for math-heavy kernels (softmax, attention).

**Caution**: May fail tight numerical tolerances.

---

## 9. TF32 Guard for MMA

**What**: Cast FP32 inputs to TF32 before `ct.mma()` to use tensor cores.

```python
dtype = ct.tfloat32 if a.dtype == ct.float32 else a.dtype
a = ct.astype(a, dtype)
b = ct.astype(b, dtype)
acc = ct.mma(a, b, acc=acc)  # Uses tensor cores instead of FP32 CUDA cores
```

**Impact**: ~2x for FP32 MMA operations.

**Note**: cuTile requires explicit cast to tf32 before `ct.mma()`.

---

## 10. GROUP_SIZE_M (2D Swizzling)

**What**: Controls how 2D tiles are grouped for L2 cache locality.

**Impact**: +5-15% for large 2D tiled kernels.

| GROUP_SIZE_M | When to Try |
|-------------|-------------|
| 4 | Small matrices, few M tiles |
| 8 | Default — good general choice |
| 16 | Large matrices, many M tiles |

---

## 11. Padding Mode

**What**: How out-of-bounds reads are handled.

| Mode | Value | Use Case |
|------|-------|----------|
| `ZERO` | 0 | Most ops (default) |
| `NEG_ZERO` | -0 | Signed-zero-sensitive ops |
| `NEG_INF` | -inf | Softmax max reduction |
| `POS_INF` | +inf | Min reduction |
| `NAN` | NaN | Debug: detect unintended OOB |
| `UNDETERMINED` | — | Default (let compiler decide) |

**Note**: Using `ZERO` explicitly instead of `UNDETERMINED` can avoid unnecessary masking code.

---

## Optimization Priority Summary

### Memory-bound kernel priority:
1. TMA (2-78x)
2. Persistent scheduling (+50-300%)
3. Autotune (+10-50%)
4. allow_tma=False on store (+10-30%)
5. Tile size tuning (+5-20%)
6. Latency hints (+2-5%)
7. Flush to zero (+1-5%)

### Compute-bound (MMA) kernel priority:
1. TF32 guard (~2x)
2. Tile size (M/N/K) tuning (+10-50%)
3. Autotune (num_ctas + occupancy) (+10-30%)
4. GROUP_SIZE_M swizzling (+5-15%)
5. Persistent scheduling (+20-100%)
6. Latency hints (+2-5%)
