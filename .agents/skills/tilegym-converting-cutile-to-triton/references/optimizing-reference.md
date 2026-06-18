# Triton Optimization Reference (cuTile → Triton)

**Use this reference when converting or optimizing GEMM/BMM/attention-style Triton kernels** so the result is within ~20% of cuTile (or of an existing optimized Triton implementation). Patterns below are derived from real comparisons (e.g. BMM: pointer + TMA kernels) and apply to batched matmul, attention, and block-level matmul.

**Prerequisites:** TMA is already applied for all 2D+ tile loads (complete **TMA OPTIMIZATION (Phase c2t-4)** and read **CRITICAL PERFORMANCE PATTERNS** in [translations/workflow.md](../translations/workflow.md)). This document covers **post-TMA** optimizations that can still yield **~10–20%** gains.

**Strategy hub:** [optimization-strategy.md](./optimization-strategy.md) condenses this file and [advanced-patterns.md](../translations/advanced-patterns.md) into an ordered checklist; use it for **attention / Gemma FMHA** (§4) and for **§2–§3** fast-vs-slow patterns before deep-diving here.

---

## When to Use This Reference

- **During conversion:** After Phase c2t-4 (TMA optimization), apply the patterns below for GEMM/BMM/attention kernels before running Phase c2t-5 (performance test). For Gemma-style attention, follow **[optimization-strategy.md §4](./optimization-strategy.md#4-gemma-fmha--gemma_attention-conversion-checklist-mandatory)** in parallel.
- **When Triton is 10–20% slower:** If perf test shows Triton within 2–5x of cuTile but still >20% slower, check this reference and **PERFORMANCE ANALYSIS (Phase c2t-5)** in [translations/workflow.md](../translations/workflow.md).
- **When comparing two Triton implementations:** Use the patterns as a checklist to explain or fix performance gaps (e.g. “naive” vs “optimized” BMM).

---

## 1. EVEN_K (or EVEN_*) Fast Path for Reductions

**Impact: ~5–15%** for GEMM/BMM when the reduced dimension (usually K) is divisible by the tile size.

**Problem:** In the K-loop (or any reduction loop), using a mask on every load when the remaining length equals the block size adds branches and prevents the compiler from emitting a single bulk load.

**Pattern:**

- Add a **heuristic** (or constexpr) that is true when the dimension is divisible by the block size (e.g. `EVEN_K: K % BLOCK_K == 0`).
- In the loop, **branch on that heuristic**: when true, use **unmasked** loads; when false, use masked loads with `k_remaining` (or equivalent).

```python
@triton.heuristics({"EVEN_K": lambda args: args["K"] % args["BLOCK_SIZE_K"] == 0})
@triton.jit
def kernel(..., EVEN_K: tl.constexpr):
    for k in range(0, tl.cdiv(K, BLOCK_SIZE_K)):
        if EVEN_K:
            a = tl.load(a_ptrs)
            b = tl.load(b_ptrs)
        else:
            k_remaining = K - k * BLOCK_SIZE_K
            a = tl.load(a_ptrs, mask=offs_k[None, :] < k_remaining, other=0.0)
            b = tl.load(b_ptrs, mask=offs_k[:, None] < k_remaining, other=0.0)
        accumulator += tl.dot(a, b)
        a_ptrs += BLOCK_SIZE_K * stride_ak
        b_ptrs += BLOCK_SIZE_K * stride_bk
```

**Avoid:** Always computing and applying masks in the inner loop when you could use an EVEN_* fast path.

---

## 2. Transpose: Pointer Arithmetic vs In-Loop Transpose

**Impact: ~5–15%** for BMM/GEMM when one or both inputs are transposed.

**Problem:** If the kernel supports transposed A or B, doing `tl.trans(a)` or `tl.trans(b)` **inside the K-loop** every iteration adds extra instructions and register pressure. The alternative is to encode transpose in **pointer arithmetic** so the loaded block already has the layout expected by `tl.dot`.

**Pattern:**

- **Preferred:** Compute different pointer strides/offsets for transposed vs non-transposed so that the **loaded tile is already in (BLOCK_M, BLOCK_K)** or **(BLOCK_K, BLOCK_N)** form. No `tl.trans` in the loop.
- **Acceptable when necessary:** If descriptor/TMA API forces a fixed block shape, use `tl.trans` after load but keep it out of the hottest path (e.g. one trans per load, not per element).

```python
# GOOD: Transpose encoded in pointer layout (no tl.trans in loop)
if transpose_a:
    a_ptrs = a_ptr + pid_q * stride_aq + offs_am[:, None] * stride_ak + offs_k[None, :] * stride_am
else:
    a_ptrs = a_ptr + pid_q * stride_aq + offs_am[:, None] * stride_am + offs_k[None, :] * stride_ak
# ... in loop: a = tl.load(a_ptrs); accumulator += tl.dot(a, b)
```

```python
# SLOW: Transpose in K-loop every iteration
for k in range(num_k_tiles):
    a = tl.load(a_ptrs, mask=a_mask, other=0.0)
    a = tl.trans(a)  # Extra work every K tile
    b = tl.load(b_ptrs, mask=b_mask, other=0.0)
    b = tl.trans(b)
    acc = tl.dot(a, b, acc)
```

**Apply to:** Pointer-based GEMM/BMM kernels; in TMA kernels, prefer descriptor block_shape that matches the expected 2D layout so no trans is needed after load.

---

## 3. Grid Layout (Pointer-Based Kernels)

**Impact: ~0–10%** depending on GPU and batch size.

**Problem:** A 3D grid `(num_pid_m, num_pid_n, Q)` can map to hardware differently than a 2D grid where batch is on `program_id(axis=1)` and the 2D tile index is flattened on axis=0. The latter often gives better occupancy and scheduling on many GPUs.

**Pattern:**

- Prefer a **2D grid**: `(num_pid_m * num_pid_n, Q)` with `pid = tl.program_id(0)` and `pid_q = tl.program_id(1)`. Decode `pid` into `pid_m` and `pid_n` (e.g. with GROUP_SIZE_M grouping for L2 reuse).
- Use **grouped ordering** (GROUP_SIZE_M) in the decoding so that tiles in the same M-group are adjacent; this improves L2 reuse and can match cuTile’s scheduling.

```python
# 2D grid: (num_blocks_mn, Q)
grid = lambda META: (
    triton.cdiv(M, META["BLOCK_SIZE_M"]) * triton.cdiv(N, META["BLOCK_SIZE_N"]),
    Q,
)
# In kernel: pid = tl.program_id(0); pid_q = tl.program_id(1); decode pid -> pid_m, pid_n
```

**Apply to:** Non-persistent, pointer-based BMM/GEMM when comparing or porting from a kernel that uses a 2D grid.

---

## 4. Autotune Breadth and Backend/GPU-Specific Configs

**Impact: ~10–20%** (picking a better block size / num_stages / num_warps).

**Problem:** A small or generic autotune space can miss the best config for a given GPU or backend (e.g. sm_90 vs sm_120). Missing `num_stages`, `num_warps`, or `occupancy` can leave significant performance on the table.

**Pattern:**

- **Expand config space** for GEMM/BMM: vary `BLOCK_M`, `BLOCK_N`, `BLOCK_K`, `num_stages`, `num_warps`, and for persistent kernels `occupancy` and optionally `num_ctas`.
- **Specialize by backend and GPU:** Use `get_available_triton_backend()` and `torch.cuda.get_device_capability()` to return different config lists (e.g. sm_120/sm_121 vs sm_90 vs older).
- **Pre-hook for TMA:** When using tensor descriptors, set `block_shape` in a `pre_hook` from the chosen `BLOCK_M`/`BLOCK_N`/`BLOCK_K` so TMA uses the same tile sizes as the kernel.

```python
def get_configs(pre_hook=None):
    cap = torch.cuda.get_device_capability()
    if cap in [(12, 0), (12, 1)]:
        return [
            triton.Config({"BLOCK_M": BM, "BLOCK_N": BN, "BLOCK_K": BK, ...}, num_stages=s, pre_hook=pre_hook)
            for BM in [64, 128] for BN in [64, 128] for BK in [32, 64] for s in [2, 3]
        ]
    elif cap == (9, 0):
        return [...]
    else:
        return [...]
```

**Apply to:** All TMA and pointer-based GEMM/BMM kernels after conversion.

---

## 5. Epilogue Subtile (TMA Store)

**Impact: ~5–15%** on some GPUs (e.g. Blackwell) when the C tile is large.

**Problem:** Writing the full output block in one TMA store can underutilize the memory subsystem or cause suboptimal scheduling. Splitting the C block into two halves and doing two stores (with correct offsets) can improve store throughput.

**Pattern:**

- Add an **EPILOGUE_SUBTILE** (or similar) constexpr. When true, treat the N dimension of the accumulator as two subtiles (e.g. `BLOCK_N // 2` each). Reshape/permute the accumulator accordingly, convert to output dtype, and **store twice** (first half at `[..., offs_bn]`, second at `[..., offs_bn + BLOCK_N // 2]`).
- Include both `EPILOGUE_SUBTILE=True` and `False` in autotune; let the tuner choose.

```python
if EPILOGUE_SUBTILE:
    acc = tl.reshape(acc, (1, BLOCK_M, 2, BLOCK_N // 2))
    acc = tl.permute(acc, (0, 1, 3, 2))
    acc0, acc1 = tl.split(acc)
    c_desc.store([..., offs_bn], acc0.to(dtype))
    c_desc.store([..., offs_bn + BLOCK_N // 2], acc1.to(dtype))
else:
    c_desc.store([..., offs_bn], acc.to(dtype))
```

**Apply to:** TMA-based GEMM/BMM when the output block is large (e.g. BLOCK_N ≥ 128) and the target GPU benefits (typically sm_90+).

---

## 6. Alignment and Bounds Hints

**Impact: ~5–15%** when the compiler or TMA can use alignment for wider transactions.

**Pattern:**

- Add `tl.assume(stride % 8 == 0)` (or 16) for strides that are known to be aligned.
- Add `tl.assume(ptr.to(tl.int64) % 16 == 0)` for base pointers when valid.
- For TMA, ensure descriptor `block_shape` and strides match the actual access; avoid unnecessary masks for full tiles (TMA can handle bounds).

See **TMA Checklist** in [translations/workflow.md](../translations/workflow.md) and [SKILL.md](../SKILL.md) (Performance Gotchas) for alignment.

---

## 7. Persistent vs Non-Persistent and Occupancy

**Impact: ~10–30%** depending on problem size and GPU.

**Pattern:**

- For **small/medium** problems, a **non-persistent** grid (one program per tile) can be faster due to less scheduling overhead.
- For **large** problems or when you want to amortize launch cost, use a **static persistent** loop: `for current_pid in tl.range(pid, total_tiles, num_programs, flatten=True)`, with grid size = `min(NUM_SMS // num_ctas, total_tiles) * occupancy`. Tune `occupancy` (1, 2, 4) in autotune.
- When using persistent scheduling, decode the flat `current_pid` into (batch, pid_m, pid_n) with the same GROUP_SIZE_M grouping for L2 reuse.

---

## Quick Checklist for GEMM/BMM Conversions

After TMA is in place, apply these before declaring conversion “optimized”:

| Check | Action |
|-------|--------|
| **EVEN_K** | Add heuristics and branch: unmasked loads when `K % BLOCK_K == 0`. |
| **Transpose** | Prefer pointer arithmetic for transposed A/B; avoid `tl.trans` in the K-loop. |
| **Grid** | Prefer 2D grid `(num_blocks_mn, Q)` with grouped (GROUP_SIZE_M) decoding for pointer BMM. |
| **Autotune** | Backend- and GPU-specific configs; vary BLOCK_*, num_stages, num_warps, occupancy. |
| **Epilogue** | Consider EPILOGUE_SUBTILE for TMA C-store when BLOCK_N is large (e.g. ≥128). |
| **Alignment** | Add `tl.assume()` for strides and pointers where valid. |
| **Persistent** | For large problems, use static persistent + occupancy in autotune. |

---

## 8. Batched Kernel Launch (Multi-Tensor Operations)

**Impact: ~2–4× speedup** for memory-bound operations on small-to-medium tensors (common in LLM inference KV-cache concatenation).

**Problem:** Operations like `cat`, `stack`, or multi-tensor copies often process N tensors by launching N separate kernels. Each kernel launch has ~5–10µs overhead on GPU. For small tensors, this overhead dominates actual compute time.

**Pattern:**

- **Batch multiple tensors into a single kernel launch** using a 2D grid where one dimension iterates over tensors (up to 4 is a good batch size).
- Pass all tensor pointers and metadata as separate kernel arguments; use `tl.program_id(1)` to select which tensor the block processes.
- Use conditional assignment (not branching) to select the correct tensor's data.

```python
@triton.jit
def batched_copy_kernel_4(
    out_ptr,
    in_ptr_a, in_ptr_b, in_ptr_c, in_ptr_d,
    size_a, size_b, size_c, size_d,
    offset_a, offset_b, offset_c, offset_d,
    total_a, total_b, total_c, total_d,
    BLOCK_X: tl.constexpr,
):
    pid_x = tl.program_id(0)  # Block index over elements
    pid_y = tl.program_id(1)  # Tensor index (0-3)

    # Select tensor data based on pid_y (no branching in hot path)
    if pid_y == 0:
        in_ptr, size_in, offset, total = in_ptr_a, size_a, offset_a, total_a
    elif pid_y == 1:
        in_ptr, size_in, offset, total = in_ptr_b, size_b, offset_b, total_b
    elif pid_y == 2:
        in_ptr, size_in, offset, total = in_ptr_c, size_c, offset_c, total_c
    else:
        in_ptr, size_in, offset, total = in_ptr_d, size_d, offset_d, total_d

    block_start = pid_x * BLOCK_X
    offsets = tl.arange(0, BLOCK_X)
    mask = block_start + offsets < total

    idx = block_start + offsets
    # Compute output index with unified formula
    out_idx = compute_output_index(idx, size_in, offset, ...)

    data = tl.load(in_ptr + idx, mask=mask)
    tl.store(out_ptr + out_idx, data, mask=mask)


# Host-side: batch tensors in groups of 4
def cat(tensors, dim=0):
    BLOCK = 1024
    i = 0
    while i < len(tensors):
        batch = tensors[i : i + 4]
        num_in_batch = len(batch)

        # Pad unused slots with placeholder (first tensor)
        args = []
        max_elements = 0
        for j in range(4):
            if j < num_in_batch:
                t = batch[j].contiguous()
                args.extend([t, t.shape[dim], offset, t.numel()])
                max_elements = max(max_elements, t.numel())
            else:
                args.extend([batch[0], 0, 0, 0])  # Placeholder

        # 2D grid: (blocks over elements, tensors in batch)
        grid = (triton.cdiv(max_elements, BLOCK), num_in_batch)

        batched_copy_kernel_4[grid](out, *args, BLOCK_X=BLOCK)
        i += num_in_batch
```

**Why this works:**

| Aspect | Per-Tensor Launch | Batched (4 tensors) |
|--------|-------------------|---------------------|
| Kernel launches | N | ⌈N/4⌉ |
| Launch overhead | N × 5–10µs | ⌈N/4⌉ × 5–10µs |
| GPU parallelism | Sequential | Concurrent (different SMs) |
| Block size | Often smaller | Can use larger (1024) |

**When to use:**

- **Multi-tensor memory-bound ops:** `cat`, `stack`, `split`, `chunk`, multi-tensor copy/scatter/gather
- **Small-to-medium tensor sizes:** When kernel launch overhead is significant relative to compute
- **LLM inference:** KV-cache concatenation, attention output gathering

**When NOT to use:**

- **Large tensors:** Launch overhead is negligible compared to compute
- **Single tensor operations:** No batching benefit
- **Compute-bound ops:** GEMM, convolution (launch overhead already amortized)

**Real-world example:** TileGym's original `cat` implementation (adapted from [FlagGems](https://github.com/FlagOpen/FlagGems)) uses this pattern to achieve **2–4× speedup** over naive per-tensor launches in transformer KV-cache operations.

---

## 9. Blackwell Advanced Optimization Patterns

**Impact: 2–10× speedup** on Blackwell (sm_100+) GPUs when converting complex kernels with iterative algorithms.

These patterns were discovered comparing optimized vs naive implementations of `chunk_gated_delta_rule` (a chunked linear attention kernel with Neumann series matrix inversion). They apply to any kernel with:
- Iterative loops (matrix inversion, recurrence, series expansion)
- Large intermediate tensors
- Multiple `tl.dot` operations
- Block-matrix algorithms

### 9.1 TMA Descriptors vs Raw Pointer Arithmetic

**Impact: 20–50%** on Blackwell for structured memory access.

**Problem:** Raw pointer arithmetic with strides requires the GPU to compute addresses at runtime, wastes registers on stride calculations, and prevents hardware-accelerated bulk transfers.

**Pattern:**

```python
# SLOW: Raw pointer + stride arithmetic
@triton.jit
def kernel_slow(Q_ptr, stride_qb, stride_qt, stride_qh, stride_qk, ...):
    q_ptrs = Q_ptr + b_idx * stride_qb + t_ids[:, None] * stride_qt + h_idx * stride_qh + offs_k[None, :] * stride_qk
    q = tl.load(q_ptrs, mask=valid[:, None] & mask_k[None, :], other=0.0)

# FAST: TMA descriptor (triton DSL / Blackwell)
from triton.tools.tensor_descriptor import TensorDescriptor

@triton.jit
def kernel_fast(Q_desc, ...):
    q = tl.reshape(Q_desc.load([b_idx, t_offset, h_idx, 0]), (CHUNK_SIZE, BLOCK_K)).to(tl.float32)
```

**Host-side setup:**
```python
Q_desc = TensorDescriptor.from_tensor(query, [1, BS, 1, BLOCK_K])
kernel_fast[grid](Q_desc, ...)
```

**Why it's faster:**
- TMA is a hardware unit on Blackwell that handles bulk data movement
- No runtime address calculation — hardware computes offsets
- Better memory coalescing (hardware optimizes access patterns)
- Lower register pressure (no stride variables needed)

### 9.2 Loop Unrolling Control for Register Pressure

**Impact: 2–5×** for kernels with iterative algorithms (matrix inversion, recurrence).

**Problem:** Full loop unrolling makes all intermediate values live simultaneously, causing massive register spilling. NCU shows symptoms like "168 regs/thread + 51M local spill requests".

**Pattern:**

```python
# SLOW: Full unroll (implicit with range() or tl.static_range)
@triton.jit
def _solve_tril_slow(A, BS: tl.constexpr):
    for i in tl.static_range(1, BS):  # 31 iterations fully unrolled
        # All 31 intermediate values live simultaneously → register spill
        is_row = offs == i
        row = tl.sum(tl.where(is_row[:, None], A, 0.0), axis=0)
        corr = tl.sum(row[:, None] * A, axis=0)
        A = A + tl.where(is_row[:, None], corr[None, :], 0.0)
    return A

# FAST: Controlled unroll factor
@triton.jit
def _solve_tril_fast(A, BS: tl.constexpr):
    for i in tl.range(1, BS, loop_unroll_factor=1):  # No unroll
        # Only current iteration's intermediates are live
        is_row = offs == i
        row = tl.sum(tl.where(is_row[:, None], A, 0.0), axis=0)
        corr = tl.sum(row[:, None] * A, axis=0)
        A = A + tl.where(is_row[:, None], corr[None, :], 0.0)
    return A
```

**When to use `loop_unroll_factor=1`:**
- Loop body has many intermediate tensors
- Loop iteration count > 16
- NCU shows high register usage or local memory spills
- Kernel is slower than expected despite correct algorithm

**When full unroll is OK:**
- Loop body is simple (few intermediates)
- Iteration count ≤ 8
- Register pressure is not a concern

### 9.3 Occupancy Autotuning

**Impact: 1.5–3×** by finding optimal resource allocation.

**Problem:** Default occupancy=1 lets the compiler use maximum resources per thread, which can backfire when aggressive optimization causes spilling.

**Pattern:**

```python
@triton.autotune(
    configs=[
        triton.Config({"occupancy": 1}, num_stages=3),
        triton.Config({"occupancy": 2}, num_stages=3),
        triton.Config({"occupancy": 4}, num_stages=3),
        triton.Config({"occupancy": 8}, num_stages=3),
        triton.Config({"occupancy": 2}, num_stages=4),
        triton.Config({"occupancy": 4}, num_stages=4),
    ],
    key=["K_dim", "V_dim"],
)
@triton.jit
def kernel(..., occupancy: tl.constexpr = 1):
    ...
```

**Occupancy guidance:**
- Higher occupancy = more concurrent thread blocks = better latency hiding
- Higher occupancy forces compiler to use fewer registers per thread
- Start with `[1, 2, 4]` for dot-heavy kernels
- Try `[1, 4, 8, 16]` for norm/elementwise kernels

### 9.4 TMEM-Friendly Block Sizes for `tl.dot`

**Impact: 1.5–2×** on Blackwell when `tl.dot` shapes qualify for Tensor Memory (TMEM).

**Problem:** Small block sizes (e.g., 16×16) force `tl.dot` to materialize results in registers. Larger sizes (≥32×32) enable TMEM, which is fast on-chip memory between registers and shared memory.

**Pattern:**

```python
# SLOW: 16×16 blocks → register materialization
BS: tl.constexpr = 16
# 4 diagonal blocks + 6 off-diagonal = 10 blocks to manage
# tl.dot shapes: (16, BLOCK_K) × (BLOCK_K, 16) → (16, 16) — no TMEM

# FAST: 32×32 blocks → TMEM enabled
BS: tl.constexpr = 32
# 2 diagonal blocks + 1 off-diagonal = 3 blocks (simpler)
# tl.dot shapes: (32, BLOCK_K) × (BLOCK_K, 32) → (32, 32) — TMEM OK
```

**Rule of thumb:** For hierarchical block algorithms, prefer block sizes that make `tl.dot` operands ≥32 in both dimensions on Blackwell.

### 9.5 Single Buffer Allocation (Slab Allocator)

**Impact: 10–30%** reduction in kernel launch overhead for kernels with multiple intermediate buffers.

**Problem:** Multiple `torch.empty()` calls trigger multiple `cudaMalloc` calls (~10–100μs each), causing fragmentation and launch latency.

**Pattern:**

```python
# SLOW: 6 separate allocations
q_chunked = torch.empty(B, H, num_chunks, chunk_size, K, device=device, dtype=torch.float32)
k_chunked = torch.empty(B, H, num_chunks, chunk_size, K, device=device, dtype=torch.float32)
v_corrected = torch.empty(B, H, num_chunks, chunk_size, V, device=device, dtype=torch.float32)
k_cumdecay = torch.empty(B, H, num_chunks, chunk_size, K, device=device, dtype=torch.float32)
g_cum = torch.empty(B, H, num_chunks, chunk_size, device=device, dtype=torch.float32)
output = torch.empty(B, H, num_chunks, chunk_size, V, device=device, dtype=torch.float32)

# FAST: Single slab allocation
total_elems = B * H * NC * (3 * K + 2 * V + 1)
buf = torch.empty(total_elems, device=device, dtype=torch.float32)

off = 0
def _slab(shape):
    nonlocal off
    n = 1
    for s in shape:
        n *= s
    t = buf[off : off + n].view(shape)
    off += n
    return t

q_chunked = _slab((B, H, num_chunks, chunk_size, K))
k_chunked = _slab((B, H, num_chunks, chunk_size, K))
v_corrected = _slab((B, H, num_chunks, chunk_size, V))
k_cumdecay = _slab((B, H, num_chunks, chunk_size, K))
g_cum = _slab((B, H, num_chunks, chunk_size))
output = _slab((B, H, num_chunks, chunk_size, V))
```

**Benefits:**
- Single `cudaMalloc` call instead of N calls
- Contiguous memory → better cache locality
- Reduced memory fragmentation
- Works with any number of intermediate buffers

### 9.6 Broadcasting vs `tl.expand_dims`

**Impact: 5–10%** in hot loops.

**Pattern:**

```python
# SLOW: tl.expand_dims may generate instructions
is_row_col = tl.expand_dims(is_row, axis=1)
row = tl.sum(tl.where(is_row_col, A, 0.0), axis=0)

# FAST: Broadcasting is compile-time (zero runtime cost)
row = tl.sum(tl.where(is_row[:, None], A, 0.0), axis=0)
```

**Rule:** Prefer `tensor[:, None]` or `tensor[None, :]` over `tl.expand_dims` for simple broadcast patterns.

### 9.8 Quick Checklist for Blackwell Optimization

After basic conversion, apply these for complex kernels on Blackwell:

| Check | Action |
|-------|--------|
| **TMA** | Use `TensorDescriptor` for all 2D+ loads/stores on triton DSL path |
| **Loop unroll** | Add `loop_unroll_factor=1` for loops with >16 iterations and complex bodies |
| **Occupancy** | Add `occupancy` to autotune configs: `[1, 2, 4]` for dot-heavy, `[1, 4, 8, 16]` for others |
| **Block size** | Use ≥32×32 blocks for `tl.dot` to enable TMEM |
| **Slab alloc** | Combine multiple intermediate buffers into single allocation |
| **Dual path** | Implement both triton DSL (TMA) and OpenAI Triton (pointer) paths |
| **Broadcasting** | Use `[:, None]` instead of `tl.expand_dims` |

### 9.9 Profiling with NCU

When a kernel is slower than expected, profile with NVIDIA Nsight Compute:

```bash
ncu --set full -o profile python test_kernel.py
```

**Key metrics to check:**
- **Registers/thread**: >128 suggests register pressure
- **Local memory**: Any spills indicate register overflow
- **Occupancy**: Low achieved vs theoretical suggests resource constraints
- **Memory throughput**: Compare to roofline

**Symptoms → Actions:**

| NCU Symptom | Likely Cause | Action |
|-------------|--------------|--------|
| High registers + local spills | Full loop unroll | Add `loop_unroll_factor=1` |
| Low occupancy | Too many resources/thread | Increase `occupancy` hint |
| Memory bound, low throughput | Raw pointer loads | Convert to TMA |
| Compute bound, low FLOPS | Small `tl.dot` shapes | Increase block sizes to ≥32 |

---

## Cross-References

Use [SKILL.md](../SKILL.md) as the hub. Deeper workflow sections (**TMA OPTIMIZATION**, **CRITICAL PERFORMANCE PATTERNS**, **PERFORMANCE ANALYSIS**) are in [translations/workflow.md](../translations/workflow.md).
