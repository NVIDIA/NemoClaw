# Debugging Guide (Julia cuTile.jl)

---

## Julia-Specific Error Patterns

### Compilation Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `IRError: Unsupported function call: max` | `max(a, b)` on two tiles (non-broadcast) | Use `max.(a, b)` — broadcast dot syntax (same as regular Julia arrays) |
| `IRError: Unsupported function call: min` | Same as above for `min` | Use `min.(a, b)` |
| `IRError` or `MethodError` mentioning `IRStructurizer` | Internal compiler bug | Do not work around — write a minimal reproducer and file upstream |
| `TypeError: in typeassert, expected Tile{...}, got Tile{...}` | Type mismatch in tile operation | Check `convert(ct.Tile{T}, tile)` calls |
| `BoundsError` at launch | Wrong number of args to `ct.launch` | Verify arg count matches kernel signature exactly |
| `UndefVarError: X not defined` | Variable only defined in one `if` branch | Pre-define variable before the `if/else` |
| `UndefVarError: rsqrt not defined in Main` | `rsqrt` used without `import cuTile as ct` | Ensure `import cuTile as ct` is present; then use `rsqrt.(tile)` or `map(ct.rsqrt, tile)` |

### Runtime Errors

| Error | Cause | Fix |
|-------|-------|-----|
| Wrong numerical results, correct shapes | `ct.launch` arg order doesn't match kernel signature | Args are positional — verify order |
| Correct for first tile, wrong for subsequent tiles in loop | `ct.load` with `order` parameter has index positions not matching the remapped dimensions | **`order` remaps BOTH shape AND index** — see Critical Rule 16 |
| Wrong results at boundaries | Padding mode wrong or missing | Add `; padding_mode=ct.PaddingMode.Zero` |
| Off-by-one errors | 0-based index not converted to 1-based | Check `ct.bid`, `dims`, `ct.num_tiles` axis, `permutedims` axes |
| Silent wrong results | Column-major vs row-major mismatch | For 3D+ arrays, consider transposing layout |
| `CUDA error: illegal memory access` | Index out of bounds in gather/scatter | Check index computation and bounds |
| Stale compilation cache | Old kernel cached after editing `.jl` file | `rm -rf ~/.julia/compiled/cuTile*` to force recompilation |

For common **test failure patterns** with symptoms and fixes, see [`testing.md`](testing.md) § Common Test Failure Patterns.

---

## Debug Commands

### Running Tests

```bash
# Run all Julia tests
julia --project=julia/ julia/test/runtests.jl

# Run a single test file
julia --project=julia/ julia/test/test_<op>.jl

# With TileGym debug logging
TILEGYM_LOG_LEVEL=DEBUG julia --project=julia/ julia/test/runtests.jl

# Disable autotuning (get single config)
DISABLE_CUTILE_TUNE=1 julia --project=julia/ julia/test/test_<op>.jl
```

### Standalone Kernel Debugging

```bash
# Run a kernel file in isolation
julia --project=julia/ julia/kernels/<op>.jl

# Crash dump on failure
CUDA_TILE_ENABLE_CRASH_DUMP=1 julia --project=julia/ julia/kernels/<op>.jl
```
