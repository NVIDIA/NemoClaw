# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0

#

"""
Matrix Multiplication (GEMM) - Triton Implementation

This file demonstrates the Triton equivalent of the CUDA tiled matmul kernel.
Key translation patterns:
- CUDA shared memory tiling → Triton block-level tiling with tl.dot
- Manual tile loading → tl.load with block pointers
- Nested loops for dot product → tl.dot (tensor core accelerated)
- Thread-level indexing → Program-level block indexing

Focuses on tiling pattern translation and autotune configuration.
"""

import torch
import triton
import triton.language as tl


@triton.jit
def matmul_kernel(
    # Pointers to matrices
    a_ptr,
    b_ptr,
    c_ptr,
    # Matrix dimensions
    M,
    N,
    K,
    # Strides (elements to skip to get to next row/col)
    stride_am,
    stride_ak,
    stride_bk,
    stride_bn,
    stride_cm,
    stride_cn,
    # Block sizes (compile-time constants)
    BLOCK_SIZE_M: tl.constexpr,
    BLOCK_SIZE_N: tl.constexpr,
    BLOCK_SIZE_K: tl.constexpr,
):
    """
    Triton kernel for matrix multiplication: C = A @ B

    Translation from CUDA:
    - blockIdx.x/y → tl.program_id(0/1)
    - __shared__ float As/Bs → tl.load into registers (Triton manages caching)
    - Nested k-loop with accumulation → tl.dot (uses tensor cores when available)
    - __syncthreads() → Automatic (Triton handles synchronization)

    Each program computes a BLOCK_SIZE_M x BLOCK_SIZE_N tile of C.
    """
    # Program ID determines which output tile this program computes
    # CUDA equivalent: blockIdx.x, blockIdx.y
    pid_m = tl.program_id(axis=0)  # Row tile index
    pid_n = tl.program_id(axis=1)  # Column tile index

    # Calculate starting row/col for this program's output tile
    # CUDA equivalent: row = blockIdx.y * TILE_SIZE, col = blockIdx.x * TILE_SIZE
    offs_m = pid_m * BLOCK_SIZE_M + tl.arange(0, BLOCK_SIZE_M)
    offs_n = pid_n * BLOCK_SIZE_N + tl.arange(0, BLOCK_SIZE_N)
    offs_k = tl.arange(0, BLOCK_SIZE_K)

    # Pointers to first block of A and B
    # A: [M, K] - we load BLOCK_SIZE_M x BLOCK_SIZE_K tiles
    # B: [K, N] - we load BLOCK_SIZE_K x BLOCK_SIZE_N tiles
    a_ptrs = a_ptr + (offs_m[:, None] * stride_am + offs_k[None, :] * stride_ak)
    b_ptrs = b_ptr + (offs_k[:, None] * stride_bk + offs_n[None, :] * stride_bn)

    # Accumulator for the output tile
    # CUDA equivalent: float acc = 0.0f; (but here it's a 2D tile)
    acc = tl.zeros((BLOCK_SIZE_M, BLOCK_SIZE_N), dtype=tl.float32)

    # Iterate over K dimension in blocks
    # CUDA equivalent: for (int t = 0; t < num_tiles; t++)
    for k in range(0, K, BLOCK_SIZE_K):
        # Boundary masks
        # CUDA equivalent: if (row < M && a_col < K)
        a_mask = (offs_m[:, None] < M) & ((k + offs_k[None, :]) < K)
        b_mask = ((k + offs_k[:, None]) < K) & (offs_n[None, :] < N)

        # Load tiles of A and B
        # CUDA equivalent: As[ty][tx] = A[row * K + a_col];
        a = tl.load(a_ptrs, mask=a_mask, other=0.0)
        b = tl.load(b_ptrs, mask=b_mask, other=0.0)

        # Matrix multiply and accumulate
        # CUDA equivalent: for (int k = 0; k < TILE_SIZE; k++) acc += As[ty][k] * Bs[k][tx];
        # tl.dot uses tensor cores when:
        # - dtype is float16/bfloat16
        # - BLOCK_SIZE_K is multiple of 16
        # - Shapes are compatible (M, N multiples of 16)
        acc += tl.dot(a, b)

        # Advance pointers to next K-tile
        a_ptrs += BLOCK_SIZE_K * stride_ak
        b_ptrs += BLOCK_SIZE_K * stride_bk

    # Write output tile to C
    # CUDA equivalent: if (row < M && col < N) C[row * N + col] = acc;
    c_ptrs = c_ptr + (offs_m[:, None] * stride_cm + offs_n[None, :] * stride_cn)
    c_mask = (offs_m[:, None] < M) & (offs_n[None, :] < N)
    tl.store(c_ptrs, acc, mask=c_mask)


