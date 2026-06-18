# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


"""
GEMM (C = A @ B) - CuTile Fixed-Config Launch (BEFORE autotuning)

Demonstrates a CuTile tiled GEMM with hardcoded tile sizes and occupancy
passed to ct.launch.  The autotuned version (autotuned_launch.py) replaces
this with a full search over TILE_SIZE_M, TILE_SIZE_N, TILE_SIZE_K, occupancy,
and (on sm90+) num_ctas.

Kernel shape:
  A: (M, K)  B: (K, N)  C: (M, N)
  Each block computes a TILE_M x TILE_N tile, accumulating over K in strips.
"""

import math

import cuda.tile as ct
import torch

# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _swizzle_2d(M: int, N: int, TILE_M: int, TILE_N: int, GROUP_M: int = 8):
    """Block-swizzle for L2 cache locality (L2 reuse across tiles)."""
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
# Kernel
# ---------------------------------------------------------------------------


@ct.kernel(occupancy=2)
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

    Each block computes one (TILE_M, TILE_N) output tile by iterating over
    K-strips of width TILE_K.  Accumulator held in float32 for precision.
    """
    M = A.shape[0]
    N = B.shape[1]
    bid_m, bid_n = _swizzle_2d(M, N, TILE_M, TILE_N)

    num_k_tiles = ct.num_tiles(A, axis=1, shape=(TILE_M, TILE_K))
    acc = ct.full((TILE_M, TILE_N), 0, dtype=ct.float32)
    zero = ct.PaddingMode.ZERO

    # Use tf32 for fp32 inputs to enable tensor-core acceleration
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
# Host wrapper
# ---------------------------------------------------------------------------

TILE_M = 128
TILE_N = 128
TILE_K = 32


def matmul(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    """
    GEMM C = A @ B with fixed tile sizes and occupancy.

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

    grid = (math.ceil(M / TILE_M) * math.ceil(N / TILE_N), 1, 1)

    ct.launch(
        torch.cuda.current_stream(),
        grid,
        matmul_kernel,
        (a, b, c, TILE_M, TILE_N, TILE_K),
    )

    return c


# ---------------------------------------------------------------------------
# Tests / timing
# ---------------------------------------------------------------------------


def test_matmul():
    print("Testing GEMM fixed-launch implementation...")
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
    M: int = 4096, K: int = 4096, N: int = 4096, dtype=torch.float16, n_warmup: int = 20, n_rep: int = 100
):
    a = torch.randn(M, K, device="cuda", dtype=dtype)
    b = torch.randn(K, N, device="cuda", dtype=dtype)

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
    print(f"Fixed-launch GEMM M={M} K={K} N={N}: {ms:.3f} ms  {tflops:.2f} TFLOP/s")


if __name__ == "__main__":
    test_matmul()
    print()
    benchmark_matmul()
