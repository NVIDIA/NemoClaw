# cuTile Python → cuTile.jl (Julia) Conversion Workflow

**Complete guide for converting cuTile Python kernels to cuTile.jl Julia with maximum detail and rigor.**

---

## TODO WORKFLOW (MANDATORY - CREATE IMMEDIATELY)

**Upon starting a Python→Julia conversion task, IMMEDIATELY create this todo list using `todowrite`:**

```
todowrite([
  { content: "Pre-flight analysis — grep source for patterns needing special handling", status: "pending", priority: "medium" },
  { content: "Write Julia kernel — create julia/kernels/<op>.jl with bridge functions", status: "pending", priority: "high" },
  { content: "Write Julia test — create julia/test/test_<op>.jl with NNlib.jl or manual reference", status: "pending", priority: "high" },
  { content: "Register test — add include(...) in julia/test/runtests.jl", status: "pending", priority: "high" },
  { content: "Validate — run python scripts/validate_cutile_jl.py on the .jl file", status: "pending", priority: "high" },
  { content: "Test — run julia --project=julia/ julia/test/runtests.jl", status: "pending", priority: "high" },
])
```

### Workflow Execution Rules

| Rule | Description |
|------|-------------|
| **Auto-proceed** | Move to next phase automatically after success — NO user confirmation needed |
| **Single focus** | Only ONE todo `in_progress` at a time |
| **Immediate update** | Mark `completed` immediately after phase passes |
| **Stop conditions** | Only stop on: (1) critical failure after 5 attempts, (2) all phases complete |

### Phase → Todo Mapping

| Phase | Success Criteria | Next Action |
|-------|------------------|-------------|
| Pre-flight | Patterns identified, special handling noted | → Write Julia kernel |
| Julia kernel | `.jl` file in `julia/kernels/` with bridge functions | → Write Julia test |
| Julia test | `test_<op>.jl` in `julia/test/` with reference comparison | → Register test |
| Register | `include(...)` added to `julia/test/runtests.jl` | → Validate |
| Validate | `validate_cutile_jl.py` reports OK | → Test |
| Test | `julia --project=julia/ julia/test/runtests.jl` passes | → DONE |

**DO NOT ask "should I proceed?" — execute the full workflow end-to-end.**

---

## RATIONALE: Key Thresholds

| Threshold | Value | Rationale |
|-----------|-------|-----------|
| Max fix attempts | 5 | Most errors resolve in 1-2; after 5, likely needs human insight |
| float32 rtol/atol | 1e-3 / 1e-3 | Standard precision |
| float16 rtol/atol | 1e-2 / 1e-2 | Half precision, higher tolerance |
| bfloat16 rtol/atol | 1e-2 / 1e-2 | Brain float, higher tolerance |
| Relaxed tolerances | 2x above | For reductions, transcendentals, chained ops |

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
- [ ] Check: no exceptions, numerical output matches?
- [ ] If FAIL: identify error → fix → increment attempt
- [ ] If attempt >= 5: STOP, escalate to user
```

---

## TEST COMMANDS

### Static Validation (run BEFORE testing)
```bash
# Checks for common anti-patterns (0-based indexing, Python API leftovers)
# The script is bundled with this skill at scripts/validate_cutile_jl.py
python <skill-dir>/scripts/validate_cutile_jl.py <path_to_julia_file.jl>
```

### Run Julia Tests
```bash
# Run all Julia tests
julia --project=julia/ julia/test/runtests.jl

# Run a single test file directly
julia --project=julia/ julia/test/test_<op>.jl

# With IR debug logging (compilation issues)
CUDA_TILE_LOGS=CUTILEIR julia --project=julia/ julia/test/test_<op>.jl 2>&1 | head -100
```

---

## PHASE 1: Pre-flight Analysis (30 seconds)

```bash
# 1. Count kernels (each @ct.kernel becomes a Julia function)
grep "@ct.kernel" source.py | wc -l

# 2. Count helpers (stay as @inline functions)
grep "^def " source.py | wc -l

