# Gotchas — Most Common cuTile → Triton Translation Errors

Comprehensive table of patterns that frequently break or regress when porting
`@ct.kernel` to `@triton.jit`. Read this BEFORE writing the Triton kernel — most
entries describe a wrong-by-default first attempt.

| Pattern | cuTile | Triton | Common Mistake |
|---------|--------|--------|----------------|
| **mma accumulator** | `ct.mma(a, b, acc=acc)` | `tl.dot(a, b, acc)` | Using keyword `acc=` in Triton (positional only) |
| **mma float32→tf32** | Explicit `ct.astype(..., ct.tfloat32)` guard before ct.mma | `tl.dot(a, b, allow_tf32=True)` (default) | Over-specifying; Triton auto-casts by default |
| **Type cast** | `ct.astype(x, dtype)` | `x.to(dtype)` | Using ct.astype in Triton |
| **Grid** | `(n, 1, 1)` tuple, `ct.launch(stream, grid, kernel, args)` | `lambda meta: (n,)` or tuple, bracket launch | Using ct.launch or 3-tuple in Triton |
| **Host cdiv** | `(a + b - 1) // b` (Python) | `triton.cdiv(a, b)` | Forgetting triton.cdiv in host |
| **2D+ tile load** | `ct.load(arr, index=(i,j), shape=(BM,BK))` (cuTile uses TMA) | `tl.make_tensor_descriptor(...).load([...])` | Using raw `tl.load(ptr+offs, mask=m)` → **5-20x regression**; always use TMA for 2D+ block loads |
| **Index type** | Block index in ct.load/ct.store | Element offset (ptr + offs) or TMA descriptor | Using block index as tl.load offset |
| **arange** | `ct.arange(N, dtype=ct.int32)` | `tl.arange(0, N)` | Triton has start param (0, N) |
| **None args** | Dummy tensor + flag | Allowed in kernel | Carrying over dummy+flag when not needed |
| **String const** | `ct.Constant[int]` only (no str) | `tl.constexpr` (any type) | Keeping int enum; Triton can use str constexpr if needed |
| **Shape args** | Static/constexpr in ct.full/ct.zeros | Dynamic shapes OK in Triton | Over-constraining shapes |
| **Launch** | `ct.launch(stream, grid, kernel, args)` | bracket launch (grid then args) | Leaving ct.launch in Triton host |
| **Branch vars** | Pre-define before if | Can define in branch | Over-defining before branch in Triton |
| **Pointer table type** | Typed tensor descriptor (auto) | `tl.load(ptrs+idx).to(tl.pointer_type(DTYPE))` where `DTYPE: tl.constexpr` | **Hardcoding `tl.float16`** → `cudaErrorIllegalAddress` for bfloat16/float32 inputs |
| **Stride dtype** | cuTile uses tensor shape (auto) | Pass strides as `torch.int64`, not `int32` | `int32` overflows → illegal address for large matrices (M×K > 2^31) |
| **dtype map coverage** | cuTile typed tensors (auto) | `_DTYPE_MAP` must cover all dtypes (incl. float8); use `hasattr` guards | Missing entry → `ValueError: Unsupported dtype` before kernel launch |
| **tl.math.erf dtype** | cuTile erf handles all dtypes | `tl.math.erf` **only accepts fp32/fp64** | `ValueError: Expected dtype ['fp32', 'fp64'] but got fp16` — do NOT replace with tanh approximation (mathematically wrong); let Triton auto-promote or cast input |
| **tl.exp with fp16** | cuTile exp handles all dtypes | Cast to fp32 before `tl.exp` for precision: `tl.exp(x.to(tl.float32))` | Precision loss or NaN with fp16 inputs in exp/log/sqrt |
| **Math func approx** | N/A | Never substitute `tl.math.erf` with tanh-based approximation | Using GELU tanh formula (`0.044715*x³`) as erf approximation is **mathematically incorrect** — they are different functions |
| **Layout flag (`transpose`)** | cuTile may use one path per layout | Need **two Triton kernels** when math differs (e.g. MLA: `qk` `[H,N]` vs `[N,H]`, different `V` TMA) | Reusing transpose-only logic for `transpose=False` + fixed blocks → **3–15×** on that mode; see [../translations/advanced-patterns.md](../translations/advanced-patterns.md) |
| **Batched matmul** | `ct.matmul(W, X)` broadcasts implicitly at tile level | `tl.dot(W, X)` only supports 2D operands | Using `broadcast_to + tl.dot` → **10-50× slower**, no tensor cores (see FFT anti-pattern in [performance-gotchas.md](./performance-gotchas.md)) |
| **Batch-per-block** | cuTile processes 1 batch per block naturally | Triton temptation: process BS batches per block | Creates BS× register pressure, breaks tensor core compatibility |
