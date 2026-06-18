# Triton Runtime Error Debugging (cuTile → Triton)

This guide covers runtime errors that commonly appear after converting a cuTile kernel to Triton.

---

## `cudaErrorIllegalAddress` (Illegal Memory Access)

**Symptom:**
```
torch.AcceleratorError: CUDA error: an illegal memory access was encountered
Search for 'cudaErrorIllegalAddress' ...
```

This is the **most frequent runtime crash** when converting cuTile kernels that use pointer
indirection (grouped/batched ops: group GEMM, batched attention, MoE, etc.).

### Root Cause 1: Hardcoded pointer type mismatch (PRIMARY)

**What happens:** When loading tensor pointers from a pointer table inside the kernel, the
element type must exactly match the actual tensor dtype. Triton's pointer arithmetic advances
the address by `offset * element_size_in_bytes`, so a wrong type causes every load/store to
hit an unintended address.

| Tensor dtype | Element size | `tl.float16` pointer arithmetic | Result |
|---|---|---|---|
| `torch.float16` | 2 bytes | 2 bytes/element | Correct |
| `torch.bfloat16` | 2 bytes | 2 bytes/element | Correct (same size) |
| `torch.float32` | 4 bytes | 2 bytes/element | **Off by 2×** → crash |

**Where to look:** Any `tl.load(ptr_table + idx).to(tl.pointer_type(...))` line with a
hardcoded type:

```python
# WRONG — crashes for bfloat16/float32 inputs
a_ptr = tl.load(a_ptrs + group_id).to(tl.pointer_type(tl.float16))
b_ptr = tl.load(b_ptrs + group_id).to(tl.pointer_type(tl.float16))
c_ptr = tl.load(c_ptrs + group_id).to(tl.pointer_type(tl.float16))
```

**Fix:** Pass the dtype as a `tl.constexpr` and use it for the pointer type:

```python
# Kernel signature — add DTYPE constexpr
@triton.jit
def my_kernel(..., DTYPE: tl.constexpr):
    ...
    a_ptr = tl.load(a_ptrs + group_id).to(tl.pointer_type(DTYPE))
    b_ptr = tl.load(b_ptrs + group_id).to(tl.pointer_type(DTYPE))
    c_ptr = tl.load(c_ptrs + group_id).to(tl.pointer_type(DTYPE))
    ...
    # Also fix the store cast — do NOT hardcode output dtype
    tl.store(c_ptr + c_offs, acc.to(DTYPE), mask=c_mask)

# Host wrapper — build dtype map and pass it
_DTYPE_MAP = {
    torch.float16:  tl.float16,
    torch.bfloat16: tl.bfloat16,
    torch.float32:  tl.float32,
}
triton_dtype = _DTYPE_MAP.get(dtype)
if triton_dtype is None:
    raise ValueError(f"Unsupported dtype: {dtype}")

my_kernel［grid］(..., DTYPE=triton_dtype)
```

**Checklist — scan every pointer table load/store in the converted kernel:**
```bash
grep -n "pointer_type" <your_triton_kernel.py>
```
Every occurrence should use `DTYPE` (or equivalent constexpr), never a hardcoded type.

Also scan the store path for hardcoded cast:
```bash
grep -n "acc.to(tl\." <your_triton_kernel.py>
```

---

### Root Cause 2: int32 stride overflow

**What happens:** Strides stored in a `torch.int32` tensor overflow when
`max_row_index × stride > 2^31 − 1`. The overflowed value wraps to a negative or
small positive number, pointing to an entirely different memory region.

Threshold: overflow occurs when `(TILE_M - 1 + (num_m_tiles - 1) * TILE_M) * stride > 2^31`
i.e. roughly when `M × K > 2^31` elements (≈ 4096 × 512K, or 512K × 4096 rows).

**Where to look:**

```python
# WRONG — int32 overflows for large matrices
a_strides = torch.tensor(a_stride_list, dtype=torch.int32, device=device)
b_strides = torch.tensor(b_stride_list, dtype=torch.int32, device=device)
c_strides = torch.tensor(c_stride_list, dtype=torch.int32, device=device)
```

**Fix:** Use `int64`:

```python
a_strides = torch.tensor(a_stride_list, dtype=torch.int64, device=device)
b_strides = torch.tensor(b_stride_list, dtype=torch.int64, device=device)
c_strides = torch.tensor(c_stride_list, dtype=torch.int64, device=device)
```

This applies to any array of strides passed to the kernel for pointer arithmetic, whether
in a pointer table pattern or as direct scalar stride arguments for large tensors.

---

### Quick diagnosis checklist

Run through these in order when you see `cudaErrorIllegalAddress`:

```
[ ] 1. Search for hardcoded pointer types:
        grep -n "pointer_type(tl\." <your_triton_kernel.py>
        → Should show DTYPE (constexpr), not tl.float16/tl.bfloat16/tl.float32

[ ] 2. Check store casts:
        grep -n "\.to(tl\." <your_triton_kernel.py>
        → Accumulator cast before tl.store should use DTYPE, not hardcoded type

[ ] 3. Check stride tensor dtypes in host:
        grep -n "dtype=torch.int32" <your_triton_kernel.py>
        → Strides used in pointer arithmetic should be int64

[ ] 4. Check pointer table dtype (usually already int64 — verify):
        grep -n "a_ptrs\|b_ptrs\|c_ptrs" <your_triton_kernel.py>
        → Should be dtype=torch.int64

[ ] 5. Verify DTYPE constexpr flows correctly:
        - Defined as DTYPE: tl.constexpr in kernel signature
        - Passed from host as DTYPE=triton_dtype (a tl.* type, not torch.* type)
        - _DTYPE_MAP covers all dtypes used in tests
```

---

### Pattern: pointer table kernels (group GEMM, MoE, batched ops)

The pointer table pattern (passing `int64` pointer arrays to the kernel and loading per-group
pointers inside) is the primary source of this error class. cuTile handles this automatically
through its typed tensor API; Triton requires explicit pointer casts.

**cuTile (source):**
```python
@ct.kernel
def group_gemm_kernel(As, Bs, Cs, TILE_M: ConstInt, ...):
    Ai = As[g]       # cuTile knows the type from the tensor descriptor
    ta = ct.load(Ai, (tile_m_idx, kk), shape=(TILE_M, TILE_K), ...)
```

**Triton (target — correct pattern):**
```python
@triton.jit
def group_gemm_kernel(a_ptrs, ..., DTYPE: tl.constexpr):
    a_ptr = tl.load(a_ptrs + group_id).to(tl.pointer_type(DTYPE))   # ← use DTYPE
    a_tile = tl.load(a_ptr + a_offs, mask=a_mask, other=0.0)
    ...
    tl.store(c_ptr + c_offs, acc.to(DTYPE), mask=c_mask)            # ← use DTYPE
```

**Host (correct pattern):**
```python
_DTYPE_MAP = {
    torch.float16:  tl.float16,
    torch.bfloat16: tl.bfloat16,
    torch.float32:  tl.float32,
}
triton_dtype = _DTYPE_MAP[dtype]
my_kernel［grid］(..., DTYPE=triton_dtype)
```

---

### Root Cause 3: Incomplete dtype map (`ValueError: Unsupported dtype`)

**What happens:** The host-side `_DTYPE_MAP` only covers the dtypes the author tested. When the
caller uses a dtype not in the map (e.g., `torch.float8_e5m2`), a `ValueError` is raised before
the kernel even launches.

```
ValueError: Unsupported dtype for group_gemm triton backend: torch.float8_e5m2
```

**Fix:** Extend `_DTYPE_MAP` to cover all float8 variants. Because float8 types were added in
specific PyTorch and Triton releases, use `hasattr` guards so the code still works on older
installs where those types don't exist yet:

```python
_DTYPE_MAP = {
    torch.float16:  tl.float16,
    torch.bfloat16: tl.bfloat16,
    torch.float32:  tl.float32,
}
# float8 types: add only when both torch and tl have them
_FLOAT8_PAIRS = [
    ("float8_e5m2",    "float8e5"),
    ("float8_e4m3fn",  "float8e4nv"),
    ("float8_e5m2fnuz","float8e5b16"),
    ("float8_e4m3fnuz","float8e4b8"),
]
for torch_name, tl_name in _FLOAT8_PAIRS:
    if hasattr(torch, torch_name) and hasattr(tl, tl_name):
        _DTYPE_MAP[getattr(torch, torch_name)] = getattr(tl, tl_name)
```

**PyTorch → Triton float8 type mapping:**

| `torch` dtype | `tl` dtype | Notes |
|---|---|---|
| `torch.float8_e5m2` | `tl.float8e5` | E5M2, 1 byte/element |
| `torch.float8_e4m3fn` | `tl.float8e4nv` | E4M3 NVIDIA format |
| `torch.float8_e5m2fnuz` | `tl.float8e5b16` | E5M2 UZ (unsigned zero) |
| `torch.float8_e4m3fnuz` | `tl.float8e4b8` | E4M3 UZ |

**Note:** float8 inputs use 1 byte/element. Ensure the `DTYPE` constexpr reflects this when
setting up pointer arithmetic. The accumulator remains `tl.float32`; only the final store cast
uses the float8 type.