# 3. Check for patterns needing special handling
grep "ct.permute\|ct.transpose" source.py     # → permutedims/transpose
grep "ct.where" source.py                      # → ifelse.(cond, x, y)
grep "\.astype(" source.py                     # → convert(ct.Tile{T}, tile)
grep "ct.mma\|ct.matmul" source.py             # → muladd(a, b, acc) or a * b
grep "for .* in range" source.py               # → for k in Int32(1):n (native for loops supported)
grep "ct.sum\|ct.max\|ct.min" source.py        # → sum/maximum/minimum with dims+1
grep "ct.maximum\|ct.minimum" source.py        # → max.(a, b) / min.(a, b)
grep "ct.atomic" source.py                     # → ct.atomic_cas/xchg/add (kwarg syntax changes)
grep "ct.Constant\[" source.py                 # → ::Int or ::Float32 params, ct.Constant() at launch
grep "\.shape\[" source.py                     # → size(arr, dim+1)
grep "ct.gather\|ct.scatter" source.py         # → same API, check index type
grep "order=" source.py                        # → ct.load with order: index positions must follow remapped dims!
grep "ct.rsqrt" source.py                      # → rsqrt.(t) or map(ct.rsqrt, t)
grep "ct.bitwise" source.py                    # → a .⊻ b, a .>> n, a .& mask, etc.
```

**Action items based on findings:**

| Finding | Action |
|---------|--------|
| `@ct.kernel` count | Each becomes a `function ... end` |
| `for ... in range(...)` | Use `for k in Int32(1):n` (native for loops supported in 0.2) |
| `ct.where` | Use `ifelse.(cond, x, y)` |
| `.astype(ct.X)` | Use `convert(ct.Tile{X}, tile)` |
| `ct.mma(a, b, acc=acc)` | Use `muladd(a, b, acc)` |
| `ct.Constant[int]` | `::Int` in signature, `ct.Constant(val)` at launch |
| `.shape[N]` | `size(arr, N+1)` |
| Reductions `ct.sum/max/min` | `sum/maximum/minimum(tile; dims=axis+1)`, keeps dims |
| `ct.maximum/minimum(a, b)` | `max.(a, b)` / `min.(a, b)` — MUST use broadcast dot |
| `ct.rsqrt` | `rsqrt.(tile)` — cuTile.jl exports rsqrt; `map(ct.rsqrt, tile)` also works |
| `ct.bitwise_*` | `a .⊻ b`, `a .& mask`, `a .\| b`, `a .>> n`, `a .<< n` |
| `order=` in `ct.load` | **⚠️ Critical**: `order` remaps both shape AND index (Rule 16) |
| Atomics | Same API but `;` for kwargs: `memory_order=` → `; memory_order=` |

---

## PHASE 2: Convert Kernel

### 2-Layer Architecture

Julia kernel integration in TileGym follows a **2-layer** pattern (no Python bridge):

```
Layer 1: Julia Kernel (.jl)     — julia/kernels/<op>.jl
Layer 2: Julia Test (.jl)       — julia/test/test_<op>.jl (using Test + NNlib.jl reference)
```

### Step 1: Julia Kernel File Structure (Layer 1)

The Julia file lives in `julia/kernels/<op>.jl` and contains:
1. The cuTile.jl kernel function(s)
2. A host harness function that allocates GPU arrays and launches the kernel

```julia
# <op_name> cuTile.jl kernel
#

using CUDA
import cuTile as ct

# Helpers (@inline, no decorator)
@inline function helper(...)
    ...
end

# Kernel (typed TileArray parameters)
function my_kernel(output::ct.TileArray{T, 2}, input::ct.TileArray{T, 2},
                   param::Int) where {T}
    ct.@compiler_options occupancy=2
    bid = ct.bid(1)
    # ... body ...
    return
end

# === Host harness function ===
# Accepts CuArrays directly, launches kernel, synchronizes
function my_op(input::CuArray{T, 2}, output::CuArray{T, 2}) where {T}
    M, N = size(input)

    grid_size = M  # one block per row (example)
    ct.launch(my_kernel, grid_size, output, input, ct.Constant(N))

    CUDA.synchronize()
    return nothing
end
```

**Key points:**
- Host harness accepts `CuArray` directly (no raw pointer wrapping needed for standalone use)
- If interop with external callers is needed, accept `Int` pointers and use `unsafe_wrap(CuArray, ptr, shape; own=false)`
- MUST call `CUDA.synchronize()` after kernel launch
- Column-major: Julia interprets `(M, N)` as col-major — consider layout when porting from row-major Python

### Step 2: Convert Kernel Signature

```python
# Python
@ct.kernel
def kernel(X, Y, M: ct.Constant[int], BLOCK: ct.Constant[int]):
    ...
```

```julia
# Julia
function kernel(X::ct.TileArray{T, 2}, Y::ct.TileArray{T, 2},
                M::Int, BLOCK::Int) where {T}
    ...
    return
