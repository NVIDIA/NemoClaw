# Kernel Type Templates

Copy-paste autotune templates for each kernel type. All code uses the `exhaustive_search` + cache + `ct.launch` pattern from production code in the TileGym repository.

## Common Helpers

These utility functions are referenced throughout the templates. Import or define them before use:

```python
def cdiv(a: int, b: int) -> int:
    """Ceiling division: returns ceil(a / b)."""
    return (a + b - 1) // b
```

`cdiv` is available as `ct_ops.cdiv` in TileGym (`from tilegym.ops.cutile.ct_ops import cdiv`).

`swizzle_2d` applies a 2D block swizzling pattern to improve L2 cache locality for matmul:

```python
def swizzle_2d(M: int, N: int, TILE_M: int, TILE_N: int, GROUP_SIZE_M: int):
    """Returns (bidx, bidy) for swizzled 2D grid indexing. Uses ct.bid(0) internally.
    Must be called inside a @ct.kernel function (ct.bid is only valid in kernel context)."""
    bid = ct.bid(0)
    num_tiles_m = cdiv(M, TILE_M)
    num_tiles_n = cdiv(N, TILE_N)
    num_tiles_in_group = GROUP_SIZE_M * num_tiles_n
    group_id = bid // num_tiles_in_group
    first_tile_m = group_id * GROUP_SIZE_M
    group_tile_id = bid % num_tiles_in_group
    return (first_tile_m + (group_tile_id % GROUP_SIZE_M), group_tile_id // GROUP_SIZE_M)
```

This pattern is standard across production CuTile matmul kernels.

## Template 1: 1D Elementwise (SwiGLU, GeGLU, RoPE, LayerNorm, RMS LN)

**Characteristics**: Single dominant dimension, BLOCK_SIZE fixed at host side, only occupancy tuned.

### search_space

```python
from types import SimpleNamespace

def autotune_configs():
    """Standard occupancy search — shared by all elementwise kernels."""
    for occ in [1, 2, 4, 8]:
        yield SimpleNamespace(occupancy=occ)
```

### Kernel Definition

```python
import cuda.tile as ct

ConstInt = ct.Constant[int]

@ct.kernel
def _my_elementwise_kernel(
    input_data,     # flattened 1D tensor
    output_data,    # flattened 1D tensor
    n_elements: ConstInt,
    BLOCK_SIZE: ConstInt,
):
    """1D elementwise kernel with gather/scatter."""
    bid = ct.bid(0)
    offsets = bid * BLOCK_SIZE + ct.arange(BLOCK_SIZE, dtype=ct.int32)

    x = ct.gather(input_data, offsets, padding_value=0)
    # ... compute ...
    result = x  # placeholder for actual computation
    ct.scatter(output_data, offsets, result, check_bounds=True)
```

### exhaustive_search + cache + ct.launch

```python
import os
import cuda.tile as ct
import torch
from cuda.tile.tune import exhaustive_search

from .ct_ops import autotune_configs, cdiv

BLOCK_SIZE = 1024  # Determined by sweep benchmark on B200

# Module-level tune cache: (n_elements, dtype, device) -> (best_cfg, tuned_kernel)
_my_elementwise_tune_cache: dict = {}

def my_elementwise_op(x):
    n_elements = x.numel()
    output = torch.empty_like(x)
    stream = torch.cuda.current_stream()

    # DISABLE_AUTOTUNE=1: use first config for CI
    if os.environ.get("DISABLE_AUTOTUNE", "0") == "1":
        cfg = next(autotune_configs())
        tuned_kernel = ct.kernel(_my_elementwise_kernel._pyfunc, occupancy=cfg.occupancy)
        ct.launch(
            stream, (cdiv(n_elements, BLOCK_SIZE),), tuned_kernel,
            (x.reshape(-1), output.reshape(-1), n_elements, BLOCK_SIZE),
        )
        return output

    cache_key = (n_elements, x.dtype, str(x.device))
    if cache_key not in _my_elementwise_tune_cache:
        result = exhaustive_search(
            list(autotune_configs()),
            stream,
            lambda cfg: (cdiv(n_elements, BLOCK_SIZE),),
            _my_elementwise_kernel,
            lambda cfg: (x.reshape(-1), output.reshape(-1), n_elements, BLOCK_SIZE),
            lambda cfg: {"occupancy": cfg.occupancy},
        )
        best_cfg = result.best.config
        _my_elementwise_tune_cache[cache_key] = (
            best_cfg,
            ct.kernel(_my_elementwise_kernel._pyfunc, occupancy=best_cfg.occupancy),
        )
    best_cfg, tuned_kernel = _my_elementwise_tune_cache[cache_key]
    ct.launch(
        stream,
        (cdiv(n_elements, BLOCK_SIZE),),
        tuned_kernel,
        (x.reshape(-1), output.reshape(-1), n_elements, BLOCK_SIZE),
    )
    return output
```

**Real example**: `suites/unsloth/cutile/swiglu.py` — `swiglu_fg()` function.

**Large tensor note**: If `n_elements` could exceed 2^31 (~2 billion), use 64-bit offset indexing. See `LONG_INDEXING` pattern in `swiglu.py`:
```python
LONG_INDEXING = 0 if n_elements <= (2**31 - BLOCK_SIZE * 4) else 1
# Inside kernel:
if LONG_INDEXING:
    offsets = ct.astype(ct.arange(BLOCK_SIZE, dtype=ct.int32), ct.int64) + ct.astype(bid, ct.int64) * BLOCK_SIZE
else:
    offsets = bid * BLOCK_SIZE + ct.arange(BLOCK_SIZE, dtype=ct.int32)
```

---

## Template 2: In-Place Elementwise with Split-Buffer (RoPE)

**Characteristics**: Kernel modifies input in-place. Requires split-buffer pattern during search phase; final `ct.launch` uses real in-place args.

### search_space

Same as Template 1 (`autotune_configs` with occupancy=[1,2,4,8]).

### Kernel Definition

```python
@ct.kernel
def _inplace_kernel(
    X_in,      # flattened — read-only input
    X_out,     # flattened — write-only output
    n_elements: ConstInt,
    BLOCK_SIZE: ConstInt,
):
    """In-place kernel with split input/output buffers for autotune safety."""
    bid = ct.bid(0)
    offsets = bid * BLOCK_SIZE + ct.arange(BLOCK_SIZE, dtype=ct.int32)

    x = ct.gather(X_in, offsets, padding_value=0)
    # ... compute in-place transformation ...
    result = x  # placeholder
    ct.scatter(X_out, offsets, result, check_bounds=True)
```

### Forward (with exhaustive_search — split-buffer during search, in-place after)

```python
import os
from cuda.tile.tune import exhaustive_search

# Module-level tune cache: key -> (best_cfg, tuned_kernel)
_inplace_tune_cache: dict = {}

def my_inplace_op_forward(X):
    n_elements = X.numel()
    X_flat = X.reshape(-1)
    # Split-buffer: separate output during search to avoid data corruption
    X_result = torch.empty_like(X_flat)
    stream = torch.cuda.current_stream()

    # DISABLE_AUTOTUNE=1: use first config, no search (safe for in-place: single launch)
    if os.environ.get("DISABLE_AUTOTUNE", "0") == "1":
        cfg = next(autotune_configs())
        tuned_kernel = ct.kernel(_inplace_kernel._pyfunc, occupancy=cfg.occupancy)
        ct.launch(
            stream, (cdiv(n_elements, BLOCK_SIZE),), tuned_kernel,
            (X_flat, X_result, n_elements, BLOCK_SIZE),
        )
        return X_result.view_as(X)

    cache_key = (n_elements, X.dtype, str(X.device))
    if cache_key not in _inplace_tune_cache:
        # Search phase: split-buffer (X_flat -> X_result) to prevent corruption
        result = exhaustive_search(
            list(autotune_configs()),
            stream,
            lambda cfg: (cdiv(n_elements, BLOCK_SIZE),),
            _inplace_kernel,
            lambda cfg: (X_flat, X_result, n_elements, BLOCK_SIZE),
            lambda cfg: {"occupancy": cfg.occupancy},
        )
        best_cfg = result.best.config
        _inplace_tune_cache[cache_key] = (
            best_cfg,
            ct.kernel(_inplace_kernel._pyfunc, occupancy=best_cfg.occupancy),
        )
    best_cfg, tuned_kernel = _inplace_tune_cache[cache_key]
    # Final launch: still uses split-buffer for forward (returns new tensor)
    ct.launch(
        stream,
        (cdiv(n_elements, BLOCK_SIZE),),
        tuned_kernel,
        (X_flat, X_result, n_elements, BLOCK_SIZE),
    )
    return X_result.view_as(X)
```

