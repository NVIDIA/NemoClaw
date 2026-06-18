# cuTile to Triton Conversion Workflow

**Guide for converting cuTile kernels to Triton with the same rigor as the inverse (Triton→cuTile).**

---

## 🚀 TODO WORKFLOW (MANDATORY - CREATE IMMEDIATELY)

**Upon starting a cuTile→Triton conversion task, IMMEDIATELY create this todo list using `todowrite`:**

```
todowrite([
  { id: "c2t-1", content: "[Optional] Analyze test coverage - verify cuTile tests pass, identify edge cases", status: "pending", priority: "medium" },
  { id: "c2t-2", content: "Convert cuTile → Triton - apply API mapping, generate Triton file", status: "pending", priority: "high" },
  { id: "c2t-3", content: "Test correctness - run python -m pytest -k 'triton', fix errors (max 5 attempts)", status: "pending", priority: "high" },
  { id: "c2t-4", content: "TMA optimization (MANDATORY) - replace ALL 2D+ raw ptr+mask with tl.make_tensor_descriptor; add tl.assume() alignment hints; add autotuning; if transpose/layout flag, two kernels + lambda META grid (advanced-patterns.md); skip = 5-20x regression", status: "pending", priority: "high" },
  { id: "c2t-5", content: "Performance test - run pytest -k 'test_perf' --print-record, compare vs cuTile, optimize if >20% slower", status: "pending", priority: "high" }
])
```

### Workflow Execution Rules

| Rule | Description |
|------|-------------|
| **Auto-proceed** | Move to next phase automatically after success - NO user confirmation needed |
| **Single focus** | Only ONE todo `in_progress` at a time |
| **Immediate update** | Mark `completed` immediately after phase passes |
| **Skip c2t-1** | If user says "skip test checker" OR Triton already exists and tests pass |
| **Stop conditions** | Only stop on: (1) critical failure after 5 attempts, (2) all phases complete |

### Phase → Todo Mapping

| Phase | Todo ID | Success Criteria | Next Action |
|-------|---------|------------------|-------------|
| Test Coverage | c2t-1 | cuTile tests pass, edge cases identified | → c2t-2 |
| Convert | c2t-2 | Triton file created, no syntax errors | → c2t-3 |
| Test | c2t-3 | `X passed, 0 failed` | → c2t-4 |
| TMA Optimize | c2t-4 | **MANDATORY:** TMA descriptors for ALL 2D+ loads (no raw ptr+mask for block tiles), alignment hints, autotuning added | → c2t-5 |
| Performance | c2t-5 | `pytest -k test_perf` run, Triton within 20% of cuTile | → DONE |

**DO NOT ask "should I proceed?" - execute the full workflow end-to-end.**

---

## RATIONALE: Key Thresholds

**Why these values? (Aligned with Triton→cuTile skill.)**

| Threshold | Value | Rationale |
|-----------|-------|-----------|
| Max fix attempts | 5 | Most errors resolve in 1–2; after 5, likely needs human insight |
| Perf threshold | >20% slower | Below 20%, measurement noise masks real differences (5–15% variance) |
| float32 rtol/atol | 1e-3 | 7 sig digits; allows 4 digits agreement |
| float16 rtol/atol | 1e-2 | 3–4 sig digits; matches precision limit |
| bfloat16 rtol/atol | 1e-2 | Same as float16 |

**Relaxed tolerances:** Use 2× for reductions, transcendentals, chained ops.

---

## VALIDATION LOOP (MANDATORY)

**NEVER proceed until tests pass. This pattern applies to ALL test phases.**