end
```

**Checklist:**
- [ ] `@ct.kernel` removed — just `function ... end`
- [ ] Pointer args → `ct.TileArray{T, N}` with correct N
- [ ] `ct.Constant[int]` → `::Int` (wrap with `ct.Constant()` at launch)
- [ ] `ct.Constant[float]` → `::Float32` (wrap with `ct.Constant()` at launch)
- [ ] `where {T}` added if kernel is generic over element type
- [ ] `return` or `return nothing` at end

### Step 3: Convert Kernel Body (apply in order)

Full API mapping → [`references/api-mapping.md`](../references/api-mapping.md)
Full critical rules (17) → [`references/critical-rules.md`](../references/critical-rules.md)

| # | Python cuTile | Julia cuTile.jl | Check |
|---|--------------|-----------------|-------|
| 1 | `ct.bid(0)` | `ct.bid(1)` | ☐ |
| 2 | `ct.num_blocks(0)` | `ct.num_blocks(1)` | ☐ |
| 3 | `ct.num_tiles(A, axis=1, shape=(...))` | `ct.num_tiles(A, 2, (...))` | ☐ |
| 4 | `A.shape[0]` | `size(A, 1)` | ☐ |
| 5 | `ct.arange(N, dtype=ct.int32)` | `ct.arange(N)` | ☐ |
| 6 | `ct.full((m,n), v, dtype=ct.float32)` | `fill(v, (m, n))` — ct.full doesn't exist | ☐ |
| 7 | `ct.zeros((m,n), dtype=ct.float32)` | `zeros(Float32, m, n)` — Base.zeros overlay | ☐ |
| 8 | `ct.load(arr, index=(...), shape=(...))` | `ct.load(arr; index=(...), shape=(...))` — keyword preferred | ☐ |
| 8b | `ct.load(... order=(...))` | `ct.load(... ; order=(...))` — **index positions must follow remapped dims** (Rule 16) | ☐ |
| 9 | `ct.store(arr, index=(...), tile=t)` | `ct.store(arr; index=(...), tile=t)` — keyword preferred | ☐ |
| 10 | `ct.load(arr, index=bid, shape=())` (0-D tile) | `arr[bid]` | ☐ |
| 11 | `tile.astype(ct.float32)` | `convert(ct.Tile{Float32}, tile)` | ☐ |
| 12 | `ct.mma(a, b, acc=acc)` | `muladd(a, b, acc)` | ☐ |
| 13 | `ct.matmul(a, b)` | `a * b` | ☐ |
| 14 | `ct.where(m, x, y)` | `ifelse.(m, x, y)` | ☐ |
| 15 | `ct.sum(t, axis=1)` | `sum(t; dims=2)` (keeps dim!) | ☐ |
| 16 | `ct.max(t, axis=0)` | `maximum(t; dims=1)` | ☐ |
| 17 | `ct.maximum(a, b)` (elem-wise) | `max.(a, b)` | ☐ |
| 18 | `ct.minimum(a, b)` (elem-wise) | `min.(a, b)` | ☐ |
| 19 | `ct.exp(t)` | `exp.(t)` | ☐ |
| 20 | `ct.log(t)` | `log.(t)` | ☐ |
| 21 | `ct.sqrt(t)` | `sqrt.(t)` | ☐ |
| 22 | `ct.rsqrt(t)` | `rsqrt.(t)` (cuTile.jl exports rsqrt) | ☐ |
| 23 | `ct.permute(t, (0,2,1))` | `permutedims(t, (1,3,2))` | ☐ |
| 24 | `ct.transpose(t)` | `transpose(t)` | ☐ |
| 25 | `ct.reshape(t, shape)` | `reshape(t, shape)` | ☐ |
| 26 | `ct.extract(t, index=(...), shape=(...))` | `ct.extract(t, (...), (...))` | ☐ |
| 27 | `ct.cat((a,b), axis=0)` | `ct.cat((a,b), 1)` | ☐ |
| 28 | `for k in range(n):` | `for k in Int32(1):n` — native for loops supported | ☐ |
| 29 | `a + b` (different shapes) | `a .+ b` | ☐ |
| 30 | `a * b` (element-wise) | `a .* b` | ☐ |
| 31 | `a / b` (element-wise) | `a ./ b` | ☐ |
| 32 | `a ** 2` | `a .^ 2.0f0` | ☐ |
| 33 | `ct.cdiv(a, b)` | `cld(a, b)` | ☐ |
| 34 | `ct.atomic_cas(arr, idx, e, d, memory_order=...)` | `ct.atomic_cas(arr, idx, e, d; memory_order=...)` | ☐ |
| 35 | `ct.PaddingMode.ZERO` | `ct.PaddingMode.Zero` | ☐ |

### Step 4: Memory Layout Considerations

Python uses **row-major** (C-order), Julia uses **column-major** (Fortran-order).

For **2D arrays**, cuTile handles this via strides — usually transparent.

For **batched operations (3D+)**:
- Python: `(Batch, M, K)` — batch is outermost in row-major
- Julia: `(M, K, Batch)` — batch should be outermost in column-major

**Options:**
1. **Transpose layout** (recommended for perf): change array shapes, adjust kernel indexing
2. **Keep layout**: accept potentially suboptimal memory access

For batched operations, use batch-last ordering in Julia (e.g., `(M, K, Batch)` instead of Python's `(Batch, M, K)`).

---

## PHASE 3: Validate

```bash
python <skill-dir>/scripts/validate_cutile_jl.py <path_to_julia_file.jl>
```

This checks for common anti-patterns:
- `ct.full()` usage (doesn't exist — use fill/zeros/ones)
- `.astype(` or `ct.where(` instead of Julia equivalents
- Missing `return` at end of kernel
- 0-based indexing in `ct.bid(0)`, `ct.num_blocks(0)`
- `ct.mma(` instead of `muladd(`
- `ct.float32` or `ct.int32` type names
- Lambda grids
- `ct.cdiv(` instead of `cld(`
- `ct.launch(stream, ...)` with Python-style stream argument

Fix any reported errors before proceeding.

---

## PHASE 4: Test Correctness

### Step 1: Write Test File

Create `julia/test/test_<op>.jl`:

```julia

using Test
using CUDA

const KERNEL_DIR = joinpath(@__DIR__, "..", "kernels")
include(joinpath(KERNEL_DIR, "<op>.jl"))

@testset "<Op> Kernel" begin
    @testset "basic correctness" begin
        M, N = 128, 256
        x_gpu = CUDA.rand(Float32, M, N)
        out_gpu = similar(x_gpu)

        my_op!(out_gpu, x_gpu)

        expected = reference_impl(Array(x_gpu))
        @test Array(out_gpu) ≈ expected atol=1e-5
    end
end
```

### Step 2: Register in `julia/test/runtests.jl`

```julia
@testset "TileGym Julia Kernels" begin
    # ... existing includes ...
    include(joinpath(TEST_DIR, "test_<op>.jl"))  # ← ADD THIS
end
```

### Step 3: Run Tests

```bash
# Run all Julia tests
julia --project=julia/ julia/test/runtests.jl

# Run a single test file
julia --project=julia/ julia/test/test_<op>.jl
```

**Expected output**: All `@test` pass. Julia's `Test` stdlib prints summary automatically.

If test fails → fix → re-validate → re-test (loop until green, max 5 attempts).

---

## POST-CONVERSION CHECKLIST

```
Julia Kernel (julia/kernels/<op>.jl):
 [ ] File exists in correct location
 [ ] All indices converted from 0-based to 1-based
 [ ] for loops use Int32 ranges (for k in Int32(1):n)
 [ ] Broadcasting uses .+ .* etc. for different-shape tiles
 [ ] cuTile-specific math (rsqrt) uses rsqrt.(tile) — cuTile.jl exports rsqrt
 [ ] ct.Constant parameters wrapped at launch site (not in signature)
 [ ] Reduction dims shifted by +1 (axis=0 → dims=1)
 [ ] ct.mma → muladd, ct.matmul → *
 [ ] .astype() → convert(ct.Tile{T}, tile)
 [ ] ct.where → ifelse.(cond, x, y)
 [ ] fill/zeros/ones use Julia types (ct.full doesn't exist; use fill, zeros, ones)
 [ ] Kernel returns nothing
 [ ] Column-major layout considered
 [ ] ct.launch arg order matches kernel signature
 [ ] Element-wise max/min uses max.(a,b) not max(a,b)
 [ ] No Int32()/Float32() casts on runtime kernel values
 [ ] ct.arange/ct.full shape args use ct.Constant parameters (no @eval needed)
 [ ] Host harness accepts CuArray directly
 [ ] Host harness calls CUDA.synchronize() after launch
 [ ] validate_cutile_jl.py passes

Julia Test (julia/test/test_<op>.jl):
 [ ] Uses @testset with descriptive names
 [ ] Tests multiple dtypes (Float32, Float16, BFloat16) where applicable
 [ ] Tests multiple shapes (small, medium, boundary cases)
 [ ] Uses NNlib.jl reference where available (softmax, etc.)
 [ ] Uses isapprox() with appropriate rtol/atol per dtype
 [ ] Included in julia/test/runtests.jl
 [ ] julia --project=julia/ julia/test/runtests.jl passes
```
