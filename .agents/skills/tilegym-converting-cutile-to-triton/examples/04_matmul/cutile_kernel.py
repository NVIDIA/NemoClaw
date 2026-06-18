# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0

#

"""
Matrix Multiplication (GEMM) - cuTile Implementation

This file demonstrates the cuTile equivalent of the CUDA/Triton matmul kernel.
Key translation patterns:
- Triton tl.dot → cuTile ct.mma for tensor core acceleration
- Triton tiled loads → cuTile ct.load with index-based tile access
- Triton pointer arithmetic → cuTile tile-based indexing
- Automatic tensor core usage with ct.mma

cuTile uses high-level tile abstractions for cleaner GEMM implementations.
"""

import math

import cuda.tile as ct
import torch


def swizzle_2d(M, N, TILE_SIZE_M, TILE_SIZE_N, GROUP_SIZE_M):
    """
    2D block swizzling for better L2 cache utilization.
    Groups blocks to improve data locality.
    """
    bid = ct.bid(0)
    num_bid_m = ct.cdiv(M, TILE_SIZE_M)
    num_bid_n = ct.cdiv(N, TILE_SIZE_N)
    num_bid_in_group = GROUP_SIZE_M * num_bid_n
    group_id = bid // num_bid_in_group
    first_bid_m = group_id * GROUP_SIZE_M
    group_size_m = min(num_bid_m - first_bid_m, GROUP_SIZE_M)
    bid_m = first_bid_m + (bid % group_size_m)
    bid_n = (bid % num_bid_in_group) // group_size_m
    return bid_m, bid_n


@ct.kernel(num_ctas=ct.ByTarget(sm_100=2))
def matmul_kernel(
    A,
    B,
    C,
    TILE_SIZE_M: ct.Constant[int],
    TILE_SIZE_N: ct.Constant[int],
    TILE_SIZE_K: ct.Constant[int],
):
    """
    cuTile kernel for matrix multiplication: C = A @ B

    Translation from Triton:
    - tl.dot(a, b) → ct.mma(a, b, acc) for tensor core operations
    - tl.load with offsets → ct.load with index/shape
    - Pointer arithmetic → Tile-based indexing
    - Automatic dtype conversion for tensor cores (fp32 → tf32)

    Each CTA computes a TILE_SIZE_M x TILE_SIZE_N tile of C.
    Iterates over K dimension in blocks of TILE_SIZE_K.

    Args:
        A: Input matrix (M x K)
        B: Input matrix (K x N)
        C: Output matrix (M x N)
        TILE_SIZE_M: Height of output tile
        TILE_SIZE_N: Width of output tile
        TILE_SIZE_K: Depth of inner loop tile
    """
    GROUP_SIZE_M = 8
    M = A.shape[0]
    N = B.shape[1]
    bidx, bidy = swizzle_2d(M, N, TILE_SIZE_M, TILE_SIZE_N, GROUP_SIZE_M)

    # Number of K-tiles to process
    num_tiles_k = ct.num_tiles(A, axis=1, shape=(TILE_SIZE_M, TILE_SIZE_K))

    # Initialize accumulator in float32 for precision
    accumulator = ct.full((TILE_SIZE_M, TILE_SIZE_N), 0, dtype=ct.float32)
    zero_pad = ct.PaddingMode.ZERO

    # Convert fp32 to tf32 for tensor core utilization
    dtype = ct.tfloat32 if A.dtype == ct.float32 else A.dtype

    # K-dimension loop
    for k in range(num_tiles_k):
        # Load A tile: [TILE_SIZE_M, TILE_SIZE_K]
        # Triton equivalent: a = tl.load(a_ptrs, mask=a_mask, other=0.0)
        a = ct.load(A, index=(bidx, k), shape=(TILE_SIZE_M, TILE_SIZE_K), padding_mode=zero_pad).astype(dtype)

        # Load B tile: [TILE_SIZE_K, TILE_SIZE_N]
        # Triton equivalent: b = tl.load(b_ptrs, mask=b_mask, other=0.0)
        b = ct.load(B, index=(k, bidy), shape=(TILE_SIZE_K, TILE_SIZE_N), padding_mode=zero_pad).astype(dtype)

        # Matrix multiply and accumulate
        # Triton equivalent: acc += tl.dot(a, b)
        accumulator = ct.mma(a, b, accumulator)

    # Convert to output dtype
    accumulator = ct.astype(accumulator, C.dtype)

    # Store result
    ct.store(C, index=(bidx, bidy), tile=accumulator)


