# cuTile Python ↔ cuTile.jl (Julia) API Mapping

## Import & Setup

| Python | Julia | Notes |
|--------|-------|-------|
| `import cuda.tile as ct` | `import cuTile as ct` | Different package name |
| `import cupy as cp` | `using CUDA` | GPU array library |
| `import numpy as np` | (stdlib) | Julia has built-in arrays |
| `from math import ceil` | (builtin `cld`) | Ceiling division |

## Kernel Definition

| Python | Julia | Notes |
|--------|-------|-------|
| `@ct.kernel` | (none) | No decorator needed |
| `def kernel(a, b, c):` | `function kernel(a::ct.TileArray{T,N}, ...) where {T}` | Typed parameters |
| `param: ct.Constant[int]` | `param::Int` (+ `ct.Constant(val)` at launch) | Constant at launch, not signature |
| `param: ct.Constant[float]` | `param::Float32` (+ `ct.Constant(val)` at launch) | Same pattern |
| (implicit return) | `return` or `return nothing` | Must be explicit |

## Kernel Launch

| Python | Julia | Notes |
|--------|-------|-------|
| `ct.launch(stream, grid, kernel, (a, b, c, val))` | `ct.launch(kernel, grid, a, b, c, ct.Constant(val))` | No stream; args splatted; constants wrapped |
| `@ct.kernel(occupancy=N)` | `ct.@compiler_options occupancy=N` (in kernel body) | Replaces launch kwargs |
| `grid = (M, N, 1)` | `grid = (M, N)` or `grid = (M, N, K)` | Trailing 1s optional |
| `cp.cuda.get_current_stream()` | (implicit) | Julia uses task-bound stream |
| `cp.cuda.runtime.deviceSynchronize()` | `CUDA.synchronize()` | Explicit sync |

## Grid & Block IDs

| Python | Julia | Notes |
|--------|-------|-------|
| `ct.bid(0)` | `ct.bid(1)` | 1-indexed |
| `ct.bid(1)` | `ct.bid(2)` | 1-indexed |
| `ct.bid(2)` | `ct.bid(3)` | 1-indexed |
| `ct.num_blocks(0)` | `ct.num_blocks(1)` | 1-indexed |
| `ct.cdiv(a, b)` | `cld(a, b)` | Julia builtin |

## Memory Operations

| Python | Julia | Notes |
|--------|-------|-------|
| `ct.load(arr, index=(i,j), shape=(m,n))` | `ct.load(arr; index=(i,j), shape=(m,n))` | Keyword preferred |
| `ct.load(arr, index=(i,j), shape=(m,n), padding_mode=ct.PaddingMode.ZERO)` | `ct.load(arr; index=(i,j), shape=(m,n), padding_mode=ct.PaddingMode.Zero)` | Semicolon kwargs; `Zero` not `ZERO` |
| `ct.load(arr, index=(b,h,0,j), shape=(1,1,D,N), order=(0,1,3,2))` | `ct.load(arr; index=(b,h,j,1), shape=(N,D,1,1), order=(2,1,3,4))` | **⚠️ `order` remaps BOTH shape AND index positions** — see Critical Rule 16 |
| `ct.store(arr, index=(i,j), tile=t)` | `ct.store(arr; index=(i,j), tile=t)` | Keyword preferred |
| `ct.gather(arr, indices)` | `ct.gather(arr, indices)` | Same |
| `ct.scatter(arr, indices, tile)` | `ct.scatter(arr, indices, tile)` | Same |
| `ct.load(arr, index=bid, shape=())` | `arr[bid]` | 0-D tile → scalar indexing |
| `ct.num_tiles(A, axis=1, shape=(m,n))` | `ct.num_tiles(A, 2, (m,n))` | Axis 1-indexed |
| `A.shape[0]` | `size(A, 1)` | 1-indexed |
| `A.shape[1]` | `size(A, 2)` | 1-indexed |
| `A.dtype` | `eltype(A)` or `T` (from where clause) | Julia type system |

## Padding Modes

| Python | Julia |
|--------|-------|
| `ct.PaddingMode.ZERO` | `ct.PaddingMode.Zero` |
| `ct.PaddingMode.NAN` | `ct.PaddingMode.Nan` |
| `ct.PaddingMode.POS_INF` | `ct.PaddingMode.PosInf` |
| `ct.PaddingMode.NEG_INF` | `ct.PaddingMode.NegInf` |
| `ct.PaddingMode.NEG_ZERO` | `ct.PaddingMode.NegZero` |

## Tile Construction

