# The GPU Stack as cuPyNumeric Uses It

Every idiom in [`idioms-that-scale.md`](idioms-that-scale.md) and [`idioms-that-block.md`](idioms-that-block.md) is grounded in concrete behavior at one of four layers: **memory hierarchy, SM utilization, communication fabric, and task dispatch.** This document is the reference you read when you want the *why* behind an idiom being flagged as scaling or blocking.

## 1. Memory hierarchy

cuPyNumeric operates across four distinct memory targets (`legate.core.StoreTarget`):

| Target | Where | Capacity (H100) | Bandwidth | When cuPyNumeric uses it |
|---|---|---|---|---|
| `FBMEM` | GPU HBM3 | 80 GB | ~3 TB/s | Primary working set for every `cupynumeric.ndarray` |
| `ZCMEM` | Pinned host (GPU-mapped) | up to host RAM | PCIe Gen5 ~64 GB/s | Small overflow arrays; sized by `--zcmem` |
| `SYSMEM` | Pageable host | host RAM | PCIe Gen5 with copy step | Fallback / explicit offload via `offload_to(StoreTarget.SYSMEM)` |
| `SOCKETMEM` | NUMA-pinned host | per-socket | host DRAM | CPU-only / hybrid variants |

### Framebuffer budgeting

cuPyNumeric uses a **single deferred allocator** backed by the CUDA caching memory pool. The older split-pool model (`--eager-alloc-percentage` controlling a "deferred" / "eager" partition) is no longer how the runtime carves up framebuffer; both the persistent `cupynumeric.ndarray` working set and short-lived scratch (intermediate tiles, gather/scatter buffers, kernel temporaries) come out of the same allocator and reuse pool blocks via the CUDA cache.

What this changes in practice:

- **You can't shift "headroom" between user data and scratch by tuning a percentage anymore.** The size of `--fbmem` is the size of the single pool; both classes of allocation compete inside it.
- **Allocation churn still hurts.** Per-iteration allocs in a hot loop fragment the pool and produce small short-lived tasks that compete for scheduling slots. The fix is unchanged: hoist allocations out of the loop and reuse via `out=` (see [R201](idioms-that-block.md#r201) and [`refactor-recipes.md#rr-alloc`](refactor-recipes.md#rr-alloc)).
- **Leave 5–10% headroom in `--fbmem`.** Setting `--fbmem 80000` on an 80 GB H100 will fail at startup; pick `--fbmem 72000`.

### The 65,536-element floor

`CUPYNUMERIC_MIN_GPU_CHUNK = 65,536` is the per-processor minimum partition size. Arrays smaller than this stay on a single processor (no partitioning). This is the runtime's protection against over-decomposing data such that dispatch overhead dominates.

**Implication for migration.** An array with < ~65K elements per GPU will not benefit from additional GPUs. For 8 GPUs that's ~500K elements total. For 1000 GPUs that's ~65M elements. **Strong scaling has a hard floor here.**

### L2 cache

H100 has a 50 MB shared L2 across all SMs. cuPyNumeric does *not* JIT-fuse kernels in the mainline runtime — each Legate task is a separate precompiled CUDA kernel from `src/cupynumeric/{binary,unary,ternary,…}/`. This means that in expressions like `c = a*x + b*y`:

1. Task 1: `tmp1 = a*x` — reads `a`, `x` from FBMEM, writes `tmp1` to FBMEM.
1. Task 2: `tmp2 = b*y` — reads `b`, `y` from FBMEM, writes `tmp2` to FBMEM.
1. Task 3: `c = tmp1 + tmp2` — reads `tmp1`, `tmp2` from FBMEM, writes `c` to FBMEM.

That's three round trips through FBMEM (FBMEM is the Legate term for the GPU memory partition; on H100 the underlying hardware is HBM). With explicit `out=`:

```python
np.multiply(a, x, out=c)        # c = a*x
np.multiply(b, y, out=tmp)      # tmp = b*y (preallocated)
np.add(c, tmp, out=c)           # c = c + tmp
```

Still three kernels, but the working set stays smaller and the allocator stops creating intermediates. The "no JIT fusion" fact is the reason the `out=` recipe (RR-inplace) is a recurring fix.

The research direction (Diffuse, ASPLOS'25 — 1.86× average speedup via task+kernel fusion) is not in mainline.

### Zero-copy and pinned transfers

Anything that crosses the host-device boundary (`np.asarray`, `.item()`, `bool()`, `print`, a SciPy call) moves over PCIe. Pinned host memory can reach Gen5 peak (~64 GB/s); pageable ~12 GB/s. Compared to FBMEM bandwidth (~3 TB/s on H100) this is a **50–250× cliff** — which is why one host materialization in a hot loop wrecks performance. (CPU-only runs don't pay the PCIe cost, but the same materialization still drains pending tasks and serializes the loop.)

## 2. SM utilization

H100: 132 SMs × up to 64 active warps × 32 threads ≈ **270K concurrent threads** per GPU. To saturate them you need enough independent work — but Legate adds a layer of overhead on top of CUDA's intrinsic launch cost.

### The 1-millisecond task-granularity rule

Upstream guidance (cuPyNumeric performance docs): *"Ensure that the problem size is large enough to offset runtime overheads associated with tasks. A rule of thumb is that the problem size is large enough for a task granularity of about 1 millisecond."*

Translating to data size on an FBMEM-bound op at ~3 TB/s on H100: 1 ms ≈ 3 GB streamed. For float32, that's ~750M elements *touched per task*. For elementwise binary ops where you touch 2 inputs + 1 output, the per-task working set is ~250M elements. At 65K (the `MIN_GPU_CHUNK` floor), a task takes ~80 µs — almost all overhead.

The data-size thresholds that follow from this (per-GPU array size → expected behavior) are the canonical **Gate 2** table in [`decision-framework.md`](decision-framework.md#gate-2-problem-size). Multi-GPU strong scaling divides the per-GPU size (8 GPUs × 100M total → 12.5M each — still above the 65K floor, but the per-task work shrinks); weak scaling (more data with more GPUs) is the documented strength.

### Tensor Cores

cuPyNumeric uses cuBLAS / cuFFT / cuSolver internally. Tensor Cores activate when:

- **float16, bfloat16, int8**: by default in cuBLAS.
- **float32**: only when `CUPYNUMERIC_FAST_MATH=1` is set (enables TF32 path in cuBLAS); accuracy is reduced from FP32 to TF32 (~10-bit mantissa). For most array workloads the speedup (3–5× on H100 GEMM) is worth the precision loss.
- **float64**: never; F64 matmul uses CUDA cores, not Tensor Cores. F64 matmul on H100 is bandwidth-bound at a fraction of FP32-TC throughput.

Globally disable TF32: `NVIDIA_TF32_OVERRIDE=0` (a cuBLAS env var, not cuPyNumeric-specific).

### Kernel launch overhead

CUDA kernel launch is on the order of 5–10 µs per kernel. Legate adds task scheduling on top — exact dispatch overhead is not published, but the 1 ms target granularity tells you it's in the high microseconds. **Per-task work must massively exceed launch overhead** for the GPU to do useful compute. This is the underlying reason `np.vectorize` (one Python call per element) and `for i in range(n): arr[i] = ...` (one task per iteration) are catastrophic — they create *millions* of micro-tasks.

## 3. Communication fabric

Multi-GPU and multi-node cuPyNumeric uses the communication libraries beneath Legate:

| Tier | Library | Bandwidth (H100) | Typical use in cuPyNumeric |
|---|---|---|---|
| Intra-GPU | n/a (FBMEM-local) | 3 TB/s on H100 | per-tile compute |
| Intra-node multi-GPU | NCCL over NVLink | ~900 GB/s aggregate | allreduce (reductions), all2all (sort, gather), broadcast (matmul tile sharing), halo (stencils) |
| Inter-node | UCX over InfiniBand / RoCE | 50 GB/s on Quantum-2 (400 Gbps) | same collectives, slower fabric |
| Inter-node fallback | UCX over Ethernet | 3–12 GB/s | small clusters without IB |
| Inter-node alt | GASNet (opt-in build) | depends | research / HPC systems |

NCCL is used unconditionally for intra-node. UCX is the default packaged inter-node transport; GASNet is an alternate transport that requires a separate install.

### Which operations require communication

From the cuPyNumeric source and best-practice docs:

| Operation class | Collective | Notes |
|---|---|---|
| Elementwise binary/unary | none | tile-local |
| Reduction (sum, mean, …) | allreduce | tree-reduce |
| matmul / dot / einsum | allreduce per output tile | tile-local cuBLAS GEMM |
| Stencil via slicing | point-to-point halo | automatic via `bloat` constraint |
| Sort / argsort (distributed axis) | all2all | sample-sort algorithm |
| Fancy / boolean indexing (write) | all2all (gather/scatter) | gated by `CUPYNUMERIC_USE_NCCL_GATHER` / `_SCATTER`, default off |
| Concatenate / hstack / vstack | bulk copies | "performance penalty" per docs |
| Reshape across partition | repartition | copy + shuffle |
| FFT (single transform) | none (single-device) | distributed FFT is batched only |
| `linalg.solve` (dim ≥ 512, >1 GPU) | cuSolverMp + NCCL | distributed |
| `linalg.cholesky` (dim ≥ 8192, >1 GPU) | cuSolverMp `mp_potrf` | distributed |
| `linalg.qr`, `linalg.svd` | none (single-device) | no multi-GPU path |
| `linalg.eig`, `eigh` (single matrix) | none (single-device) | batched-eig parallelizes across matrices |

### Halo exchange (stencils)

The canonical scaling success story. When you write `u[1:-1, 1:-1] = 0.25 * (u[:-2, 1:-1] + u[2:, 1:-1] + u[1:-1, :-2] + u[1:-1, 2:])`, the partitioner observes that the LHS tile depends on neighbors offset by 1 row/col. It inserts a `bloat` constraint and fetches just the boundary rows from adjacent tiles — automatic halo exchange.

The cost per stencil step is roughly:

```
halo_bytes ≈ 2 * (tile_rows + tile_cols) * stride * dtype_size
halo_time  ≈ halo_bytes / NVLink_or_IB_bandwidth
```

For 1024×1024 float32 tiles, halo is ~32 KB per neighbor — sub-millisecond even over IB. Interior compute scales with `tile_rows * tile_cols` (~1M elements ≈ 100 µs at FBMEM rate). When the interior is large enough to dominate per-step halo + runtime overhead, communication becomes a small fraction; the [Eos 1024-H100 weak-scaling result](https://developer.nvidia.com/blog/effortlessly-scale-numpy-from-laptops-to-supercomputers-with-nvidia-cupynumeric/) lives in this regime. Real-world stencil workloads frequently *don't* — small per-tile interior or CFD-class kernels with thin per-step compute end up runtime-dominated. See [R005](idioms-that-scale.md#r005) for the conditions that make it work and the conditions that don't.

Strong scaling breaks down when the tile shrinks until halo ≥ interior — typically when per-tile area < ~10K elements.

### Repartitions are expensive

A repartition moves data between tiles. Triggers (from source and docs):

- `reshape` to a shape that doesn't compose with the existing partition.
- Reductions along a partitioned axis (allreduce — necessary but cheaper than a repartition for the *result*).
- `hstack` / `vstack` / `concatenate` (data is copied across tile boundaries).
- Sort along the partitioned axis (sample sort algorithm).
- Fancy indexing with destination indices that fall outside the current owner's tile.

If your code calls these frequently in a hot loop, the runtime spends most of its time shuffling rather than computing. These show up as REFACTOR-category idioms ([R201](idioms-that-block.md#r201), [R203](idioms-that-block.md#r203), [R206](idioms-that-block.md#r206)) or BLOCKS-category ([R109](idioms-that-block.md#r109) when `order=` would force a re-layout).

## 4. Task dispatch and the mapper

The Legate **mapper** decides, per task, which processor runs it, how to partition inputs, and how to allocate memory — see §4 of [`execution-model.md`](execution-model.md) for the full picture. The relevant performance fact here: task-graph construction and partition planning add overhead per call.

### Why tiny tasks are worse than no tasks

A million 1 µs tasks aren't a million parallel kernels — they're a serial queue, each item paying the mapper + Legion + CUDA-launch overhead. The runtime cannot batch them without seeing the *Python* loop. From the user side, the only fix is to avoid creating the small tasks in the first place.

This is the deep reason why every BLOCKS-category idiom that involves Python-level loops over array elements ([R101](idioms-that-block.md#r101), [R102](idioms-that-block.md#r102), [R103](idioms-that-block.md#r103)) is a hard blocker, not a tunable cost.

### Mapper bias toward GPU

The Legate default mapper picks "the most accelerated variant available" (GPU > OMP > CPU) unless constrained otherwise. So in a hybrid run with `--cpus 16 --gpus 4`, all GPU-capable tasks will route to GPUs, with CPU only as fallback for unsupported ops.

## 5. Putting it together — a checklist

For each kernel-like region of your code, the runtime needs:

1. **Enough work per task.** Elements_per_GPU × bytes ≳ 1 ms × HBM_bandwidth.
1. **Few host syncs.** Any `.item()`, `bool(x)`, `print(x)` flushes the pipeline.
1. **Few re-partitions.** Avoid `hstack`/`vstack` inside loops; `reshape` outside hot paths.
1. **Compatible partitioning across the chain.** Don't transpose then access by the original axis in the same hot loop.
1. **Reasonable communication-to-compute ratio.** Halo per step ≪ interior compute per step.

When all five hold, multi-GPU scales. Each idiom catalogued in [`idioms-that-scale.md`](idioms-that-scale.md) and [`idioms-that-block.md`](idioms-that-block.md) ties back to one of these five mechanisms.

## Cross-references by stack layer

- Memory hierarchy / out= → [R001 elementwise](idioms-that-scale.md#r001), [R006 out=](idioms-that-scale.md#r006), [R201 alloc-in-loop](idioms-that-block.md#r201), [R202 rebind in loop](idioms-that-block.md#r202)
- SM utilization / task granularity → [R101 loop indexing](idioms-that-block.md#r101), [R102 vectorize](idioms-that-block.md#r102), [R103 iter array](idioms-that-block.md#r103)
- Communication → [R005 stencil](idioms-that-scale.md#r005), [R203 stack in loop](idioms-that-block.md#r203), [R204 nonzero+index](idioms-that-block.md#r204)
- Sync points → [R104 .item()](idioms-that-block.md#r104), [R105 if reduction](idioms-that-block.md#r105), [R110 builtins](idioms-that-block.md#r110)

## Authoritative sources

- [cuPyNumeric best practices](https://docs.nvidia.com/cupynumeric/latest/user/practices.html)
- [cuPyNumeric advanced topics — data offloading](https://docs.nvidia.com/cupynumeric/latest/user/advanced.html#data-offloading)
- [cuPyNumeric settings](https://docs.nvidia.com/cupynumeric/latest/api/settings.html)
- [Legate runtime — standard execution](https://docs.nvidia.com/legate/latest/manual/runtime/standard_execution.html)
- [Legate tasks](https://docs.nvidia.com/legate/latest/manual/tasks/index.html)
- [Legate mappers](https://docs.nvidia.com/legate/latest/manual/mappers/index.html)
- [Eos 1024-GPU stencil blog](https://developer.nvidia.com/blog/effortlessly-scale-numpy-from-laptops-to-supercomputers-with-nvidia-cupynumeric/)
- [Legate NumPy SC'19 paper](https://research.nvidia.com/publication/2019-11_Legate-NumPy:-Accelerated)