# Autotune configuration for optimal performance
# Triton will benchmark each configuration and select the best
@triton.autotune(
    configs=[
        # Small matrices - smaller tiles
        triton.Config(
            {"BLOCK_SIZE_M": 32, "BLOCK_SIZE_N": 32, "BLOCK_SIZE_K": 32},
            num_stages=2,
            num_warps=4,
        ),
        triton.Config(
            {"BLOCK_SIZE_M": 64, "BLOCK_SIZE_N": 32, "BLOCK_SIZE_K": 32},
            num_stages=2,
            num_warps=4,
        ),
        triton.Config(
            {"BLOCK_SIZE_M": 32, "BLOCK_SIZE_N": 64, "BLOCK_SIZE_K": 32},
            num_stages=2,
            num_warps=4,
        ),
        # Medium matrices - balanced tiles
        triton.Config(
            {"BLOCK_SIZE_M": 64, "BLOCK_SIZE_N": 64, "BLOCK_SIZE_K": 32},
            num_stages=3,
            num_warps=4,
        ),
        triton.Config(
            {"BLOCK_SIZE_M": 128, "BLOCK_SIZE_N": 64, "BLOCK_SIZE_K": 32},
            num_stages=3,
            num_warps=4,
        ),
        triton.Config(
            {"BLOCK_SIZE_M": 64, "BLOCK_SIZE_N": 128, "BLOCK_SIZE_K": 32},
            num_stages=3,
            num_warps=4,
        ),
        # Large matrices - larger tiles for better data reuse
        triton.Config(
            {"BLOCK_SIZE_M": 128, "BLOCK_SIZE_N": 128, "BLOCK_SIZE_K": 32},
            num_stages=3,
            num_warps=8,
        ),
        triton.Config(
            {"BLOCK_SIZE_M": 128, "BLOCK_SIZE_N": 256, "BLOCK_SIZE_K": 32},
            num_stages=3,
            num_warps=8,
        ),
        triton.Config(
            {"BLOCK_SIZE_M": 256, "BLOCK_SIZE_N": 128, "BLOCK_SIZE_K": 32},
            num_stages=3,
            num_warps=8,
        ),
        # Tensor core optimized (BLOCK_SIZE_K=16 for fp16)
        triton.Config(
            {"BLOCK_SIZE_M": 128, "BLOCK_SIZE_N": 128, "BLOCK_SIZE_K": 16},
            num_stages=4,
            num_warps=8,
        ),
    ],
    key=["M", "N", "K"],  # Autotune based on matrix dimensions
)
@triton.jit
def matmul_kernel_autotuned(
    a_ptr,
    b_ptr,
    c_ptr,
    M,
    N,
    K,
    stride_am,
    stride_ak,
    stride_bk,
    stride_bn,
    stride_cm,
    stride_cn,
    BLOCK_SIZE_M: tl.constexpr,
    BLOCK_SIZE_N: tl.constexpr,
    BLOCK_SIZE_K: tl.constexpr,
):
    """
    Autotuned version of matmul kernel.

    Autotune parameters:
    - BLOCK_SIZE_M/N: Output tile dimensions (affects parallelism vs. data reuse)
    - BLOCK_SIZE_K: K-dimension tile size (affects memory bandwidth)
    - num_stages: Software pipelining depth (hides memory latency)
    - num_warps: Number of warps per program (affects occupancy)

    Tensor Core Requirements (for tl.dot acceleration):
    - Input dtype: float16 or bfloat16
    - BLOCK_SIZE_K: Multiple of 16
    - BLOCK_SIZE_M, BLOCK_SIZE_N: Multiples of 16
    - Accumulator: float32 (automatic)
    """
    pid_m = tl.program_id(axis=0)
    pid_n = tl.program_id(axis=1)

    offs_m = pid_m * BLOCK_SIZE_M + tl.arange(0, BLOCK_SIZE_M)
    offs_n = pid_n * BLOCK_SIZE_N + tl.arange(0, BLOCK_SIZE_N)
    offs_k = tl.arange(0, BLOCK_SIZE_K)

    a_ptrs = a_ptr + (offs_m[:, None] * stride_am + offs_k[None, :] * stride_ak)
    b_ptrs = b_ptr + (offs_k[:, None] * stride_bk + offs_n[None, :] * stride_bn)

    acc = tl.zeros((BLOCK_SIZE_M, BLOCK_SIZE_N), dtype=tl.float32)

    for k in range(0, K, BLOCK_SIZE_K):
        a_mask = (offs_m[:, None] < M) & ((k + offs_k[None, :]) < K)
        b_mask = ((k + offs_k[:, None]) < K) & (offs_n[None, :] < N)

        a = tl.load(a_ptrs, mask=a_mask, other=0.0)
        b = tl.load(b_ptrs, mask=b_mask, other=0.0)

        acc += tl.dot(a, b)

        a_ptrs += BLOCK_SIZE_K * stride_ak
        b_ptrs += BLOCK_SIZE_K * stride_bk

    c_ptrs = c_ptr + (offs_m[:, None] * stride_cm + offs_n[None, :] * stride_cn)
    c_mask = (offs_m[:, None] < M) & (offs_n[None, :] < N)
    tl.store(c_ptrs, acc, mask=c_mask)