| Python | Julia | Notes |
|--------|-------|-------|
| `ct.full((m,n), 0, dtype=ct.float32)` | `fill(0.0f0, (m, n))` | Base.fill overlay |
| `ct.zeros((m,n), dtype=ct.float32)` | `zeros(Float32, m, n)` | Base.zeros overlay |
| `ct.arange(N, dtype=ct.int32)` | `ct.arange(N)` | Returns 1-indexed [1,...,N], Int32 |
| `ct.ones((m,n), dtype=ct.float32)` | `ones(Float32, m, n)` | Base.ones overlay |

## Type Conversion

| Python | Julia | Notes |
|--------|-------|-------|
| `tile.astype(ct.float32)` | `convert(ct.Tile{Float32}, tile)` | — |
| `ct.astype(tile, ct.float32)` | `convert(ct.Tile{Float32}, tile)` | — |
| `tile.astype(ct.tfloat32)` | `convert(ct.Tile{ct.TFloat32}, tile)` | TFloat32 type |
| `ct.astype(acc, C.dtype)` | `convert(ct.Tile{T}, acc)` | Use type parameter |

## Type Names

| Python | Julia |
|--------|-------|
| `ct.float16` | `Float16` |
| `ct.float32` | `Float32` |
| `ct.float64` | `Float64` |
| `ct.bfloat16` | `BFloat16` |
| `ct.tfloat32` | `ct.TFloat32` |
| `ct.int8` | `Int8` |
| `ct.int16` | `Int16` |
| `ct.int32` | `Int32` |
| `ct.int64` | `Int64` |
| `ct.uint8` | `UInt8` |
| `ct.uint16` | `UInt16` |
| `ct.uint32` | `UInt32` |
| `ct.uint64` | `UInt64` |
| `ct.bool_` / `bool` | `Bool` |

## Arithmetic & Element-wise

| Python | Julia | Notes |
|--------|-------|-------|
| `a + b` (same shape) | `a + b` | Same |
| `a + b` (different shape) | `a .+ b` | Must use broadcast dot |
| `a - b` (same shape) | `a - b` | Same |
| `a * scalar` | `a * scalar` | Same |
| `a / scalar` | `a / scalar` | Same |
| `a * b` (element-wise) | `a .* b` | Broadcast; `a * b` is matmul! |
| `a / b` (element-wise) | `a ./ b` | Broadcast |
| `a ** 2` | `a .^ 2` or `a .^ 2.0f0` | Broadcast |
| `-tile` | `.-tile` or broadcast neg | — |

## Comparisons & Logic

| Python | Julia |
|--------|-------|
| `a < b` | `a .< b` |
| `a > b` | `a .> b` |
| `a <= b` | `a .<= b` |
| `a >= b` | `a .>= b` |
| `a == b` | `a .== b` |
| `a != b` | `a .!= b` |

## Math Functions

| Python | Julia | Notes |
|--------|-------|-------|
| `ct.exp(tile)` | `exp.(tile)` | Broadcast syntax |
| `ct.exp2(tile)` | `exp2.(tile)` | — |
| `ct.log(tile)` | `log.(tile)` | — |
| `ct.log2(tile)` | `log2.(tile)` | — |
| `ct.sqrt(tile)` | `sqrt.(tile)` | Base function — safe everywhere |
| `ct.rsqrt(tile)` | `rsqrt.(tile)` | cuTile.jl exports `rsqrt` — broadcast dot works. `map(ct.rsqrt, tile)` also works. |
| `ct.abs(tile)` | `abs.(tile)` | Base function — safe everywhere |
| `ct.sin(tile)` | `sin.(tile)` | — |
| `ct.cos(tile)` | `cos.(tile)` | — |
| `ct.fma(a, b, c)` | `fma.(a, b, c)` | — |
| `ct.negative(tile)` | `(-).(tile)` or `.-(tile)` | Negate |
| `ct.maximum(a, b)` (element-wise) | `max.(a, b)` | Element-wise max |
| `ct.minimum(a, b)` (element-wise) | `min.(a, b)` | Element-wise min |

## Reductions