### Backward (ct.launch — no autotune, same buffer)

```python
def my_inplace_op_backward(dX):
    n_elements = dX.numel()
    dX_flat = dX.reshape(-1)
    # Backward: inplace OK (no autotune, single launch)
    grid = (cdiv(n_elements, BLOCK_SIZE),)
    ct.launch(
        torch.cuda.current_stream(),
        grid,
        _inplace_kernel,
        (dX_flat, dX_flat, n_elements, BLOCK_SIZE),  # X_in = X_out (same buffer)
    )
    return dX
```

**Real example**: `suites/unsloth/cutile/rope_embedding.py` — `_Fast_RoPE_Embedding_CT` class.

---

## Template 3: Matmul (Standard)

**Characteristics**: 2D tiling with architecture-specific configs. Most complex search space.

### search_space

```python
import torch
from types import SimpleNamespace

def _matmul_autotune_configs():
    gpu_capability = torch.cuda.get_device_capability()

    if gpu_capability in [(12, 0), (12, 1)]:
        # sm120: small tiles, single CTA
        yield SimpleNamespace(TILE_SIZE_M=128, TILE_SIZE_N=64, TILE_SIZE_K=64, num_ctas=1, occupancy=1)
        yield SimpleNamespace(TILE_SIZE_M=128, TILE_SIZE_N=64, TILE_SIZE_K=32, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_SIZE_M=64, TILE_SIZE_N=64, TILE_SIZE_K=64, num_ctas=1, occupancy=1)
        yield SimpleNamespace(TILE_SIZE_M=64, TILE_SIZE_N=64, TILE_SIZE_K=32, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_SIZE_M=256, TILE_SIZE_N=256, TILE_SIZE_K=64, num_ctas=1, occupancy=1)
    elif gpu_capability[0] == 9:
        # sm90 (H100): medium tiles, occupancy=2, 7 configs
        yield SimpleNamespace(TILE_SIZE_M=32, TILE_SIZE_N=32, TILE_SIZE_K=64, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_SIZE_M=64, TILE_SIZE_N=32, TILE_SIZE_K=32, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_SIZE_M=64, TILE_SIZE_N=128, TILE_SIZE_K=32, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_SIZE_M=64, TILE_SIZE_N=256, TILE_SIZE_K=32, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_SIZE_M=128, TILE_SIZE_N=64, TILE_SIZE_K=32, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_SIZE_M=128, TILE_SIZE_N=64, TILE_SIZE_K=64, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_SIZE_M=128, TILE_SIZE_N=128, TILE_SIZE_K=32, num_ctas=1, occupancy=2)
    elif gpu_capability[0] < 9:
        # Pre-Hopper: num_ctas=1 only, tiles ≤ 128×128 (larger tiles spill on sm80)
        yield SimpleNamespace(TILE_SIZE_M=64, TILE_SIZE_N=64, TILE_SIZE_K=32, num_ctas=1, occupancy=1)
        yield SimpleNamespace(TILE_SIZE_M=64, TILE_SIZE_N=128, TILE_SIZE_K=32, num_ctas=1, occupancy=1)
        yield SimpleNamespace(TILE_SIZE_M=128, TILE_SIZE_N=64, TILE_SIZE_K=32, num_ctas=1, occupancy=1)
        yield SimpleNamespace(TILE_SIZE_M=128, TILE_SIZE_N=128, TILE_SIZE_K=32, num_ctas=1, occupancy=1)
    else:
        # sm100+ (Blackwell): large tiles, multi-CTA
        yield SimpleNamespace(TILE_SIZE_M=128, TILE_SIZE_N=128, TILE_SIZE_K=32, num_ctas=1, occupancy=1)
        yield SimpleNamespace(TILE_SIZE_M=256, TILE_SIZE_N=256, TILE_SIZE_K=64, num_ctas=2, occupancy=1)
        yield SimpleNamespace(TILE_SIZE_M=256, TILE_SIZE_N=256, TILE_SIZE_K=64, num_ctas=4, occupancy=1)
        yield SimpleNamespace(TILE_SIZE_M=512, TILE_SIZE_N=256, TILE_SIZE_K=64, num_ctas=2, occupancy=1)
```

### Kernel Definition

```python
@ct.kernel(num_ctas=ct.ByTarget(sm_100=2))
def matmul_kernel(
    A, B, C,
    TILE_SIZE_M: ConstInt,
    TILE_SIZE_N: ConstInt,
    TILE_SIZE_K: ConstInt,
):
    GROUP_SIZE_M = 8
    M = A.shape[0]
    N = B.shape[1]
    bidx, bidy = swizzle_2d(M, N, TILE_SIZE_M, TILE_SIZE_N, GROUP_SIZE_M)

    num_tiles_k = ct.num_tiles(A, axis=1, shape=(TILE_SIZE_M, TILE_SIZE_K))
    accumulator = ct.full((TILE_SIZE_M, TILE_SIZE_N), 0, dtype=ct.float32)
    zero_pad = ct.PaddingMode.ZERO

    dtype = ct.tfloat32 if A.dtype == ct.float32 else A.dtype

    for k in range(num_tiles_k):
        a = ct.load(A, index=(bidx, k), shape=(TILE_SIZE_M, TILE_SIZE_K), padding_mode=zero_pad).astype(dtype)
        b = ct.load(B, index=(k, bidy), shape=(TILE_SIZE_K, TILE_SIZE_N), padding_mode=zero_pad).astype(dtype)
        accumulator = ct.mma(a, b, accumulator)

    accumulator = ct.astype(accumulator, C.dtype)
    ct.store(C, index=(bidx, bidy), tile=accumulator)
```

### exhaustive_search + cache + ct.launch

```python
import os
from math import ceil
from cuda.tile.tune import exhaustive_search

# Module-level tune cache: (M, K, N, dtype, device) -> (best_cfg, tuned_kernel)
_matmul_tune_cache: dict = {}

def cutile_autotune_matmul(stream, a, b, c):
    M, N = c.shape
    K = a.shape[1]

    # DISABLE_AUTOTUNE=1: use first config for CI
    if os.environ.get("DISABLE_AUTOTUNE", "0") == "1":
        cfg = next(_matmul_autotune_configs())
        tuned_kernel = ct.kernel(
            matmul_kernel._pyfunc, num_ctas=cfg.num_ctas, occupancy=cfg.occupancy,
        )
        ct.launch(
            stream,
            (ceil(M / cfg.TILE_SIZE_M) * ceil(N / cfg.TILE_SIZE_N), 1, 1),
            tuned_kernel,
            (a, b, c, cfg.TILE_SIZE_M, cfg.TILE_SIZE_N, cfg.TILE_SIZE_K),
        )
        return c

    cache_key = (M, K, N, a.dtype, str(a.device))
    if cache_key not in _matmul_tune_cache:
        result = exhaustive_search(
            list(_matmul_autotune_configs()),
            stream,
            lambda cfg: (
                ceil(M / cfg.TILE_SIZE_M) * ceil(N / cfg.TILE_SIZE_N), 1, 1,
            ),
            matmul_kernel,
            lambda cfg: (a, b, c, cfg.TILE_SIZE_M, cfg.TILE_SIZE_N, cfg.TILE_SIZE_K),
            lambda cfg: {"num_ctas": cfg.num_ctas, "occupancy": cfg.occupancy},
        )
        best_cfg = result.best.config
        _matmul_tune_cache[cache_key] = (
            best_cfg,
            ct.kernel(
                matmul_kernel._pyfunc,
                num_ctas=best_cfg.num_ctas,
                occupancy=best_cfg.occupancy,
            ),
        )
    best_cfg, tuned_kernel = _matmul_tune_cache[cache_key]
    ct.launch(
        stream,
        (ceil(M / best_cfg.TILE_SIZE_M) * ceil(N / best_cfg.TILE_SIZE_N), 1, 1),
        tuned_kernel,
        (a, b, c, best_cfg.TILE_SIZE_M, best_cfg.TILE_SIZE_N, best_cfg.TILE_SIZE_K),
    )
    return c
```