```
┌─────────────────────────────────────────────────────────┐
│                   VALIDATION LOOP                        │
│                                                          │
│   ┌─────────┐     ┌─────────┐     ┌─────────┐          │
│   │  RUN    │────▶│  CHECK  │────▶│  PASS?  │          │
│   │  TEST   │     │  OUTPUT │     │         │          │
│   └─────────┘     └─────────┘     └────┬────┘          │
│        ▲                               │               │
│        │              ┌────────────────┼───────────┐   │
│        │              │                │           │   │
│        │              ▼                ▼           │   │
│   ┌─────────┐    ┌─────────┐     ┌─────────┐      │   │
│   │  FIX    │◀───│   NO    │     │  YES    │──────┘   │
│   │  ERROR  │    │(attempt │     │  DONE   │          │
│   └─────────┘    │  < 5)   │     └─────────┘          │
│                  └─────────┘                          │
└─────────────────────────────────────────────────────────┘
```

**Validation Checklist** (copy for each attempt):
```
- [ ] Attempt #__: Run test command
- [ ] Check: `X passed, 0 failed`?
- [ ] No `FAILED tests/...` markers?
- [ ] No exceptions (syntax, shape, dtype)?
- [ ] If FAIL: identify error → fix → increment attempt
- [ ] If attempt >= 5: STOP, escalate to user
```

**CRITICAL:** Do NOT proceed to next phase until loop completes successfully.

---

## EXACT TEST COMMANDS (LOW FREEDOM)

**DO NOT MODIFY these commands. Flags are validated for correct output handling.**

### Correctness Test (Triton)
```bash
# DO NOT MODIFY
python -m pytest {test_path} -k "test_op and triton" -vs --tb=short 2>&1 | tail -100
```

### Performance Test
```bash
# DO NOT MODIFY
python -m pytest {test_path} -k "test_perf" --print-record -v 2>&1 | tail -50
```

### Triton Debug / Profiling
```bash
TRITON_INTERPRET=1 python script.py
TRITON_PRINT_AUTOTUNING=1 python script.py
TILEIR_DUMP_DIR=/tmp/dumping/triton python -m pytest {test_path} -k "test_op and triton" --timeout=120
```

**Flag rationale:** `-vs` (verbose + no capture), `--tb=short` (concise tracebacks), `2>&1 | tail -100` (capture stderr, limit for context).

---