def matmul(
    a: torch.Tensor,
    b: torch.Tensor,
    TILE_SIZE_M: int = 128,
    TILE_SIZE_N: int = 128,
    TILE_SIZE_K: int = 32,
) -> torch.Tensor:
    """
    Host wrapper for cuTile matrix multiplication.

    Args:
        a: Input tensor [M, K]
        b: Input tensor [K, N]
        TILE_SIZE_M: M-dimension tile size
        TILE_SIZE_N: N-dimension tile size
        TILE_SIZE_K: K-dimension tile size

    Returns:
        c: Output tensor [M, N]
    """
    assert a.is_cuda and b.is_cuda
    assert a.shape[1] == b.shape[0], f"Incompatible shapes: {a.shape} @ {b.shape}"

    M, K = a.shape
    K, N = b.shape

    # Allocate output
    c = torch.empty((M, N), device=a.device, dtype=a.dtype)

    # Grid calculation
    grid = (
        math.ceil(M / TILE_SIZE_M) * math.ceil(N / TILE_SIZE_N),
        1,
        1,
    )

    ct.launch(
        torch.cuda.current_stream(),
        grid,
        matmul_kernel,
        (a, b, c, TILE_SIZE_M, TILE_SIZE_N, TILE_SIZE_K),
    )

    return c


def matmul_fp16(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    """
    FP16 matrix multiplication optimized for tensor cores.

    Args:
        a: Input tensor [M, K] in float16
        b: Input tensor [K, N] in float16

    Returns:
        c: Output tensor [M, N] in float16
    """
    assert a.dtype in [torch.float16, torch.bfloat16]
    assert b.dtype in [torch.float16, torch.bfloat16]
    return matmul(a, b)


def test_matmul():
    """Test function to verify correctness against PyTorch."""
    torch.manual_seed(42)

    # Test parameters
    M, N, K = 512, 512, 512

    # Test FP32
    print("Testing FP32 matmul...")
    a = torch.randn(M, K, device="cuda", dtype=torch.float32)
    b = torch.randn(K, N, device="cuda", dtype=torch.float32)

    # cuTile result
    c_cutile = matmul(a, b)

    # Reference (PyTorch)
    c_ref = torch.matmul(a, b)

    # Verify
    # Note: TF32 mode may have slightly lower precision
    fp32_passed = torch.allclose(c_cutile, c_ref, atol=1e-2, rtol=1e-2)
    if fp32_passed:
        print("FP32 test PASSED")
    else:
        diff = (c_cutile - c_ref).abs().max()
        print(f"FP32 test FAILED - Max difference: {diff}")

    # Test FP16
    print("\nTesting FP16 matmul (tensor cores)...")
    a_fp16 = torch.randn(M, K, device="cuda", dtype=torch.float16)
    b_fp16 = torch.randn(K, N, device="cuda", dtype=torch.float16)

    c_cutile_fp16 = matmul_fp16(a_fp16, b_fp16)
    c_ref_fp16 = torch.matmul(a_fp16, b_fp16)

    fp16_passed = torch.allclose(c_cutile_fp16, c_ref_fp16, atol=1e-1, rtol=1e-1)
    if fp16_passed:
        print("FP16 test PASSED")
    else:
        diff = (c_cutile_fp16 - c_ref_fp16).abs().max()
        print(f"FP16 test FAILED - Max difference: {diff}")

    # Test non-square matrices
    print("\nTesting non-square matrices...")
    M2, N2, K2 = 256, 1024, 512
    a2 = torch.randn(M2, K2, device="cuda", dtype=torch.float32)
    b2 = torch.randn(K2, N2, device="cuda", dtype=torch.float32)

    c_cutile2 = matmul(a2, b2)
    c_ref2 = torch.matmul(a2, b2)

    nonsquare_passed = torch.allclose(c_cutile2, c_ref2, atol=1e-2, rtol=1e-2)
    if nonsquare_passed:
        print("Non-square test PASSED")
    else:
        diff = (c_cutile2 - c_ref2).abs().max()
        print(f"Non-square test FAILED - Max difference: {diff}")

    return fp32_passed and fp16_passed and nonsquare_passed


if __name__ == "__main__":
    test_matmul()
