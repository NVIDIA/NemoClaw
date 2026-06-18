# Hardware Constraints

Architecture-specific constraints that affect autotune parameter selection. All data is from production kernel tuning on B200 (sm100), 5090 (sm120), H100 (sm90), and A100 (sm80).

## Architecture Summary

| Property | sm90 (H100) | sm100 (B200) | sm103 (GB300) | sm120 (5090) | sm80/sm86 (A100/A10) |
|----------|-------------|-------------|--------------|-------------|----------------------|
| Shared memory / SM | 228 KB | 228 KB | 228 KB | 128 KB | 164 KB (A100) |
| Register file / SM | 256 KB | 256 KB | 256 KB | 256 KB | 256 KB |
| SMs | 132 | 128 | 152 | 84 | 108 (A100) |
| Max CTAs / SM | 32* | 32* | 32* | 32* | 32* |
| CGA support (num_ctas>1) | Yes | Yes | Yes | No (use num_ctas=1) | No (use num_ctas=1) |
| TMA multicast | Yes | Yes | Yes | No | No |
| Preferred tile size | Medium (64-128) | 64-256 (standard); 512 only in specific matmul | same as sm100 | Small (64-128) | Small (64-128) |
| Preferred num_ctas | 1-2 | 2-4 | 2-4 | 1 | 1 only |
| Preferred occupancy | 2 | 1 | 1 | 1-4 | 1-2 |

\* Max CTAs / SM is a practical CuTile scheduling limit that depends on shared memory allocation per CTA. The hardware maximum may be higher.

## sm100 (Blackwell B200/B100)

### Key Characteristics

- Large shared memory enables large tiles (256x256 and above)
- TMA multicast benefits from multi-CTA cooperation (num_ctas=2-4)
- occupancy=1 is often optimal because each CTA uses substantial shared memory for large tiles
- Best for compute-heavy workloads (matmul, FMHA)

### Recommended Configs

See `kernel-type-templates.md` for copy-paste configs:
- Standard matmul → Template 3 (sm100+ branch): tiles 128-512, `num_ctas=1-4`, `occupancy=1`
- Persistent matmul → Template 4 (sm100+ branch): tiles 128-512, `num_ctas=2-4`, `occupancy=1`
- FMHA → Template 5 (sm90/sm100+ branch): TILE_M=128-256, `num_ctas=1-2`, `occupancy=1-2`

### Performance Data (B200)

Grouped GEMM persistent kernel vs Triton (kernel-only via CUDAGraph):

| Shape (E, T, N, K) | Triton | CuTile | CuTile/Triton |
|---------------------|--------|--------|---------------|
| (8, 128, 512, 512) | 8.9us | 5.4us | 0.60x (faster) |
| (8, 256, 2048, 1024) | 92.6us | 29.8us | 0.32x |
| (16, 128, 2048, 1024) | 147.4us | 37.8us | 0.26x |

## sm103 (Blackwell GB300)

sm_103 is a variant of sm_100 with 152 SMs (vs 128 on B200). SMEM, register file, CGA, and TMA multicast behavior are identical to sm_100. Use the same configs as sm_100 — `gpu_capability[0] >= 10` covers both. The extra SMs may shift the occupancy/num_ctas sweet spot slightly (more SMs → higher parallelism → `num_ctas=2` can be more beneficial), but the same template configs apply.

Detect with: `torch.cuda.get_device_capability() == (10, 3)`

## sm120 (Blackwell 5090)

### Key Characteristics

- Smaller shared memory than sm100 → limits tile sizes
- No benefit from multi-CTA TMA multicast — always use num_ctas=1
- num_ctas=1 is the only correct choice for sm120
- Wider occupancy range (1-4) can be beneficial
- Small to medium tiles perform better

### Recommended Configs

See `kernel-type-templates.md` for copy-paste configs:
- Standard matmul → Template 3 (sm120 branch): tiles 64-256, `num_ctas=1`, `occupancy=1-2`
- Persistent matmul → Template 4 (sm120 branch): tiles 64-128, `num_ctas=1`, `occupancy=1-4`
- FMHA → Template 5 (sm120 branch): TILE_M=64, `num_ctas=1`, `occupancy=2`

### Key Difference from sm100

| Dimension | sm100 (B200) | sm120 (5090) |
|-----------|-------------|-------------|
| TILE_M range | 128-512 | 64-256 |
| TILE_N range | 128-512 | 64-256 |
| num_ctas | 1-4 | 1 only |
| occupancy | typically 1 | 1-4 |
| Best FMHA TILE_M | 256 | 64 |