**Real example**: `ops/cutile/matmul.py` — `cutile_autotune_matmul()`.

---

## Template 4: Persistent Matmul

**Characteristics**: Grid bounded by SM count, not problem size. Each CTA processes multiple tiles.

### search_space

```python
def _static_persistent_matmul_autotune_configs():
    gpu_capability = torch.cuda.get_device_capability()
    if gpu_capability in [(12, 0), (12, 1)]:
        # sm120 (5090): small tiles, num_ctas=1
        yield SimpleNamespace(TILE_SIZE_M=64, TILE_SIZE_N=64, TILE_SIZE_K=64, GROUP_SIZE_M=8, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_SIZE_M=64, TILE_SIZE_N=64, TILE_SIZE_K=64, GROUP_SIZE_M=8, num_ctas=1, occupancy=4)
        yield SimpleNamespace(TILE_SIZE_M=64, TILE_SIZE_N=64, TILE_SIZE_K=64, GROUP_SIZE_M=8, num_ctas=1, occupancy=1)
        yield SimpleNamespace(TILE_SIZE_M=128, TILE_SIZE_N=64, TILE_SIZE_K=64, GROUP_SIZE_M=8, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_SIZE_M=128, TILE_SIZE_N=64, TILE_SIZE_K=64, GROUP_SIZE_M=8, num_ctas=1, occupancy=1)
        yield SimpleNamespace(TILE_SIZE_M=128, TILE_SIZE_N=64, TILE_SIZE_K=64, GROUP_SIZE_M=8, num_ctas=1, occupancy=4)
        yield SimpleNamespace(TILE_SIZE_M=256, TILE_SIZE_N=256, TILE_SIZE_K=64, GROUP_SIZE_M=8, num_ctas=1, occupancy=1)
    elif gpu_capability[0] < 9:
        # Pre-Hopper: num_ctas=1 only, tiles ≤ 128 (larger tiles spill on sm80)
        yield SimpleNamespace(TILE_SIZE_M=64, TILE_SIZE_N=128, TILE_SIZE_K=64, GROUP_SIZE_M=8, num_ctas=1, occupancy=1)
        yield SimpleNamespace(TILE_SIZE_M=128, TILE_SIZE_N=64, TILE_SIZE_K=64, GROUP_SIZE_M=8, num_ctas=1, occupancy=1)
        yield SimpleNamespace(TILE_SIZE_M=128, TILE_SIZE_N=128, TILE_SIZE_K=32, GROUP_SIZE_M=8, num_ctas=1, occupancy=1)
        yield SimpleNamespace(TILE_SIZE_M=128, TILE_SIZE_N=128, TILE_SIZE_K=64, GROUP_SIZE_M=8, num_ctas=1, occupancy=1)
    elif gpu_capability[0] == 9:
        # sm90 (H100): medium tiles, occupancy=2
        yield SimpleNamespace(TILE_SIZE_M=64, TILE_SIZE_N=128, TILE_SIZE_K=64, GROUP_SIZE_M=8, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_SIZE_M=64, TILE_SIZE_N=256, TILE_SIZE_K=64, GROUP_SIZE_M=8, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_SIZE_M=128, TILE_SIZE_N=64, TILE_SIZE_K=64, GROUP_SIZE_M=8, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_SIZE_M=128, TILE_SIZE_N=128, TILE_SIZE_K=64, GROUP_SIZE_M=8, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_SIZE_M=128, TILE_SIZE_N=256, TILE_SIZE_K=64, GROUP_SIZE_M=8, num_ctas=2, occupancy=1)
        yield SimpleNamespace(TILE_SIZE_M=256, TILE_SIZE_N=256, TILE_SIZE_K=64, GROUP_SIZE_M=8, num_ctas=2, occupancy=1)
    else:
        # sm100+ (Blackwell): large tiles, multi-CTA
        yield SimpleNamespace(TILE_SIZE_M=128, TILE_SIZE_N=512, TILE_SIZE_K=64, GROUP_SIZE_M=8, num_ctas=4, occupancy=1)
        yield SimpleNamespace(TILE_SIZE_M=256, TILE_SIZE_N=256, TILE_SIZE_K=64, GROUP_SIZE_M=8, num_ctas=2, occupancy=1)
        yield SimpleNamespace(TILE_SIZE_M=256, TILE_SIZE_N=256, TILE_SIZE_K=64, GROUP_SIZE_M=8, num_ctas=1, occupancy=1)
        yield SimpleNamespace(TILE_SIZE_M=256, TILE_SIZE_N=256, TILE_SIZE_K=128, GROUP_SIZE_M=8, num_ctas=2, occupancy=1)
```

### exhaustive_search + cache + ct.launch

```python
import os
from cuda.tile.tune import exhaustive_search

# Module-level tune cache: (M, N, K, trans_a, trans_b, dtype, device) -> (best_cfg, tuned_kernel)
_persistent_matmul_tune_cache: dict = {}

def cutile_autotune_static_persistent_matmul(stream, a, b, c, M, N, K, trans_a, trans_b):
    NUM_SMS = torch.cuda.get_device_properties("cuda").multi_processor_count

    # DISABLE_AUTOTUNE=1: use first config for CI
    if os.environ.get("DISABLE_AUTOTUNE", "0") == "1":
        cfg = next(_static_persistent_matmul_autotune_configs())
        tuned_kernel = ct.kernel(
            static_persistent_matmul_kernel._pyfunc,
            num_ctas=cfg.num_ctas, occupancy=cfg.occupancy,
        )
        grid = (
            min(NUM_SMS // cfg.num_ctas, ceil(M / cfg.TILE_SIZE_M) * ceil(N / cfg.TILE_SIZE_N)) * cfg.occupancy,
            1, 1,
        )
        ct.launch(
            stream, grid, tuned_kernel,
            (a, b, c, M, N, K, cfg.TILE_SIZE_M, cfg.TILE_SIZE_N, cfg.TILE_SIZE_K,
             trans_a, trans_b, cfg.GROUP_SIZE_M),
        )
        return c

    cache_key = (M, N, K, trans_a, trans_b, a.dtype, str(a.device))
    if cache_key not in _persistent_matmul_tune_cache:
        result = exhaustive_search(
            list(_static_persistent_matmul_autotune_configs()),
            stream,
            lambda cfg: (
                min(NUM_SMS // cfg.num_ctas, ceil(M / cfg.TILE_SIZE_M) * ceil(N / cfg.TILE_SIZE_N)) * cfg.occupancy,
                1, 1,
            ),
            static_persistent_matmul_kernel,
            lambda cfg: (
                a, b, c, M, N, K,
                cfg.TILE_SIZE_M, cfg.TILE_SIZE_N, cfg.TILE_SIZE_K,
                trans_a, trans_b, cfg.GROUP_SIZE_M,
            ),
            lambda cfg: {"num_ctas": cfg.num_ctas, "occupancy": cfg.occupancy},
        )
        best_cfg = result.best.config
        _persistent_matmul_tune_cache[cache_key] = (
            best_cfg,
            ct.kernel(
                static_persistent_matmul_kernel._pyfunc,
                num_ctas=best_cfg.num_ctas,
                occupancy=best_cfg.occupancy,
            ),
        )
    best_cfg, tuned_kernel = _persistent_matmul_tune_cache[cache_key]
    ct.launch(
        stream,
        (
            min(NUM_SMS // best_cfg.num_ctas,
                ceil(M / best_cfg.TILE_SIZE_M) * ceil(N / best_cfg.TILE_SIZE_N)) * best_cfg.occupancy,
            1, 1,
        ),
        tuned_kernel,
        (
            a, b, c, M, N, K,
            best_cfg.TILE_SIZE_M, best_cfg.TILE_SIZE_N, best_cfg.TILE_SIZE_K,
            trans_a, trans_b, best_cfg.GROUP_SIZE_M,
        ),
    )
    return c
```

