# cuTile → Triton API Mapping

## Contents

 [Import & Decorator](#import--decorator)
 [Indexing](#indexing)
 [Memory Operations](#memory-operations)
 [Tensor Creation](#tensor-creation)
 [Reductions](#reductions)
 [Matrix Operations](#matrix-operations)
 [Type Operations](#type-operations)
 [Math Operations](#math-operations)
 [Comparison & Logic](#comparison--logic)
 [Bitwise Operations](#bitwise-operations)
 [Debug Operations](#debug-operations)
 [Atomic Operations](#atomic-operations)
 [Synchronization](#synchronization)
 [Host Functions](#host-functions)
 [Data Types](#data-types)
 [Launch Patterns](#launch-patterns)
 [cuTile → Triton Gotchas](#cutile--triton-gotchas)
 [Quick Reference Card](#quick-reference-card)
 [TensorDescriptor Pattern (ct.load/ct.store → Triton TMA)](#tensordescriptor-pattern-ctloadctstore--triton-tma)
 [Multi-dimensional Indexing](#multi-dimensional-indexing)
 [Array.slice → Triton (Ragged Tensors)](#arrayslice--triton-ragged-tensors)
 [ct.gather().item() → Triton (Runtime Index TMA)](#ctgatheritem--triton-runtime-index-tma)

This document provides **cuTile → Triton** mappings for converting `@ct.kernel` code to `@triton.jit`. Source column is cuTile; target column is Triton.

---

## Import & Decorator

| cuTile | Triton | Notes (c2t) |
|--------|--------|-------------|
| N/A | `import triton` | Add top-level triton import in Triton file |
| `import cuda.tile as ct` | `import triton.language as tl` | **Replace** ct with tl; remove cuda.tile |
| `@ct.kernel` | `@triton.jit` | Symmetric |
| `BLOCK: ct.Constant[int]` | `BLOCK: tl.constexpr` | Symmetric (ConstInt → constexpr) |

---

## Indexing

| cuTile | Triton | Notes (c2t) |
|--------|--------|-------------|
| `ct.bid(axis)` | `tl.program_id(axis)` | Symmetric |
| `ct.num_blocks(axis)` | `tl.num_programs(axis)` | Symmetric |
| `ct.arange(N, dtype=ct.int32)` | `tl.arange(0, N)` | **Triton has start param:** use `0, N`; drop `dtype=` (Triton infers) |

---

## Memory Operations

### ct.load / ct.store → Triton

**⚠️ TMA for 2D+ loads:** cuTile uses **TMA** internally for block-aligned 2D+ loads. Converting to **raw** `tl.load(ptr + offs, mask=m)` for 2D+ tile shapes causes **500%-2000% (5-20x) regression**. For any load with **2D+ block shape** (e.g. GEMM tiles, attention tiles), use **TMA**: `tl.make_tensor_descriptor(...).load([...])` — see [TensorDescriptor Pattern](#tensordescriptor-pattern-ctloadctstore--triton-tma). Use raw ptr+mask only for 1D or truly scattered access.

cuTile uses **block index** in `ct.load(arr, index=(...), shape=(...))`. Triton uses **element offset** (`ptr + offs`), **block ptr**, or **TMA tensor descriptor**. When converting:

| cuTile | Triton | Notes (c2t) |
|--------|--------|-------------|
| `ct.load(arr, index=(...), shape=(...))` **1D** | `tl.load(ptr + offs, mask=m)` or block_ptr | **Index is block index in cuTile;** compute element offset: `offs = bid * BLOCK + tl.arange(0, BLOCK)` |
| `ct.load(arr, index=(i,j,...), shape=(BM,BK,...))` **2D+** | **TMA:** `tl.make_tensor_descriptor(base, shape, strides, block_shape).load([...])` | **Do NOT use** `tl.load(ptr+offs, mask=m)` for 2D+ block loads — 5-20x regression |
| `ct.store(arr, index=(...), tile=val)` (1D) | `tl.store(ptr + offs, val, mask=m)` or block_ptr + store | Same: convert block index → ptr + offset |
| `ct.store(arr, index=(...), tile=val)` (2D+) | **TMA:** descriptor `.store([...], val)` | Use TMA for 2D+ block stores |
| `ct.load(arr, index=(...), shape=(...))` (block-aligned) | `tl.make_tensor_descriptor` + `.load([...])` or block_ptr | Prefer TMA for 2D+ (see TensorDescriptor section) |
| Loop variable in `index=` | `tl.advance(block_ptr, (delta_m, delta_n))` or TMA with offset args | Reintroduce advance when you have a loop over blocks |

### Gather/Scatter → Pointer load/store

| cuTile (Fallback) | Triton | When |
|-------------------|--------|------|
| `ct.gather(arr, indices, check_bounds=True, padding_value=v)` | `tl.load(ptr + offs, mask=m, other=v)` | Truly sparse random access |
| `ct.scatter(arr, indices, val, check_bounds=True)` | `tl.store(ptr + offs, val, mask=m)` | Truly sparse random access |

**Critical:** In Triton, `tl.load(ptr + offs, ...)` uses **element offset** `offs`, not block index. Build `offs` from `tl.program_id(axis)` and `tl.arange(0, BLOCK)` (and strides).

---

## Tensor Creation

| cuTile | Triton | Notes (c2t) |
|--------|--------|-------------|
| `ct.zeros(shape, dtype)` | `tl.zeros(shape, dtype)` | Symmetric |
| `ct.full(shape, val, dtype)` | `tl.full(shape, val, dtype)` | Symmetric |
| `ct.full(shape, 1, dtype)` | `tl.full(shape, 1.0, dtype)` | Triton can use 1.0; no `tl.ones()` either |

---

## Reductions

| cuTile | Triton | Notes (c2t) |
|--------|--------|-------------|
| `ct.sum(x, axis=0)` | `tl.sum(x, axis=0)` | Symmetric |
| `ct.max(x, axis=0)` | `tl.max(x, axis=0)` | Symmetric |
| `ct.min(x, axis=0)` | `tl.min(x, axis=0)` | Symmetric |
| `ct.argmax(x, axis=0)` | `tl.argmax(x, axis=0)` | Symmetric |
| `ct.argmin(x, axis=0)` | `tl.argmin(x, axis=0)` | Symmetric |

---

## Matrix Operations

| cuTile | Triton | Notes (c2t) |
|--------|--------|-------------|
| `ct.matmul(a, b)` | `tl.dot(a, b)` | Symmetric |
| `ct.mma(a, b, acc=acc)` | `tl.dot(a, b, acc)` | **Drop `acc=` keyword** in Triton (positional only) |
| Explicit tf32 guard + `ct.mma` | `tl.dot(a, b, allow_tf32=True)` (default) | Triton auto-casts fp32→tf32; you can omit guard or set `allow_tf32=False` for full fp32 |

### float32 → tf32 in Triton

In cuTile you may have:

```python
a_mma = ct.astype(a, ct.tfloat32) if a.dtype == ct.float32 else a
b_mma = ct.astype(b, ct.tfloat32) if b.dtype == ct.float32 else b
acc = ct.mma(a_mma, b_mma, acc=acc)
```

In Triton, default behavior already matches:

```python
# Triton: allow_tf32=True by default
acc = tl.dot(a, b, acc=acc)
```

Use `allow_tf32=False` only if you need strict IEEE float32.

---

## Type Operations

| cuTile | Triton | Notes (c2t) |
|--------|--------|-------------|
| `ct.astype(x, dtype)` | `x.to(dtype)` | **Use `.to(dtype)`** in Triton; no ct.astype |
| `ct.transpose(x)` | `x.T` or `tl.trans(x)` | Symmetric |
| `ct.reshape(x, shape)` | `tl.reshape(x, shape)` or `tl.view(x, shape)` | Symmetric |
| `ct.broadcast_to(x, shape)` | `tl.broadcast_to(x, shape)` | Symmetric |
| `ct.expand_dims(x, axis)` | `tl.expand_dims(x, axis)` | Symmetric |

---

## Math Operations

| cuTile | Triton | Notes (c2t) |
|--------|--------|-------------|
| `ct.exp(x)` | `tl.exp(x)` | Symmetric |
| `ct.exp2(x)` | `tl.exp2(x)` | Symmetric |
| `ct.log(x)` | `tl.log(x)` | Symmetric |
| `ct.log2(x)` | `tl.log2(x)` | Symmetric |
| `ct.sqrt(x)` | `tl.sqrt(x)` | Symmetric |
| `ct.rsqrt(x)` | `tl.rsqrt(x)` | Symmetric |
| `ct.sin(x)` / `ct.cos(x)` | `tl.sin(x)` / `tl.cos(x)` | Symmetric |
| `ct.abs(x)` | `tl.abs(x)` | Symmetric |
| `ct.maximum(a, b)` / `ct.minimum(a, b)` | `tl.maximum(a, b)` / `tl.minimum(a, b)` | Symmetric |
| `ct.sigmoid(x)` | `tl.sigmoid(x)` | Symmetric |
| `ct.softmax(x, axis)` | `tl.softmax(x, axis)` | Symmetric |
| `ct.floor(x)` / `ct.ceil(x)` | `tl.floor(x)` / `tl.ceil(x)` | Symmetric |
| `ct.fma(a, b, c)` | `tl.fma(a, b, c)` | Symmetric |
| `ct.clamp(x, min, max)` | `tl.clamp(x, min, max)` | Symmetric |

### Index Arithmetic

| cuTile | Triton | Notes (c2t) |
|--------|--------|-------------|
| `a + b` (Python) | `a + b` (Python) | Keep using Python `+`, `*`, `//` for index math |
| `ct.add(a, b)` / `ct.mul(a, b)` | N/A | **Do not** use tl.add/tl.mul for indices; use Python ops (ct promotes to float) |

---

## Comparison & Logic

| cuTile | Triton | Notes (c2t) |
|--------|--------|-------------|
| `ct.where(cond, x, y)` | `tl.where(cond, x, y)` | Symmetric |
| `x == y`, `x < y` (Python) | `x == y`, `x < y` (Python) | Symmetric |

---

## Bitwise Operations

| cuTile | Triton | Notes (c2t) |
|--------|--------|-------------|
| `x & y`, `x \| y`, `x ^ y`, `~x`, `x << n`, `x >> n` | Same (Python) | Symmetric |
| `ct.sum(x ^ y, axis)` (manual) | `tl.xor_sum(x, axis)` | Triton has built-in xor_sum |

---

## Debug Operations

| cuTile | Triton | Notes (c2t) |
|--------|--------|-------------|
| `ct.printf(fmt, *args)` | `tl.device_print(prefix, x)` | Triton uses prefix + value(s), not C-style format |
| `ct.assert_(cond)` | `tl.device_assert(cond, msg)` | Triton allows an optional message |
| N/A | `tl.static_print(...)` | Triton-only |
| N/A | `tl.static_assert(cond)` | Triton-only |

```python
# cuTile
ct.printf("value: %f\n", x)
ct.assert_(x > 0)

# Triton
tl.device_print("value", x)
tl.device_assert(x > 0, "x must be positive")
```

---

## Atomic Operations

| cuTile | Triton | Notes (c2t) |
|--------|--------|-------------|
| `ct.atomic_add(arr, indices, val)` | `tl.atomic_add(ptr, val, mask)` | Triton uses ptr + mask; build ptr from base + indices |
| `ct.atomic_max(arr, indices, val)` | `tl.atomic_max(ptr, val, mask)` | Same |
| `ct.atomic_min(arr, indices, val)` | `tl.atomic_min(ptr, val, mask)` | Same |
| `ct.atomic_cas(arr, indices, cmp, val)` | `tl.atomic_cas(ptr, cmp, val)` | Same |
| `ct.atomic_xchg(arr, indices, val)` | `tl.atomic_xchg(ptr, val)` | Same |
| `ct.atomic_and` / `ct.atomic_or` | `tl.atomic_and` / `tl.atomic_or` | Same pattern |

---

## Synchronization

| cuTile | Triton | Notes (c2t) |
|--------|--------|-------------|
| `ct.barrier()` | `tl.debug_barrier()` | Symmetric |

---

## Host Functions

| cuTile | Triton | Notes (c2t) |
|--------|--------|-------------|
| `(a + b - 1) // b` (host) | `triton.cdiv(a, b)` | **Prefer** `triton.cdiv` in Triton host code |
| `1 << (n-1).bit_length()` | `triton.next_power_of_2(n)` | Optional; Triton has built-in |
| `ct.launch(stream, grid, kernel, args)` | `kernel［grid］(kernel_args)` | **Replace** with bracket launch; no stream in call |
| Grid must be 3-tuple | Grid can be tuple or **lambda** | You can use `grid = lambda meta: (...)` in Triton |
| Dummy tensor + flag (no None) | `None` allowed in args | You can simplify to `None` in Triton if desired |

---

## Data Types

| cuTile | Triton | Notes (c2t) |
|--------|--------|-------------|
| `ct.float16` | `tl.float16` | Symmetric |
| `ct.float32` | `tl.float32` | Symmetric |
| `ct.float64` | `tl.float64` | Symmetric |
| `ct.bfloat16` | `tl.bfloat16` | Symmetric |
| `ct.int8` … `ct.int64` | `tl.int8` … `tl.int64` | Symmetric |
| `ct.uint8` … `ct.uint64` | `tl.uint8` … `tl.uint64` | Symmetric |
| `ct.bool_` | `tl.int1` | Symmetric |

---

## Launch Patterns

### cuTile (source) → Triton (target)

```python
# cuTile
grid = ((N + BLOCK - 1) // BLOCK, 1, 1)
ct.launch(torch.cuda.current_stream(), grid, kernel, (x, y, N, BLOCK))

# Triton
grid = (triton.cdiv(N, BLOCK),)
kernel［grid］(x_ptr, y_ptr, N, BLOCK=256)
```

```python
# cuTile 2D
grid = ((M + BLOCK_M - 1) // BLOCK_M, (N + BLOCK_N - 1) // BLOCK_N, 1)
ct.launch(stream, grid, kernel, (a, b, c, M, N, K, BLOCK_M, BLOCK_N))

# Triton 2D (tuple or lambda)
grid = (triton.cdiv(M, BLOCK_M), triton.cdiv(N, BLOCK_N))
kernel［grid］(a_ptr, b_ptr, c_ptr, M, N, K, BLOCK_M=64, BLOCK_N=64)

# Triton lambda (e.g. autotune)
grid = lambda meta: (triton.cdiv(M, meta['BLOCK_M']), triton.cdiv(N, meta['BLOCK_N']))
kernel［grid］(...)
```

---

## cuTile → Triton Gotchas

1. **Import:** `import cuda.tile as ct` → `import triton.language as tl` (and add `import triton` if needed).
2. **TMA for 2D+ loads (critical):** cuTile uses TMA for block-aligned 2D+ loads. In Triton you **must** use `tl.make_tensor_descriptor(...).load([...])` (see [TensorDescriptor Pattern](#tensordescriptor-pattern-ctloadctstore--triton-tma)). Do **not** convert 2D+ `ct.load(arr, index=, shape=)` to raw `tl.load(ptr + offs, mask=...)` — that causes **500%-2000% (5-20x) regression**.
3. **Loop index → advance:** Loop variable in `ct.load(index=)` → express as loop with `tl.advance(ptr, delta)` in Triton.
4. **Gather/scatter → pointer:** `ct.gather`/`ct.scatter` → `tl.load`/`tl.store` with `ptr + offs` and mask.
5. **Type cast:** `ct.astype(x, dtype)` → `x.to(dtype)`.
6. **Matrix multiply:** `ct.mma(a, b, acc=acc)` → `tl.dot(a, b, acc)` (no `acc=` keyword).
7. **Arange:** `ct.arange(N, dtype=ct.int32)` → `tl.arange(0, N)`.
8. **Grid:** Replace fixed 3-tuple and `ct.launch(stream, grid, kernel, args)` with `grid = (...)` or `lambda meta: (...)` and `kernel［grid］(kernel_args)`.
9. **None args:** Dummy tensor + flag in cuTile → you can use `None` in Triton kernel args if the kernel supports it.
10. **Host cdiv:** `(a + b - 1) // b` → can use `triton.cdiv(a, b)` in Triton host.
11. **Index math:** Keep using Python `+`, `*`, `//` for indices; do not use `tl.add`/`tl.mul` for index arithmetic.
12. **Kernel args:** Tensor args in cuTile → pass pointers (and shapes/strides if needed) in Triton; constexpr/Constant → `tl.constexpr`.

---

## Quick Reference Card (cuTile → Triton)

| Operation | cuTile | Triton |
|-----------|--------|--------|
| Import | `import cuda.tile as ct` | `import triton.language as tl` |
| Decorator | `@ct.kernel` | `@triton.jit` |
| Constexpr | `BLOCK: ct.Constant[int]` | `BLOCK: tl.constexpr` |
| Block ID | `ct.bid(0)` | `tl.program_id(0)` |
| Range | `ct.arange(N, dtype=ct.int32)` | `tl.arange(0, N)` |
| TMA Load (2D+) | `ct.load(arr, index=(...), shape=(...))` (2D+ block) | **Must use** `tl.make_tensor_descriptor(...).load([...])` — raw tl.load = 5-20x regression |
| TMA Store (2D+) | `ct.store(arr, index=(...), tile=v)` (2D+ block) | **Must use** descriptor `.store([...], v)` |
| Ptr Load | `ct.gather(arr, idx, check_bounds=True)` | `tl.load(ptr+offs, mask=m)` |
| Ptr Store | `ct.scatter(arr, idx, v, check_bounds=True)` | `tl.store(ptr+offs, v, mask=m)` |
| Cast | `ct.astype(x, dtype)` | `x.to(dtype)` |
| Matmul | `ct.mma(a, b, acc=acc)` | `tl.dot(a, b, acc)` |
| Launch | `ct.launch(stream, grid, kernel, args)` | `kernel［grid］(kernel_args)` |
| Cdiv (host) | `(a + b - 1) // b` | `triton.cdiv(a, b)` |

---

## TensorDescriptor Pattern (ct.load/ct.store → Triton TMA)

**Mandatory for 2D+ tile loads.** When converting cuTile block-aligned loads (`ct.load`/`ct.store` with 2D+ shape) to Triton on Hopper (SM 90+) / Blackwell, use **TensorDescriptor** (`tl.make_tensor_descriptor` + `.load`/`.store`) so Triton can use TMA. Falling back to plain `tl.load(ptr + offs, mask=...)` for 2D+ block access causes **5-20x (500%-2000%) regression**.

```python
from triton.tools.tensor_descriptor import TensorDescriptor

def supports_host_descriptor():
    return torch.cuda.get_device_capability()[0] >= 9

@triton.jit
def _maybe_make_tensor_desc(desc_or_ptr, shape, strides, block_shape):
    if isinstance(desc_or_ptr, tl.tensor_descriptor):
        return desc_or_ptr
    else:
        return tl.make_tensor_descriptor(desc_or_ptr, shape, strides, block_shape)

@triton.jit
def kernel(X, X_shape_0, X_shape_1, X_stride_0, X_stride_1, BLOCK: tl.constexpr):
    pid = tl.program_id(0)
    X_desc = _maybe_make_tensor_desc(X, shape=[X_shape_0, X_shape_1],
                                      strides=[X_stride_0, X_stride_1],
                                      block_shape=[1, BLOCK])
    tile = X_desc.load([pid, 0])
    # ... computation ...
    X_desc.store([pid, 0], tile)

# Host
def wrapper(x):
    BLOCK = 128
    grid = (x.shape[0], 1, 1)
    if supports_host_descriptor():
        desc_x = TensorDescriptor(x, shape=x.shape, strides=x.stride(), block_shape=[1, BLOCK])
    else:
        desc_x = x
    kernel［grid］(desc_x, x.shape[0], x.shape[1], x.stride(0), x.stride(1), BLOCK)
```

- Shape/stride passed as **individual scalars** to the kernel.
- Use `_maybe_make_tensor_desc` for fallback when TensorDescriptor is not available.

---

## Multi-dimensional Indexing

| cuTile | Triton | Notes (c2t) |
|--------|--------|-------------|
| `ct.gather(arr, indices)` or `ct.gather(arr, (idx0, idx1))` | `tl.load(ptr + offs, mask=m)` | Build offset from indices and strides; handle OOB with mask |
| Multi-dim indexing (OOB auto) | Manual mask when `BLOCK > actual_dim` | Triton: `mask = tl.arange(0, BLOCK) < actual_dim` |

---

## Array.slice → Triton (Ragged Tensors)

| cuTile | Triton |
|--------|--------|
| `start = ct.load(indptr, idx, shape=())` | `start = tl.load(indptr_ptr + idx)` |
| `A.slice(axis=0, start=start, stop=end)` | `ptr + start * stride` and manual extent |
| `ct.load(sliced, (tile_idx,), shape=(...))` | `tl.load(ptr + start*stride + offs)` or block_ptr over segment |
| `ct.num_tiles(sliced, axis, shape)` | `tl.cdiv(end - start, BLOCK)` |

For Array.slice ragged tensor patterns, apply the mapping above: compute `ptr + start * stride + offs` manually and use `tl.cdiv` for tile counts.

---

## ct.gather().item() → Triton (Runtime Index TMA)

| cuTile | Triton |
|--------|--------|
| `page_id = ct.gather(block_tables, (idx,), padding_value=0).item()` | `page_id = tl.load(block_tables + idx)` |
| `ct.load(k_cache, index=(page_id, ...), allow_tma=True)` | `tl.load(k_cache + page_id * stride + offs)` or block_ptr |

For paged attention TMA: load the page index with `tl.load(block_tables + idx)`, then use it as an offset into the cache tensor via `tl.make_tensor_descriptor` or manual pointer arithmetic.
