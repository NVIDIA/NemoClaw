# Partitioning and Load Balance

How Legate splits a `cupynumeric.ndarray` across processors, and what makes that split good or bad for *your* code. This is the deepest source of "I migrated and got slower" surprises after host-device sync.

## 1. Partitioning strategies

Three primary policies, applied per-operation:

| Strategy | When the runtime picks it | What it does |
|---|---|---|
| **Tile (natural)** | Default for large arrays in an op that operates element-wise across a partitionable dimension | Equal contiguous blocks along the leading partitionable axis |
| **Broadcast** | Small inputs or non-partitionable dims (filter kernel in convolution, inner axes of FFT, scalar operands) | Each rank gets the full array |
| **Replicated** | Pre-broadcast / explicit decision by mapper | Full array on every processor |

The runtime can mix these across operands of a single op: e.g. a stencil binary op might have *tile* for the array and *broadcast* for a scalar coefficient.

### The key-array rule

When deciding a partition, the partitioner identifies the **key array** of the operation (largest input/output) and derives partitions for all other operands by `align(key, other)` constraints in the task. This produces co-located inputs and outputs — the GPU that owns tile *(i)* of the key array also owns tile *(i)* of every other partitioned operand.

Co-location is why elementwise expressions over many arrays don't pay communication cost: every operand for tile *(i)* is already on GPU *(i)*.

### Halo (bloat) constraints

When an op accesses neighbors of a tile (stencils via slicing), the partitioner inserts a `bloat(p_output, p_input, offsets, offsets)` constraint. This tells the runtime: "for each tile of the output, also fetch a halo of width `offsets` around the corresponding input tile."

The cuPyNumeric implementation of `convolve` literally does this:

```python
offsets = tuple((ext + 1) // 2 for ext in filter.shape)
bloat(p_output, p_halo, offsets, offsets)
```

For stencils written as slicing expressions like `u[1:-1, 1:-1] = 0.25*(u[:-2, 1:-1] + u[2:, 1:-1] + ...)`, the partitioner derives the same halo automatically from the slice offsets.

**No manual halo code is required.** This is why stencils are the workload class that scales best.

## 2. The 65,536-element floor

`CUPYNUMERIC_MIN_GPU_CHUNK = 65,536` is the minimum per-processor tile size. Below this, the runtime collapses the partition to one processor (no parallelism).

