# Parameter Space Design

How to design the autotune search space for each kernel type. Every config is a `SimpleNamespace` with fields read by `grid_fn`, `args_fn`, and `hints_fn`.

## Parameter Dimensions

CuTile autotune has fewer knobs than Triton (no `num_warps`, no `num_stages`):

| Parameter | Type | Passed via | Description |
|-----------|------|-----------|-------------|
| `TILE_SIZE_M`, `TILE_SIZE_N`, `TILE_SIZE_K` | `ct.Constant[int]` | `args_fn` | Tile dimensions — affect register pressure, shared memory, MMA utilization |
| `occupancy` | int | `hints_fn` | CTAs per SM — controls parallelism vs per-CTA resources |
| `num_ctas` | int | `hints_fn` | CTAs per CGA — enables TMA multicast cooperation (sm90+ only) |
| `GROUP_SIZE_M` | `ct.Constant[int]` | `args_fn` | L2 cache swizzle group size (matmul only, usually fixed at 8) |
| `swap_ab` | `ct.Constant[int]` | `args_fn` | MMA operand order (FP8 matmul only) |

## Per-Kernel-Type Search Spaces

### 1. Elementwise Kernels (SwiGLU, GeGLU, RoPE, LayerNorm, RMS LN)

**What to tune**: occupancy only. Tile/block size is determined by input dimensions at host side.

**Why**: These kernels have a single dominant dimension. BLOCK_SIZE was determined by sweep to be 1024 globally optimal on B200 (tested [256, 512, 1024, 2048, 4096, 8192]). Occupancy is the only remaining knob.

```python
from types import SimpleNamespace

def autotune_configs():
    """Standard occupancy search for all elementwise kernels."""
    for occ in [1, 2, 4, 8]:
        yield SimpleNamespace(occupancy=occ)
# Total: 4 configs. Search space upper bound: 8.
```

**Behavior by shape** (from A/B testing on B200):
- Small shapes (n_rows ≤ 512): autotune selects occ=1-2
- Large shapes (n_rows ≥ 1024): autotune selects occ=4-8

### 2. Matmul (Standard + Persistent)

**What to tune**: `TILE_SIZE_M` x `TILE_SIZE_N` x `TILE_SIZE_K` x `num_ctas` x `occupancy`, per architecture.