## sm90 (Hopper H100)

### Key Characteristics

- First architecture with CGA support (num_ctas > 1)
- TMA available; multicast less effective than on Blackwell
- occupancy=2 is the sweet spot for most workloads
- Medium tile sizes work best

### Recommended Configs

See `kernel-type-templates.md` for copy-paste configs:
- Standard matmul → Template 3 (sm90 branch): 7 configs, tiles 32-128, `num_ctas=1`, `occupancy=2`
- Persistent matmul → Template 4 (sm90 branch): 6 configs, tiles 64-256, `num_ctas=1-2`, `occupancy=1-2`
- FMHA → Template 5 (sm90/sm100+ branch): 4 configs, TILE_M=128-256, `num_ctas=1-2`

## Ampere (sm80/sm86, e.g. A100/A10)

### Key Constraints

- **No CGA support**: `num_ctas` must always be 1
- **No hardware TMA**: `ct.load`/`ct.store` with `allow_tma=True` falls back to `cp.async` emulation; use gather/scatter paths
- **Smaller tiles required**: tiles larger than 128×128 exceed the register budget and cause spilling
- `occupancy ∈ {1, 2}` — higher values cause register pressure for complex kernels

### Recommended Configs

See `kernel-type-templates.md` for copy-paste configs:
- Standard matmul → Template 3 (pre-Hopper branch): tiles ≤ 128×128, `num_ctas=1`, `occupancy=1`
- Persistent matmul → Template 4 (pre-Hopper branch): add `GROUP_SIZE_M=8`, restrict `TILE_K`
- FMHA → Template 5 (pre-Hopper branch): TILE_M/N ∈ {64, 128}, `num_ctas=1`

Key constraint: TILE_M/N ≤ 128 (larger tiles spill on sm80). TILE_K ∈ {32, 64, 128}. `occupancy ∈ {1, 2}`.

> **Config count**: if adding SM90/SM100+ branches pushes the total above 30, apply arch-conditional yield (yield only for the current arch) to stay within the ≤30 config limit.

## num_ctas Constraints

`num_ctas` (Cooperative Group Array size) has strict hardware constraints:

| Architecture | Supported num_ctas | Notes |
|-------------|-------------------|-------|
| sm90 (H100) | 1, 2, 4 | CGA support; TMA multicast with num_ctas > 1 |
| sm100 (B200) | 1, 2, 4 | Full CGA; best TMA multicast |
| sm103 (GB300) | 1, 2, 4 | Same as sm100; 152 SMs |
| sm120 (5090) | 1 only | CGA hardware exists but multi-CTA yields no benefit in practice; always use num_ctas=1 |
| sm80/sm86 (Ampere) | 1 only | No CGA support; >1 will error |

### Rules

1. Always include `num_ctas=1` as a fallback config for any architecture
2. Only add `num_ctas > 1` for sm90+ in the search space
3. On sm120, even though CGA is supported, `num_ctas=1` wins in practice
4. `num_ctas` divides the grid: if `grid = (N,)`, each CGA gets `N // num_ctas` blocks. Ensure grid is divisible.
5. Multi-CTA benefits matmul-class kernels most (TMA multicast for shared K tiles)

## TMA vs Gather Selection

TMA (Tensor Memory Accelerator) provides hardware-accelerated bulk memory transfers. Available on sm90+.

### When to Use TMA

| Pattern | Use TMA? | Reason |
|---------|----------|--------|
| 2D tile loads (matmul A, B) | Yes | Significant bandwidth improvement |
| 2D tile stores (matmul C) | Yes | Hardware-accelerated store |
| 1D element access | No | TMA requires minimum contig_dim * elem_size >= 16 bytes |
| Small scatter/gather | No | TMA overhead exceeds benefit |
| Scale tensors (FP8 As, Bs) | No | Too small; gather is more efficient |

### TMA Load Syntax

```python
# TMA load: tile-indexed, requires contiguous layout
a = ct.load(A, index=(pid_m, k_tile), shape=(BLOCK_SIZE_M, BLOCK_SIZE_K),
            order=(0, 1), latency=3, allow_tma=True)

# TMA store
ct.store(C, index=(pid_m, pid_n), tile=result, order=(0, 1), allow_tma=True)
```

### Gather Load Syntax (Fallback)

```python
# 2D gather: element-indexed, always works
a = ct.gather(A, (offs_m[:, None], offs_k[None, :]),
              check_bounds=True, padding_value=0)

# 1D gather
x = ct.gather(data, offsets, padding_value=0)
```

