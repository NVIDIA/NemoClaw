# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


"""
GEMM (C = A @ B) - CuTile Autotuned Launch (AFTER autotuning)

Refactors fixed_launch.py to use exhaustive_search + cache + ct.launch with a
full search over:
  - TILE_SIZE_M, TILE_SIZE_N, TILE_SIZE_K  (tile dimensions)
  - occupancy                              (CTAs per SM)
  - num_ctas                               (CGA size, sm90+ only)

Teaching points
---------------
- Tile sizes are compile-time constants: passed via args_fn as ct.Constant[int].
- Grid depends on tile sizes: grid_fn reads cfg.TILE_M / cfg.TILE_N.
- num_ctas is hardware-gated: only yielded for sm90+.
- Total configs kept <= 30 to avoid compilation timeout (Pitfall #2).
- exhaustive_search benchmarks every config; the best config and tuned kernel
  are cached as a tuple keyed on (M, K, N, dtype, device) so subsequent calls
  skip the search entirely (Pitfall #7: avoid replace_hints on hot path).
- DISABLE_AUTOTUNE=1 falls back to ct.launch with the first config.
"""

import math
import os
from types import SimpleNamespace

import cuda.tile as ct
import torch
from cuda.tile.tune import exhaustive_search

# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _swizzle_2d(M: int, N: int, TILE_M: int, TILE_N: int, GROUP_M: int = 8):
    bid = ct.bid(0)
    num_bid_m = ct.cdiv(M, TILE_M)
    num_bid_n = ct.cdiv(N, TILE_N)
    tiles_per_group = GROUP_M * num_bid_n
    group_id = bid // tiles_per_group
    first_m = group_id * GROUP_M
    group_m = min(num_bid_m - first_m, GROUP_M)
    bid_m = first_m + (bid % group_m)
    bid_n = (bid % tiles_per_group) // group_m
    return bid_m, bid_n


# ---------------------------------------------------------------------------
# Kernel — no fixed occupancy in decorator; hints supplied via replace_hints
# ---------------------------------------------------------------------------


@ct.kernel
def matmul_kernel(
    A,
    B,
    C,
    TILE_M: ct.Constant[int],
    TILE_N: ct.Constant[int],
    TILE_K: ct.Constant[int],
):
    """
    Tiled GEMM: C = A @ B.

    TILE_M/N/K are compile-time constants injected per-config by args_fn.
    Occupancy and num_ctas are injected by replace_hints at compile time.
    """
    M = A.shape[0]
    N = B.shape[1]
    bid_m, bid_n = _swizzle_2d(M, N, TILE_M, TILE_N)

    num_k_tiles = ct.num_tiles(A, axis=1, shape=(TILE_M, TILE_K))
    acc = ct.full((TILE_M, TILE_N), 0, dtype=ct.float32)
    zero = ct.PaddingMode.ZERO

    a_dtype = ct.tfloat32 if A.dtype == ct.float32 else A.dtype

    for k in range(num_k_tiles):
        a = ct.load(A, index=(bid_m, k), shape=(TILE_M, TILE_K), padding_mode=zero)
        a = ct.astype(a, a_dtype)
        b = ct.load(B, index=(k, bid_n), shape=(TILE_K, TILE_N), padding_mode=zero)
        b = ct.astype(b, a_dtype)
        acc = ct.mma(a, b, acc)

    acc = ct.astype(acc, C.dtype)
    ct.store(C, index=(bid_m, bid_n), tile=acc)


# ---------------------------------------------------------------------------
# Search space — full search (tile sizes + occupancy + num_ctas)
# Total configs must stay <= 30 (Pitfall #2: compilation timeout)
# ---------------------------------------------------------------------------


def _matmul_autotune_configs():
    """
    Full GEMM search space.

    Tile size choices: 3 x 3 x 2 = 18 (M x N x K combinations)
    Occupancy: 2 values
    num_ctas: 1 or 2 (sm90+ only; arch-gated)

    sm90+ total: 18 x 2 x 2 = 72  -> too many; prune to keep <= 30.
    Strategy: fix num_ctas=1 for all, add num_ctas=2 only for the best tile pairs.
    Final count: 18 x 2 + 4 x 1 = 40.  Still > 30 -- trim tile choices.
    Simplified: 9 tile combos x 2 occ + 3 with num_ctas=2 = 21 configs (sm90+),
                9 tile combos x 2 occ                      = 18 configs (else).
    """
    is_sm90_plus = torch.cuda.get_device_capability()[0] >= 9

    tile_configs = [
        (64, 64, 32),
        (64, 128, 32),
        (128, 64, 32),
        (128, 128, 32),
        (128, 256, 64),
        (256, 128, 64),
        (64, 64, 64),
        (128, 128, 64),
        (256, 256, 64),
    ]

    for tm, tn, tk in tile_configs:
        for occ in [2, 4]:
            yield SimpleNamespace(TILE_M=tm, TILE_N=tn, TILE_K=tk, occupancy=occ, num_ctas=1)

    # num_ctas=2 variants (sm90+ only; limited to 3 promising configs to stay <= 30 total)
    if is_sm90_plus:
        for tm, tn, tk in [(128, 128, 64), (128, 256, 64), (256, 128, 64)]:
            yield SimpleNamespace(TILE_M=tm, TILE_N=tn, TILE_K=tk, occupancy=2, num_ctas=2)


# ---------------------------------------------------------------------------
# Host wrapper
# ---------------------------------------------------------------------------