**Real example**: `ops/cutile/matmul.py` — `cutile_autotune_static_persistent_matmul()`.

---

## Template 5: FMHA (Forward)

**Characteristics**: 2D grid (seq_tiles x batch*heads), tile sizes depend on head_dim.

### search_space

```python
import math
import torch
from types import SimpleNamespace

def _fmha_autotune_configs(head_dim=None):
    """Internal build: architecture-conditional with num_ctas/occupancy.
    Release build uses head_dim-keyed tile configs (TILE_M/TILE_N only, no hints).

    All configs are yielded unconditionally per arch — exhaustive_search picks the
    best for the actual workload shape at runtime. No seq_len pre-filtering.
    """
    gpu_capability = torch.cuda.get_device_capability()
    if gpu_capability in [(12, 0), (12, 1)]:
        # sm120: limited tile support
        yield SimpleNamespace(TILE_M=64, TILE_N=64, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_M=128, TILE_N=64, num_ctas=1, occupancy=2)
    elif gpu_capability[0] < 9:
        # pre-Hopper: num_ctas=1 only, tiles ≤ 128
        yield SimpleNamespace(TILE_M=64, TILE_N=64, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_M=128, TILE_N=64, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_M=128, TILE_N=128, num_ctas=1, occupancy=1)
    else:
        # sm90 / sm100+ (Blackwell): all tiles + num_ctas variants
        yield SimpleNamespace(TILE_M=128, TILE_N=128, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_M=256, TILE_N=128, num_ctas=1, occupancy=1)
        yield SimpleNamespace(TILE_M=256, TILE_N=128, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_M=256, TILE_N=128, num_ctas=2, occupancy=2)
```

### exhaustive_search + cache + ct.launch

```python
import os
from cuda.tile.tune import exhaustive_search

# Module-level tune cache: (batch, nheads, q_len, hidden_size, is_causal, dtype, device) -> (best_cfg, tuned_kernel)
_fmha_tune_cache: dict = {}

def cutile_autotune_fmha(stream, q, k, v, o, sm_scale, input_pos,
                          hidden_size, num_heads, query_group_size,
                          is_causal, EVEN_K):
    batch_size, _, q_len, _ = q.shape

    cache_key = (batch_size, num_heads, q_len, hidden_size, is_causal, q.dtype, str(q.device))
    if cache_key not in _fmha_tune_cache:
        configs = list(_fmha_autotune_configs(hidden_size))

        if os.environ.get("DISABLE_AUTOTUNE", "0") == "1":
            # Skip search; use first config directly
            cfg = configs[0]
            _fmha_tune_cache[cache_key] = (
                cfg,
                ct.kernel(
                    fmha_kernel._pyfunc,
                    num_ctas=cfg.num_ctas,
                    occupancy=cfg.occupancy,
                ),
            )
        else:
            # Search phase: split-buffer pattern used internally by exhaustive_search
            result = exhaustive_search(
                configs,
                stream,
                lambda cfg: (
                    math.ceil(q_len / cfg.TILE_M), batch_size * num_heads, 1,
                ),
                fmha_kernel,
                lambda cfg: (
                    q, k, v, o, sm_scale, input_pos, hidden_size, num_heads,
                    cfg.TILE_M, cfg.TILE_N, query_group_size, is_causal, EVEN_K,
                ),
                lambda cfg: {"num_ctas": cfg.num_ctas, "occupancy": cfg.occupancy},
            )
            best_cfg = result.best.config
            _fmha_tune_cache[cache_key] = (
                best_cfg,
                ct.kernel(
                    fmha_kernel._pyfunc,
                    num_ctas=best_cfg.num_ctas,
                    occupancy=best_cfg.occupancy,
                ),
            )

    best_cfg, tuned_kernel = _fmha_tune_cache[cache_key]
    grid = (math.ceil(q_len / best_cfg.TILE_M), batch_size * num_heads, 1)
    ct.launch(
        stream, grid, tuned_kernel,
        (q, k, v, o, sm_scale, input_pos, hidden_size, num_heads,
         best_cfg.TILE_M, best_cfg.TILE_N, query_group_size, is_causal, EVEN_K),
    )
    return o
```

**Note**: `_fmha_autotune_configs` yields at most 4 configs per architecture, so exhaustive search completes quickly. The `DISABLE_AUTOTUNE` env var bypasses search entirely by picking the first config.

**Internal vs release build**: The `hints_fn` with `num_ctas`/`occupancy` applies to internal builds where `_fmha_autotune_configs` yields configs with those fields. In release builds, configs contain only `TILE_M`/`TILE_N`; omit `hints_fn` or use `hints_fn=None`.

**Real example**: `ops/cutile/attention.py` — `cutile_autotune_fmha()`.

### FMHA Backward (dK/dV and dQ)

Backward uses tile-size search only. `num_ctas` and `occupancy` are left to compiler defaults (no `hints_fn`).

```python
# Module-level tune cache for backward
_fmha_bwd_dkdv_tune_cache: dict = {}

def fmha_backward_dkdv(stream, q, k, v, do, dk, dv, lse, delta,
                        sm_scale, hidden_size, num_heads_q, num_heads_kv,
                        seq_len, query_group_size, is_causal):
    batch_size = q.shape[0]

    cache_key = (batch_size, num_heads_kv, seq_len, hidden_size, is_causal, q.dtype, str(q.device))
    if cache_key not in _fmha_bwd_dkdv_tune_cache:
        result = exhaustive_search(
            list(_fmha_bwd_dkdv_autotune_configs(hidden_size)),
            stream,
            lambda cfg: (
                math.ceil(k.shape[2] / cfg.TILE_N),
                batch_size * num_heads_kv,
                1,
            ),
            fmha_bwd_dkdv_kernel,
            lambda cfg: (
                q, k, v, do, dk, dv, lse, delta,
                sm_scale, hidden_size, num_heads_q, num_heads_kv,
                seq_len, cfg.TILE_M, cfg.TILE_N, query_group_size, is_causal,
            ),
            # No hints_fn — occupancy/num_ctas left to compiler
        )
        best_cfg = result.best.config
        _fmha_bwd_dkdv_tune_cache[cache_key] = best_cfg
    best_cfg = _fmha_bwd_dkdv_tune_cache[cache_key]
    ct.launch(
        stream,
        (
            math.ceil(k.shape[2] / best_cfg.TILE_N),
            batch_size * num_heads_kv,
            1,
        ),
        fmha_bwd_dkdv_kernel,
        (
            q, k, v, do, dk, dv, lse, delta,
            sm_scale, hidden_size, num_heads_q, num_heads_kv,
            seq_len, best_cfg.TILE_M, best_cfg.TILE_N, query_group_size, is_causal,
        ),
    )
```

### FMHA Backward Configs

Backward has separate configs for dK/dV and dQ kernels:

```python
_FMHA_BWD_DKDV_TILE_CONFIGS_BY_D = {
    64:  ([32, 64, 128], [64, 128]),
    128: ([16, 32, 64],  [32, 64]),
    256: ([32],          [32, 64]),
}

_FMHA_BWD_DQ_TILE_CONFIGS_BY_D = {
    64:  ([64, 128], [32, 64, 128]),
    128: ([32, 64],  [16, 32, 64]),
    256: ([64],      [32, 64]),
}

def next_power_of_2(n):
    """Smallest power of 2 >= n."""
    return 1 << (n - 1).bit_length() if n > 0 else 1

def _fmha_bwd_dkdv_autotune_configs(head_dim=None):
    key = next_power_of_2(head_dim) if head_dim else None
    tile_ms, tile_ns = _FMHA_BWD_DKDV_TILE_CONFIGS_BY_D.get(key, ([32, 64, 128], [64, 128]))
    for tm in tile_ms:
        for tn in tile_ns:
            yield SimpleNamespace(TILE_M=tm, TILE_N=tn)

def _fmha_bwd_dq_autotune_configs(head_dim=None):
    key = next_power_of_2(head_dim) if head_dim else None
    tile_ms, tile_ns = _FMHA_BWD_DQ_TILE_CONFIGS_BY_D.get(key, ([64, 128], [32, 64, 128]))
    for tm in tile_ms:
        for tn in tile_ns:
            yield SimpleNamespace(TILE_M=tm, TILE_N=tn)
```

---

## Template 6: FP8 Matmul (W8A8 Block Quantized with TMA)

> **Production note**: In the current TileGym codebase, FP8 matmul uses `ct.launch` with heuristic `BLOCK_SIZE_M` (not autotuning) to maintain A/B fairness with Triton, which has no FP8 autotune. **Use this template when** adding autotune to a new FP8 kernel, or when the fairness constraint does not apply (i.e., no Triton baseline to compare against).
>
> Current production pattern: `ct.launch(stream, grid, kernel, args)` with `BLOCK_SIZE_M = min(128, next_power_of_2(M))`.

**Characteristics**: Quantization-aligned block sizes, TMA loads, swap_ab optimization.

### Kernel Definition (TMA variant)

```python
@ct.kernel(num_ctas=1)
def w8a8_block_fp8_matmul_kernel_ct_tma(
    A,   # (M, K) FP8
    B,   # (N, K) FP8
    C,   # (M, N) output
    As,  # (M, K_groups) float32 activation scales
    Bs,  # (N_groups, K_groups) float32 weight scales
    M: ConstInt, N: ConstInt, K: ConstInt,
    group_n: ConstInt, group_k: ConstInt,
    BLOCK_SIZE_M: ConstInt, BLOCK_SIZE_N: ConstInt, BLOCK_SIZE_K: ConstInt,
    GROUP_SIZE_M: ConstInt,
    OUTPUT_DTYPE: ConstInt,
    swap_ab: ConstInt,
):
    pid = ct.bid(0)
    pid_m, pid_n = _gemm_swizzle_pid(pid, M, N, BLOCK_SIZE_M, BLOCK_SIZE_N, GROUP_SIZE_M)
    offs_am = pid_m * BLOCK_SIZE_M + ct.arange(BLOCK_SIZE_M, dtype=ct.int32)

    accumulator = ct.zeros((BLOCK_SIZE_M, BLOCK_SIZE_N), dtype=ct.float32)
    num_k_tiles = ct.cdiv(K, BLOCK_SIZE_K)

    for k_tile in range(num_k_tiles):
        # TMA loads
        a = ct.load(A, index=(pid_m, k_tile), shape=(BLOCK_SIZE_M, BLOCK_SIZE_K),
                     order=(0, 1), latency=3, allow_tma=True)
        b = ct.load(B, index=(pid_n, k_tile), shape=(BLOCK_SIZE_N, BLOCK_SIZE_K),
                     order=(0, 1), latency=3, allow_tma=True)

        # Per-block scales
        a_s = ct.gather(As, (offs_am, k_tile), check_bounds=True, padding_value=0.0, latency=4)
        b_s = ct.gather(Bs, (pid_n, k_tile), check_bounds=True, padding_value=0.0, latency=4)
        ab_s = ct.mul(a_s[:, None], b_s)

        # MMA with optional operand swap
        if swap_ab:
            zero_acc = ct.zeros((BLOCK_SIZE_N, BLOCK_SIZE_M), dtype=ct.float32)
            a_t = ct.permute(a, (1, 0))
            dot_result = ct.mma(b, a_t, acc=zero_acc)
            dot_result = ct.permute(dot_result, (1, 0))
        else:
            zero_acc = ct.zeros((BLOCK_SIZE_M, BLOCK_SIZE_N), dtype=ct.float32)
            b_t = ct.permute(b, (1, 0))
            dot_result = ct.mma(a, b_t, acc=zero_acc)

        accumulator = ct.add(accumulator, ct.mul(dot_result, ab_s))

    # Output dtype conversion + TMA store
    if OUTPUT_DTYPE == 1:
        c = ct.astype(accumulator, ct.float16)
    elif OUTPUT_DTYPE == 2:
        c = ct.astype(accumulator, ct.bfloat16)
    else:
        c = accumulator
    ct.store(C, index=(pid_m, pid_n), tile=c, order=(0, 1), allow_tma=True)
```

### Wrapper with exhaustive_search + cache + ct.launch

```python
import os
from cuda.tile.tune import exhaustive_search

_DTYPE_TO_INT = {torch.float32: 0, torch.float16: 1, torch.bfloat16: 2}

# Module-level tune cache: (M, N, K, block_size, output_dtype, device) -> (best_cfg, tuned_kernel)
_fp8_matmul_tune_cache: dict = {}

def w8a8_block_fp8_matmul(A, B, As, Bs, block_size, output_dtype=torch.bfloat16):
    M, K = A.shape
    N, _ = B.shape
    C = torch.empty((M, N), dtype=output_dtype, device=A.device)

    group_n = block_size
    group_k = block_size
    BLOCK_SIZE_K = group_k
    BLOCK_SIZE_N = group_n
    GROUP_SIZE_M = 8
    dtype_int = _DTYPE_TO_INT[output_dtype]

    stream = torch.cuda.current_stream()

    # DISABLE_AUTOTUNE=1: use first config for CI
    if os.environ.get("DISABLE_AUTOTUNE", "0") == "1":
        cfg = next(_fp8_matmul_configs(M, group_k, group_n))
        tuned_kernel = ct.kernel(
            w8a8_block_fp8_matmul_kernel_ct_tma._pyfunc, occupancy=cfg.occupancy,
        )
        ct.launch(
            stream,
            (ceil(M / cfg.BLOCK_SIZE_M) * ceil(N / BLOCK_SIZE_N), 1, 1),
            tuned_kernel,
            (A, B, C, As, Bs, M, N, K, group_n, group_k,
             cfg.BLOCK_SIZE_M, BLOCK_SIZE_N, BLOCK_SIZE_K,
             GROUP_SIZE_M, dtype_int, cfg.swap_ab),
        )
        return C

    cache_key = (M, N, K, block_size, output_dtype, str(A.device))
    if cache_key not in _fp8_matmul_tune_cache:
        result = exhaustive_search(
            list(_fp8_matmul_configs(M, group_k, group_n)),
            stream,
            lambda cfg: (
                ceil(M / cfg.BLOCK_SIZE_M) * ceil(N / BLOCK_SIZE_N), 1, 1,
            ),
            w8a8_block_fp8_matmul_kernel_ct_tma,
            lambda cfg: (
                A, B, C, As, Bs, M, N, K, group_n, group_k,
                cfg.BLOCK_SIZE_M, BLOCK_SIZE_N, BLOCK_SIZE_K,
                GROUP_SIZE_M, dtype_int, cfg.swap_ab,
            ),
            lambda cfg: {"occupancy": cfg.occupancy},
        )
        best_cfg = result.best.config
        _fp8_matmul_tune_cache[cache_key] = (
            best_cfg,
            ct.kernel(
                w8a8_block_fp8_matmul_kernel_ct_tma._pyfunc,
                occupancy=best_cfg.occupancy,
            ),
        )
    best_cfg, tuned_kernel = _fp8_matmul_tune_cache[cache_key]
    ct.launch(
        stream,
        (ceil(M / best_cfg.BLOCK_SIZE_M) * ceil(N / BLOCK_SIZE_N), 1, 1),
        tuned_kernel,
        (
            A, B, C, As, Bs, M, N, K, group_n, group_k,
            best_cfg.BLOCK_SIZE_M, BLOCK_SIZE_N, BLOCK_SIZE_K,
            GROUP_SIZE_M, dtype_int, best_cfg.swap_ab,
        ),
    )
    return C

def _fp8_matmul_configs(M, group_k, group_n):
    for block_m in [16, 32, 64, 128]:
        if block_m > M:
            continue
        for occ in [1, 2, 4]:
            for swap in [0, 1]:
                yield SimpleNamespace(
                    BLOCK_SIZE_M=block_m, occupancy=occ, swap_ab=swap,
                )
```