| Python | Julia | Notes |
|--------|-------|-------|
| `ct.sum(tile, axis=0)` | `sum(tile; dims=1)` | Axis +1; **keeps dim** |
| `ct.sum(tile, axis=1)` | `sum(tile; dims=2)` | Axis +1; **keeps dim** |
| `ct.max(tile, axis=0)` | `maximum(tile; dims=1)` | `max` → `maximum` |
| `ct.min(tile, axis=0)` | `minimum(tile; dims=1)` | `min` → `minimum` |
| `ct.sum(tile, axis=0, keepdims=True)` | `sum(tile; dims=1)` | Always keeps dims |
| `ct.sum(tile, axis=0, keepdims=False)` | `dropdims(sum(tile; dims=1); dims=1)` | Explicit dropdims |
| `ct.argmax(tile, axis=0)` | `argmax(tile; dims=1)` | 1-indexed result |
| `ct.argmin(tile, axis=0)` | `argmin(tile; dims=1)` | 1-indexed result |

## Scans (Prefix Operations)

| Python | Julia |
|--------|-------|
| `ct.cumsum(tile, axis=0)` | `cumsum(tile; dims=1)` |
| `ct.cumprod(tile, axis=0)` | `cumprod(tile; dims=1)` |

## Shape Operations

| Python | Julia | Notes |
|--------|-------|-------|
| `ct.reshape(tile, shape)` | `reshape(tile, shape)` | — |
| `ct.permute(tile, (0,2,1))` | `permutedims(tile, (1,3,2))` | Each axis +1 |
| `ct.transpose(tile)` | `transpose(tile)` | 2D only |
| `ct.broadcast_to(tile, shape)` | `ct.broadcast_to(tile, shape)` | Same |
| `ct.extract(tile, index=(i,j), shape=(m,n))` | `ct.extract(tile, (i+1,j+1), (m,n))` | Index 1-based |
| `ct.cat((a, b), axis=0)` | `ct.cat((a, b), 1)` | Axis +1 |
| `ct.cat((a, b), axis=-1)` | `ct.cat((a, b), -1)` | Negative OK |

## Matrix Operations

| Python | Julia | Notes |
|--------|-------|-------|
| `ct.mma(a, b, acc=acc)` | `muladd(a, b, acc)` | No keyword for acc |
| `ct.mma(a, b)` | `a * b` | No accumulator |
| `ct.matmul(W, X)` | `W * X` | `*` is matmul for 2D/3D tiles |
| (manual TF32 check) `if A.dtype == ct.float32: a = ct.astype(a, ct.tfloat32)` | `if T === Float32; a = convert(ct.Tile{ct.TFloat32}, a); end` | `===` for type comparison |

## Conditional / Selection

| Python | Julia | Notes |
|--------|-------|-------|
| `ct.where(mask, x, y)` | `ifelse.(mask, x, y)` | Broadcast ifelse |
| `ct.where(mask, tile, 0)` | `ifelse.(mask, tile, 0.0f0)` | Scalar must match type |

## Atomic Operations

| Python | Julia |
|--------|-------|
| `ct.atomic_cas(arr, idx, expected, desired, memory_order=ct.MemoryOrder.ACQUIRE)` | `ct.atomic_cas(arr, idx, expected, desired; memory_order=ct.MemoryOrder.Acquire)` |
| `ct.atomic_xchg(arr, idx, val, memory_order=ct.MemoryOrder.RELEASE)` | `ct.atomic_xchg(arr, idx, val; memory_order=ct.MemoryOrder.Release)` |
| `ct.atomic_add(arr, idx, val)` | `ct.atomic_add(arr, idx, val)` |
| `ct.MemoryOrder.ACQUIRE` | `ct.MemoryOrder.Acquire` |
| `ct.MemoryOrder.RELEASE` | `ct.MemoryOrder.Release` |
| `ct.MemoryOrder.RELAXED` | `ct.MemoryOrder.Relaxed` |

## Control Flow

| Python | Julia | Notes |
|--------|-------|-------|
| `for k in range(n):` | `for k in Int32(1):n` | cuTile 0.2 supports native `for` loops; use 1-based when `k` is a tile index for `ct.load`/`ct.store` |
| `for k in range(0, n):` | `for k in Int32(0):n - Int32(1)` | Use 0-based when `k` is used in arithmetic (e.g., `k * TILE_SIZE + offset`) |
| `if cond:` | `if cond` | Same structure |
| `if A.dtype == ct.float32:` | `if T === Float32` | Use `===` for type check |

## Host Harness