_autotune_cache = {}  # (M, K, N, dtype, device_str) -> (best_cfg, tuned_kernel)


def matmul(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    """
    GEMM C = A @ B with exhaustive_search + cache (full tile-size + occupancy search).

    On first call for a given (M, K, N, dtype, device), exhaustive_search benchmarks
    all configs and picks the best tile sizes, occupancy, and num_ctas.  Both the config
    and tuned kernel are cached so subsequent calls go straight to ct.launch with zero
    overhead.

    Args:
        a: (M, K) tensor
        b: (K, N) tensor

    Returns:
        c: (M, N) tensor
    """
    assert a.is_cuda and b.is_cuda
    M, K = a.shape
    K2, N = b.shape
    assert K == K2, f"Shape mismatch: {a.shape} @ {b.shape}"

    a = a.contiguous()
    b = b.contiguous()
    c = torch.empty((M, N), device=a.device, dtype=a.dtype)

    stream = torch.cuda.current_stream()

    # DISABLE_AUTOTUNE=1: use first config for CI
    if os.environ.get("DISABLE_AUTOTUNE", "0") == "1":
        cfg = next(_matmul_autotune_configs())
        grid = (math.ceil(M / cfg.TILE_M) * math.ceil(N / cfg.TILE_N), 1, 1)
        tuned_kernel = matmul_kernel.replace_hints(occupancy=cfg.occupancy, num_ctas=cfg.num_ctas)
        ct.launch(
            stream,
            grid,
            tuned_kernel,
            (a, b, c, cfg.TILE_M, cfg.TILE_N, cfg.TILE_K),
        )
        return c

    # Tune once, cache (best_cfg, tuned_kernel) keyed on problem shape + dtype + device
    cache_key = (M, K, N, a.dtype, str(a.device))
    if cache_key not in _autotune_cache:
        configs = list(_matmul_autotune_configs())

        def grid_fn(cfg):
            return (math.ceil(M / cfg.TILE_M) * math.ceil(N / cfg.TILE_N), 1, 1)

        def args_fn(cfg):
            return (a, b, c, cfg.TILE_M, cfg.TILE_N, cfg.TILE_K)

        def hints_fn(cfg):
            return {"occupancy": cfg.occupancy, "num_ctas": cfg.num_ctas}

        result = exhaustive_search(configs, stream, grid_fn, matmul_kernel, args_fn, hints_fn)
        best_cfg = result.best.config
        tuned_kernel = matmul_kernel.replace_hints(occupancy=best_cfg.occupancy, num_ctas=best_cfg.num_ctas)
        _autotune_cache[cache_key] = (best_cfg, tuned_kernel)

    # Launch with the cached best config + tuned kernel (no replace_hints on hot path)
    cfg, tuned_kernel = _autotune_cache[cache_key]
    grid = (math.ceil(M / cfg.TILE_M) * math.ceil(N / cfg.TILE_N), 1, 1)
    ct.launch(
        stream,
        grid,
        tuned_kernel,
        (a, b, c, cfg.TILE_M, cfg.TILE_N, cfg.TILE_K),
    )

    return c


# ---------------------------------------------------------------------------
# Tests / timing
# ---------------------------------------------------------------------------


def test_matmul():
    print("Testing GEMM autotuned-launch implementation...")
    torch.manual_seed(42)

    test_cases = [
        (512, 512, 512, torch.float16),
        (1024, 512, 2048, torch.bfloat16),
        (256, 768, 768, torch.float32),
    ]

    all_passed = True
    for M, K, N, dtype in test_cases:
        a = torch.randn(M, K, device="cuda", dtype=dtype)
        b = torch.randn(K, N, device="cuda", dtype=dtype)

        c_ct = matmul(a, b)
        c_ref = torch.matmul(a.float(), b.float()).to(dtype)

        atol = 0.1 if dtype in (torch.float16, torch.bfloat16) else 1e-2
        passed = torch.allclose(c_ct.float(), c_ref.float(), atol=atol, rtol=1e-2)
        max_diff = (c_ct.float() - c_ref.float()).abs().max().item()
        all_passed = all_passed and passed
        print(
            f"  M={M:4d} K={K:4d} N={N:4d} {str(dtype):15s}  max_diff={max_diff:.3e}  {'PASSED' if passed else 'FAILED'}"
        )

    print()
    print(f"Overall: {'ALL TESTS PASSED' if all_passed else 'SOME TESTS FAILED'}")
    return all_passed


def benchmark_matmul(
    M: int = 4096, K: int = 4096, N: int = 4096, dtype=torch.float16, n_warmup: int = 5, n_rep: int = 50
):
    a = torch.randn(M, K, device="cuda", dtype=dtype)
    b = torch.randn(K, N, device="cuda", dtype=dtype)

    # First call triggers autotuning
    print("Running autotune (first call)...")
    matmul(a, b)

    for _ in range(n_warmup):
        matmul(a, b)

    torch.cuda.synchronize()
    start = torch.cuda.Event(enable_timing=True)
    end = torch.cuda.Event(enable_timing=True)
    start.record()
    for _ in range(n_rep):
        matmul(a, b)
    end.record()
    torch.cuda.synchronize()

    ms = start.elapsed_time(end) / n_rep
    flop = 2 * M * N * K
    tflops = flop / (ms * 1e-3) / 1e12
    print(f"Autotuned GEMM M={M} K={K} N={N}: {ms:.3f} ms  {tflops:.2f} TFLOP/s")


if __name__ == "__main__":
    test_matmul()
    print()
    benchmark_matmul()