**Real example**: `suites/unsloth/cutile/fp8.py` — `w8a8_block_fp8_matmul_kernel_ct_tma`.

---

## Template 7: Grouped GEMM (Occupancy-Only + Persistent)

**Characteristics**: Persistent scheduling with `grid=NUM_SMS`. Only occupancy is tuned after learning from compilation timeout on block-size search.

### search_space

```python
# Same as elementwise — occupancy only
from .ct_ops import autotune_configs  # yields occ in [1, 2, 4, 8]
```

### exhaustive_search + cache + ct.launch

```python
import os
from cuda.tile.tune import exhaustive_search

# Module-level tune cache
_grouped_gemm_tune_cache: dict = {}

def grouped_gemm_op(A_grouped, B_grouped, ...):
    NUM_SMS = torch.cuda.get_device_properties("cuda").multi_processor_count
    # Host-side heuristic for block sizes (NOT tuned)
    BLOCK_M = min(128, next_power_of_2(max_tokens_per_expert))
    BLOCK_N = 128
    BLOCK_K = 64

    stream = torch.cuda.current_stream()

    # DISABLE_AUTOTUNE=1: use first config for CI
    if os.environ.get("DISABLE_AUTOTUNE", "0") == "1":
        cfg = next(autotune_configs())
        tuned_kernel = ct.kernel(grouped_gemm_kernel._pyfunc, occupancy=cfg.occupancy)
        ct.launch(
            stream, (NUM_SMS, 1, 1), tuned_kernel,
            (A_grouped, B_grouped, C, ..., BLOCK_M, BLOCK_N, BLOCK_K),
        )
        return C

    cache_key = (total_tokens, N, K, num_experts, BLOCK_M, BLOCK_N, BLOCK_K, A_grouped.dtype, str(A_grouped.device))
    if cache_key not in _grouped_gemm_tune_cache:
        result = exhaustive_search(
            list(autotune_configs()),
            stream,
            lambda cfg: (NUM_SMS, 1, 1),
            grouped_gemm_kernel,
            lambda cfg: (
                A_grouped, B_grouped, C, ..., BLOCK_M, BLOCK_N, BLOCK_K,
            ),
            lambda cfg: {"occupancy": cfg.occupancy},
        )
        best_cfg = result.best.config
        _grouped_gemm_tune_cache[cache_key] = ct.kernel(
            grouped_gemm_kernel._pyfunc,
            occupancy=best_cfg.occupancy,
        )
    tuned_kernel = _grouped_gemm_tune_cache[cache_key]
    ct.launch(
        stream,
        (NUM_SMS, 1, 1),
        tuned_kernel,
        (A_grouped, B_grouped, C, ..., BLOCK_M, BLOCK_N, BLOCK_K),
    )
    return C
```

**Why occupancy-only**: Expanding to 32-config block-size search caused >5min compilation timeout. Heuristic block sizes + occupancy autotune matches same performance.

---

## Template 8: Variable-Length Attention (attention_varlen)

**Characteristics**: Multi-dimensional search over TILE_M x TILE_N x occupancy x num_ctas (sm90+). Per-batch variable query/KV lengths, GQA support, causal masking. Grid depends on TILE_M from best config.

### search_space

```python
import torch
from types import SimpleNamespace

def _attention_varlen_autotune_configs():
    """Architecture-conditional configs for variable-length attention.
    sm100+: 9 configs covering TILE_M x TILE_N x occupancy x num_ctas.
    num_ctas=2 on large tiles (256×128) enables TMA multicast for ~13% extra speedup.
    """
    gpu_capability = torch.cuda.get_device_capability()

    if gpu_capability[0] >= 10:
        # sm100+ (Blackwell): 9 configs with num_ctas dimension
        yield SimpleNamespace(TILE_M=64,  TILE_N=64,  num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_M=64,  TILE_N=128, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_M=128, TILE_N=64,  num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_M=128, TILE_N=128, num_ctas=1, occupancy=1)
        yield SimpleNamespace(TILE_M=128, TILE_N=128, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_M=256, TILE_N=128, num_ctas=1, occupancy=1)
        yield SimpleNamespace(TILE_M=256, TILE_N=128, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_M=256, TILE_N=128, num_ctas=2, occupancy=2)
        yield SimpleNamespace(TILE_M=256, TILE_N=64,  num_ctas=1, occupancy=1)
    elif gpu_capability[0] == 9:
        # sm90 (H100): num_ctas=1 for attention varlen
        yield SimpleNamespace(TILE_M=64,  TILE_N=64,  num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_M=128, TILE_N=64,  num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_M=128, TILE_N=128, num_ctas=1, occupancy=1)
        yield SimpleNamespace(TILE_M=128, TILE_N=128, num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_M=64,  TILE_N=128, num_ctas=1, occupancy=2)
    else:
        # Pre-Hopper fallback: num_ctas=1 only
        yield SimpleNamespace(TILE_M=64,  TILE_N=64,  num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_M=128, TILE_N=64,  num_ctas=1, occupancy=1)
        yield SimpleNamespace(TILE_M=128, TILE_N=64,  num_ctas=1, occupancy=2)
        yield SimpleNamespace(TILE_M=128, TILE_N=128, num_ctas=1, occupancy=1)
```

### Kernel Definition

The kernel has the same structure as Template 5 (FMHA) but uses variable-length sequence parameters. Q/K/V/Out have shape `(batch, heads, max_seq_len, head_dim)` with per-batch `Q_lens` and `KV_lens` tensors controlling actual sequence lengths.

### exhaustive_search + cache + ct.launch

