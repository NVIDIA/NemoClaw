# Idioms That Scale

These NumPy patterns translate cleanly to cuPyNumeric. After the one-line import swap, they will run on a single GPU with no further changes and scale across multiple GPUs / multiple nodes when the array is large enough.

Each pattern below is an idiom to look for when reading user code. The `R00…` headers are stable anchors used throughout this skill's references and recipes — they are *categories*, not analyzer rule IDs. The "Why it scales" sections refer back to [`gpu-stack.md`](gpu-stack.md) and [`partitioning-and-balance.md`](partitioning-and-balance.md) for the underlying mechanism.

A worked example bundling several of these idioms is in [`assets/examples/scales_well.py`](../assets/examples/scales_well.py).

______________________________________________________________________

## R001 — Vectorized elementwise expression

```python
c = a * x + b * y
result = np.sin(theta) + 0.5 * np.cos(2 * theta)
mask = (a > threshold) & (b < cutoff)
```

### Why it scales

- Each op is a Legate task. The runtime partitions the inputs (key-array rule), runs one CUDA kernel per GPU on its share of the data.
- Tasks are FBMEM-bound: at ~3 TB/s on H100 (lower on smaller cards; system-memory bandwidth on CPU), even a tiny problem size per GPU overlaps memory traffic with compute.
- Co-located inputs (`align(a, b, c)`): no inter-GPU communication for the elementwise op itself.

### Scaling profile

- **Single GPU**: linear-ish in array size until FBMEM saturates.
- **Multi-GPU**: near-linear weak scaling. Strong scaling holds while problem size per GPU ≫ `MIN_GPU_CHUNK = 65,536`.
- **Multi-node**: same; no collectives needed.

### Caveats