## TABLE OF CONTENTS
 [🚀 TODO WORKFLOW (MANDATORY - CREATE IMMEDIATELY)](#-todo-workflow-mandatory---create-immediately)
 [RATIONALE: Key Thresholds](#rationale-key-thresholds)
 [VALIDATION LOOP (MANDATORY)](#validation-loop-mandatory)
 [EXACT TEST COMMANDS (LOW FREEDOM)](#exact-test-commands-low-freedom)
 [MODE SELECTION](#mode-selection)
 [COMMAND CHEAT SHEET](#command-cheat-sheet)
 [TMA OPTIMIZATION (Phase c2t-4)](#tma-optimization-phase-c2t-4)
 [PERFORMANCE ANALYSIS (Phase c2t-5)](#performance-analysis-phase-c2t-5)
 [CRITICAL PERFORMANCE PATTERNS](#critical-performance-patterns-avoid-10-50x-regression)
 [DUAL LAYOUT FLAG + AUTOTUNE GRID (MLA-style)](#dual-layout-flag--autotune-grid-mla-style)
 [MEMORY LAYOUT PATTERNS](#memory-layout-patterns-avoid-50-150-regression)
 [Standard Conversion Steps](#standard-conversion-steps)
 [Quick Reference: cuTile → Triton](#quick-reference-cutile--triton)

---

## MODE SELECTION

### Standard Mode (cuTile → Triton)

**Use when:** Converting existing TileGym cuTile operators to Triton (e.g. for portability or comparison).

**Path convention:** `/cutile/` → `/triton/`

```bash
TRITON_PATH="${CUTILE_PATH//\/cutile\//\/triton\/}"
mkdir -p $(dirname $TRITON_PATH)
```

---

## COMMAND CHEAT SHEET

```bash
# Standard mode path derivation
TRITON_PATH="${CUTILE_PATH//\/cutile\//\/triton\/}"
mkdir -p $(dirname $TRITON_PATH)

# Correctness testing
python -m pytest {test_path} -k "test_op and triton" -vs

# Performance testing (Triton vs cuTile)
python -m pytest {test_path} -k "test_perf and (triton or cutile)" --print-record -v

# Triton profiling / autotune visibility
TRITON_PRINT_AUTOTUNING=1 python -m pytest {test_path} -k "test_op and triton"
triton.testing.do_bench(lambda: kernel［grid］(launch_args))  # In script: measure ms
```

---

## TMA OPTIMIZATION (Phase c2t-4) {#tma-optimization-phase-c2t-4}

**This phase is MANDATORY. Do not skip.** Raw pointer + mask for 2D+ tile loads are **5-20x (500%-2000%) slower** than TMA on Hopper/Blackwell. Converted kernels that use only `tl.load(ptr+offs, mask=...)` for block-shaped 2D+ access will show severe regression until TMA is added.

### When TMA is Required

- **2D+ tile loads** (GEMM, attention, convolution, any load with shape like `(BLOCK_M, BLOCK_K)`) → **ALWAYS use TMA** (`tl.make_tensor_descriptor` + `.load([...])`)
- **1D loads** (single contiguous block, elementwise, simple reductions) → raw pointer OK

### TMA Conversion Pattern

```python
# BEFORE (cuTile ct.load) - already uses TMA internally
tile = ct.load(arr, index=(bid_m, bid_k), shape=(BLOCK_M, BLOCK_K))

# WRONG (naive Triton conversion) - 10-20x SLOWER
offs_m = pid_m * BLOCK_M + tl.arange(0, BLOCK_M)
offs_k = tl.arange(0, BLOCK_K)
tile = tl.load(ptr + offs_m[:, None] * stride_m + offs_k[None, :], mask=mask)

# CORRECT (TMA tensor descriptor) - FAST
desc = tl.make_tensor_descriptor(
    base=ptr,
    shape=[M, K],
    strides=[stride_m, 1],
    block_shape=[BLOCK_M, BLOCK_K],
)
tile = desc.load([pid_m * BLOCK_M, pid_k * BLOCK_K])
```

### TMA Setup (Required Once)

```python
from typing import Optional

def alloc_fn(size: int, alignment: int, stream: Optional[int]):
    return torch.empty(size, device="cuda", dtype=torch.int8)

triton.set_allocator(alloc_fn)
```

### TMA Checklist (Run BEFORE moving to c2t-5) {#tma-checklist-run-before-moving-to-c2t-5}

```
TMA Optimization Verification:
 [ ] All 2D+ tile loads use tl.make_tensor_descriptor
 [ ] Masks removed (TMA handles bounds automatically)
 [ ] tl.assume() alignment hints added for strides: tl.assume(stride % 8 == 0)
 [ ] tl.assume() alignment hints added for pointers: tl.assume(ptr.to(tl.int64) % 16 == 0)
 [ ] Autotuning added with GPU-specific configs (see PERFORMANCE ANALYSIS)
```

---

## PERFORMANCE ANALYSIS (Phase c2t-5) {#performance-analysis-phase-c2t-5}

When Triton is **>20% slower** than cuTile, follow this systematic flow.

### Step 1: Benchmark

```bash
python -m pytest {test_path} -k "test_perf and (triton or cutile)" --print-record -v
```

If Triton is within 20% of cuTile → done. If not → continue.

### Step 2: Match Tile Sizes and Grid

- **Constexpr block sizes** — Use the same BLOCK_M, BLOCK_N, BLOCK_K (or BLOCK_SIZE) as the cuTile kernel as `tl.constexpr` in Triton.
- **Grid** — Use `triton.cdiv(M, BLOCK_M)` etc. so grid shape matches cuTile's `(n_m, n_n, 1)`-style launch.

### Step 3: Memory Access Pattern

- **cuTile** uses block index in `ct.load(arr, index=(...), shape=(...))`.
- **Triton** uses element offset: `offs = pid * BLOCK + tl.arange(0, BLOCK)` (and strides for 2D+). Ensure `tl.load(ptr + offs, mask=...)` or `tl.make_block_ptr` + load matches the same coalescing and alignment.
- **Cache hints** — For memory-bound kernels, try `tl.load(..., cache_modifier=".cg")` if appropriate (see performance-model.md).

### Step 4: Triton Autotuning

If the cuTile op uses autotune (tile sizes, occupancy), add `triton.autotune` to the Triton kernel so Triton can search the same space:

```python
@triton.autotune(
    configs=[
        triton.Config({'BLOCK_M': 128, 'BLOCK_N': 256, 'BLOCK_K': 64}, num_stages=3, num_warps=8),
        triton.Config({'BLOCK_M': 64, 'BLOCK_N': 256, 'BLOCK_K': 32}, num_stages=4, num_warps=4),
        # ... match or expand cuTile config space
    ],
    key=['M', 'N', 'K'],  # Retune when these change
)
@triton.jit
def kernel(a_ptr, b_ptr, c_ptr, M, N, K, ...,
           BLOCK_M: tl.constexpr, BLOCK_N: tl.constexpr, BLOCK_K: tl.constexpr):
    ...
```

**Triton autotune knobs:** `BLOCK_*` (tile dimensions), `num_warps` (1, 2, 4, 8, 16, 32), `num_stages` (2–5 typical).

### Step 5: Profiling and Bottleneck

- Run with `TRITON_PRINT_AUTOTUNING=1` to see which config is chosen.
- Use `triton.testing.do_bench(lambda: kernel［grid］(launch_args))` for stable timings.
- For deeper analysis: Nsight Compute, or dump Triton IR (`TILEIR_DUMP_DIR=/tmp/dumping/triton`) and compare with cuTile IR (see [references/debugging.md](../references/debugging.md)) if the gap remains unexplained.

### Step 6: tf32 and Dtypes

- Triton defaults `allow_tf32=True` for `tl.dot`. If cuTile used an explicit tf32 cast before `ct.mma`, behavior should already match; use `allow_tf32=False` only if you need strict fp32.

**Bottleneck checklist:** algorithmic/grid → memory access → occupancy/warps → micro-optimizations.

---

## Standard Conversion Steps

| Step | Action |
|------|--------|
| 1 | Pre-flight: grep for ct.kernel, ct.load, ct.store, ct.launch, ct.Constant, ct.astype (see SKILL.md); if 2D+ ct.load → plan TMA |
| 2 | Create Triton file under triton/ mirror path (see file-structure.md) |
| 3 | Convert signature: tensor args → pointers + strides/shapes; ct.Constant[int] → tl.constexpr |
| 4 | Convert body: ct.load/ct.store → **for 2D+ block loads use tl.make_tensor_descriptor + .load([...]) (TMA)**; for 1D use tl.load(ptr+offs, mask=...); ct.astype → .to(); ct.mma(..., acc=acc) → tl.dot(..., acc) |
| 4b | **TMA (mandatory):** Replace any 2D+ raw ptr+mask loads with TMA; add triton.set_allocator(alloc_fn) in host; add tl.assume() alignment (see TMA OPTIMIZATION above) |
| 5 | Convert host: grid = (n,) or lambda meta: (...); <code>kernel［grid］(launch_args)</code>; use triton.cdiv for grid size |
| 6 | Test and compare numerically with compare_outputs.py |

---

## Quick Reference: cuTile → Triton

| cuTile | Triton |
|--------|--------|
| `@ct.kernel` | `@triton.jit` |
| `import cuda.tile as ct` | `import triton.language as tl` |
| `ct.bid(axis)` | `tl.program_id(axis)` |
| `ct.num_blocks(axis)` | `tl.num_programs(axis)` |
| `ct.arange(N, dtype=ct.int32)` | `tl.arange(0, N)` |
| `ct.load(arr, index=(bid,), shape=(BLOCK,))` (1D) | `tl.load(ptr + offs, mask=...)` (offs = bid * BLOCK + arange) |
| `ct.load(arr, index=(i,j), shape=(BM,BK))` (2D+) | **TMA:** `tl.make_tensor_descriptor(...).load([...])` — do NOT use raw tl.load(ptr+offs) (5-20x regression) |
| `ct.astype(x, dtype)` | `x.to(dtype)` |
| `ct.mma(a, b, acc=acc)` | `tl.dot(a, b, acc)` |
| `ct.Constant[int]` | `tl.constexpr` |
| `grid = (n, 1, 1)`; `ct.launch(stream, grid, kernel, args)` | `grid = (triton.cdiv(n, BLOCK),)`; <code>kernel［grid］(launch_args)</code> |
| `(a + b - 1) // b` (host) | `triton.cdiv(a, b)` |

Full cuTile → Triton API mapping: **[references/api-mapping.md](../references/api-mapping.md)**.

---

## CRITICAL PERFORMANCE PATTERNS (AVOID 10-50x REGRESSION) {#critical-performance-patterns-avoid-10-50x-regression}

**Case study: Group GEMM conversion showed 20-50x regression. Root causes and fixes below.**

### Performance Killer #1: Raw Pointer Arithmetic vs TMA Tensor Descriptors

**Impact: 5-20x slowdown (500%-2000% regression) — most common cause of conversion regression**

TMA (Tensor Memory Accelerator) enables async bulk memory transfers on Hopper/Blackwell. Raw pointer arithmetic with masks for 2D+ tile loads is dramatically slower. **Always use TMA for 2D+ block-shaped loads; do not ship conversion with raw ptr+mask for GEMM/attention/conv tiles.**

```python
# SLOW (10-20x regression) - Raw pointer + masks
offs_m = tile_m * TILE_M + tl.arange(0, TILE_M)
offs_k = tl.arange(0, TILE_K)
a_ptrs = A_ptr + (offs_m[:, None] * stride_am + offs_k[None, :] * stride_ak)
a_mask = (offs_m[:, None] < M) & (offs_k[None, :] < K)
a = tl.load(a_ptrs, mask=a_mask, other=0.0)  # Masked load = SLOW

# FAST - TMA tensor descriptors
a_desc = tl.make_tensor_descriptor(
    base=a_base_ptr,
    shape=[m, k],
    strides=[lda, 1],
    block_shape=[BLOCK_M, BLOCK_K],
)
a = a_desc.load([offset_am, kk * BLOCK_K])  # Bulk TMA load = FAST
```

**When to use TMA:**
- Blackwell (sm_120) or Hopper (sm_90) GPUs
- Matrix operations (GEMM, attention, convolution)
- Any kernel with 2D+ tile loads

**TMA setup requirements:**
```python
from typing import Optional

# TMA allocator (required once per kernel launch context)
def alloc_fn(size: int, alignment: int, stream: Optional[int]):
    return torch.empty(size, device="cuda", dtype=torch.int8)

triton.set_allocator(alloc_fn)
```

### Performance Killer #2: Inefficient Group/Batch Iteration

**Impact: 2-5x slowdown**

For grouped operations (group GEMM, batched attention), how you find which group a tile belongs to matters.

```python
# SLOW (2-5x regression) - Linear search ALL groups per tile
@triton.jit
def _find_group_id(tile_idx, problem_offsets, num_groups: tl.constexpr):
    group_id = num_groups - 1
    for g in range(num_groups):  # Scans ALL groups every time
        offset_start = tl.load(problem_offsets + g)
        offset_end = tl.load(problem_offsets + g + 1)
        is_in_group = (tile_idx >= offset_start) & (tile_idx < offset_end)
        group_id = tl.where(is_in_group, group_id, g)  # Conditional per group
    return group_id

# FAST - Natural while-loop advancement
@triton.jit
def kernel(...):
    tile_idx = tl.program_id(0)
    last_problem_end = 0

    for g in range(group_size):
        # ... load group dimensions ...
        num_tiles = num_m_tiles * num_n_tiles

        # Only process tiles belonging to this group
        while tile_idx >= last_problem_end and tile_idx < last_problem_end + num_tiles:
            # Process tile
            tile_idx += num_programs  # Persistent scheduling

        last_problem_end += num_tiles  # Advance boundary
```

### Performance Killer #3: Missing Autotuning

**Impact: 2-3x slowdown**

Fixed tile sizes vs architecture-optimized configurations.

```python
# SLOW - Fixed sizes, no tuning
TILE_M, TILE_N, TILE_K = 128, 128, 64  # May be wrong for your GPU/problem

# FAST - Autotuning with GPU-specific configs
def _get_configs():
    gpu_cap = torch.cuda.get_device_capability()
    if gpu_cap in [(12, 0), (12, 1)]:  # Blackwell
        return [
            triton.Config({"BLOCK_M": BM, "BLOCK_N": BN, "BLOCK_K": BK})
            for BM in [64, 128]
            for BN in [64, 128, 256]
            for BK in [64, 128]
        ]
    elif gpu_cap == (9, 0):  # Hopper
        return [
            triton.Config({"BLOCK_M": BM, "BLOCK_N": BN, "BLOCK_K": BK},
                         num_stages=s, num_warps=w)
            for BM in [128, 256]
            for BN in [128, 256]
            for BK in [64, 128]
            for s in [4, 5]
            for w in [8]
        ]
    # ... other architectures

@triton.autotune(configs=_get_configs(), key=["group_size", "dtype"])
@triton.jit
def kernel(...):
    ...
```

### Performance Killer #4: Missing Alignment Hints

**Impact: 1.5-2x slowdown**

Triton compiler can optimize better with alignment guarantees.

```python
# SLOW - No hints, compiler assumes worst case
lda = tl.load(group_strides + g * 3)
a_base_ptr = tl.load(group_a_ptrs + g).to(tl.pointer_type(dtype))

# FAST - Alignment hints enable compiler optimizations
lda = tl.load(group_strides + g * 3)
tl.assume(lda % 8 == 0)  # Stride is 8-element aligned

a_base_ptr = tl.load(group_a_ptrs + g).to(tl.pointer_type(dtype))
tl.assume(a_base_ptr.to(tl.int64) % 16 == 0)  # 16-byte aligned pointer
```

### Performance Killer #5: Unnecessary Masking

**Impact: 1.2-1.5x slowdown**

Masks add predication overhead. TMA handles boundaries automatically.

```python
# SLOW - Masks on every operation
a = tl.load(a_ptrs, mask=a_mask, other=0.0)
b = tl.load(b_ptrs, mask=b_mask, other=0.0)
tl.store(c_ptrs, c, mask=c_mask)

# FAST - TMA handles bounds, no masks needed
a = a_desc.load([offset_am, kk * BLOCK_K])
b = b_desc.load([kk * BLOCK_K, offset_bn])
c_desc.store([offset_cm, offset_cn], c)
```

### Performance Killer #6: K-loop Offset Recalculation

**Impact: 1.1-1.2x slowdown**

For GEMM K-loops, avoid recalculating full offsets each iteration.

```python
# SLOW - Recalculate every iteration
for k_tile in range(num_k_tiles):
    k_offset = k_tile * TILE_K
    a_ptrs = A_ptr + (offs_m[:, None] * stride_am + (k_offset + offs_k[None, :]) * stride_ak)
    # ... full offset calculation each time

# FAST - Increment pointers (for non-TMA kernels)
a_ptrs = a_ptr + offs_am[:, None] * lda + offs_k[None, :]
for kk in range(0, tl.cdiv(k, BLOCK_K)):
    tl.multiple_of(a_ptrs, [16, 16])  # Pipeline hint
    a = tl.load(a_ptrs)
    a_ptrs += BLOCK_K  # Simple increment
```

### Performance Checklist (Run BEFORE declaring conversion complete)

```
Performance Verification:
 [ ] TMA tensor descriptors used for 2D+ tile loads (Hopper/Blackwell)
 [ ] Autotuning added with GPU-specific configs
 [ ] Group/batch iteration uses natural loop advancement (not linear search)
 [ ] tl.assume() hints added for stride and pointer alignment
 [ ] Masks removed where TMA handles boundaries
 [ ] K-loop uses pointer increment or TMA offset (not full recalc)
 [ ] Pipeline hints (tl.multiple_of) added for non-TMA loads
 [ ] num_stages and num_warps tuned in autotune configs
 [ ] Benchmark shows <20% regression vs original cuTile
 [ ] Memory layout matches original (transpose + contiguous, NOT 5D reshape)
 [ ] Dimension params marked as tl.constexpr (bs, hd, n_heads, pad_*)
 [ ] No unnecessary tensor clones (transpose + contiguous suffices)
 [ ] If `transpose`/layout flag: two kernels + `grid = lambda META: (triton.cdiv(..., META["BLOCK_H"]), ...)` — see [advanced-patterns.md](advanced-patterns.md)
```

---

## DUAL LAYOUT FLAG + AUTOTUNE GRID (MLA-style)

**When:** cuTile or the public API exposes **`transpose`** (or equivalent) and perf tests show **one mode fast, the other 3–15× slow**.

**Do not** implement the non-transpose case by reusing the transpose kernel with extra **`tl.trans`** on `qk` / `p` and a **`[BLOCK_N, BLOCK_H]`** softmax state unless that matches a proven-fast reference.

**Do** implement two separate kernels following this structure:

| Mode | Kernel role (conceptually) |
|------|----------------------------|
| `transpose=False` | Head-major `qk` `[H,N]`, `l_prev` `[H]`, direct **`tl.dot(p, v, acc)`** |
| `transpose=True` | Seq-major `qk` `[N,H]`, separate **V** TMA descriptor (`shape=[S_kv, B, D]`, …), **`tl.dot(v, p, acc)`** after layout transposes |

**Autotune:** If `@triton.autotune` supplies `BLOCK_H` / `BLOCK_N`, the host must **not** pass fixed blocks into `torch.autograd.Function.apply`. Use:

```python
grid = lambda META: (triton.cdiv(num_head, META["BLOCK_H"]), B, 1)
kernel with grid then call (tensor_bases…, BLOCK_D=BLOCK_D, BLOCK_KPE=BLOCK_KPE)
```

**Full pattern, diagnosis table, and host-descriptor caveat:** [advanced-patterns.md](advanced-patterns.md).

---

## MEMORY LAYOUT PATTERNS (AVOID 50-150% REGRESSION)

**Case study: RoPE conversion showed 50-150% regression. Root cause: wrong memory layout.**

### Performance Killer #7: 5D Reshape vs Contiguous Access

**Impact: 50-150% slowdown**

When kernels access tensor halves (first `[0:dim//2]`, second `[dim//2:dim]`), naive 5D reshape breaks memory coalescing.

```python
# SLOW (50-150% regression) - 5D reshape
# Original cuTile might reshape: q.reshape(bsz, n_head, seq_len, 2, head_dim//2)
# Then access via stride_2 dimension - NON-CONTIGUOUS
q_offs_1 = batch * q_stride_b + heads[:, None] * q_stride_h + 0 * q_stride_2 + hd[None, :]
q_offs_2 = batch * q_stride_b + heads[:, None] * q_stride_h + 1 * q_stride_2 + hd[None, :]

# FAST - Transpose + contiguous + offset arithmetic
# Transpose to: (bsz, seq_len, n_head, head_dim) - head_dim CONTIGUOUS
q = q.transpose(1, 2).contiguous()
q = q + pid * q_row_stride  # Row-based addressing
first_half_offs = heads[:, None] * hd + tl.arange(0, pad_hd // 2)[None, :]
second_half_offs = first_half_offs + (hd // 2)  # Just add offset!
q_tile_1 = tl.load(q + first_half_offs, mask=mask)
q_tile_2 = tl.load(q + second_half_offs, mask=mask)
```

**Why this matters:**
- 5D reshape with `stride_2` creates non-sequential access: `[..., 0, :half_hd]` then `[..., 1, :half_hd]`
- Transpose + offset gives sequential access: `[:half_hd]` then `[half_hd:]` - both contiguous
- Memory coalescing difference: ~50-150% performance gap

### Performance Killer #8: Missing constexpr on Dimension Parameters

**Impact: 10-20% slowdown**

Triton compiler can optimize better when dimensions are compile-time constants.

```python
# SLOW - All parameters dynamic
def kernel(q, k, n_qh, n_kh, hd, pad_hd, BACKWARD_PASS):
    # Compiler cannot unroll loops or optimize register allocation

# FAST - Dimension params as constexpr
def kernel(q, k,
           n_qh: tl.constexpr,
           n_kh: tl.constexpr,
           hd: tl.constexpr,
           pad_hd: tl.constexpr,
           bs: tl.constexpr,
           BACKWARD_PASS: tl.constexpr = False):
    # Compiler can unroll, specialize, and optimize
```

### Performance Killer #9: Unnecessary Tensor Clones

**Impact: 10-20% slowdown**

In-place operations don't need explicit clones when transpose + contiguous already creates a copy.

```python
# SLOW - Explicit clone overhead
def forward(ctx, q, k, ...):
    q = q.clone()  # Unnecessary copy
    k = k.clone()  # Unnecessary copy
    q, k = rope_forward(q, k, ...)

# FAST - Transpose + contiguous is sufficient
def rope_forward(q, k, ...):
    q = q.transpose(1, 2)  # Returns view
    k = k.transpose(1, 2)  # Returns view
    q = q.contiguous()     # Creates copy (if needed)
    k = k.contiguous()     # Creates copy (if needed)
    # Now safe to modify in-place
```

### Pre-flight: Detect Split-Dimension Patterns

```bash
# Check if kernel splits a dimension
grep "reshape.*2," source.py        # Reshape with 2 in shape
grep "stride_2\|stride(3)" source.py  # Extra stride dimension
grep "half_\|// 2" source.py        # Half-dimension patterns
```

If found, use transpose + offset pattern, NOT 5D reshape.

---

### Quick Diagnosis: Why Is My Converted Kernel Slow?

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| 10-50x slower | No TMA, raw pointer + masks | Add `tl.make_tensor_descriptor` |
| Fast only when `transpose=True` (or only `False`) | One kernel + wrong softmax/`dot` layout for the other mode | Two kernels + autotune grid from `META` — [advanced-patterns.md](advanced-patterns.md) |
| 3-10x slower | O(N) group search per tile | Use while-loop with boundary tracking |
| 2-5x slower | Fixed tile sizes | Add `@triton.autotune` with GPU configs |
| **50-150% slower** | 5D reshape for split dims | Transpose + contiguous + offset arithmetic |
| 1.5-3x slower | No alignment hints | Add `tl.assume(stride % 8 == 0)` etc. |
| 1.2-2x slower | Masks on full tiles | Remove masks, rely on TMA bounds |
| 10-20% slower | Dynamic dimension params | Mark as `tl.constexpr` |
| 10-20% slower | Unnecessary `.clone()` | Let transpose + contiguous handle copies |