```python
import math
import os
from math import ceil
from cuda.tile.tune import exhaustive_search

# Module-level tune cache:
# (batch_size, num_heads, S_qo, S_kv, hidden_size, query_group_size, is_causal, dtype, device) -> (best_cfg, tuned_kernel)
_attention_varlen_tune_cache: dict = {}

def run_attention_varlen(Q, K, V, q_lens=None, kv_lens=None, is_causal=True):
    Q = Q.contiguous()
    K = K.contiguous()
    V = V.contiguous()
    batch_size, num_heads, S_qo, head_dim = Q.shape
    _, num_head_kv, S_kv, _ = K.shape

    if num_heads == num_head_kv:
        query_group_size = 0
    else:
        query_group_size = num_heads // num_head_kv

    Out = torch.empty_like(Q)
    qk_scale = 1.0 / math.sqrt(head_dim)

    Q_LEN_MASK = q_lens is not None
    KV_LEN_MASK = kv_lens is not None

    if q_lens is None:
        q_lens = torch.empty(batch_size, dtype=torch.int32, device=Q.device)
    if kv_lens is None:
        kv_lens = torch.empty(batch_size, dtype=torch.int32, device=Q.device)

    stream = torch.cuda.current_stream()

    # DISABLE_AUTOTUNE=1: use first config for CI
    if os.environ.get("DISABLE_AUTOTUNE", "0") == "1":
        cfg = next(_attention_varlen_autotune_configs())
        tuned_kernel = ct.kernel(fmha_varlen_kernel._pyfunc,
                                 num_ctas=cfg.num_ctas, occupancy=cfg.occupancy)
        grid = (ceil(S_qo / cfg.TILE_M), batch_size * num_heads, 1)
        ct.launch(
            stream, grid, tuned_kernel,
            (Q, K, V, q_lens, kv_lens, Out, qk_scale,
             head_dim, num_heads, S_qo, S_kv,
             cfg.TILE_M, cfg.TILE_N,
             query_group_size, is_causal, Q_LEN_MASK, KV_LEN_MASK),
        )
        return Out

    cache_key = (batch_size, num_heads, S_qo, S_kv, head_dim,
                 query_group_size, is_causal, Q.dtype, str(Q.device))

    if cache_key not in _attention_varlen_tune_cache:
        result = exhaustive_search(
            list(_attention_varlen_autotune_configs()),
            stream,
            lambda cfg: (ceil(S_qo / cfg.TILE_M), batch_size * num_heads, 1),
            fmha_varlen_kernel,
            lambda cfg: (
                Q, K, V, q_lens, kv_lens, Out, qk_scale,
                head_dim, num_heads, S_qo, S_kv,
                cfg.TILE_M, cfg.TILE_N,
                query_group_size, is_causal, Q_LEN_MASK, KV_LEN_MASK,
            ),
            lambda cfg: {"num_ctas": cfg.num_ctas, "occupancy": cfg.occupancy},
        )
        best_cfg = result.best.config
        _attention_varlen_tune_cache[cache_key] = (
            best_cfg,
            ct.kernel(
                fmha_varlen_kernel._pyfunc,
                num_ctas=best_cfg.num_ctas,
                occupancy=best_cfg.occupancy,
            ),
        )

    best_cfg, tuned_kernel = _attention_varlen_tune_cache[cache_key]
    grid = (ceil(S_qo / best_cfg.TILE_M), batch_size * num_heads, 1)
    ct.launch(
        stream,
        grid,
        tuned_kernel,
        (Q, K, V, q_lens, kv_lens, Out, qk_scale,
         head_dim, num_heads, S_qo, S_kv,
         best_cfg.TILE_M, best_cfg.TILE_N,
         query_group_size, is_causal, Q_LEN_MASK, KV_LEN_MASK),
    )
    return Out
```

**Key differences from Template 5 (FMHA)**:
- Cache key includes `S_kv` and `query_group_size` for variable-length + GQA combinations.
- Grid depends on `TILE_M` from best config (not a fixed tile size), so `best_cfg` must be stored alongside the tuned kernel.
- Multi-dimensional search: TILE_M x TILE_N x occupancy x num_ctas (9 configs on sm100+) vs. Template 5's 4-config search.
- `num_ctas=2` on large tiles (256×128) enables TMA multicast for ~13% extra speedup on sm100+.

---

## Template 9: Dual-GEMM Fusion (Linear+GLUAct, Linear+GeGLU)

**Characteristics**: Two matrix multiplications sharing the same input tile, fused with an activation (SiLU/GeGLU) and element-wise gating. Each CTA maintains **two accumulators** and loads **two weight tiles** per K-iteration, resulting in ~2× the register and shared memory pressure of a single GEMM. This means lower optimal occupancy and more conservative tile sizes compared to Template 3 (standard matmul).

**Resource model**:
- Shared memory per CTA: 1 input tile + 2 weight tiles ≈ 1.5–2× single GEMM
- Registers per CTA: 2 accumulators + activation intermediates ≈ 2× single GEMM
- Consequence: `occupancy=2` may cause register spilling; prefer `occupancy=1` on sm100+

### search_space

```python
import torch
from types import SimpleNamespace

def _dual_gemm_autotune_configs():
    """Architecture-conditional configs for dual-GEMM fusion kernels.
    Occupancy biased toward 1 due to 2× register/SHMEM pressure.
    Tile sizes more conservative than single GEMM.
    """
    gpu_capability = torch.cuda.get_device_capability()

    if gpu_capability[0] >= 10:
        # sm100+ (Blackwell): 11 configs — occupancy={1,2}, num_ctas={1,2}
        # occ=1 is preferred for most shapes due to 2× register/SHMEM pressure in dual-GEMM,
        # but occ=2 + num_ctas=2 can win on certain shapes (e.g. sm_103 GB300 linear_gluact).
        yield SimpleNamespace(BLOCK_M=128, BLOCK_N=128, BLOCK_K=64, GROUP_M=8, num_ctas=1, occupancy=1)
        yield SimpleNamespace(BLOCK_M=128, BLOCK_N=128, BLOCK_K=64, GROUP_M=8, num_ctas=1, occupancy=2)
        yield SimpleNamespace(BLOCK_M=128, BLOCK_N=256, BLOCK_K=64, GROUP_M=8, num_ctas=1, occupancy=1)
        yield SimpleNamespace(BLOCK_M=256, BLOCK_N=128, BLOCK_K=64, GROUP_M=8, num_ctas=1, occupancy=1)
        yield SimpleNamespace(BLOCK_M=256, BLOCK_N=128, BLOCK_K=64, GROUP_M=8, num_ctas=2, occupancy=1)
        yield SimpleNamespace(BLOCK_M=256, BLOCK_N=256, BLOCK_K=64, GROUP_M=8, num_ctas=1, occupancy=1)
        yield SimpleNamespace(BLOCK_M=256, BLOCK_N=256, BLOCK_K=64, GROUP_M=8, num_ctas=2, occupancy=1)
        yield SimpleNamespace(BLOCK_M=128, BLOCK_N=256, BLOCK_K=64, GROUP_M=8, num_ctas=2, occupancy=1)
        # occ=2 + num_ctas=2 probes — multicast + higher occupancy can help on sm_103+
        yield SimpleNamespace(BLOCK_M=256, BLOCK_N=128, BLOCK_K=64, GROUP_M=8, num_ctas=2, occupancy=2)
        yield SimpleNamespace(BLOCK_M=128, BLOCK_N=128, BLOCK_K=64, GROUP_M=8, num_ctas=2, occupancy=2)
        yield SimpleNamespace(BLOCK_M=256, BLOCK_N=256, BLOCK_K=64, GROUP_M=8, num_ctas=2, occupancy=2)
    elif gpu_capability[0] == 9:
        # sm90 (H100): num_ctas=1, occupancy={1,2}
        yield SimpleNamespace(BLOCK_M=64,  BLOCK_N=128, BLOCK_K=64, GROUP_M=8, num_ctas=1, occupancy=1)
        yield SimpleNamespace(BLOCK_M=128, BLOCK_N=64,  BLOCK_K=64, GROUP_M=8, num_ctas=1, occupancy=1)
        yield SimpleNamespace(BLOCK_M=128, BLOCK_N=128, BLOCK_K=64, GROUP_M=8, num_ctas=1, occupancy=1)
        yield SimpleNamespace(BLOCK_M=128, BLOCK_N=128, BLOCK_K=64, GROUP_M=8, num_ctas=1, occupancy=2)
    else:
        # Pre-Hopper: conservative tiles, occupancy=1
        yield SimpleNamespace(BLOCK_M=64,  BLOCK_N=128, BLOCK_K=32, GROUP_M=8, num_ctas=1, occupancy=1)
        yield SimpleNamespace(BLOCK_M=128, BLOCK_N=64,  BLOCK_K=32, GROUP_M=8, num_ctas=1, occupancy=1)
        yield SimpleNamespace(BLOCK_M=128, BLOCK_N=128, BLOCK_K=32, GROUP_M=8, num_ctas=1, occupancy=1)
```