Add to the diagnosis checklist:
```
[ ] 6. Does _DTYPE_MAP cover all dtypes in the test suite?
        grep -n "dtype=torch\." tests/ops/test_your_op.py
        → Every dtype listed must have an entry in _DTYPE_MAP (or a hasattr guard)
```

---

## Other Common Triton Runtime Errors

### `tl.dot` shape error (`expected block of shape [M,K,N]`)

**Cause:** `tl.dot` requires both inputs to have power-of-2 dimensions and compatible shapes.
TILE_M, TILE_N, TILE_K must each be powers of 2 ≥ 16 (or ≥ 32 for float32 on some GPUs).

**Fix:** Ensure tile sizes are powers of 2, and add `TILE_M >= 16` / `TILE_K >= 16` guards.

### `tl.load` with non-scalar pointer from pointer table

**Symptom:** JIT compilation error mentioning "expected scalar pointer."

**Cause:** `tl.load(a_ptrs + group_id)` where `group_id` is not a scalar (e.g., a vector due
to loop unrolling). Keep `group_id` as a scalar loop variable; do not vectorize the group loop.

### NaN/Inf after conversion (not a crash but related)

See [SKILL.md](../SKILL.md) and [translations/workflow.md](../translations/workflow.md) for testing and numerical comparison workflows.
Common cause: accumulator cast mismatch (e.g., storing fp32 acc as fp32 when original stored
as fp16 — use the same output dtype as the cuTile kernel).

---

## Triton Math Function Dtype Requirements (CRITICAL) {#triton-math-function-dtype-requirements-critical}

Several Triton math functions have **strict dtype requirements** that differ from cuTile:

| Function | Required dtype | Error if wrong | Solution |
|----------|---------------|----------------|----------|
| `tl.math.erf(x)` | fp32, fp64 only | `ValueError: Expected dtype ['fp32', 'fp64'] but got fp16` | Let Triton auto-promote OR explicit `.to(tl.float32)` |
| `tl.math.erfc(x)` | fp32, fp64 only | Same as above | Same as above |
| `tl.exp(x)` | All (but fp16 loses precision) | Silent precision loss, potential NaN | Cast: `tl.exp(x.to(tl.float32))` |
| `tl.log(x)` | All (but fp16 loses precision) | Silent precision loss | Cast: `tl.log(x.to(tl.float32))` |
| `tl.sqrt(x)` | All (but fp16 loses precision) | Silent precision loss | Cast if precision needed |

### Common Mistake: Wrong Mathematical Substitution

**NEVER** replace `tl.math.erf` with a tanh-based approximation to "fix" the dtype error.

```python
# WRONG - mathematically incorrect substitution
def standard_normal_cdf(x):
    # This is the GELU tanh approximation formula, NOT an erf approximation!
    erf_approx = tanh(sqrt_2_div_pi * (x + 0.044715 * x * x * x))  # WRONG
    return 0.5 * (1 + erf_approx)

# CORRECT - use the actual erf function
def standard_normal_cdf(x):
    # 1.0 / math.sqrt(2.0)  ≈ 0.70710678
    inverse_sqrt_2 = 0.70710678
    cdf = 0.5 * (1 + tl.math.erf(x * inverse_sqrt_2))  # CORRECT
    return cdf
```

The formula `tanh(√(2/π) * (x + 0.044715x³))` is specifically the **GELU tanh approximation**, not an approximation of the error function. These are mathematically different:
- **Exact GELU**: `x * Φ(x)` where `Φ(x) = 0.5 * (1 + erf(x/√2))`
- **Tanh GELU**: `0.5 * x * (1 + tanh(√(2/π) * (x + 0.044715x³)))`

### Recommended Pattern for fp16/bf16 Kernels

```python
@triton.jit
def kernel_with_erf(x_ptr, y_ptr, n, BLOCK: tl.constexpr):
    offs = tl.program_id(0) * BLOCK + tl.arange(0, BLOCK)
    x = tl.load(x_ptr + offs, mask=offs < n)

    # For erf: Triton auto-promotes fp16→fp32, result stays fp32
    # Output will be written as fp32 unless you cast back
    # 1.0 / math.sqrt(2.0)  ≈ 0.70710678
    cdf = 0.5 * (1 + tl.math.erf(x * 0.70710678))

    # For exp with fp16 input: explicit cast recommended for precision
    # 1.0 / math.sqrt(2.0 * math.pi)  ≈ 0.39894228
    pdf = 0.39894228 * tl.exp((-0.5 * x * x).to(tl.float32))

    tl.store(y_ptr + offs, x * cdf, mask=offs < n)
```
