# GPU Performance Model

A guide to GPU performance fundamentals for cuTile kernel optimization.

## Contents
- [The Three Pillars](#the-three-pillars)
- [Arithmetic Intensity](#arithmetic-intensity)
- [Framework Comparison](#framework-comparison)
- [Autotune Examples](#autotune-examples)
- [Common Bottleneck Diagnosis](#common-bottleneck-diagnosis)
- [Profiling Guidance](#profiling-guidance)
- [Benchmark Template](#benchmark-template)
- [Performance Checklist](#performance-checklist)
- [Summary: Optimization Strategy](#summary-optimization-strategy)
- [cuTile Performance Optimization (Advanced)](#cutile-performance-optimization-advanced)

## The Three Pillars

Every GPU kernel's performance is governed by: **Memory Bandwidth**, **Compute Throughput**, and **Latency Hiding**.

**Most ML kernels are memory-bound.** Optimize memory access first, then compute, then latency.

---

## Arithmetic Intensity

```
AI = FLOPs / Bytes Transferred
```

| AI < 10 = Memory-bound (element-wise, reductions) | AI > 50 = Compute-bound (GEMM, attention) |

---


## Framework Comparison

| Aspect | CUDA | cuTile | PyTorch |
|--------|------|--------|---------|
| **Paradigm** | Thread-based | Tile-based | Automatic |
| **Tuning** | Manual | Autotune (occupancy, num_ctas, tile sizes) | Automatic |
| **Tensor Cores** | WMMA API | `ct.mma` | Automatic |
| **Shared Memory** | Explicit | Automatic | Automatic |
| **Profiling** | Nsight | Nsight | PyTorch Profiler |
| **Control** | Maximum | High | Minimal |

---

## Autotune Examples

### cuTile Autotune

cuTile uses **autotune** to find optimal occupancy, num_ctas, and tile sizes at runtime.
Do NOT hardcode `occupancy=` in `@ct.kernel()` — instead, let the autotuner search over it.

```python
@ct.kernel
def optimized_kernel(input, output, n_items: ct.Constant[int], ...):
    bid = ct.bid(0)
    num_programs = ct.num_blocks(0)
    for item_idx in range(bid, n_items, num_programs):
        data = ct.load(input, index=(item_idx, 0), ...)
        result = compute(data)
        ct.store(output, index=(item_idx, 0), tile=result)
```

**cuTile Occupancy (via Autotune):**

Occupancy controls how many thread blocks can run concurrently per SM.
The autotuner searches over occupancy values to find the best one:

| Occupancy Range | Best For | Example Kernels |
|-----------------|----------|-----------------|
| 1-4 | Compute-bound (heavy math) | Complex transforms |
| 4-8 | Balanced (GEMM, TMA) | Matrix multiply |
| 8-16 | Memory-bound (reductions) | Softmax, LayerNorm |
| 16-32 | Very light (copies, casts) | Type conversions |
**Grid Size Calculation (with autotune):**
```python
NUM_SM = torch.cuda.get_device_properties(device).multi_processor_count
# occupancy comes from autotune config, e.g., cfg.occupancy
num_programs = min(NUM_SM * cfg.occupancy, n_items)
grid = (num_programs, 1, 1)
```

---

## Common Bottleneck Diagnosis

### Memory-Bound Symptoms

**Indicators:**
- Low compute utilization (<50%)
- High memory throughput (>80%)
- Nsight shows "Memory Bound" classification

**Fixes by Framework:**

| Framework | Solution |
|-----------|----------|
| **CUDA** | Vectorized loads (`float4`), coalesced access, shared memory tiling |
| **cuTile** | `ct.load` for aligned access (compiler uses TMA automatically), `ct.gather`/`ct.scatter` for arbitrary offsets |

```python
# cuTile: Block-aligned access — compiler will use TMA automatically
data = ct.load(input, index=(bid, 0), shape=(TILE_M, TILE_K))
```

### Compute-Bound Symptoms

**Indicators:**
- High compute utilization (>80%)
- Low memory throughput
- Nsight shows "Compute Bound" classification

**Fixes by Framework:**

| Framework | Solution |
|-----------|----------|
| **CUDA** | Tensor cores (`wmma::mma_sync`), fast math intrinsics, reduced precision |
| **cuTile** | `ct.mma` with proper accumulator, mixed precision |

```python
# cuTile: Explicit MMA
acc = ct.mma(a_tile, b_tile, acc=acc)  # acc= is REQUIRED
```

### Latency-Bound Symptoms

**Indicators:**
- Achieved occupancy <25%
- High register usage per thread
- Many stalls in Nsight

**Fixes by Framework:**

| Framework | Solution |
|-----------|----------|
| **CUDA** | `__launch_bounds__`, `--maxrregcount`, smaller tiles |
| **cuTile** | Tune occupancy via autotune, persistent scheduling |

```python
# CUDA: Limit register usage
__global__ __launch_bounds__(256, 2)  // Max threads, min blocks per SM
void kernel(...) { ... }

# cuTile: Persistent scheduling + autotune occupancy
@ct.kernel
def kernel(...):
    for item in range(bid, n_items, num_programs):  # Work sharing
        ...
```

---

## Profiling Guidance

### Nsight Compute (All Frameworks)

```bash
# Full profiling
ncu --set full -o profile_output ./my_app

# cuTile kernel profiling
ncu --set full python my_cutile_script.py
```

**Key Metrics to Check:**

| Metric | Target | Indicates |
|--------|--------|-----------|
| SM Throughput | >80% | Good compute utilization |
| Memory Throughput | >80% | Good bandwidth utilization |
| Achieved Occupancy | >50% | Adequate latency hiding |
| L1 Hit Rate | >80% | Good cache utilization |

### cuTile-Specific Profiling

```python
# Manual timing
torch.cuda.synchronize()
start = time.time()
ct.launch(stream, grid, kernel, args)
torch.cuda.synchronize()
elapsed = time.time() - start
print(f"Kernel time: {elapsed * 1000:.2f} ms")
```

**Environment Variables (cuTile framework):**
```bash
CUDA_TILE_LOGS=CUTILEIR    # Show compilation IR
CUDA_TILE_ENABLE_CRASH_DUMP=1  # Enable crash dump
```

**Environment Variables (TileGym project convention — NOT part of cuTile):**
```bash
DISABLE_CUTILE_TUNE=1      # Disable autotuning (use fixed configs)
                            # This is an TileGym-specific convention used in tilegym kernels,
                            # not a cuTile framework feature.
```

---

## Benchmark Template

Benchmark cuTile kernel performance:

```python
import torch
import time

def benchmark_cutile(fn, x, n_warmup=10, n_rep=100):
    """Simple benchmark for cuTile kernels."""
    # Warmup
    for _ in range(n_warmup):
        fn(x)
    torch.cuda.synchronize()

    # Benchmark
    times = []
    for _ in range(n_rep):
        torch.cuda.synchronize()
        start = time.perf_counter()
        fn(x)
        torch.cuda.synchronize()
        elapsed = time.perf_counter() - start
        times.append(elapsed * 1000)  # ms

    ms = sum(times) / len(times)

    # Calculate bandwidth (read + write)
    bytes_transferred = 2 * x.numel() * x.element_size()
    bandwidth_gbps = bytes_transferred / ms * 1e-6
    print(f"Kernel time: {ms:.3f} ms, Bandwidth: {bandwidth_gbps:.1f} GB/s")
    return ms
```

---

## Performance Checklist

When a translated kernel is slower than expected:

### Priority 1: Algorithmic Issues (10-100x Impact)

- [ ] Is persistent scheduling used? (cuTile)
- [ ] Is grid size reasonable (NUM_SM * occupancy from autotune)?
- [ ] Is work distribution balanced?
- [ ] Are you using the right memory access pattern (`ct.load` vs `ct.gather`)?

### Priority 2: Memory Access (2-10x Impact)

- [ ] Are accesses coalesced?
- [ ] Are block sizes aligned to memory transaction sizes?
- [ ] Is shared memory used effectively?

### Priority 3: Occupancy (1.2-2x Impact)
- [ ] Is autotune configured with a wide range of occupancy values?
- [ ] Is occupancy appropriate for workload type (see Occupancy Range table)?
- [ ] Are there register spills?

### Priority 4: Microoptimizations (1.05-1.2x Impact)

- [ ] Minimize type conversions
- [ ] Hoist invariants out of loops
- [ ] Avoid redundant tensor creations

---

## Summary: Optimization Strategy

```
1. PROFILE FIRST
   - Identify bottleneck (memory, compute, latency)
   - Use Nsight Compute for detailed analysis

2. OPTIMIZE THE BOTTLENECK
   +-- Memory-bound  -> Improve access patterns, increase reuse
   +-- Compute-bound -> Use tensor cores, reduce precision
   +-- Latency-bound -> Increase occupancy, add prefetching

3. USE CUTILE FEATURES
   +-- autotune (occupancy, num_ctas, tile sizes) + persistent scheduling

4. VERIFY CORRECTNESS
   - Always check numerical accuracy after optimization
   - Use appropriate tolerances (1e-3 for FP32, 1e-2 for FP16)

5. ITERATE
   - Profile again after each optimization
   - New bottleneck may emerge
```

**Key Takeaways:**
- Most kernels are memory-bound - optimize memory access first
- cuTile's autotune handles many optimizations automatically
- Profile before optimizing - don't guess at bottlenecks
- Use tensor cores (`ct.mma`) whenever possible for matrix operations

---

## cuTile Performance Optimization (Advanced)

This section covers advanced cuTile-specific optimizations discovered through production kernel development.

### Static Persistent Scheduling (HIGHEST IMPACT)

**Problem**: Naive 1:1 block-to-work mapping severely underutilizes GPU.

**Bad Pattern (Poor GPU Utilization):**
```python
@ct.kernel
def naive_kernel(input, output, ...):
    bid = ct.bid(0)  # Each block processes ONE work item

    # Process single item
    data = ct.load(input, index=(bid, 0), ...)
    result = compute(data)
    ct.store(output, index=(bid, 0), tile=result)

# Launch: grid = (n_items, 1, 1)
# Problem: If n_items >> NUM_SM, thousands of blocks sit idle in queue
```

**Good Pattern (Static Persistent Scheduling):**
```python
@ct.kernel
def optimized_kernel(input, output, n_items: ct.Constant[int], ...):
    bid = ct.bid(0)
    num_programs = ct.num_blocks(0)

    # Each block processes MULTIPLE items
    for item_idx in range(bid, n_items, num_programs):
        data = ct.load(input, index=(item_idx, 0), ...)
        result = compute(data)
        ct.store(output, index=(item_idx, 0), tile=result)

# Launch: grid = (NUM_SM * cfg.occupancy, 1, 1)
# Benefit: Fixed number of blocks, each processes ~(n_items / grid_size) items
```

**Grid Size Calculation:**
```python
NUM_SM = torch.cuda.get_device_properties(device).multi_processor_count
# occupancy comes from autotune config (cfg.occupancy), NOT hardcoded in @ct.kernel
occupancy = 4  # Example default; in practice, use cfg.occupancy from autotune
num_programs = min(NUM_SM * occupancy, total_work_items)
grid = (num_programs, 1, 1)
```

**Expected Performance Gain:**
- Softmax: **+50-300%** (2-4x faster)
- Workloads with n_items > 1000: Typically **+100-200%**
- Best for row-wise/independent operations

**When to Use:**
- Row-wise operations (softmax, layer_norm, etc.)
- Independent work items (matmul tiles, attention blocks)
- When work_items >> NUM_SM
- NOT when work_items < NUM_SM (just use grid=(work_items,))

---

### cuTile Autotune Template

**Step 1: Define Config Generator**

```python
from types import SimpleNamespace
import torch

def _my_kernel_autotune_configs():
    """
    Autotune config generator.

    IMPORTANT: Cover a WIDE RANGE of configurations!
    - The autotuner will find the best combination
    - Don't pre-optimize by narrowing the search space
    """
    # Tile sizes: Cover from smallest expected input to largest
    tile_sizes = [64, 128, 256, 512, 1024]

    # Occupancy: Range is [1, 32]
    occupancies = [1, 2, 4, 8, 16]

    # num_ctas: Valid values are 1, 2, 4, 8, 16
    num_ctas_options = [1, 2, 4]

    # Generate all combinations
    for tile in tile_sizes:
        for occ in occupancies:
            for num_ctas in num_ctas_options:
                yield SimpleNamespace(
                    TILE_SIZE=tile,
                    num_ctas=num_ctas,
                    occupancy=occ,
                )
```

**Step 2: Autotune Launch Function**

> **Note:** The recommended autotune API is `ct.tune.exhaustive_search()` (see
> [Modern API](#modern-autotune-api-recommended) below).  The legacy
> `ct_experimental.autotune_launch()` shown here is **deprecated** but still
> used in existing TileGym kernels.  New code should prefer `exhaustive_search`.

```python
# --- Legacy API (deprecated, still used in TileGym) ---
import cuda.tile_experimental as ct_experimental

def _my_kernel_autotune_base(stream, input, output, N, C):
    """Autotuned kernel launch with dynamic grid and args."""
    NUM_SM = torch.cuda.get_device_properties(input.device).multi_processor_count

    def args_fn(cfg):
        tile_size = min(cfg.TILE_SIZE, _next_power_of_2(C))
        return (input, output, tile_size, N)

    def grid_fn(cfg):
        num_programs = min(NUM_SM * cfg.occupancy, N)
        return (num_programs, 1, 1)

    ct_experimental.autotune_launch(
        stream,
        grid_fn=grid_fn,
        kernel=_my_kernel,
        args_fn=args_fn,
        hints_fn=lambda cfg: {
            "num_ctas": cfg.num_ctas,
            "occupancy": cfg.occupancy,
        },
        search_space=_my_kernel_autotune_configs,
    )
```

#### Modern Autotune API (Recommended)

`ct.tune.exhaustive_search()` is the replacement for the deprecated
`autotune_launch`.  Key differences:
- `search_space` must be a `Sequence` (e.g. `list`), **not** a generator or `Callable`.
- Returns a `TuningResult` with `best_config` / `best_time_us`; does **not**
  launch the kernel — you call `ct.launch` yourself with the tuned config.
- No built-in caching; manage your own cache if needed.

```python
import cuda.tile as ct

def _my_kernel_autotune_modern(stream, input, output, N, C):
    """Autotuned kernel launch using the modern ct.tune API."""
    NUM_SM = torch.cuda.get_device_properties(input.device).multi_processor_count

    # search_space must be a list (Sequence), not a generator
    configs = list(_my_kernel_autotune_configs())

    def args_fn(cfg):
        tile_size = min(cfg.TILE_SIZE, _next_power_of_2(C))
        return (input, output, tile_size, N)

    def grid_fn(cfg):
        num_programs = min(NUM_SM * cfg.occupancy, N)
        return (num_programs, 1, 1)

    result = ct.tune.exhaustive_search(
        search_space=configs,
        stream=stream,
        grid_fn=grid_fn,
        kernel=_my_kernel,
        args_fn=args_fn,
        hints_fn=lambda cfg: {
            "num_ctas": cfg.num_ctas,
            "occupancy": cfg.occupancy,
        },
    )

    # exhaustive_search does NOT launch — launch manually with best config
    best = result.best_config
    kernel = _my_kernel.replace_hints(
        num_ctas=best.num_ctas, occupancy=best.occupancy
    )
    ct.launch(stream, grid_fn(best), kernel, args_fn(best))
```

**Step 3: Conditional Autotune in Forward Pass**

```python
import os

class MyOpcuTile(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x, ...):
        enable_autotune = os.environ.get("DISABLE_CUTILE_TUNE", "0") != "1"

        if enable_autotune:
            _my_kernel_autotune_base(
                torch.cuda.current_stream(), x, output, N, C
            )
        else:
            # Use fixed default configs
            configs = {"TILE_SIZE": 256, "num_ctas": 1, "occupancy": 4}
            # ... launch with fixed configs

        return output
```

**Autotune Parameter Ranges:**

| Parameter | Valid Range | Description |
|-----------|-------------|-------------|
| **occupancy** | 1 - 32 | Active warps per SM |
| **num_ctas** | 1, 2, 4, 8, 16 | CTAs to fuse (powers of 2) |
| **TILE_SIZE** | Powers of 2 | Tile dimension size |

---

### `ct.load` vs `ct.gather`/`ct.scatter` Selection

> **How TMA works in cuTile:** TMA is **not** an explicit API — the cuTile
> compiler decides whether to use TMA hardware automatically when you call
> `ct.load`/`ct.store`.  The `allow_tma` parameter (default `True`) is the
> only user-facing control.  Your job is to choose the right API:
> **`ct.load`** for block-aligned tile access, **`ct.gather`** for arbitrary
> element offsets.

**CRITICAL RULE**: `ct.load` works with block-aligned tile-space indices.
Use `ct.gather`/`ct.scatter` for arbitrary element offsets.

**`ct.load` — Block-Aligned Access (compiler may use TMA):**
```python
@ct.kernel
def gemm_kernel(...):
    bid_m, bid_n = ct.bid(0), ct.bid(1)

    # Block-aligned tile-space indices — compiler will use TMA when possible
    a = ct.load(a_tensor, index=(bid_m, k), shape=(TILE_M, TILE_K))
```

**`ct.load` Fails for Non-Aligned Ragged Access:**
```python
# Segment starts: [0, 5504, 10656, 14424] <- 10656 % 128 = 32 (NOT aligned!)

@ct.kernel
def ragged_kernel(...):
    # m_start = 10656 (not aligned to TILE_M=128)
    # ct.load tile-space indexing cannot express arbitrary byte offsets!
```

**Solution: Use `ct.gather`/`ct.scatter`:**
```python
@ct.kernel
def ragged_kernel(...):
    # Calculate exact element indices
    m_indices = m_start + bid_m * TILE_M + ct.arange(TILE_M, dtype=ct.int32)
    # m_indices = [10656, 10657, ..., 10783] <- Exact rows needed!

    # Gather supports arbitrary element offsets (padding defaults to 0)
    a_tile = ct.gather(a, (m_indices_2d, k_indices_2d))
```

**Decision Tree:**
```
Is data access pattern block-aligned?
├─ YES -> Use ct.load/ct.store (compiler uses TMA automatically)
│         Example: Regular GEMM, batch operations
│
└─ NO -> Use ct.gather/ct.scatter (element-level indexing, no TMA)
          Examples: Ragged BMM, paged attention, sparse ops

Special case: Mixed approach
- Use ct.load for aligned dimensions (e.g., B matrix in ragged BMM)
- Use ct.gather/ct.scatter for ragged dimensions (e.g., A, C matrices)
```

---

### Performance Anti-Patterns

**Anti-Pattern 1: Excessive Type Conversions**
```python
# BAD: Convert for every row in loop
for row in range(...):
    row_fp32 = ct.astype(row, ct.float32)
    result = compute(row_fp32)
    row_fp16 = ct.astype(result, ct.float16)

# Better: Keep in fp32 longer, batch conversions
```

**Anti-Pattern 2: Redundant Tensor Creation**
```python
# BAD: Create mask inside loop
for i in range(n):
    mask = ct.full((tm,), True, dtype=ct.bool_)  # Recreated every iteration!

# GOOD: Create once outside loop
mask = ct.full((tm,), True, dtype=ct.bool_)
for i in range(n):
    # Use mask
```

**Anti-Pattern 3: Column Loops for Row-Wise Ops**
```python
# BAD: Softmax with column loop
for col_tile in range(num_col_tiles):
    partial = ct.load(..., index=(row, col_tile), ...)
    # Partial softmax on tile -> WRONG! Need full row

# GOOD: Load entire row
row = ct.load(..., index=(row, 0), shape=(1, TILE_SIZE_COVERS_ALL_COLS))
```

---

### Quick Performance Fix Template

**Add Persistent Scheduling** (30 seconds):
```python
# In kernel: change from bid to loop
- bid = ct.bid(0)
+ bid = ct.bid(0)
+ num_programs = ct.num_blocks(0)
 for work_id in range(bid, total_work, num_programs):

# In launch: change grid
- grid = (n_items, 1, 1)
+ NUM_SM = torch.cuda.get_device_properties(device).multi_processor_count
+ grid = (NUM_SM * 4, 1, 1)

# In kernel signature: add total_work
- def kernel(input, output, ...):
+ def kernel(input, output, total_work: ct.Constant[int], ...):
```

**Fix Slow Kernel** (2 minutes):
1. Use `@ct.kernel`
2. Add persistent loop
3. Set up autotune with occupancy in search space
4. Update grid to use `NUM_SM * cfg.occupancy`
5. Test -> Usually 2-3x faster