**Why occupancy is biased low**: With two weight tile loads and two accumulators per CTA, the per-CTA resource footprint is ~2× a standard GEMM. On sm100+, `occupancy=2` forces the SM to fit two of these heavy CTAs simultaneously, often causing register spilling to local memory and degrading performance. Benchmarking data confirms `occupancy=1` consistently wins for this kernel type.

### Kernel Definition

```python
@ct.kernel  # No fixed hints — autotuned via replace_hints
def dual_gemm_fusion_kernel(
    Input,   # [M, K]
    W_gate,  # [N, K]
    W_up,    # [N, K]
    Out,     # [M, N]
    M: ConstInt, N: ConstInt, K: ConstInt,
    BLOCK_M: ConstInt, BLOCK_N: ConstInt, BLOCK_K: ConstInt,
    GROUP_M: ConstInt,
):
    """Fused dual-GEMM: out = activation(Input @ W_gate.T) * (Input @ W_up.T)"""
    pid_m, pid_n = swizzle_2d(M, N, BLOCK_M, BLOCK_N, GROUP_M)

    # Two accumulators — the defining characteristic of dual-GEMM fusion
    acc_gate = ct.full((BLOCK_M, BLOCK_N), 0.0, dtype=ct.float32)
    acc_up   = ct.full((BLOCK_M, BLOCK_N), 0.0, dtype=ct.float32)
    zero_pad = ct.PaddingMode.ZERO

    for k in range(ct.cdiv(K, BLOCK_K)):
        # One input tile shared across both GEMMs (saves 1 TMA load vs 2 separate GEMMs)
        x = ct.load(Input, index=(pid_m, k), shape=(BLOCK_M, BLOCK_K), padding_mode=zero_pad)
        # Two weight tiles — this is where the 2× SHMEM pressure comes from
        wg = ct.load(W_gate, index=(pid_n, k), shape=(BLOCK_N, BLOCK_K), padding_mode=zero_pad)
        wu = ct.load(W_up,   index=(pid_n, k), shape=(BLOCK_N, BLOCK_K), padding_mode=zero_pad)

        acc_gate = ct.mma(x, ct.transpose(wg), acc=acc_gate)
        acc_up   = ct.mma(x, ct.transpose(wu), acc=acc_up)

    # Activation + gating (SiLU shown; replace with GeGLU etc. as needed)
    gate = ct.astype(acc_gate, Input.dtype)
    up   = ct.astype(acc_up, Input.dtype)
    # ... silu(gate) * up ...
    ct.store(Out, index=(pid_m, pid_n), tile=out_tile)
```

### exhaustive_search + cache + ct.launch

```python
import os
from math import ceil
from cuda.tile.tune import exhaustive_search

# Module-level tune cache: (M, N, K, dtype, device) -> (best_cfg, tuned_kernel)
_dual_gemm_tune_cache: dict = {}

def run_dual_gemm_fusion(X, W_gate, W_up):
    M, K = X.shape
    N, _ = W_gate.shape
    Out = torch.empty((M, N), dtype=X.dtype, device=X.device)
    stream = torch.cuda.current_stream()

    # DISABLE_AUTOTUNE=1: skip search, use first config
    if os.environ.get("DISABLE_AUTOTUNE", "0") == "1":
        cfg = next(_dual_gemm_autotune_configs())
        tuned_kernel = ct.kernel(
            dual_gemm_fusion_kernel._pyfunc,
            num_ctas=cfg.num_ctas, occupancy=cfg.occupancy,
        )
        grid = (ceil(M / cfg.BLOCK_M) * ceil(N / cfg.BLOCK_N), 1, 1)
        ct.launch(
            stream, grid, tuned_kernel,
            (X, W_gate, W_up, Out, M, N, K,
             cfg.BLOCK_M, cfg.BLOCK_N, cfg.BLOCK_K, cfg.GROUP_M),
        )
        return Out

    cache_key = (M, N, K, X.dtype, str(X.device))
    if cache_key not in _dual_gemm_tune_cache:
        result = exhaustive_search(
            list(_dual_gemm_autotune_configs()),
            stream,
            lambda cfg: (ceil(M / cfg.BLOCK_M) * ceil(N / cfg.BLOCK_N), 1, 1),
            dual_gemm_fusion_kernel,
            lambda cfg: (
                X, W_gate, W_up, Out, M, N, K,
                cfg.BLOCK_M, cfg.BLOCK_N, cfg.BLOCK_K, cfg.GROUP_M,
            ),
            lambda cfg: {"num_ctas": cfg.num_ctas, "occupancy": cfg.occupancy},
        )
        best_cfg = result.best.config
        _dual_gemm_tune_cache[cache_key] = (
            best_cfg,
            ct.kernel(
                dual_gemm_fusion_kernel._pyfunc,
                num_ctas=best_cfg.num_ctas,
                occupancy=best_cfg.occupancy,
            ),
        )
    best_cfg, tuned_kernel = _dual_gemm_tune_cache[cache_key]
    ct.launch(
        stream,
        (ceil(M / best_cfg.BLOCK_M) * ceil(N / best_cfg.BLOCK_N), 1, 1),
        tuned_kernel,
        (X, W_gate, W_up, Out, M, N, K,
         best_cfg.BLOCK_M, best_cfg.BLOCK_N, best_cfg.BLOCK_K, best_cfg.GROUP_M),
    )
    return Out
```

**Key differences from Template 3 (standard matmul)**:
- `args_fn` passes **two** weight tensors (W_gate, W_up) — the kernel does dual GEMM internally.
- Search space biased toward **low occupancy** (`occupancy=1` preferred) due to 2× resource pressure.
- Tile sizes more conservative: avoid very large tiles (e.g., 512×256) that would exceed SHMEM budget with two weight tiles.
- `GROUP_M=8` typically fixed (same swizzle as standard matmul).

**When to use this template**: Kernel performs two or more GEMM operations in a single fused kernel, sharing input tiles across branches. Common in gated architectures: Linear+SiLU+GLU (LLaMA MLP), Linear+GeGLU (Gemma), Linear+ReGLU. If the kernel has only one GEMM, use Template 3 instead.

---

## Quick Reference: Which Template to Use

| Kernel Type | Template | Key Pattern |
|-------------|----------|-------------|
| SwiGLU, GeGLU, activation | Template 1 | Occupancy-only, fixed BLOCK_SIZE |
| RoPE (in-place forward) | Template 2 | Split-buffer during search, in-place after |
| RoPE (backward) | Template 2 (backward) | Same-buffer + ct.launch (no search) |
| LayerNorm, RMS LN | Template 1 | Occupancy-only |
| Dense matmul | Template 3 | Full tile search, per-arch configs |
| Persistent matmul | Template 4 | SM-bounded grid, GROUP_SIZE_M |
| FMHA forward | Template 5 | Cache (cfg, kernel) tuple, DISABLE_AUTOTUNE fallback |
| FMHA backward | Template 5 (backward) | Head-dim-dependent tile configs |
| FP8 W8A8 matmul | Template 6 | TMA + swap_ab + quant-aligned blocks |
| Grouped GEMM | Template 7 | Persistent + occupancy-only |
| Attention varlen | Template 8 | Multi-dim TILE_M x TILE_N x occ x num_ctas, variable-length seqs |
| Dual-GEMM fusion (Linear+GLUAct, GeGLU) | Template 9 | Dual accumulator, low occupancy (2× SHMEM/register pressure) |
| Memory-bound (CE Loss) | Template 1 | Occupancy-only [1,2,4,8]; warn user: <=2% gain; suggest codegen fixes (see "Further Optimization Suggestions" in SKILL.md) |