def matmul(a: torch.Tensor, b: torch.Tensor, use_autotune: bool = True) -> torch.Tensor:
    """
    Host wrapper for Triton matrix multiplication.

    Args:
        a: Input tensor [M, K]
        b: Input tensor [K, N]
        use_autotune: Whether to use autotuned kernel

    Returns:
        c: Output tensor [M, N]
    """
    assert a.is_cuda and b.is_cuda
    assert a.shape[1] == b.shape[0], f"Incompatible shapes: {a.shape} @ {b.shape}"

    M, K = a.shape
    K, N = b.shape

    # Allocate output
    c = torch.empty((M, N), device=a.device, dtype=a.dtype)

    # Grid: one program per output tile
    # CUDA equivalent: dim3 grid((N + TILE_SIZE - 1) / TILE_SIZE, (M + TILE_SIZE - 1) / TILE_SIZE)
    def grid(meta):
        return (
            triton.cdiv(M, meta["BLOCK_SIZE_M"]),
            triton.cdiv(N, meta["BLOCK_SIZE_N"]),
        )

    if use_autotune:
        matmul_kernel_autotuned[grid](
            a,
            b,
            c,
            M,
            N,
            K,
            a.stride(0),
            a.stride(1),
            b.stride(0),
            b.stride(1),
            c.stride(0),
            c.stride(1),
        )
    else:
        # Fixed configuration for debugging/testing
        BLOCK_SIZE_M = 64
        BLOCK_SIZE_N = 64
        BLOCK_SIZE_K = 32
        grid_fixed = (triton.cdiv(M, BLOCK_SIZE_M), triton.cdiv(N, BLOCK_SIZE_N))
        matmul_kernel[grid_fixed](
            a,
            b,
            c,
            M,
            N,
            K,
            a.stride(0),
            a.stride(1),
            b.stride(0),
            b.stride(1),
            c.stride(0),
            c.stride(1),
            BLOCK_SIZE_M=BLOCK_SIZE_M,
            BLOCK_SIZE_N=BLOCK_SIZE_N,
            BLOCK_SIZE_K=BLOCK_SIZE_K,
        )

    return c