| Python | Julia | Notes |
|--------|-------|-------|
| `cp.random.rand(M, N).astype(np.float32)` | `CUDA.rand(Float32, M, N)` | — |
| `cp.random.randn(M, N).astype(np.float32)` | `CUDA.randn(Float32, M, N)` | — |
| `cp.empty((M, N), dtype=np.float32)` | `CuArray{Float32}(undef, M, N)` | — |
| `cp.zeros((M, N), dtype=np.float32)` | `CUDA.zeros(Float32, M, N)` | — |
| `cp.empty_like(a)` | `similar(a)` | — |
| `cp.asnumpy(arr)` | `Array(arr)` | GPU → CPU |
| `np.allclose(a, b, rtol=..., atol=...)` | `isapprox(a, b; rtol=..., atol=...)` | — |
| `assert ...` | `@assert ...` | — |
| CUDA event timing | `CUDA.@elapsed ct.launch(...)` | Returns seconds |
| `ceil(M / tile)` | `cld(M, tile)` | Ceiling division |
| `data["key"]` | `data.key` | Named tuple access |
| `{"key": val}` | `(; key=val)` | Named tuple literal |

## Memory Layout Considerations

Python uses **row-major** (C-order), Julia uses **column-major** (Fortran-order).

For 2D arrays, this is largely transparent since cuTile handles it via strides.

For **batched operations** (3D+), consider reordering dimensions:
- Python: `(Batch, M, K)` — batch is first (outermost in row-major)
- Julia: `(M, K, Batch)` — batch is last (outermost in column-major)

This gives optimal memory access patterns in each language.

When converting, either:
1. **Transpose the layout** (recommended for performance): change array shapes and adjust kernel indexing
2. **Keep the layout** and accept potentially suboptimal memory access patterns

## Bitwise Operations

| Python cuTile | Julia cuTile.jl |
|--------------|-----------------|
| `ct.bitwise_xor(a, b)` | `a .⊻ b` |
| `ct.bitwise_rshift(a, n)` | `a .>> n` |
| `ct.bitwise_lshift(a, n)` | `a .<< n` |
| `ct.bitwise_and(a, mask)` | `a .& mask` |
| `ct.bitwise_or(a, b)` | `a .\| b` |
| `ct.bitwise_not(a)` | `.~a` |

## 1D Element-wise Pattern (TMA load/store)

For simple 1D element-wise ops (dropout, activations), use the TMA `ct.load`/`ct.store` pattern. No `to_col_major`/`from_col_major` needed — 1D arrays have no row/col distinction.

```julia
# 1D kernel using TMA block indexing
function my_1d_kernel(x::ct.TileArray{T,1}, output::ct.TileArray{T,1},
                      BLOCK_SIZE::Int) where {T}
    bid = ct.bid(1)
    x_tile = ct.load(x; index=bid, shape=(BLOCK_SIZE,))
    # ... process ...
    ct.store(output; index=bid, tile=result_tile)
    return nothing
end
```

Host harness: flatten input, pad to `BLOCK_SIZE` multiple, launch kernel, trim output.

## 2D Persistent Scheduling Pattern (RoPE, etc.)

For row-per-block kernels with many rows, use persistent scheduling with `ct.Constant` for tile sizes:

```julia
function my_kernel(data::ct.TileArray{T,2}, TILE_HD::Int) where {T}
    ct.@compiler_options occupancy=2
    bid = ct.bid(1)
    num_programs = ct.num_blocks(1)
    n_rows = size(data, 2)
    row_idx = bid
    while row_idx <= n_rows
        tile = ct.load(data; index=(Int32(1), row_idx), shape=(TILE_HD, 1))
        # ... process row ...
        ct.store(data; index=(Int32(1), row_idx), tile=result)
        row_idx += num_programs
    end
    return
end

# Launch with ct.Constant for tile size
ct.launch(my_kernel, num_blocks, data_cu, ct.Constant(tile_hd))
```

## Kernel Patterns for Large Tensors

When a single `ct.load` of the entire data exceeds hardware limits, use one of these patterns:

### Pattern A: Column-loop with `ct.load`/`ct.store` (Online Algorithm)

Best for TMA-based kernels where each chunk is a contiguous tile along columns.
Uses `for` loops for column iteration and `ct.num_tiles` for tile count.