**Starting point for GEMM configs**: For new GEMM kernels, consider using `nvMatmulHeuristics` (CUTLASS 4.2+) to generate initial candidates. It returns 8-16 high-quality CTA shapes that achieve 96-99% of exhaustive-search peak performance at ~5x less compilation time. The production configs below were derived from this approach and manual tuning. See the [CUTLASS heuristics blog](https://developer.nvidia.com/blog/improving-gemm-kernel-auto-tuning-efficiency-on-nvidia-gpus-with-heuristics-and-cutlass-4-2/) for details.

**Config design**: Copy-paste-ready configs are in `kernel-type-templates.md`:
- Standard matmul → **Template 3** (`_matmul_autotune_configs`): 2-7 configs per arch, well under the 30-config limit
- Persistent matmul → **Template 4** (`_static_persistent_matmul_autotune_configs`): adds `GROUP_SIZE_M=8` (fixed, not tuned) and SM-bounded grid

Key design principles:
- sm100+: large tiles (128-512), `num_ctas=2-4`, `occupancy=1`
- sm120: small tiles (64-256), `num_ctas=1` only, `occupancy=1-4`
- sm90: medium tiles (32-128), `occupancy=2`, `num_ctas=1-2`
- Pre-Hopper: tiles ≤ 128×128, `num_ctas=1`, `occupancy=1-2`

Source: `ops/cutile/matmul.py`.

### 3. FMHA (Forward + Backward)

**What to tune**: `TILE_M` x `TILE_N` (+ `num_ctas` x `occupancy` on internal builds), per architecture. `TILE_D` equals `head_dim` and is not tuned.

**Config design**: Copy-paste-ready configs are in `kernel-type-templates.md`:
- FMHA forward → **Template 5** (`_fmha_autotune_configs`): 1-4 configs per arch
- FMHA backward (dK/dV, dQ) → **Template 5** backward section: head_dim-dependent tile ranges

Key design principles:
- `TILE_D = head_dim` (not tuned); tune `TILE_M × TILE_N` (+ `num_ctas × occupancy` in internal builds)
- sm100+/sm90: TILE_M=128-256, TILE_N=128, with `num_ctas ∈ {1,2}`
- sm120/pre-Hopper: TILE_M=64-128, TILE_N=64, `num_ctas=1`
- Release builds: tile sizes only (no `num_ctas`/`occupancy`), keyed by `next_power_of_2(head_dim)`
- Backward: separate configs for dK/dV and dQ, head_dim-dependent tile tables

Source: `ops/cutile/attention.py`.

### 4. FP8 Matmul (W8A8 Block Quantized)

**What to tune**: `BLOCK_SIZE_M` x `occupancy` x `swap_ab`.

**Constraints**:
- `BLOCK_SIZE_K` must equal `group_k` (quantization block alignment)
- `BLOCK_SIZE_N` must equal `group_n` (quantization block alignment)
- These are fixed by the quantization scheme, not tuned

```python
def _fp8_matmul_autotune_configs(M, group_k, group_n):
    """FP8 matmul configs with quantization-aligned block sizes."""
    BLOCK_SIZE_K = group_k  # fixed: must match quantization group
    BLOCK_SIZE_N = group_n  # fixed: must match quantization group
    for block_m in [16, 32, 64, 128]:
        if block_m > M:
            continue  # prune: BLOCK_SIZE_M > M is wasteful
        for occ in [1, 2, 4]:
            for swap in [0, 1]:
                yield SimpleNamespace(
                    BLOCK_SIZE_M=block_m, BLOCK_SIZE_N=BLOCK_SIZE_N,
                    BLOCK_SIZE_K=BLOCK_SIZE_K, GROUP_SIZE_M=8,
                    occupancy=occ, swap_ab=swap,
                )
# Total: up to 24 configs (with pruning by M)
```

### 5. Grouped GEMM

**What to tune**: occupancy only (after learning from compilation timeout incident).

Block sizes are determined by heuristic at host side. Persistent scheduling uses `grid=NUM_SMS`.

```python
# Same as elementwise — occupancy only
def autotune_configs():
    for occ in [1, 2, 4, 8]:
        yield SimpleNamespace(occupancy=occ)
```

**Why not tune block sizes**: 32-config block-size search caused >5min compilation timeout on all backward variants. Heuristic block sizes + occupancy autotune matches the same performance.

## Cross-Architecture Adaptation Patterns

### Pattern 1: Conditional Yield (Recommended for autotune)

Generate different configs per detected GPU capability. This is the standard pattern for all kernel types.

```python
def _my_autotune_configs():
    gpu_capability = torch.cuda.get_device_capability()
    if gpu_capability in [(12, 0), (12, 1)]:  # sm120
        yield SimpleNamespace(...)
    elif gpu_capability[0] == 9:               # sm90
        yield SimpleNamespace(...)
    elif gpu_capability[0] < 9:                # pre-Hopper
        yield SimpleNamespace(...)
    else:                                       # sm100+ default
        yield SimpleNamespace(...)
```

### Pattern 2: ct.ByTarget (For fixed hints, no autotune)

Set architecture-specific fixed values in the kernel decorator. Use when you know the best config per arch and don't need runtime tuning.

```python
@ct.kernel(num_ctas=ct.ByTarget(sm_100=2, sm_120=1, default=1))
def my_kernel(...): ...

@ct.kernel(occupancy=ct.ByTarget(sm_100=8, sm_120=4, default=2))
def my_kernel(...): ...
```

### Pattern 3: Manual Dispatch (For 2-3 fixed options)

Pre-compile a few kernel variants and select at runtime based on problem size. More efficient than autotune when the search space is tiny.

```python
# Pre-compiled variants
_SOFTMAX_OCC8 = ...  # compiled with occupancy=8
_SOFTMAX_OCC2 = ...  # compiled with occupancy=2

def _select_kernel(n_cols):
    if n_cols <= 4096:
        return _SOFTMAX_OCC8
    else:
        return _SOFTMAX_OCC2
```

## grid_fn Design Patterns

### Pattern A: Simple Tile Coverage

For standard matmul and elementwise kernels. Grid = ceil(dim / tile_size) for each dimension.

```python
from math import ceil
# 2D matmul
grid_fn=lambda cfg: (ceil(M / cfg.TILE_SIZE_M) * ceil(N / cfg.TILE_SIZE_N), 1, 1)
# 1D elementwise
grid_fn=lambda cfg: (cdiv(n_elements, BLOCK_SIZE),)
```

### Pattern B: Persistent Kernel

Grid is bounded by SM count, not problem size. Each CTA processes multiple tiles in a loop.

```python
NUM_SMS = torch.cuda.get_device_properties("cuda").multi_processor_count
grid_fn=lambda cfg: (
    min(NUM_SMS // cfg.num_ctas, ceil(M / cfg.TILE_M) * ceil(N / cfg.TILE_N)) * cfg.occupancy,
    1, 1,
)
```

### Pattern C: 2D Grid (Attention)

One dimension for sequence tiles, another for batch * heads.

```python
grid_fn=lambda cfg: (ceil(q_len / cfg.TILE_M), batch_size * num_heads, 1)
```

### Pattern D: Multi-Head Elementwise

Two grid dimensions: one for spatial, one for heads.

```python
grid_fn=lambda cfg: (n_rows, n_heads, 1)
```

## Pruning Rules

To keep compilation fast, apply these pruning rules:

1. **Architecture filter**: Only yield configs for the detected `torch.cuda.get_device_capability()`. Never test sm120 configs on sm100.
2. **Size filter**: Skip `BLOCK_SIZE_M > M` or `TILE_M > seq_len` (wasteful tiles).
3. **num_ctas constraint**: `num_ctas > 1` only on sm90+. Pre-Hopper must use `num_ctas=1`.
4. **Tile alignment**: For FP8, `BLOCK_SIZE_K == group_k` and `BLOCK_SIZE_N == group_n` (quantization alignment). Non-aligned configs are incorrect, not just slow.
5. **Total count**: Hard limit ≤ 30 configs. Soft target: 3-7 per architecture.
6. **Power of 2**: Tile sizes should be powers of 2 for efficient hardware utilization.

## Adapting Search Space for Your Problem

The per-architecture configs in the sections above are **starting points** derived from production kernels with typical problem sizes. They are not universally optimal — you may need to adapt them based on:

- **Problem size**: If `max_dim / TILE_SIZE < 16` for any tile dimension, parallelism is too low. Add smaller tile options (e.g., 64×64 instead of only 256×256) to ensure enough CTAs for full SM occupancy.
- **Kernel complexity**: Kernels that fuse multiple operations (dual-GEMM, GEMM+activation) use more registers and shared memory per CTA. Use conservative (smaller) tile sizes compared to standalone matmul — e.g., start with 128×128 instead of 256×256.
- **Non-standard shapes**: Tall-skinny matrices (M >> N or N >> M) benefit from asymmetric tiles (e.g., 256×64 instead of 256×256). Match the tile aspect ratio to the problem shape.
- **When in doubt**: Start with the recommended configs, benchmark, and compare against the fixed-config baseline. If autotuning shows no improvement or regression, expand the search space with additional tile sizes and re-benchmark. Iterating on measured results is more reliable than guessing.

## Summary Table

| Kernel Type | Tuned Parameters | Configs/Arch | Search Limit | Expected Benefit |
|-------------|-----------------|--------------|-------------|-----------------|
| Elementwise | occupancy | 4 | 8 | 2-15% |
| Matmul | tile_m x tile_n x tile_k x num_ctas x occ | 2-7 | 30 | 5-30% |
| FMHA | tile_m x tile_n (+ num_ctas x occ) | 1-4 | 30 | 5-20% |
| FP8 Matmul | block_m x occ x swap_ab | up to 24 | 30 | 10-50% |
| Grouped GEMM | occupancy | 4 | 8 | 2-10% |
| CE Loss / memory-bound* | occupancy | 4 | 8 | 0-3% (low benefit) |

\* Historical experiment: occupancy × num_ctas (12 configs) was tried on CE Loss and showed only 2.5% improvement (0.79x → 0.81x vs Triton) — reverted because compilation cost outweighed the marginal benefit. Occupancy-only (4 configs) achieves the same result. If asked to add autotune to a memory-bound kernel, use occupancy-only search (4 configs). Warn the user that the benefit is small and suggest codegen-level improvements (see "Further Optimization Suggestions" in SKILL.md).