def matmul_fp16(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    """
    FP16 matrix multiplication optimized for tensor cores.

    Tensor Core Requirements:
    1. Input dtype: float16 or bfloat16
    2. Shapes: M, N, K should be multiples of 16 for best performance
    3. BLOCK_SIZE_K: Multiple of 16 (handled by autotune configs)

    The tl.dot operation automatically uses tensor cores when these
    conditions are met, providing significant speedup over FP32.
    """
    assert a.dtype in [torch.float16, torch.bfloat16]
    assert b.dtype in [torch.float16, torch.bfloat16]
    return matmul(a, b, use_autotune=True)


def test_matmul():
    """Test function to verify correctness against PyTorch."""
    torch.manual_seed(42)

    # Test parameters
    M, N, K = 512, 512, 512

    # Test FP32
    print("Testing FP32 matmul...")
    a = torch.randn(M, K, device="cuda", dtype=torch.float32)
    b = torch.randn(K, N, device="cuda", dtype=torch.float32)

    # Triton result
    c_triton = matmul(a, b, use_autotune=False)

    # Reference (PyTorch)
    c_ref = torch.matmul(a, b)

    # Verify
    fp32_passed = torch.allclose(c_triton, c_ref, atol=1e-2, rtol=1e-2)
    if fp32_passed:
        print("FP32 test PASSED")
    else:
        diff = (c_triton - c_ref).abs().max()
        print(f"FP32 test FAILED - Max difference: {diff}")

    # Test FP16 (tensor cores)
    print("\nTesting FP16 matmul (tensor cores)...")
    a_fp16 = torch.randn(M, K, device="cuda", dtype=torch.float16)
    b_fp16 = torch.randn(K, N, device="cuda", dtype=torch.float16)

    c_triton_fp16 = matmul_fp16(a_fp16, b_fp16)
    c_ref_fp16 = torch.matmul(a_fp16, b_fp16)

    fp16_passed = torch.allclose(c_triton_fp16, c_ref_fp16, atol=1e-1, rtol=1e-1)
    if fp16_passed:
        print("FP16 test PASSED")
    else:
        diff = (c_triton_fp16 - c_ref_fp16).abs().max()
        print(f"FP16 test FAILED - Max difference: {diff}")

    # Test non-square matrices
    print("\nTesting non-square matrices...")
    M2, N2, K2 = 256, 1024, 512
    a2 = torch.randn(M2, K2, device="cuda", dtype=torch.float32)
    b2 = torch.randn(K2, N2, device="cuda", dtype=torch.float32)

    c_triton2 = matmul(a2, b2, use_autotune=False)
    c_ref2 = torch.matmul(a2, b2)

    nonsquare_passed = torch.allclose(c_triton2, c_ref2, atol=1e-2, rtol=1e-2)
    if nonsquare_passed:
        print("Non-square test PASSED")
    else:
        diff = (c_triton2 - c_ref2).abs().max()
        print(f"Non-square test FAILED - Max difference: {diff}")

    return fp32_passed and fp16_passed and nonsquare_passed


def benchmark_matmul():
    """Benchmark Triton vs PyTorch matmul."""
    import time

    sizes = [(512, 512, 512), (1024, 1024, 1024), (2048, 2048, 2048)]

    print("\nBenchmark Results:")
    print("-" * 60)
    print(f"{'Size':<20} {'PyTorch (ms)':<15} {'Triton (ms)':<15} {'Speedup':<10}")
    print("-" * 60)

    for M, N, K in sizes:
        a = torch.randn(M, K, device="cuda", dtype=torch.float16)
        b = torch.randn(K, N, device="cuda", dtype=torch.float16)

        # Warmup
        for _ in range(10):
            _ = torch.matmul(a, b)
            _ = matmul_fp16(a, b)

        torch.cuda.synchronize()

        # Benchmark PyTorch
        start = time.perf_counter()
        for _ in range(100):
            _ = torch.matmul(a, b)
        torch.cuda.synchronize()
        pytorch_time = (time.perf_counter() - start) / 100 * 1000

        # Benchmark Triton
        start = time.perf_counter()
        for _ in range(100):
            _ = matmul_fp16(a, b)
        torch.cuda.synchronize()
        triton_time = (time.perf_counter() - start) / 100 * 1000

        speedup = pytorch_time / triton_time
        print(f"{M}x{N}x{K:<10} {pytorch_time:<15.3f} {triton_time:<15.3f} {speedup:<10.2f}x")


if __name__ == "__main__":
    passed = test_matmul()
    if passed:
        print("\nAll tests passed!")
        benchmark_matmul()
    else:
        print("\nSome tests failed!")
