# cuTile API Reference

## Contents
 [Quick Lookup: Most Common Mistakes](#quick-lookup-most-common-mistakes)
 [Import & Decorator](#import--decorator)
 [Indexing](#indexing)
 [Memory Operations](#memory-operations)
 [Tensor Creation](#tensor-creation)
 [Reductions](#reductions)
 [Scan Operations](#scan-operations)
 [Matrix Operations](#matrix-operations)
 [Type & Shape Operations](#type--shape-operations)
 [Slicing & Extraction](#slicing--extraction)
 [Math Functions](#math-functions)
 [Comparison Operations](#comparison-operations)
 [Bitwise Operations](#bitwise-operations)
 [Atomic Operations](#atomic-operations)
 [Debug & Utility Functions](#debug--utility-functions)
 [Host Functions](#host-functions)
 [Data Types](#data-types)
 [Enums: PaddingMode, RoundingMode, MemoryOrder, MemoryScope](#enums)
 [Launch Pattern](#launch-pattern)
 [Kernel Compilation Hints](#kernel-compilation-hints)
 [Critical Rules (The 18 Rules)](#critical-rules-the-18-rules)

> **For patterns, debug tables, and conversion reference:** See [cutile-patterns-reference.md](cutile-patterns-reference.md)

---

## Quick Lookup: Most Common Mistakes

| What You Wrote | What's Wrong | Correct Form |
|----------------|--------------|--------------|
| `import cutile as ct` | Wrong module name | `import cuda.tile as ct` |
| `ct.add(bid, offset)` | Promotes to float | `bid + offset` (Python op) |
| `x.to(ct.float32)` | No `.to()` method | `ct.astype(x, ct.float32)` |
| `grid = lambda: (n,)` | No lambda grid | `grid = (n, 1, 1)` |
| `ct.launch(..., None)` | No None allowed | Use dummy tensor + flag |

## Import & Decorator

```python
import cuda.tile as ct  # NOT import cutile as ct!

@ct.kernel
def kernel(X, Y, BLOCK: ct.Constant[int]):
    ...

ConstInt = ct.Constant[int]  # Type alias for cleaner signatures
```

## Indexing

| Function | Description | Example |
|----------|-------------|---------|
| `ct.bid(axis)` | Get block ID (axis: 0, 1, 2) | `bid = ct.bid(0)` |
| `ct.num_blocks(axis)` | Get grid size along axis | `n = ct.num_blocks(0)` |
| `ct.arange(size, dtype=)` | Create range [0, size) — starts at 0! | `offs = ct.arange(256, dtype=ct.int32)` |
| `ct.num_tiles(arr, axis, shape)` | Number of tiles in tile space along axis | `n = ct.num_tiles(A, 0, shape=(64, 64))` |

**Persistent scheduling pattern** (kernel processes multiple blocks):
```python
@ct.kernel
def persistent_kernel(X, Y, BLOCK: ConstInt):
    num_blks = ct.num_blocks(0)       # total blocks in grid
    for bid in range(ct.bid(0), total_tiles, num_blks):
        x = ct.load(X, index=(bid,), shape=(BLOCK,))
        ct.store(Y, index=(bid,), tile=x)
```

## Memory Operations

### ⚠️ TMA-FIRST STRATEGY

**ALWAYS try TMA (`ct.load`/`ct.store`) FIRST!** TMA is 2-4x faster than gather/scatter due to hardware acceleration.

### TMA Load/Store (PREFERRED - Block-aligned)

| Function | Signature |
|----------|-----------|
| `ct.load(arr, index, shape, *, order='C', padding_mode=PaddingMode.UNDETERMINED, latency=None, allow_tma=None, memory_order=MemoryOrder.WEAK, memory_scope=MemoryScope.NONE)` | TMA load |
| `ct.store(arr, index, tile, *, order='C', latency=None, allow_tma=None, memory_order=MemoryOrder.WEAK, memory_scope=MemoryScope.NONE)` | TMA store |

**Parameters:**
- `order` — `'C'` (default, no permutation), `'F'` (reversed axes), or tuple of ints for custom axis permutation
- `padding_mode` — What value to use for out-of-bounds reads (see [PaddingMode](#enums))
- `latency` — Hint for DRAM traffic intensity, int 1 (low) to 10 (high), or None (auto)
- `allow_tma` — If `False`, disables TMA for this load/store. Default `None` (TMA allowed)
- `memory_order` — Memory ordering for non-TMA load/store. Default `MemoryOrder.WEAK` (see [MemoryOrder](#enums))
- `memory_scope` — Memory scope for non-TMA load/store. Default `MemoryScope.NONE` (see [MemoryScope](#enums))

**⚠️ CRITICAL: `index` and `shape` must have the SAME number of dimensions as the source tensor!**

**⚠️ CRITICAL: `index` is BLOCK INDEX (which block), NOT element offset!**

```python
# CORRECT: index=(bid,) means "load block number `bid`"
bid = ct.bid(0)
x = ct.load(X, index=(bid,), shape=(BLOCK,))  # Loads elements [bid*BLOCK : (bid+1)*BLOCK]

# WRONG: Do NOT multiply bid by BLOCK_SIZE
# x = ct.load(X, index=(bid * BLOCK,), shape=(BLOCK,))  # WRONG!

# Example: Loading 2D tile from 4D tensor [batch, head, seq, dim]
# CORRECT: index and shape both have 4 elements, then reshape
q = ct.load(
    Q, index=(batch_idx, head_idx, bid_x, 0), shape=(1, 1, TILE_M, TILE_D)
).reshape((TILE_M, TILE_D))

# WRONG: mismatched dimensions
# q = ct.load(Q, index=(batch_idx, head_idx, bid_x, 0), shape=(TILE_M, TILE_D))  # ERROR!

# Load with transpose
tile = ct.load(array2d, (0, 0), shape=(4, 2), order='F')

# Load a single element as 0d tile
tile = ct.load(array3d, (0, 0, 0), shape=())
```

### Gather/Scatter (FALLBACK - Arbitrary offset)

**Use ONLY when TMA truly fails** (truly sparse random access). Most "paged" or "ragged" patterns CAN use TMA - see patterns below!

| Function | Signature |
|----------|-----------|
| `ct.gather(arr, indices, *, mask=None, padding_value=0, check_bounds=True, latency=None)` | Gather load |
| `ct.scatter(arr, indices, value, *, mask=None, check_bounds=True, latency=None)` | Scatter store |

**gather parameters:**
- `indices` — Tuple of integer tiles (length = array rank), or single tile for 1D arrays
- `mask` — Boolean tile; where `False`, returns `padding_value` instead of loading
- `padding_value` — Value for masked/OOB elements (default: 0)
- `check_bounds` — If `True` (default), OOB indices return `padding_value`. If `False`, OOB is undefined behavior
- `latency` — DRAM traffic hint (1-10), or None (auto)

**scatter parameters:**
- `indices` — Same as gather
- `value` — Tile or scalar to store
- `mask` — Boolean tile; where `False`, no store occurs
- `check_bounds` — If `True` (default), OOB indices are skipped. If `False`, OOB is undefined behavior
- `latency` — DRAM traffic hint (1-10), or None (auto)

**Note:** When both `mask` and `check_bounds=True` are provided, the effective mask is the logical AND of both.

### TMA with Runtime Index (ct.gather().item() Pattern) - CRITICAL!

**⚠️ TMA works with RUNTIME indices!** For paged attention or indirect access:

```python
# ⚠️ WRONG (78x slower!): Using gather for all loads
page_id_tile = ct.gather(block_tables, (idx,))
k_indices = compute_flat_indices(page_id_tile, ...)
k_tile = ct.gather(k_cache.view(-1), k_indices)  # NO TMA!

# ✅ CORRECT: Extract scalar with .item(), then use ct.load(allow_tma=True)
page_id = ct.gather(block_tables, (idx,), padding_value=0).item()
k_tile = ct.load(k_cache, index=(page_id, ...), shape=(...), allow_tma=True)
```

| Pattern | Use | Performance |
|---------|-----|-------------|
| `ct.gather` for all loads | NO TMA | 78x slower |
| `ct.gather().item()` + `ct.load(allow_tma=True)` | TMA enabled | Baseline |

## Tensor Creation

| Function | Description |
|----------|-------------|
| `ct.zeros(shape, dtype)` | Create zero-filled tile |
| `ct.ones(shape, dtype)` | Create one-filled tile |
| `ct.full(shape, fill_value, dtype)` | Create tile filled with given value |

**⚠️ `shape` must be compile-time constants (literals or `ct.Constant` params), NOT `X.shape`.**

## Reductions

| Function | Description | Optional Params |
|----------|-------------|-----------------|
| `ct.sum(x, axis=None, *, keepdims=False)` | Sum reduction | `rounding_mode=`, `flush_to_zero=` |
| `ct.max(x, axis=None, *, keepdims=False)` | Max reduction | `flush_to_zero=` |
| `ct.min(x, axis=None, *, keepdims=False)` | Min reduction | `flush_to_zero=` |
| `ct.prod(x, axis=None, *, keepdims=False)` | Product reduction | `rounding_mode=`, `flush_to_zero=` |
| `ct.argmax(x, axis=None, *, keepdims=False)` | Index of max value | — |
| `ct.argmin(x, axis=None, *, keepdims=False)` | Index of min value | — |
| `ct.reduce(x, axis, func, identity, *, keepdims=False)` | Custom reduction | — |

**`axis`**: `None` (reduce all), `int`, or `tuple[int, ...]`.

**`ct.reduce` example:**
```python
# Custom sum via reduce
result = ct.reduce(x, axis=0, func=lambda a, b: a + b, identity=0)

# Multi-tile reduce (x is a tuple of tiles)
# func takes 2N args and returns N combined tiles
```

## Scan Operations

| Function | Description | Optional Params |
|----------|-------------|-----------------|
| `ct.cumsum(x, axis=0, *, reverse=False)` | Cumulative sum | `rounding_mode=`, `flush_to_zero=` |
| `ct.cumprod(x, axis=0, *, reverse=False)` | Cumulative product | `rounding_mode=`, `flush_to_zero=` |
| `ct.scan(x, axis, func, identity, *, reverse=False)` | Custom scan (inclusive prefix) | — |

**`ct.scan` example:**
```python
# Custom cumsum via scan
result = ct.scan(x, axis=0, func=lambda a, b: a + b, identity=0)
```

## Matrix Operations

| Function | Description |
|----------|-------------|
| `ct.matmul(a, b)` or `a @ b` | Matrix multiply (1D/2D/3D). Auto-promotes dtypes. |
| `ct.mma(a, b, acc)` | MMA with accumulator — preserves acc dtype. |

**`ct.mma` signature:** `def mma(x, y, /, acc) -> Tile`

`acc` is a **positional** parameter (not keyword-only). Both forms work:
```python
acc = ct.mma(a, b, acc)       # positional — OK
acc = ct.mma(a, b, acc=acc)   # keyword — also OK
```

**Supported mma dtypes:**

| Input | Acc/Output |
|-------|------------|
| f16 | f16 or f32 |
| bf16 | f32 |
| f32 | f32 |
| f64 | f64 |
| tf32 | f32 |
| f8e4m3fn | f16 or f32 |
| f8e5m2 | f16 or f32 |
| [u\|i]8 | i32 |

**⚠️ `ct.mma` does NOT auto-cast f32→tf32.** You must manually cast:
```python
a_tf32 = ct.astype(a, ct.tfloat32)
b_tf32 = ct.astype(b, ct.tfloat32)
acc = ct.mma(a_tf32, b_tf32, acc)
```

### Block-Scaled MMA

> **⚠️ Note:** `mma_scaled` is defined in `_stub.py` but is **not yet exported** from `cuda.tile.__init__`. The datatypes `float8_e8m0fnu` and `float4_e2m1fn` required by this API are also not yet exported. Confirm with the cuTile team before using.

`ct.mma_scaled(x, x_scale, y, y_scale, /, acc)` — block-scaled matrix multiply-accumulate for microscaling (MX) formats.

Computes: `result[i,j] = sum_k (x[i,k] * x_scale[i,k/V]) * (y[k,j] * y_scale[k/V,j]) + acc[i,j]`

| Input (x/y) | Scale | Acc/Out | Block Factor V |
|-------------|-------|---------|---------------|
| f8e4m3fn, f8e5m2 | f8e8m0fnu | f32 | 32 |
| f4e2m1fn | f8e8m0fnu | f32 | 16, 32 |
| f4e2m1fn | f8e4m3fn | f32 | 16 |

```python
tx = ct.full((16, 32), 1, dtype=ct.float8_e4m3fn)
sx = ct.full((16, 1), 1, dtype=ct.float8_e8m0fnu)   # scale shape: [M, K_s]
ty = ct.full((32, 16), 1, dtype=ct.float8_e4m3fn)
sy = ct.full((1, 16), 1, dtype=ct.float8_e8m0fnu)    # scale shape: [K_s, N]
acc = ct.full((16, 16), 0, dtype=ct.float32)
result = ct.mma_scaled(tx, sx, ty, sy, acc)
```

## Type & Shape Operations

| Function | Description |
|----------|-------------|
| `ct.astype(x, dtype)` | Type cast — **NO .to() method!** |
| `ct.bitcast(x, dtype)` | Reinterpret bits as different dtype (no conversion) |
| `ct.transpose(x, axis0=None, axis1=None)` | Transpose two axes (2D: auto, >2D: must specify) |
| `ct.permute(x, axes)` | Permute dimensions |
| `ct.reshape(x, shape)` | Reshape tile (supports -1 for auto-infer) |
| `ct.expand_dims(x, axis)` | Insert size-1 axis. Also: `x[:, None]`, `x[None, :]` |
| `ct.cat(tiles, axis)` | Concatenate two same-shape tiles along axis |
| `ct.broadcast_to(x, shape)` | Broadcast tile to target shape (NumPy rules) |
| `ct.pack_to_bytes(x)` | Flatten tile and reinterpret raw bytes as 1D uint8 tile. ⚠️ **Not yet exported** from `cuda.tile.__init__` |
| `ct.unpack_from_bytes(x, dtype)` | Reinterpret 1D uint8 tile as 1D tile of target dtype (inverse of `pack_to_bytes`). ⚠️ **Not yet exported** from `cuda.tile.__init__` |

**Tile properties:** `tile.dtype`, `tile.shape`, `tile.ndim`
**Tile methods:** `tile.item()` (reshape to 0D scalar), `tile.reshape(shape)`, `tile.permute(axes)`, `tile.transpose(axis0, axis1)`, `tile.astype(dtype)`, `tile.extract(index, shape)`

**Array properties:** `array.dtype`, `array.shape`, `array.strides`, `array.ndim`
**Array methods:** `array.slice(axis, start, stop)` — creates a view with restricted range along one axis

## Slicing & Extraction

| Function | Description |
|----------|-------------|
| `ct.extract(tile, index, shape)` | Extract sub-tile (like ct.load but on a tile) |
| `array.slice(axis, start, stop)` | Slice array along axis (view, no copy) |

```python
# ct.extract: Extract a sub-tile from a larger tile
a_reshaped = ct.reshape(a_interleaved, (TILE_M, TILE_N, 2))

# Extract first slice along dim 2
gelu_part = ct.reshape(
    ct.extract(a_reshaped, index=(0, 0, 0), shape=(TILE_M, TILE_N, 1)),
    (TILE_M, TILE_N)
)
# Extract second slice along dim 2
linear_part = ct.reshape(
    ct.extract(a_reshaped, index=(0, 0, 1), shape=(TILE_M, TILE_N, 1)),
    (TILE_M, TILE_N)
)

# array.slice: Create a view of an array with restricted range
segment = A.slice(axis=1, start=offset, stop=offset + length)
tile = ct.load(segment, (0, 0), shape=(TILE_M, TILE_N))
```

## Math Functions

### Unary Math

| Function | Description | Optional Params |
|----------|-------------|-----------------|
| `ct.exp(x)` | Exponential | — |
| `ct.exp2(x)` | Base-2 exponential | `flush_to_zero=` |
| `ct.log(x)` | Natural log | — |
| `ct.log2(x)` | Base-2 log | — |
| `ct.sqrt(x)` | Square root | `rounding_mode=`, `flush_to_zero=` |
| `ct.rsqrt(x)` | Reciprocal sqrt (1/√x) | `flush_to_zero=` |
| `ct.sin(x)` | Sine | — |
| `ct.cos(x)` | Cosine | — |
| `ct.tan(x)` | Tangent | — |
| `ct.sinh(x)` | Hyperbolic sine | — |
| `ct.cosh(x)` | Hyperbolic cosine | — |
| `ct.tanh(x)` | Hyperbolic tangent | `rounding_mode=` (supports `FULL`, `APPROX`) |
| `ct.floor(x)` | Floor | — |
| `ct.ceil(x)` | Ceiling | — |
| `ct.abs(x)` | Absolute value | — |
| `ct.negative(x)` or `-x` | Negation | — |
| `ct.isnan(x)` | Check for NaN (returns bool tile) | — |

**`flush_to_zero`** (bool): If `True`, flushes subnormal inputs/results to sign-preserving zero. Default `False`.

**`rounding_mode`** (RoundingMode): Controls rounding behavior for float ops. See [RoundingMode enum](#enums).

### Binary Math

| Function | Python Operator | Optional Params |
|----------|-----------------|-----------------|
| `ct.add(x, y)` | `x + y` | `rounding_mode=`, `flush_to_zero=` |
| `ct.sub(x, y)` | `x - y` | `rounding_mode=`, `flush_to_zero=` |
| `ct.mul(x, y)` | `x * y` | `rounding_mode=`, `flush_to_zero=` |
| `ct.truediv(x, y)` | `x / y` | `rounding_mode=`, `flush_to_zero=` |
| `ct.floordiv(x, y)` | `x // y` | — |
| `ct.mod(x, y)` | `x % y` | — |
| `ct.pow(x, y)` | `x ** y` | — |
| `ct.maximum(x, y)` | `max(x, y)` | `flush_to_zero=` |
| `ct.minimum(x, y)` | `min(x, y)` | `flush_to_zero=` |
| `ct.atan2(x1, x2)` | — | — |
| `ct.cdiv(x, y)` | — | — (ceil division, works on host too) |

**Recommended**: Use Python `+, -, *, /, //, %, **` operators for all arithmetic on both tiles and scalars.
Use `ct.add`/`ct.mul`/`ct.sub`/`ct.truediv` only when you need `flush_to_zero=` or `rounding_mode=` parameters (e.g., `ct.truediv(x, y, rounding_mode=RoundingMode.APPROX)`). The `ct.*` forms may also promote int32 to float — another reason to prefer Python operators for general use.

### Conditional

| Function | Description |
|----------|-------------|
| `ct.where(cond, x, y)` | Select elements: `x` where `cond` is True, `y` otherwise |

### Missing Functions (Must Implement Manually)

| Function | Implementation |
|----------|----------------|
| `softmax(x)` | `exp_x = ct.exp(x - ct.max(x, axis=...)); exp_x / ct.sum(exp_x, axis=...)` |
| `sigmoid(x)` | `1.0 / (1.0 + ct.exp(-x))` |
| `sign(x)` | `ct.where(x > 0, 1, 0) + ct.where(x < 0, -1, 0)` |
| `flip(x, dim)` | Use manual indexing with reversed indices |
| `norm(x)` | `ct.sqrt(ct.sum(x * x))` |
| `fma(a, b, c)` | `a * b + c` (no `ct.fma` API — compiler auto-fuses to FMA instruction) |
| `clamp(x, min, max)` | `ct.minimum(ct.maximum(x, min_val), max_val)` |
| `square(x)` | `x * x` |

## Comparison Operations

All comparisons return boolean tiles and support broadcasting + dtype promotion.

| Function | Python Operator |
|----------|-----------------|
| `ct.greater(x, y)` | `x > y` |
| `ct.greater_equal(x, y)` | `x >= y` |
| `ct.less(x, y)` | `x < y` |
| `ct.less_equal(x, y)` | `x <= y` |
| `ct.equal(x, y)` | `x == y` |
| `ct.not_equal(x, y)` | `x != y` |

## Bitwise Operations

| Function | Python Operator |
|----------|-----------------|
| `ct.bitwise_and(x, y)` | `x & y` |
| `ct.bitwise_or(x, y)` | `x \| y` |
| `ct.bitwise_xor(x, y)` | `x ^ y` |
| `ct.bitwise_lshift(x, y)` | `x << y` |
| `ct.bitwise_rshift(x, y)` | `x >> y` |
| `ct.bitwise_not(x)` | `~x` |

## Atomic Operations

All atomic operations follow the same index convention as `ct.gather`/`ct.scatter`.

| Function | Description |
|----------|-------------|
| `ct.atomic_add(arr, indices, update, *, check_bounds=True, memory_order=ACQ_REL, memory_scope=DEVICE)` | Atomic add, returns old value |
| `ct.atomic_max(arr, indices, update, *, ...)` | Atomic max, returns old value |
| `ct.atomic_min(arr, indices, update, *, ...)` | Atomic min, returns old value |
| `ct.atomic_and(arr, indices, update, *, ...)` | Atomic bitwise AND, returns old value |
| `ct.atomic_or(arr, indices, update, *, ...)` | Atomic bitwise OR, returns old value |
| `ct.atomic_xor(arr, indices, update, *, ...)` | Atomic bitwise XOR, returns old value |
| `ct.atomic_xchg(arr, indices, update, *, ...)` | Atomic exchange, returns old value |
| `ct.atomic_cas(arr, indices, expected, desired, *, check_bounds=True, memory_order=ACQ_REL, memory_scope=DEVICE)` | Compare-and-swap, returns old value |

**Common parameters:**
- `memory_order` — `MemoryOrder.RELAXED`, `.ACQUIRE`, `.RELEASE`, `.ACQ_REL` (default)
- `memory_scope` — `MemoryScope.BLOCK`, `.DEVICE` (default), `.SYS`
- `check_bounds` — If `True` (default), OOB indices are skipped

## Debug & Utility Functions

| Function | Description |
|----------|-------------|
| `ct.printf(format, *args)` | C-printf style device print (tiles only). **Debug only — significant overhead.** |
| `ct.print(*args, sep=' ', end='\n')` | Python-style device print. Supports f-strings and positional args. **Debug only — significant overhead.** |
| `ct.assert_(cond, message=None)` | Assert all elements are True. **Debug only — significant overhead.** |
| `ct.static_eval(expr)` | Evaluate Python expression at compile time |
| `ct.static_assert(condition, message=None)` | Compile-time assertion |
| `ct.static_iter(iterable)` | Compile-time iteration (use in `for ... in ct.static_iter(...)`) |

```python
# printf example (C-style format strings)
ct.printf("value: %d", tile)
ct.printf("two tiles: %d, %f", tile_a, tile_b)

# print example (Python-style, supports f-strings)
ct.print(f"tile={tile}")
ct.print(f"x={tile:.5f}", end='')
ct.print("tile:", tile, sep='=')

# static_eval example — select tile based on compile-time condition
x_or_y = ct.static_eval(x if N % 2 == 0 else y)

# static_assert example
ct.static_assert(x.dtype == y.dtype, f"Expected {x} and {y} to have same dtype.")

# static_iter example — compile-time unrolled loop
for i in ct.static_iter(range(4)):
    ...
```

## Host Functions

| Function | Description |
|----------|-------------|
| `ct.cdiv(a, b)` | Ceiling division — works on **both host and kernel** |
| `ct.num_tiles(arr, axis, shape)` | Get number of tiles in tile space along axis |

```python
# Prefer Python arithmetic on host (simpler, no ct import needed)
grid = ((N + BLOCK - 1) // BLOCK, 1, 1)

# ct.cdiv also valid on host, but Python arithmetic is preferred
# grid = (ct.cdiv(N, BLOCK), 1, 1)

# ct.cdiv in kernel code (operates on tiles)
num_iters = ct.cdiv(K, BLOCK_K)
```

### Power-of-2 Utility
```python
def next_power_of_2(x: int) -> int:
    """Round up to nearest power of 2 (required for tile shapes)"""
    return 1 << (x - 1).bit_length()
```

## Data Types

```
ct.float16, ct.float32, ct.float64, ct.bfloat16
ct.tfloat32
ct.float8_e4m3fn, ct.float8_e5m2
ct.float8_e8m0fnu                        # 8-bit exponent-only (scale factor for mma_scaled) ⚠️ Not yet exported from cuda.tile.__init__
ct.float4_e2m1fn                         # 4-bit MX format (for mma_scaled) ⚠️ Not yet exported from cuda.tile.__init__
ct.int8, ct.int16, ct.int32, ct.int64
ct.uint8, ct.uint16, ct.uint32, ct.uint64
ct.bool_
```

## Enums

### PaddingMode (for `ct.load`)

| Value | Description |
|-------|-------------|
| `PaddingMode.UNDETERMINED` | Padding value is not determined (default) |
| `PaddingMode.ZERO` | Pad with zero |
| `PaddingMode.NEG_ZERO` | Pad with negative zero |
| `PaddingMode.NAN` | Pad with NaN |
| `PaddingMode.POS_INF` | Pad with positive infinity |
| `PaddingMode.NEG_INF` | Pad with negative infinity |

### RoundingMode (for math ops)

| Value | Description |
|-------|-------------|
| `RoundingMode.RN` | Round to nearest, ties to even (default) |
| `RoundingMode.RZ` | Round towards zero (truncate) |
| `RoundingMode.RM` | Round towards negative infinity |
| `RoundingMode.RP` | Round towards positive infinity |
| `RoundingMode.FULL` | Full precision |
| `RoundingMode.APPROX` | Approximate (e.g., for `ct.tanh`) |
| `RoundingMode.RZI` | Round towards zero to nearest integer |

### MemoryOrder (for load/store and atomics)

| Value | Description |
|-------|-------------|
| `MemoryOrder.WEAK` | Weak (non-atomic) ordering (default for `ct.load`/`ct.store`) |
| `MemoryOrder.RELAXED` | No ordering guarantees |
| `MemoryOrder.ACQUIRE` | Acquire semantics |
| `MemoryOrder.RELEASE` | Release semantics |
| `MemoryOrder.ACQ_REL` | Combined acquire + release (default for atomics) |

### MemoryScope (for load/store and atomics)

| Value | Description |
|-------|-------------|
| `MemoryScope.NONE` | No memory scope; used with `MemoryOrder.WEAK` (default for `ct.load`/`ct.store`) |
| `MemoryScope.BLOCK` | Ordering within same block |
| `MemoryScope.DEVICE` | Ordering across all threads on GPU (default for atomics) |
| `MemoryScope.SYS` | Ordering across entire system (multi-GPU + host) |

### ByTarget (for kernel hints)

```python
from cuda.tile import ByTarget

# Different values per GPU architecture
@ct.kernel(num_ctas=ByTarget(sm_100=8, sm_120=4, default=2))
def kernel_fn(x):
    ...
```

## Launch Pattern

```python
# Grid can be 1-tuple, 2-tuple, or 3-tuple
grid = ((N + BLOCK - 1) // BLOCK,)    # 1D grid — OK
grid = (grid_m, grid_n)               # 2D grid — OK
grid = (grid_m, grid_n, 1)            # 3D grid — OK

ct.launch(torch.cuda.current_stream(), grid, kernel, (x, y, BLOCK, n))
```

**`ct.launch` signature:** `launch(stream, grid, kernel, kernel_args)`
- `stream` — CUDA stream (e.g., `torch.cuda.current_stream()`)
- `grid` — Tuple of 1, 2, or 3 ints
- `kernel` — Function decorated with `@ct.kernel`
- `kernel_args` — Tuple of arguments to pass to the kernel


## Kernel Compilation Hints

`ct.kernel` accepts optional hints that affect compilation and scheduling:

```python
@ct.kernel(num_ctas=2, occupancy=4)
def kernel(X, Y, BLOCK: ct.Constant[int]):
    ...

# Or with ByTarget for architecture-specific values:
@ct.kernel(num_ctas=ct.ByTarget(sm_100=2), occupancy=ct.ByTarget(sm_100=4))
def kernel(X, Y, BLOCK: ct.Constant[int]):
    ...
```

| Hint | Description | Default | Range |
|------|-------------|---------|-------|
| `num_ctas` | Number of CTAs in a CGA | None (auto) | Power of 2, 1–16 |
| `occupancy` | Expected active CTAs per SM | None (auto) | 1–32 |
| `opt_level` | Optimization level | 3 | 0–3 |

**Note:** `occupancy` CAN be passed directly to `@ct.kernel`, but for production code with autotuning, passing it via `hints_fn` in `autotune_launch` is the recommended approach:
```python
# Direct (simple cases):
@ct.kernel(occupancy=4)
def kernel(...): ...

# Via autotune (production):
ct_experimental.autotune_launch(
    stream, grid_fn=..., kernel=kernel, args_fn=...,
    hints_fn=lambda cfg: {"num_ctas": cfg.num_ctas, "occupancy": cfg.occupancy},
    search_space=configs,
)
```

---

## Critical Rules (The 18 Rules)

### Rule 1: Import Statement
```python
import cuda.tile as ct  # NOT import cutile as ct!
```

### Rule 2: Index = Block Index, NOT Element Offset
```python
# cuTile uses block index for TMA, or computed indices for gather
x = ct.load(X, index=(bid,), shape=(BLOCK,))
# OR
indices = bid * BLOCK + ct.arange(BLOCK, dtype=ct.int32)
x = ct.gather(X, indices, check_bounds=True)
```

### Rule 3: Python Operators for Index Math
```python
# WRONG — ct.add/ct.mul promote int32 to float
indices = ct.add(ct.mul(bid, BLOCK), ct.arange(BLOCK, dtype=ct.int32))

# CORRECT — use Python +, *, /
indices = bid * BLOCK + ct.arange(BLOCK, dtype=ct.int32)
```

### Rule 4: ct.mma — acc is Positional
```python
# Both forms are correct:
acc = ct.mma(a, b, acc)       # positional — OK
acc = ct.mma(a, b, acc=acc)   # keyword — also OK
```

### Rule 5: No None in ct.launch()
```python
# WRONG
ct.launch(stream, grid, kernel, (x, None, n))

# CORRECT
dummy = torch.zeros(1, device=x.device)
ct.launch(stream, grid, kernel, (x, dummy, n))
```

### Rule 6: Prefer Python Arithmetic on Host; Use ct.cdiv() in Kernel
```python
# Host — prefer Python arithmetic:
grid = ((N + BLOCK - 1) // BLOCK, 1, 1)  # preferred
# grid = (ct.cdiv(N, BLOCK), 1, 1)       # also valid, but Python is simpler

# Kernel — ct.cdiv() operates on tiles:
num_iters = ct.cdiv(K, BLOCK_K)
```

### Rule 7: ct.astype(), Not .to() or .cast()
```python
# WRONG
y = x.to(ct.float32)

# CORRECT — function form
y = ct.astype(x, ct.float32)
# CORRECT — method form (preferred for chaining)
y = x.astype(ct.float32)
# CORRECT — chained on load
tile = ct.load(X, index=(bid,), shape=(BLOCK,)).astype(ct.float32)
```

### Rule 8: Helper Functions - No @ct.kernel
```python
# WRONG
@ct.kernel
def helper(x): return ct.exp(x)

# CORRECT - plain function
def helper(x): return ct.exp(x)

@ct.kernel
def main_kernel(X, Y, N: ConstInt):
    y = helper(x)
```

### Rule 9: Pre-define Variables Before Branches
```python
# WRONG — Variable only defined in one branch
if condition:
    result = ct.zeros((M,), dtype=ct.float32)
    result = ct.load(X, ...)
else:
    # result is undefined here!
    pass
output = result  # ERROR: result may not exist

# CORRECT — Pre-define ALL variables used across branches
result = ct.zeros((M,), dtype=ct.float32)  # Pre-define before branch
if condition:
    result = ct.load(X, ...)
else:
    result = ct.zeros((M,), dtype=ct.float32)
output = result  # OK: always defined
```

### Rule 10: No break/continue in Loops
```python
# WRONG
for i in range(N):
    if condition: break

# CORRECT - use conditionals
for i in range(N):
    if not condition:
        # loop body
```

### Rule 11: Grid Must Be Tuple (1, 2, or 3 elements)
```python
# WRONG
grid = N // BLOCK          # bare int
grid = [N // BLOCK, 1, 1]  # list

# CORRECT — tuple of 1, 2, or 3 ints
grid = ((N + BLOCK - 1) // BLOCK,) # 1-tuple
grid = (grid_m, grid_n)            # 2-tuple
grid = (grid_m, grid_n, 1)         # 3-tuple
```

### Rule 12: ct.arange Starts at 0
```python
# ct.arange(N) produces [0, 1, ..., N-1] — always starts at 0, no start param
offs = ct.arange(BLOCK, dtype=ct.int32)
```

### Rule 13: NHWC Tensors - Use tensor.stride()
```python
# WRONG: Assumes NCHW layout
offset = n * C * H * W + c * H * W + h * W + w  # WRONG for NHWC!

# CORRECT: Use actual strides from tensor
stride_n, stride_c, stride_h, stride_w = tensor.stride()
offset = n * stride_n + c * stride_c + h * stride_h + w * stride_w

# CRITICAL: tensor.view(-1) MAY REORDER DATA for non-contiguous!
# WRONG
flat = nhwc_tensor.view(-1)  # May silently reorder!

# CORRECT - Use torch.as_strided()
flat = torch.as_strided(tensor, (tensor.numel(),), (1,), storage_offset=tensor.storage_offset())
```

### Rule 14: Block > Dim Masking - Apply ct.where AFTER gather
```python
# When BLOCK_SIZE > actual dimension size
# WRONG - No mask applied
offsets = ct.arange(BLOCK_C, dtype=ct.int32)
data = ct.gather(input, base + offsets)
sum_val = ct.sum(data, axis=0)  # WRONG: includes padding!

# CORRECT - Use gather's mask parameter
offsets = ct.arange(BLOCK_C, dtype=ct.int32)
mask = offsets < actual_C
data = ct.gather(input, base + offsets, mask=mask, padding_value=0)
sum_val = ct.sum(data, axis=0)  # Correct!

# Alternative - Mask AFTER gather with ct.where
data = ct.gather(input, base + offsets)
data = ct.where(mask, data, ct.zeros((BLOCK_C,), dtype=data.dtype))
sum_val = ct.sum(data, axis=0)  # Correct!

# CRITICAL: Divide by actual_size, NOT BLOCK_SIZE
mean = sum_val / actual_C  # Correct
mean = sum_val / BLOCK_C   # WRONG!
```

### Rule 15: Masked Scatter — Use mask= or Out-of-Bounds Offsets
```python
# ct.scatter now supports mask= parameter!

# PREFERRED: Use scatter's mask parameter directly
offsets = ct.arange(BLOCK, dtype=ct.int32)
mask = offsets < actual_size
ct.scatter(Y, offsets, data, mask=mask)  # Masked elements are skipped

# ALTERNATIVE: Out-of-bounds offsets (ct.scatter skips OOB indices when check_bounds=True)
ARRAY_SIZE = Y.numel()  # Pass as kernel arg
oob_offset = ct.full((BLOCK,), ARRAY_SIZE, dtype=ct.int32)
offsets_masked = ct.where(mask, offsets, oob_offset)
ct.scatter(Y, offsets_masked, data)  # OOB positions skipped!
```

### Rule 16: Constant Types — No Strings
```python
# ct.Constant works with int, float, bool — but NOT str
# WRONG
@ct.kernel
def kernel(X, MODE: ct.Constant[str]):  # ERROR: str not supported!
    if MODE == "relu":
        ...

# CORRECT — Use integer enum
RELU = 0
GELU = 1
@ct.kernel
def kernel(X, MODE: ct.Constant[int]):
    if MODE == RELU:
        ...

# float and bool constants are also fine:
@ct.kernel
def kernel(X, SCALE: ct.Constant[float], USE_BIAS: ct.Constant[bool]):
    ...
```

### Rule 17: Shape Args to ct.full/ct.zeros/ct.ones Must Be Static
```python
# ct.full / ct.zeros / ct.ones shape arguments must be compile-time constants.
# WRONG — X.shape is dynamic, cannot be used as shape arg to ct.full
@ct.kernel
def kernel(X, N: ct.Constant[int]):
    result = ct.full(X.shape, 0.0, dtype=ct.float32)  # ERROR!

# CORRECT — Use compile-time constant
@ct.kernel
def kernel(X, N: ct.Constant[int], BLOCK: ct.Constant[int]):
    result = ct.full((BLOCK,), 0.0, dtype=ct.float32)  # OK: BLOCK is constexpr

# NOTE: X.shape IS fine for arithmetic, loop bounds, and comparisons:
@ct.kernel
def kernel(X, BLOCK: ct.Constant[int]):
    mask = ct.arange(BLOCK, dtype=ct.int32) < X.shape[0]  # OK!
    num_iters = ct.cdiv(X.shape[0], BLOCK)                 # OK!
```

### Rule 18: No Dead Code
```python
# cuTile compiles ALL parameters. Unused params waste registers and may cause errors.
# WRONG
@ct.kernel
def kernel(X, Y, Z, UNUSED: ct.Constant[int]):  # UNUSED wastes a register
    x = ct.load(X, ...)
    ct.store(Y, ...)
    # Z and UNUSED are never used!

# CORRECT — Remove unused parameters
@ct.kernel
def kernel(X, Y):
    x = ct.load(X, ...)
    ct.store(Y, ...)
```