The floor exists because at smaller tile sizes, task dispatch and communication overhead dwarf compute time. The 1-ms task-granularity rule (see [`gpu-stack.md`](gpu-stack.md#the-1-millisecond-task-granularity-rule)) is the underlying reason.

**Strong-scaling implication.** If you have an array of *N* elements and you launch with *G* GPUs, each GPU gets *N/G* elements. If *N/G < 65,536*, you have over-decomposed — adding GPUs hurts. The hard floor:

| GPUs | Minimum profitable array size |
|---|---|
| 1 | 65,536 (technically the floor; in practice ≥10M for meaningful speedup over NumPy) |
| 8 | 524,288 (≥1M elements where parallelism helps) |
| 32 | 2,097,152 |
| 128 | 8,388,608 |
| 1024 | 67,108,864 |

These are minimums. For comfortable headroom (so the per-task work amortizes overhead), multiply by 10–100.

## 3. Repartitioning — what makes the runtime shuffle data

A repartition copies array data from one partitioning to another. Triggers:

### Repartition-inducing operations

| Operation | Why it repartitions |
|---|---|
| `reshape(new_shape)` where new_shape doesn't compose with the existing partition | New shape requires data laid out differently |
| `transpose()` followed by an op that uses the original axis | Lazy transpose materializes when the next op needs the original layout |
| `concatenate`/`hstack`/`vstack`/`stack` | Output shape combines tiles that didn't share a partition |
| `roll`, axis-shift slicing | Same — destination indices don't align with source partition |
| Sort along a partitioned axis | Sample-sort algorithm requires global key exchange |
| `np.fft.fftn` on multiple dims | Distributed FFT is batched only; multi-dim transforms re-shuffle |
| Fancy indexing write `arr[idx_array] = v` where `idx_array` isn't co-located | Scatter requires NCCL all2all |
| `np.diff(arr, axis=k)` when k is the partitioned axis | Cross-tile difference |
| Reductions along the partitioned axis | Not strictly a repartition — but adds an allreduce of the result |

### Operations that are repartition-free

- Elementwise (any rank, compatible shapes after broadcasting)
- Stencils via slicing (halo, not repartition)
- Reductions along a non-partitioned axis (each tile reduces locally)
- `transpose()` and `.T` (lazy; cost paid by the *next* op if shapes don't compose)
- Slicing `arr[a:b]` with full tile alignment
- Broadcasting a scalar to a tiled array

### How costly is a repartition?

For an array of size *B* bytes distributed across *G* GPUs intra-node:

- Cost ≈ B / NVLink-aggregate-bandwidth ≈ B / (900 GB/s)
- 8 GB array on 8 GPUs ≈ 9 ms per repartition

Inter-node over IB (50 GB/s on Quantum-2):

- 8 GB array on 8 nodes ≈ 160 ms per repartition

Compare to per-step compute on the same array (8 GB float32 = 2B elements, ~1 ms of FBMEM-bound work per GPU): a repartition is **10–100× the cost of one timestep**. If you do this every iteration, the runtime is shuffling, not computing.

## 4. Load balance

### When tiles are balanced

For arrays with a uniformly partitionable leading dimension (most regular grids), Legate produces equal-size tiles by default. Each GPU does the same amount of work.

### When tiles are imbalanced

| Cause | Symptom | Fix |
|---|---|---|
| Array dim not divisible by GPU count | Last tile smaller | Pad the array to a divisible size; the cost is negligible compared to multi-GPU strong-scaling losses |
| Ragged data (lists of arrays of different sizes) | n/a — cuPyNumeric does not represent ragged arrays | Restructure to a homogeneous array with masks/lengths |
| Sparse data | Some tiles all-zero, others all-active | Compress to indices+values arrays; do the math on the compressed representation |
| Mask-conditioned work in a hot loop with very skewed mask | All work on one GPU's tile | Reshape so the masked dimension is non-partitioned, or accept the cost |

### Mixed CPU/GPU runs

When you launch with `--cpus N --gpus M`, the mapper still prefers GPU variants for every GPU-capable task. CPUs get used as fallback for unsupported ops. The CPUs don't share work with the GPUs on the *same* operation — they get *different* tasks. So a CPU+GPU hybrid run doesn't load-balance per-tile; it dispatches different tasks to different processors.

The exact weighted-distribution algorithm in the partitioner is documented in the SC'19 paper but not exposed at the API level. Practical implication: rely on the default mapper; do not attempt to hand-tune the work split.

## 5. The transpose / contiguity pitfall

`order=` controls C vs Fortran contiguous storage in NumPy, but it is **not supported on the cuPyNumeric distributed path** — the runtime chooses an internal partitioning that is neither C- nor F-contiguous. For host interop that needs a specific layout, drop to host NumPy explicitly:

```python
host_f = onp.asfortranarray(onp.asarray(cupy_arr))
```

Treat any `order=` on a hot-path array as the [R109](idioms-that-block.md#r109) idiom — see it for the per-API behavior (warn-and-fall-back vs silent no-op) and the upstream citation.

## 6. The `align` constraint and why your code rarely fights it

When two arrays are inputs to the same op, `align(a, b)` says "partition them identically." This is the default for elementwise ops; you don't write it. It only becomes visible when you try to mix two arrays that came from incompatible operations — at which point the runtime *aligns by repartitioning*. Cost is paid silently.

The cure is consistency: keep your hot-loop computations in a single chain of elementwise / reduction / stencil ops without `reshape`, `concatenate`, or transpose-then-use in the middle.

## 7. Programming for good partitioning

**Do:**

- Use a single global array as much as possible.
- Pre-allocate at the start; reuse with `out=`.
- Express stencils as slicing; let halo derivation work.
- Keep dimensions consistent through a hot loop.

**Don't:**

- `reshape` inside a hot loop. Identify this as the [R206](idioms-that-block.md#r206) idiom.
- `concatenate` to accumulate results. Identify this as the [R203](idioms-that-block.md#r203) idiom.
- Manually split arrays and process pieces. Legate already does this — your manual split fights its planner.
- Use mpi4py to coordinate ranks. Forbidden — see [R108](idioms-that-block.md#r108).

## 8. Linear-algebra-specific thresholds

From cuPyNumeric source:

| Function | Threshold for multi-GPU | Source |
|---|---|---|
| `linalg.solve` | matrix dim ≥ **512** AND `num_gpus > 1` | `linalg/_solve.py` (`MIN_SOLVE_MATRIX_SIZE`) |
| `linalg.cholesky` | matrix dim ≥ **8192** AND `num_gpus > 1` | `linalg/_cholesky.py` (`MIN_CHOLESKY_MATRIX_SIZE`) |
| Cholesky tile size | 2048 | `MIN_CHOLESKY_TILE_SIZE` |
| `linalg.qr` | always single-device | API tag |
| `linalg.svd` | always single-device | API tag |
| `linalg.eig`/`eigh` (single matrix) | always single-device | API tag |
| `linalg.eig`/`eigh` (batched, many matrices) | data-parallel across matrices | API tag |

If your code calls `linalg.solve` on a 64×64 matrix, multi-GPU does nothing for you; it runs on one device. This is expected behavior, not a bug.

## 9. Diagnosing partitioning problems

### Tools

- `legate --profile`: emits Legion profiler logs. Visualize with Legion Prof to see per-task durations and per-GPU timelines. Idle gaps on some GPUs while others are busy = load imbalance. The lane-by-lane interpretation walkthrough is in upstream [profiling and debugging](https://docs.nvidia.com/cupynumeric/latest/user/profiling_debugging.html).
- `CUPYNUMERIC_DOCTOR=1`: catches some patterns (advanced indexing, stack-in-loop, item-in-loop). Does *not* catch repartitions directly. See upstream [cuPyNumeric Doctor](https://docs.nvidia.com/cupynumeric/latest/user/doctor.html).
- `legate --logging "legion=2"`: verbose; shows task dispatch and partition decisions. Noisy but useful when you suspect something specific.

### Symptoms → likely cause

| Symptom | Likely cause |
|---|---|
| Total wall time ≈ 1 GPU regardless of `--gpus N` | Array too small to partition (≤ `MIN_GPU_CHUNK` × N) |
| Wall time gets *worse* with more GPUs | Communication or repartition cost dominating; check for `concatenate`/`reshape`/`transpose`-heavy hot loops |
| One GPU much busier than others in Legion Prof | Load imbalance — ragged data, mask skew, or non-divisible dimension |
| GPU utilization < 10% in `nvidia-smi` | Sync stalls; per-task work too small; or Python overhead in non-array code |

## Authoritative sources

- [cuPyNumeric best practices](https://docs.nvidia.com/cupynumeric/latest/user/practices.html)
- [cuPyNumeric differences with NumPy](https://docs.nvidia.com/cupynumeric/latest/user/differences.html)
- [Legate runtime / mappers](https://docs.nvidia.com/legate/latest/manual/mappers/index.html)
- [Legate NumPy SC'19](https://research.nvidia.com/publication/2019-11_Legate-NumPy:-Accelerated)
- [cuPyNumeric source: `cupynumeric/_thunk/deferred.py`](https://github.com/nv-legate/cupynumeric/blob/main/cupynumeric/_thunk/deferred.py)
- [cuPyNumeric source: `cupynumeric/linalg/_cholesky.py`](https://github.com/nv-legate/cupynumeric/blob/main/cupynumeric/linalg/_cholesky.py)
- [cuPyNumeric source: `cupynumeric/linalg/_solve.py`](https://github.com/nv-legate/cupynumeric/blob/main/cupynumeric/linalg/_solve.py)