```julia
function online_kernel(output::ct.TileArray{T, 2}, input::ct.TileArray{T, 2},
                       TILE_SIZE::Int) where {T}
    row_idx = ct.bid(1)
    num_col_tiles = ct.num_tiles(input, 2, (1, TILE_SIZE))

    m_prev = fill(-Inf32, (1, 1))
    l_prev = zeros(Float32, 1, 1)

    for col_idx in Int32(1):num_col_tiles
        tile = ct.load(input; index=(row_idx, col_idx), shape=(1, TILE_SIZE),
                      padding_mode=ct.PaddingMode.NegInf)
        tile = convert(ct.Tile{Float32}, tile)
        tile_max = maximum(tile; dims=2)
        m_curr = max.(tile_max, m_prev)
        l_prev = l_prev .* exp.(m_prev .- m_curr)
        l_prev = sum(exp.(tile .- m_curr); dims=2) .+ l_prev
        m_prev = m_curr
    end

    for col_idx in Int32(1):num_col_tiles
        tile = ct.load(input; index=(row_idx, col_idx), shape=(1, TILE_SIZE),
                      padding_mode=ct.PaddingMode.NegInf)
        tile = convert(ct.Tile{Float32}, tile)
        result = exp.(tile .- m_prev) ./ l_prev
        ct.store(output; index=(row_idx, col_idx), tile=convert(ct.Tile{T}, result))
    end
    return
end
```

### Pattern B: Chunked with `ct.gather`/`ct.scatter` and `ct.Constant` (Preferred)

Use when you need multiple passes over column chunks. Pass tile sizes as
`ct.Constant` at launch — no `@eval` needed.

```julia
function chunked_kernel(output::ct.TileArray{T, 2}, input::ct.TileArray{T, 2},
                        n_cols::Int, TILE_SIZE::Int) where {T}
    ct.@compiler_options occupancy=4
    row_idx = ct.bid(1)
    num_chunks = (n_cols + TILE_SIZE - Int32(1)) ÷ Int32(TILE_SIZE)
    col_offsets_base = ct.arange(TILE_SIZE)
    row_tile = ct.Tile(row_idx)

    row_max = fill(-Inf32, (1,))
    denominator = zeros(Float32, TILE_SIZE)

    for chunk_idx in Int32(0):num_chunks - Int32(1)
        col_indices = ct.broadcast_to(ct.Tile(chunk_idx * Int32(TILE_SIZE)), (TILE_SIZE,)) .+ col_offsets_base
        chunk = ct.gather(input, (row_tile, col_indices); check_bounds=true, padding_value=T(-Inf))
        chunk = convert(ct.Tile{Float32}, chunk)
        row_max = max.(row_max, ct.Tile(maximum(chunk)))
    end
    # ... pass 2 and 3 similarly ...
    return
end

function julia_chunked_softmax(output::CuMatrix{T}, input::CuMatrix{T};
                               tile_size::Int=1024) where {T}
    M, N = size(input)
    ct.launch(chunked_kernel, M, output, input, ct.Constant(N), ct.Constant(tile_size))
    CUDA.synchronize()
    return
end
```

## Quick Conversion Reference

| Python cuTile | Julia cuTile.jl |
|--------------|-----------------|
| `@ct.kernel` | `function ... end` |
| `ct.bid(0)` | `ct.bid(1)` |
| `ct.num_blocks(0)` | `ct.num_blocks(1)` |
| `ct.num_tiles(A, axis=1, shape=s)` | `ct.num_tiles(A, 2, s)` |
| `A.shape[0]` | `size(A, 1)` |
| `ct.load(arr, index=i, shape=s)` | `ct.load(arr; index=i, shape=s)` |
| `ct.store(arr, index=i, tile=t)` | `ct.store(arr; index=i, tile=t)` |
| `.astype(ct.float32)` | `convert(ct.Tile{Float32}, tile)` |
| `ct.mma(a, b, acc=acc)` | `muladd(a, b, acc)` |
| `ct.where(m, x, y)` | `ifelse.(m, x, y)` |
| `ct.sum(t, axis=0)` | `sum(t; dims=1)` |
| `ct.maximum(a, b)` | `max.(a, b)` |
| `ct.exp(t)` | `exp.(t)` |
| `ct.rsqrt(t)` | `rsqrt.(t)` (cuTile.jl exports `rsqrt`; `map(ct.rsqrt, t)` also works) |
| `for k in range(n):` | `for k in Int32(1):n` |
| `ct.launch(stream, grid, kernel, (args))` | `ct.launch(kernel, grid, args...)` |
| `ct.Constant[int]` in sig | `::Int` in sig, `ct.Constant(val)` at launch |
| `ct.cdiv(a, b)` | `cld(a, b)` |
| `ct.PaddingMode.ZERO` | `ct.PaddingMode.Zero` |
| `a * b` (element-wise) | `a .* b` |
| `ct.bitwise_xor/and/or/rshift/lshift` | `a .⊻ b` / `a .& mask` / `a .\| b` / `a .>> n` / `a .<< n` |
| `floor(x)` element-wise | `floor.(tile)` — works on float tiles |
