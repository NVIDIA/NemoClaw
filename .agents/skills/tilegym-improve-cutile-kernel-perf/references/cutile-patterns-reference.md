# cuTile Patterns Quick-Reference Card

**Quick-lookup tables, unique patterns, and debug reference for cuTile kernels.**

> For core API (functions, types, 18 rules): See [cutile-api-reference.md](cutile-api-reference.md)
> For advanced conversion patterns (NHWC, masking, TMA decisions, ragged tensors): See [advanced-patterns.md](../translations/advanced-patterns.md)

## Contents
- [Unique Patterns](#unique-patterns)
- [Quick Debug Reference Table](#quick-debug-reference-table)
- [Appendix: Block vs Tile Terminology](#appendix-block-vs-tile-terminology)

---

## Unique Patterns

### Scalar Extraction from Tensor

Load a single element as a scalar tile for use in multi-dim indexing:

```python
# Load single element, reshape to scalar
idx_tile = ct.load(input_ids, index=(row,), shape=(1,))
scalar_idx = ct.reshape(idx_tile, ())  # (1,) → ()

# Use scalar in multi-dim gather
embedding = ct.gather(weight_2d, (scalar_idx, col_offsets))
```

### Scalar Load (0D Tile)

```python
# Load single element as 0D tile (scalar)
scalar_val = ct.load(X, index=(0,), shape=())       # 1D array
scalar_val = ct.load(X, index=(0, 0, 0), shape=())  # 3D array
# Note: index tuple length must match source array rank
```

### Batched MMA (3D Tiles)

`ct.mma` supports 2D and 3D tiles natively. For batched matmul, load 3D tiles
and call `ct.mma` directly — no reshape needed:

```python
@ct.kernel
def matmul_batched(A, B, C, B_DIM: ConstInt, M: ConstInt, N: ConstInt, K: ConstInt,
                   BLOCK_B: ConstInt, BLOCK_M: ConstInt, BLOCK_N: ConstInt):
    bid_b, bid_m, bid_n = ct.bid(0), ct.bid(1), ct.bid(2)

    # Load 3D tiles: batch × rows/cols × contraction dim
    a_tile = ct.load(A, index=(bid_b, bid_m, 0), shape=(BLOCK_B, BLOCK_M, K))
    b_tile = ct.load(B, index=(bid_b, 0, bid_n), shape=(BLOCK_B, K, BLOCK_N))

    # mma supports 3D directly — batch dims are broadcast
    acc = ct.zeros((BLOCK_B, BLOCK_M, BLOCK_N), dtype=ct.float32)
    acc = ct.mma(a_tile, b_tile, acc=acc)

    ct.store(C, index=(bid_b, bid_m, bid_n), tile=acc)
```

For true 4D tensors (e.g. shape `(B, H, M, K)`), reshape to 3D before `ct.mma`:

```python
@ct.kernel
def matmul_4d(A, B, C, BATCH: ConstInt, HEADS: ConstInt, M: ConstInt, N: ConstInt, K: ConstInt,
              BLOCK_M: ConstInt, BLOCK_N: ConstInt):
    bid_bh, bid_m, bid_n = ct.bid(0), ct.bid(1), ct.bid(2)

    # Load 4D tiles (batch and head merged into one grid dim)
    # bid_bh indexes the flattened (BATCH * HEADS) dimension
    b_idx = bid_bh // HEADS
    h_idx = bid_bh % HEADS

    a_tile = ct.load(A, index=(b_idx, h_idx, bid_m, 0),
                     shape=(1, 1, BLOCK_M, K))         # 4D: (1, 1, BLOCK_M, K)
    b_tile = ct.load(B, index=(b_idx, h_idx, 0, bid_n),
                     shape=(1, 1, K, BLOCK_N))          # 4D: (1, 1, K, BLOCK_N)

    # Reshape 4D → 2D for mma
    a_2d = ct.reshape(a_tile, (BLOCK_M, K))             # (BLOCK_M, K)
    b_2d = ct.reshape(b_tile, (K, BLOCK_N))             # (K, BLOCK_N)

    acc = ct.zeros((BLOCK_M, BLOCK_N), dtype=ct.float32)
    acc = ct.mma(a_2d, b_2d, acc=acc)

    # Reshape back to 4D for store
    result = ct.reshape(acc, (1, 1, BLOCK_M, BLOCK_N))
    ct.store(C, index=(b_idx, h_idx, bid_m, bid_n), tile=result)
```

### Multi-dimensional Index with Reshape (4D → 2D)

```python
@ct.kernel
def attention_pattern(Q, K, V, Out,
                      batch_idx: ConstInt, head_idx: ConstInt,
                      TILE_M: ConstInt, TILE_N: ConstInt, TILE_D: ConstInt):
    bid_m = ct.bid(0)

    # Load 4D slice, reshape to 2D for computation
    q = ct.load(Q, index=(batch_idx, head_idx, bid_m, 0),
                shape=(1, 1, TILE_M, TILE_D)).reshape((TILE_M, TILE_D))

    # ... compute attention ...

    # Store back: reshape to 4D
    ct.store(Out, index=(batch_idx, head_idx, bid_m, 0),
             tile=result.reshape((1, 1, TILE_M, TILE_D)))
```

### Cross-Reference: Advanced Patterns

For detailed coverage of these patterns, see the corresponding documents linked from the SKILL.md [Reference Documents table](../SKILL.md#reference-documents):

| Pattern | Primary Source |
|---------|---------------|
| Multi-dim gather/scatter, Array.slice, paged attention TMA | `translations/advanced-patterns.md` |
| NHWC layout, block masking, masked scatter | `translations/advanced-patterns.md` + rules 13-15 in `references/cutile-api-reference.md` |
| Element-wise kernel example | `examples/01_vector_add/` |
| GEMM with TMA example | `examples/04_matmul/` |

---

## Quick Debug Reference Table

| Error Pattern | Likely Cause | Quick Fix |
|---------------|--------------|-----------|
| Only False-False passes | Missing `ct.permute()` | Add explicit permute after ct.load |
| TileSyntaxError: break | break in for loop | Use `if i < n:` wrapper |
| TileTypeError: shapes mismatch | Wrong `shape` param | `shape` = OUTPUT, not input |
| Numerical error (27%+ mismatch) | Wrong transpose logic | Use `ct.permute()`, not `order` |
| Compile error at ct.load | Element offset as index | Use `bid_m` not `bid_m*TILE_M` |
| TileTypeError: float16 padding | `padding_value=0.0` | Omit padding_value (defaults to 0) |
| AttributeError: 'cast' | Using `.cast()` | Use `ct.astype(x, dtype)` or `x.astype(dtype)` |
| TypeError: NoneType | None in ct.launch | Replace with dummy tensor |
| ModuleNotFoundError: cutile | Wrong import | Use `import cuda.tile as ct` |
| Numerical error on NHWC tensor | Wrong stride assumption | Use `tensor.stride()`, not hardcoded |
| Mean/sum off by small factor | BLOCK > actual size, no mask | Apply `ct.where(mask,...)` after gather |
| TileTypeError: mask param | ct.scatter mask syntax error | Use `ct.scatter(arr, idx, val, mask=mask)` or out-of-bounds offsets |
| Silent wrong results NHWC | `tensor.view(-1)` reorders data | Use `torch.as_strided()` instead |
| ~30% wrong values, pattern in groups | BLOCK > dim, invalid offsets overwrite adjacent | Use `ct.where(mask, offsets, oob_offset)` |
| Only first channels correct per group | Partial block scatter overwrites next block | Set invalid offsets to ARRAY_SIZE (out-of-bounds) |
| NaN in output | Division by zero or log(0) | Add numerical guards: `ct.where(x > 0, ct.log(x), 0)` |
| Large numerical errors (~1e-2) | Accumulation order differs | Use float32 accumulator: `acc = ct.zeros(..., dtype=ct.float32)` |
| Numerical mismatch with fp32 mma | CuTile `ct.mma` does not auto-cast fp32→tf32 | Guard: `a = ct.astype(a, ct.tfloat32) if a.dtype == ct.float32 else a` |
| CuTile unexpectedly slow, same algorithm | Unnecessary token dependency chains in CuTile IR | Try `CUDA_TILE_TESTING_DISABLE_TOKEN_ORDER=1`, verify correctness |
| Extremely slow (paged attn) | Using ct.gather for all loads | Use `ct.gather().item()` + `ct.load(allow_tma=True)` |
| load_pointer_tko in IR | ct.gather generating per-element loads | Extract scalar with `.item()`, use `ct.load` with runtime index |

---

## Appendix: Block vs Tile Terminology

TileGym uses mixed terminology:

| Term | Context | Meaning |
|------|---------|---------|
| `BLOCK_SIZE` / `BLOCK_M` | Legacy convention | Tile dimension size |
| `TILE_SIZE` / `TILE_M` | cuTile convention | Same as BLOCK_M |
| `ct.bid(axis)` | cuTile API | Block ID = which tile in the grid |
| `ct.num_blocks(axis)` | cuTile API | Grid size = total number of tiles |
| `ct.num_tiles(arr, axis, shape)` | cuTile API | Dynamic tile count for sliced arrays |
| `CTA` | Hardware | Cooperative Thread Array ≈ thread block |
| `num_ctas` | ct.kernel kwarg | CTAs per SM (multi-CTA kernels) |

**Convention in TileGym cuTile code:**
- Prefer `TILE_M`, `TILE_N`, `TILE_K` over `BLOCK_M`, `BLOCK_N`, `BLOCK_K`
- Both are accepted in `kernel_configs` dicts
- `ct.bid(0)` returns the tile index, despite "block" in the name
