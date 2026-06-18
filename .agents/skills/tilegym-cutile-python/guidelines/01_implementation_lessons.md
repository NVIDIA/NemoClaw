# cuTile - Implementation Lessons

## Lesson 1: Use tile index, not element index, in `ct.load`
cuTile is a tile-based programming model, so you need to use the tile index to access the data.
- Wrong code: `a = ct.load(A, index=(bid_m * BLOCK_M, k_tile), shape=(BLOCK_M, BLOCK_K))`
- Correct code: `a = ct.load(A, index=(bid_m, k_tile), shape=(BLOCK_M, BLOCK_K))`

## Lesson 2: Use tile index, not element index, in `ct.store`
The same thing applies to the store operation.
- Wrong code: `ct.store(output, index=(bid_m * BLOCK_M, bid_n * BLOCK_N), tile=acc)`
- Correct code: `ct.store(output, index=(bid_m, bid_n), tile=acc)`

## Lesson 3: Use promoted dtype for accumulators
When accumulator is used, you need to use a promoted data type. Use `ct.astype` to cast the accumulator back to the original dtype after computation.
```python
# original dtype is float16
sum = ct.full(shape, 0, dtype=ct.float32)
# do some computation
sum = ct.astype(sum, ct.float16)  # change the data type of sum back to float16
```

## Lesson 4: Use `ct.num_tiles` instead of `math.ceil`
Use `ct.num_tiles` to get the number of tiles as `math.ceil` is not allowed in a cuTile kernel.
Note that the given tile shape must be the same as the shape of the input tensor.
- Wrong code: `num_tiles = ct.num_tiles(A, axis=1, shape=(tk,))` when `A` is a 2D tensor
- Correct code: `num_tiles = ct.num_tiles(A, axis=1, shape=(tm, tk))` when `A` is a 2D tensor

## Lesson 5: `ct.astype` does not work on constants
`ct.astype` is only for tile or scalar data type, not for constant data type.
- Wrong code: `ct.astype(1.0, ct.float32)`
- Correct code: `tx = ct.astype(tx, ct.float32)`

## Lesson 6: Use `ct` namespace for dtypes
Use `ct` namespace to get the data type of the tensor in cuTile kernels.
- Such as `ct.float32`, `ct.float16`, `ct.int32` and etc.

## Lesson 7: Reshape tensors for 2D/3D matmul
Since cuTile only supports 2D and 3D matrix multiplication, you need to use reshape to convert the tensor to 2D or 3D.
```python
# A is 4D (B, M, N1, K); use distinct names N1/N2 for the two N dims.
tx = ct.load(A, index=(bid_b, bid_m, bid_n1, bid_k), shape=(BLOCK_B, BLOCK_M, BLOCK_N1, BLOCK_K))
# Reshape to 3D (B*M, N1, K) so cuTile matmul applies.
tx = ct.reshape(tx, (B * M, N1, K))
# B is 4D (B, M, K, N2).
ty = ct.load(B, index=(bid_b, bid_m, bid_k, bid_n2), shape=(BLOCK_B, BLOCK_M, BLOCK_K, BLOCK_N2))
# Reshape to 3D (B*M, K, N2).
ty = ct.reshape(ty, (B * M, K, N2))
# Matmul: (B*M, N1, K) * (B*M, K, N2) -> (B*M, N1, N2).
tz = ct.matmul(tx, ty)
# Reshape back to 4D (B, M, N1, N2).
tz = ct.reshape(tz, (B, M, N1, N2))
# Store with distinct indices for the two N dims — do NOT reuse bid_n here.
ct.store(C, index=(bid_b, bid_m, bid_n1, bid_n2), tile=tz)
```

## Lesson 8: Loop over reduction dimension for tile accumulation
Using a loop for tile accumulation is supported when memory is a problem, such as the case of matrix multiplication. The loop should iterate over the reduction dimension.
```python
# Matrix multiplication example with 3D tensors:
#   Input: A (B, M, K), B (B, K, N)
#   Output: C (B, M, N)

# Get the number of tiles along the axis 2 of the input tensor A
num_tiles = ct.num_tiles(A, axis=2, shape=(tb, tm, tk))
# Need to accumulate the result, using float32 as the accumulator type
acc = ct.full(shape=(BLOCK_B, BLOCK_M, BLOCK_N), value=0, dtype=ct.float32)
for k in range(num_tiles):
    # Create a tile from the input tensor A, the shape of the tile is (BLOCK_B, BLOCK_M, BLOCK_K)
    tx = ct.load(A, index=(bid_b, bid_m, k), shape=(BLOCK_B, BLOCK_M, BLOCK_K))
    # Create a tile from the input tensor B, the shape of the tile is (BLOCK_B, BLOCK_K, BLOCK_N)
    ty = ct.load(B, index=(bid_b, k, bid_n), shape=(BLOCK_B, BLOCK_K, BLOCK_N))
    # Do tile matrix multiplication (B, M, K) * (B, K, N) -> (B, M, N)
    acc = ct.mma(tx, ty, acc)
# Cast type to the output tensor C
acc = ct.astype(acc, C.dtype)
# Store the result
ct.store(C, index=(bid_b, bid_m, bid_n), tile=acc)
```