- Chained expressions create temporaries — apply [R006 (`out=`)](#r006) when allocating in a loop matters.

______________________________________________________________________

## R002 — Array reduction (sum / mean / max / min / prod / std / var)

```python
total = np.sum(arr)
mean_per_row = np.mean(arr, axis=1)
norm = np.linalg.norm(arr)
```

### Why it scales

- Tree-reduce: each GPU computes its partial; NCCL allreduce combines.
- Communication is O(log G) for G GPUs; data volume per step is small (scalar or small vector).

### Scaling profile

- Comfortable up to 1000+ GPUs for large arrays.
- Communication cost negligible compared to read pass over the array.

### Caveats

- **Floating-point reductions are not bit-deterministic** across `--gpus N` counts (parallel order differs). Use `np.allclose(rtol=1e-5)`, not `==`.
- Reductions along a *non-partitioned* axis are cheaper (no allreduce); along the partitioned axis adds the collective.
- The result is a deferred 0-d array, **not** a Python scalar. Don't accidentally consume it with `if total > 0:` — that forces a sync. See [R104](idioms-that-block.md#r104).

______________________________________________________________________

## R003 — Matrix multiplication (matmul / dot / einsum / tensordot)

```python
C = A @ B
result = np.matmul(weights, x) + bias
G = np.einsum('ij,jk->ik', A, B)
```

### Why it scales

- Each output partition is computed by a per-GPU cuBLAS GEMM, then partial results allreduce.
- Tensor Core path available for fp16/bf16 by default; for fp32 with `CUPYNUMERIC_FAST_MATH=1` (uses TF32, ~10-bit mantissa, ~3–5× speedup on H100). fp64 uses CUDA cores (no Tensor Core path).
- Plans / per-GPU slices are cached up to `CUPYNUMERIC_MATMUL_CACHE_SIZE` (default 128 MB).

### Scaling profile

- Strong scaling holds well until the problem size per GPU drops below a useful size for cuBLAS (~256×256 minimum to be efficient on H100).
- Weak scaling holds across nodes; communication is amortized by the cubic-vs-quadratic work-to-data ratio of GEMM.

### Caveats

- **`einsum`** can take a slower path than `matmul` for the same contraction; if `einsum` is slow, try expressing as `matmul` or sequence of `tensordot`.
- Float64 matmul on Tensor-Core GPUs is much slower than float32 with FAST_MATH. Consider whether your accuracy requirement forces fp64.

______________________________________________________________________

## R004 — Vectorized conditional (where / choose / select / putmask)

```python
out = np.where(mask, a, b)
arr[:] = np.where(condition, new_values, arr)
np.putmask(arr, condition, update_value)
y = np.choose(idx, [a, b, c, d])
```

### Why it scales

- Per-GPU parallel ternary; no host round-trip.
- Replaces Python `if`/`else` over arrays — the latter would force per-element evaluation.

### Scaling profile

- Same as elementwise ([R001](#r001)). Both branches must be valid (or use `where=` keyword on ufuncs to avoid evaluating the false branch).

### Caveats

- `np.where(condition, expensive(a), b)` evaluates both branches. To avoid the expensive computation on irrelevant elements, restructure to operate only on the masked region: `out = b.copy(); out[mask] = expensive(a[mask])` (still vectorized, no Python loop).

______________________________________________________________________

## R005 — Stencil-style slicing

```python
work[1:-1, 1:-1] = 0.25 * (
    u[:-2, 1:-1] + u[2:, 1:-1] +
    u[1:-1, :-2] + u[1:-1, 2:]
)

# 3D Laplacian
lap[1:-1, 1:-1, 1:-1] = (
    u[:-2, 1:-1, 1:-1] + u[2:, 1:-1, 1:-1] +
    u[1:-1, :-2, 1:-1] + u[1:-1, 2:, 1:-1] +
    u[1:-1, 1:-1, :-2] + u[1:-1, 1:-1, 2:] -
    6 * u[1:-1, 1:-1, 1:-1]
)
```

### How partitioning works (the partitionability story)

- The partitioner derives a halo (`bloat` constraint) automatically from the slice offsets.
- Halo exchange uses NVLink intra-node (~900 GB/s), IB / UCX inter-node (~50 GB/s on Quantum-2).
- Boundary data per step ~ perimeter × bytes; interior compute ~ area × bytes. Compute dominates only when the problem size per GPU is large.

### Scaling — qualified

Stencil patterns are *partitionable*, not *unconditionally scalable*. Real-world stencil workloads frequently become **runtime-dominated**: halo exchange produces per-GPU copies and small short-lived tasks, and at moderate per-GPU problem sizes the runtime + communication overhead can exceed the GPU math. The 1,024-H100 weak-scaling result on NVIDIA Eos ([NVIDIA blog](https://developer.nvidia.com/blog/effortlessly-scale-numpy-from-laptops-to-supercomputers-with-nvidia-cupynumeric/)) is an upper bound under favourable per-GPU problem sizes, not a generic guarantee. In-house CFD-class stencils that work fine in NumPy can show flat-to-negative cuPyNumeric speedup when the per-step runtime overhead approaches the kernel time.

**Works well** when ALL of:

- Problem size per GPU is large after partition (~1M+ elements per GPU is a comfortable working point).
- The kernel is a simple 5/7-point stencil with ±1 / ±2 slice offsets.
- A single outer time-stepping loop drives the computation.

**Falters** when ANY of:

- Problem size per GPU is small relative to the halo (compute-to-communication ratio under ~10).
- Nested stencils or shape changes inside the time loop force repartition.
- Mixed-size halos defeat the auto-`bloat` heuristic.
- The kernel is CFD-class or otherwise has small per-step compute relative to the per-step runtime overhead.

If a stencil verdict matters for the user's plan, demand a problem-size-per-GPU estimate before claiming it scales.

### Caveats

- The slice offsets must be small constants (typically ±1, ±2). The partitioner derives halo width from them; very large or variable offsets reduce parallelism.
- `arr[::2]` (non-unit stride) is **not supported** — that's a different pattern, classified as [R106](idioms-that-block.md#r106), not stencil.

______________________________________________________________________

## R006 — Pre-allocation via `out=` parameter

```python
np.add(a, b, out=result)
np.multiply(result, scale, out=result)
np.matmul(A, B, out=C)
np.sum(arr, axis=0, out=row_sums)
```

### Why it scales

- Reuses an existing FBMEM allocation (or system-memory allocation on CPU) rather than creating a new one each call.
- Without `out=`, an expression like `result = a + b * c` allocates two temporaries (one for `b * c`, one for the sum). In a hot loop this churns the deferred allocator + CUDA caching pool, fragments free space, and produces small short-lived tasks that compete for scheduling slots.
- cuPyNumeric does **not** JIT-fuse adjacent kernels in mainline, so each intermediate exists as a real FBMEM allocation.

### Scaling profile

- Critical in hot loops; meaningful (~10–30%) on large arrays even outside loops.

### Caveats

- The `out` array must be the correct shape and dtype.
- Some operations don't accept `out=` (e.g. reductions with `keepdims=False` to a different shape) — use the shape-compatible variant.

______________________________________________________________________

## R007 — Boolean mask indexing

```python
arr[mask] = 0.0
total = np.sum(arr[mask])
indices_within_range = arr[(arr > lo) & (arr < hi)]
```

### Why it scales

- Boolean masks are co-located with the array (same shape, same partition). The runtime applies the mask per GPU, no global gather needed.
- Avoids materializing an index array via `np.nonzero()` — see [R204](idioms-that-block.md#r204).
- Upstream best practices: use boolean masks for indexing instead of `nonzero`-plus-indices — better performance.

### Scaling profile

- Per-GPU parallel for read; per-GPU parallel for write when the masked positions are local.

### Caveats

- Fancy indexing on a **separate** index array (e.g. `arr[idx_array]`) can require all2all communication — use boolean masks when you can.
- Don't write to the same position twice via duplicate indices in advanced indexing — behavior is undefined.

______________________________________________________________________

## Other patterns to treat as INFO (compatibility / cost, not a blocker)

### R301 — `scipy.*` imports

SciPy expects host NumPy arrays. Acceptable at endpoints, slow in hot loops. The viable / not-viable split per submodule (`linalg`, `sparse`, `special`, `optimize`, `signal`, `spatial`, `ndimage`, `stats`) is documented upstream — start with [cuPyNumeric best practices](https://docs.nvidia.com/cupynumeric/latest/user/practices.html) and the [API comparison table](https://docs.nvidia.com/cupynumeric/latest/api/comparison.html); `scipy.sparse`, `scipy.optimize`, and `scipy.spatial` are usually not viable on the hot path.

### R302 — `linalg.qr` / `linalg.svd`

Single-device only in cuPyNumeric. Multi-GPU doesn't help. Acceptable for moderate-sized factorizations. If you have many independent factorizations to do, batch them along the leading axis and the multi-GPU path becomes data-parallel.

### R303 — `fft.*`

Single transform → single GPU (cuFFT). Multi-GPU benefit only for batched FFT (stack many along an axis). 2D/ND FFT axis-by-axis is single-GPU per axis.

### R304 — Random number generation

**Flag whenever** the code calls `np.random.*` (any draw, any distribution, any `default_rng` / `seed` use) AND the user named a multi-GPU or multi-node target. Cross-config bit-identical reproduction is impossible by default; the user needs to know before they benchmark or compare runs.

cuRAND-backed; XORWOW BitGenerator. Reproducible **per fixed `--gpus N`** (and only per fixed `--gpus N`). Use `np.random.default_rng(seed)` for the modern interface. Don't expect bit-identical output across different GPU counts.

`--gpus N` here is the [Legate launcher argument](https://docs.nvidia.com/legate/latest/manual/usage/running.html) that picks how many GPUs the run uses. When invoking `python script.py` directly without the launcher, the same setting is read from `LEGATE_GPUS` (or the equivalent env vars documented at that link). Pinning `--gpus N` (or `LEGATE_GPUS`) is what makes a Monte Carlo / particle-filter / synthetic-data run reproducible across reruns; comparing a 1-GPU run against an 8-GPU run is *not* reproducible even with the same seed.

When the workload genuinely needs cross-config bit-identical reproduction, generate the random arrays once on the host with regular NumPy (or a fixed-shape cuPyNumeric run) and reload the saved arrays at the start of every run — see [cuPyNumeric differences with NumPy](https://docs.nvidia.com/cupynumeric/latest/user/differences.html) for the full reproducibility caveats.

### R305 — `linalg.solve` / `linalg.cholesky`

Multi-GPU path requires cuSolverMp and matrix size above a threshold (`solve`: dim ≥ 512, `cholesky`: dim ≥ 8192). Below threshold, runs single-device — this is expected behavior.

______________________________________________________________________

## Idioms that scale but don't have a dedicated category

These patterns translate cleanly but aren't called out as their own category; they're worth knowing to not flag them by mistake:

- **Broadcasting**: `arr + scalar`, `arr_2d + arr_1d`. The runtime broadcasts the smaller operand.
- **`np.unique`, `np.intersect1d`**: distributed-aware. Some keyword args (`axis=`, `return_inverse=`) are limited.
- **`np.cumsum`, `np.cumprod`**: distributed; results may differ from NumPy by float reduction order.
- **`np.histogram`, `np.bincount`**: distributed-parallel.
- **`np.diff`, `np.gradient`**: distributed when the axis is partitioned (uses a small halo).

## Authoritative sources

- [cuPyNumeric API comparison table](https://docs.nvidia.com/cupynumeric/latest/api/comparison.html) — which functions support multi-GPU
- [cuPyNumeric best practices](https://docs.nvidia.com/cupynumeric/latest/user/practices.html)
- [cuPyNumeric settings](https://docs.nvidia.com/cupynumeric/latest/api/settings.html) — `CUPYNUMERIC_FAST_MATH`, `CUPYNUMERIC_MATMUL_CACHE_SIZE`
- [Eos 1024-GPU stencil blog](https://developer.nvidia.com/blog/effortlessly-scale-numpy-from-laptops-to-supercomputers-with-nvidia-cupynumeric/)
