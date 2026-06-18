# Critical Rules for cuTile Python → Julia Conversion

1. **1-based indexing everywhere**: `ct.bid`, `ct.num_tiles` axis, `dims` for reductions, `permutedims` axes, `ct.extract` indices, `ct.cat` axis — ALL shifted +1 from Python.

2. **`for` loops work in kernels (cuTile 0.2+)**: `for k in Int32(1):n` and `for k in Int32(0):n - Int32(1)` are fully supported. Step ranges also work: `for i in start:step:stop`. The `while` pattern still works but `for` is preferred for simple iteration.

3. **Explicit broadcasting**: Python cuTile auto-broadcasts `+`, `-`, `*`, `/` between different shapes. Julia requires `.+`, `.-`, `.*`, `./` for shape-mismatched tiles. Same-shape `+`/`-` and scalar `*`/`/` work without dots.

4. **Left-aligned broadcasting**: Julia broadcasts from dimension 1 (left), Python/NumPy from last dimension (right). A `(N,)` tile cannot broadcast with `(M, N)`. Use `reshape(a, (1, N))` first.

5. **Constants at launch, not signature**: Python annotates `param: ct.Constant[int]` in kernel signature. Julia uses plain `param::Int` in signature and wraps with `ct.Constant(val)` at the `ct.launch` call site.

6. **Kernel must return nothing**: Every Julia cuTile kernel must end with `return` or `return nothing`.

7. **Column-major memory layout**: Julia arrays are column-major. For multi-dimensional data that was row-major in Python, consider transposing the logical layout or using batch-last ordering (e.g., `(M, K, Batch)` instead of Python's `(Batch, M, K)`).

8. **Reduction keeps dims**: `sum(tile; dims=2)` produces `(M, 1)` not `(M,)`. Use `dropdims(result; dims=2)` to remove the singleton.

9. **Type names**: `ct.float32` → `Float32`, `ct.float16` → `Float16`, `ct.int32` → `Int32`, `ct.bfloat16` → `BFloat16`, `ct.tfloat32` → `ct.TFloat32`.

10. **Integer types in loops**: Loop counters and increments must have matching types. Use `Int32` consistently. Preferred: `for k in Int32(1):n` (handles types automatically). The `while` pattern also works: `k = Int32(1); while k <= n; ...; k += Int32(1); end`.

11. **`ct.launch` arg order is positional**: Kernel args after the grid in `ct.launch(kernel, grid, arg1, arg2, ...)` map 1:1 to the kernel's parameter list. If the kernel signature is `(output, input, ...)`, you MUST pass `output` first. Swapping arguments silently produces wrong results (the kernel reads from the output buffer and writes to the input buffer).

12. **Element-wise `max`/`min` between tiles**: Use `max.(a, b)` (broadcast syntax), NOT `max(a, b)`. The non-broadcast `max(a, b)` on two tiles is not supported in kernel IR and will fail with `IRError: Unsupported function call: max`. Similarly `min(a, b)` → `min.(a, b)`.

13. **IRStructurizer / compiler errors should be reported**: If you encounter `IRError`, `MethodError` mentioning `IRStructurizer.BlockArg`, or other internal compiler errors, these are bugs in the cuTile.jl compiler pipeline — do not work around them. Write a minimal reproducer and file it upstream.

14. **Tile-size limits for `ct.load`**: TMA-based `ct.load` has hardware limits on how much data can be loaded at once (~16K elements). For large tensors, use chunked or online algorithms that iterate over the data in fixed-size tiles, using either `ct.load`/`ct.store` with column indices or `ct.gather`/`ct.scatter` with index tiles.

 15. **`ct.Constant` parameters work as shape arguments**: The shape tuple in `ct.arange(N)` and `fill(val, (N,))` can use `ct.Constant` kernel parameters — cuTile.jl's const-seeded inference pipeline resolves them at compile time. Pass tile sizes as `ct.Constant(val)` at the `ct.launch` call site and use the corresponding `::Int` parameter directly in shape tuples. No `@eval` metaprogramming needed.
     ```julia
     function my_kernel(output::ct.TileArray{T, 2}, input::ct.TileArray{T, 2},
                        TILE_SIZE::Int) where {T}
         ct.@compiler_options occupancy=2
         bid = ct.bid(1)
         tile = ct.load(input; index=(bid, Int32(1)), shape=(1, TILE_SIZE))  # TILE_SIZE from ct.Constant
         # ...
     end

     ct.launch(my_kernel, grid, output_cu, input_cu, ct.Constant(tile_size))
     ```

 16. **`ct.load` `order` parameter remaps BOTH shape AND index positions**: When using `order=(2,1,...)`, the `order` defines a logical-to-physical dimension mapping that applies to **both** the shape tuple and the index tuple. If `order=(2,1,3,4)`, then index position 0 → physical array dim 1, index position 1 → physical array dim 0. **You must place tile iterators at the index position that maps to the correct physical dimension.**

     ```julia
     # Array K_jl has physical dimensions (D, S, H, B)
     # We want: tile TILE_D from D (all of it), tile TILE_N from S (iterate with j)
     # order=(2,1,3,4) maps: position 0 → physical dim 1 (S), position 1 → physical dim 0 (D)

     # ✅ CORRECT: j at position 0 (maps to S), 1 at position 1 (maps to D)
     ct.load(K_jl, (j, 1, head_idx, batch_idx), (TILE_N, TILE_D, 1, 1); order=(2,1,3,4))

     # ❌ WRONG: j at position 1 (maps to D!), 1 at position 0 (maps to S — always tile 1!)
     ct.load(K_jl, (1, j, head_idx, batch_idx), (TILE_N, TILE_D, 1, 1); order=(2,1,3,4))
     ```

     **Symptom**: First tile (j=1) produces correct results, subsequent tiles read wrong data (zeros from out-of-bounds D, or stale data from always reading the same S tile). Errors grow with loop iteration count.

 17. **`rsqrt` usage**: cuTile.jl exports `rsqrt`, so `rsqrt.(tile)` works via broadcast dot syntax. `map(ct.rsqrt, tile)` also works. For other math functions (`exp`, `log`, `sqrt`, `sin`, `cos`, `abs`), the broadcast dot syntax works fine (e.g., `exp.(tile)`) because these are in `Base`. `rsqrt` is NOT in `Base` but IS exported by cuTile.jl.