## Lesson 9: Constants cannot be initialized with their type
Constants in cuTile cannot be initialized with its type.
- Wrong code: `x:ct.Constant[int] = ct.Constant[int](1)`
- Correct code: `x = 1` (It is optional to omit the type annotation)

## Lesson 10: Grid size must not exceed 65535
When the problem size is large, you need to estimate the number of tiles and the block size.
The maximum total number of threads in a grid is 65535.
If the problem size is large, you need to estimate the number of tiles and the
block size to ensure the total number of threads is under 65535.

## Lesson 11: `order='F'` does not transpose — use `ct.transpose` explicitly
`ct.load(..., order='F')` does NOT transpose the tile. It compiles but produces wrong shapes or results. To transpose a 2D tile (e.g., for `ct.mma`), load it normally and then explicitly transpose.
```python
# WRONG — order='F' does not perform a real transpose:
w = ct.load(A, index=(bid_n, k), shape=(BLOCK_N, BLOCK_K), order='F')

# CORRECT — load then explicitly transpose:
w = ct.load(A, index=(bid_n, k), shape=(BLOCK_N, BLOCK_K))
w_t = ct.transpose(w)   # → (BLOCK_K, BLOCK_N)
# Alternative: ct.permute(w, (1, 0))
```
Never use `order='F'` as a substitute for an explicit transpose.

## Lesson 12: Boolean tile arithmetic is not supported
Boolean tile arithmetic is NOT supported. Always cast boolean comparison results to int32 before multiplying, or use `ct.where` with a boolean mask.
```python
# WRONG — bool * bool causes a compilation error:
valid = (idx >= 0) * (idx < SIZE)

# CORRECT — cast each comparison to int32 first:
valid = ct.astype(idx >= 0, ct.int32) * ct.astype(idx < SIZE, ct.int32)

# Alternative — use ct.where with a boolean mask:
valid_mask = (idx >= 0) & (idx < SIZE)
result = ct.where(valid_mask, tile, zero_tile)
```

## Lesson 13: Tile rank must match output tensor rank in `ct.store`
The tile passed to `ct.store` must have the same rank as the index tuple, which must equal the destination tensor's rank. When a reduction produces a tile of higher rank than needed, use `ct.reshape` to match before storing. Prefer `keepdims=True` in reductions to keep track of rank.
```python
# Example: 4D input reduced along two axes, stored to a 3D tensor
max_val = ct.max(x, axis=(2, 3), keepdims=True)   # shape (1,1,1,1) — 4D
ct.store(y, index=(bid_a, bid_b, bid_c), tile=max_val)  # WRONG — index is 3D

# CORRECT — reshape tile rank to match:
ct.store(y, index=(bid_a, bid_b, bid_c), tile=ct.reshape(max_val, (1, 1, 1)))
```

## Lesson 14: Out-of-bounds (OOB) loads and gathers need `padding_value`
Both `ct.load` (when the tile extends past the tensor) and `ct.gather` (with OOB indices) read garbage memory unless you supply a `padding_value`. Downstream arithmetic on that garbage turns into NaN and is hard to diagnose. If any OOB value is produced, you **must** pass `padding_value=...` and gate the result with a mask.

```python
# ct.load: pass padding_value whenever the tile may extend past the tensor
tx = ct.load(input, index=(m, k), shape=(BLOCK_M, BLOCK_K), padding_value=0.0)

# ct.gather: clamp indices, pass padding_value, and zero with ct.where
idx = ct.minimum(idx, DIM - 1)
tx = ct.gather(input, (..., idx, ...), padding_value=0.0)

# Use ct.where (not tile * mask) to zero padded positions:
#   NaN * 0 = NaN, but ct.where(False, NaN, 0) = 0
tx = ct.where(valid_mask, tx, zero_tile)
```

`ct.gather` and `ct.scatter` also accept an optional `mask` parameter for boolean masking, which can replace the manual clamp + `ct.where` pattern in some cases.

## Lesson 15: Python slice syntax is not supported in kernels
Python-style slice syntax (`tile[0]`, `tile[:, :, 3:4]`) is NOT supported inside cuTile kernels.
Use scalar `ct.load(tensor, index=(...), shape=())` for element access, or restructure using `ct.arange` and masking.
```python
# WRONG — slice syntax causes compilation error:
val = tile[0]
sub = tile[:, :, 3:4]

# CORRECT — use ct.load with scalar shape for element access:
val = ct.load(tensor, index=(bid_x, 0), shape=())

# CORRECT — use ct.arange + masking for sub-ranges:
idx = ct.arange(BLOCK, dtype=ct.int32) + offset
mask = idx < limit
result = ct.where(mask, tile, ct.full((BLOCK,), 0, dtype=ct.float32))
```