### Impact on Autotune

FP8 GEMM ablation study (5090, 1024x2048x1024):

| Factor | Impact when removed |
|--------|-------------------|
| TMA → gather | +17.5% slower |
| Scalar b_s → vector b_s | +34.5% slower |
| Remove latency hints | +18.6% slower |

TMA is a code-level choice, not an autotune parameter. Choose TMA vs gather at implementation time, not at autotune time.

## Tile Size Constraints

### Minimum Tile Sizes

- MMA instruction minimum: 16x16 for most operations
- Practical minimum: 32x32 (below this, instruction overhead dominates)

### Maximum Tile Sizes

Bounded by shared memory. Rule of thumb:

| Architecture | Max practical tile (M x N) | With TILE_K=64 |
|-------------|---------------------------|----------------|
| sm100 (B200) | 512x256 | Yes, with occupancy=1, num_ctas=1 |
| sm120 (5090) | 256x256 | Tight on shared memory |
| sm90 (H100) | 256x256 | Possible but occupancy drops |

### Power-of-2 Requirement

Tile sizes should always be powers of 2 for efficient hardware utilization:
- Valid: 32, 64, 128, 256, 512
- Invalid: 48, 96, 160, 192 (won't error but will be suboptimal)

### TILE_K Typical Values

TILE_K controls the inner loop iteration size. Common values:

| Architecture | TILE_K values | Notes |
|-------------|--------------|-------|
| sm100 | 32, 64, 128 | 128 possible with large tiles |
| sm120 | 32, 64 | 128 may exceed shared memory |
| sm90 | 32, 64 | Standard range |

## Compilation Time vs Config Complexity

Each unique (tile_sizes + hints) combination triggers a full kernel recompilation. Compilation time depends on:

| Factor | Impact |
|--------|--------|
| Tile size | Larger tiles → more instructions → longer compile |
| num_ctas > 1 | CGA coordination adds compile complexity |
| Kernel complexity (loops, branches) | More code → longer compile |
| FP8 vs standard dtype | FP8 adds scale computation → slightly longer |

**Measured compilation times** (approximate):

| Configs | Total Wall Time | Per Config |
|---------|----------------|------------|
| 4 (occ only) | 2-4s | ~0.5-1s |
| 12 (occ x num_ctas) | 5-12s | ~0.5-1s |
| 24 (block_m x occ x swap_ab) | 10-24s | ~0.5-1s |
| 32 (full tile search) | >5min (TIMEOUT) | >10s for complex tiles |

**Hard limit**: Keep total configs in final code ≤ 30. Beyond this, compilation will timeout or take unacceptably long.

## Occupancy Guidelines per Kernel Type

| Kernel Type | Best Occupancy Range | Rationale |
|-------------|---------------------|-----------|
| Matmul (large tiles) | 1 | Large tiles use most shared memory |
| Matmul (small tiles) | 2-4 | Small tiles leave room for more CTAs |
| FMHA forward | 1-2 | Moderate shared memory usage |
| Elementwise (small shapes) | 1-2 | Low parallelism needed |
| Elementwise (large shapes) | 4-8 | High parallelism beneficial |
| Persistent kernels | 1-2 (sm100), 2-4 (sm120) | Architecture-dependent |

## Latency Hints

`ct.load` supports a `latency` parameter that hints to the compiler how far ahead to prefetch:

```python
# Higher latency = more prefetch distance = better for streaming access
k = ct.load(K, index=(...), shape=(...), latency=2)   # moderate prefetch
v = ct.load(V, index=(...), shape=(...), latency=4)   # aggressive prefetch
```

Latency hints are set at code level, not via autotune. They significantly impact performance (18.6% in FP8 GEMM ablation) but are not a tunable parameter.

## Summary: Architecture Selection Cheat Sheet

When writing autotune configs, use this quick reference:

```python
gpu = torch.cuda.get_device_capability()

if gpu in [(12, 0), (12, 1)]:
    # sm120 (5090): small tiles, num_ctas=1, occupancy=1-4
    pass
elif gpu[0] < 9:
    # Ampere (sm80/sm86): num_ctas=1 only, smaller tiles
    pass
elif gpu[0] == 9:
    # sm90 (H100): medium tiles, occupancy=2, num_ctas=1-2
    pass
else:
    # sm100+ (Blackwell B200): large tiles, num_ctas=2-4, occupancy=1
    pass
```
