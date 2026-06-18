# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0

#

"""
Row-wise Softmax - Triton Implementation

This file demonstrates the Triton equivalent of the CUDA softmax kernel.
Uses the "online softmax" pattern with tl.max, tl.exp, and tl.sum for
efficient single-pass reduction within each program.

Key differences from CUDA:
- No explicit shared memory management
- Built-in reduction primitives (tl.max, tl.sum)
- Single program processes entire row (no inter-thread communication)
- Numerical stability handled naturally with tl.max
"""

import torch
import triton
import triton.language as tl


@triton.jit
def softmax_kernel(
    input_ptr,  # Pointer to input matrix
    output_ptr,  # Pointer to output matrix
    input_row_stride,  # Stride between rows in input
    output_row_stride,  # Stride between rows in output
    n_cols,  # Number of columns (row size)
    BLOCK_SIZE: tl.constexpr,  # Block size for processing columns
):
    """
    Triton kernel for row-wise softmax.

    Each program processes one row using the "online softmax" pattern:
    1. Load row tile and compute max (for numerical stability)
    2. Compute exp(x - max) and sum
    3. Normalize by dividing by sum

    Translation from CUDA:
    - Shared memory reductions → tl.max(), tl.sum() built-ins
    - Multiple passes with __syncthreads() → Single-pass with tile operations
    - Block-level cooperation → Single program handles entire row
    """
    # Get row index (equivalent to blockIdx.x in CUDA)
    row_idx = tl.program_id(axis=0)

    # Calculate row pointers
    row_input_ptr = input_ptr + row_idx * input_row_stride
    row_output_ptr = output_ptr + row_idx * output_row_stride

    # Create column offsets for this tile
    col_offs = tl.arange(0, BLOCK_SIZE)

    # Mask for valid columns (boundary handling)
    mask = col_offs < n_cols

    # ========== Load input row ==========
    # CUDA equivalent: Multiple threads load with strided access
    # Triton: Single program loads entire tile
    row = tl.load(row_input_ptr + col_offs, mask=mask, other=-float("inf"))

    # ========== Compute max for numerical stability ==========
    # CUDA equivalent: block_reduce_max with shared memory
    # Triton: Built-in tl.max reduction
    row_max = tl.max(row, axis=0)

    # ========== Compute exp(x - max) ==========
    # CUDA equivalent: expf(row_input[i] - row_max)
    # Triton: Vectorized operation on entire tile
    numerator = tl.exp(row - row_max)

    # ========== Compute sum of exponentials ==========
    # CUDA equivalent: block_reduce_sum with shared memory
    # Triton: Built-in tl.sum reduction
    denominator = tl.sum(numerator, axis=0)

    # ========== Normalize ==========
    # CUDA equivalent: expf(row_input[i] - row_max) * inv_sum
    # Triton: Vectorized division
    softmax_output = numerator / denominator

    # ========== Store result ==========
    tl.store(row_output_ptr + col_offs, softmax_output, mask=mask)


@triton.jit
def softmax_kernel_multiblock(
    input_ptr,
    output_ptr,
    input_row_stride,
    output_row_stride,
    n_cols,
    BLOCK_SIZE: tl.constexpr,
):
    """
    Softmax kernel for rows larger than BLOCK_SIZE.

    Uses multiple passes over the row to handle arbitrary row sizes.
    This is closer to the CUDA implementation's strided access pattern.
    """
    row_idx = tl.program_id(axis=0)

    row_input_ptr = input_ptr + row_idx * input_row_stride
    row_output_ptr = output_ptr + row_idx * output_row_stride

    # ========== Pass 1: Find max value ==========
    # Iterate over row in BLOCK_SIZE chunks
    row_max = -float("inf")
    for start in range(0, n_cols, BLOCK_SIZE):
        col_offs = start + tl.arange(0, BLOCK_SIZE)
        mask = col_offs < n_cols
        chunk = tl.load(row_input_ptr + col_offs, mask=mask, other=-float("inf"))
        chunk_max = tl.max(chunk, axis=0)
        row_max = tl.maximum(row_max, chunk_max)

    # ========== Pass 2: Compute sum of exp(x - max) ==========
    row_sum = 0.0
    for start in range(0, n_cols, BLOCK_SIZE):
        col_offs = start + tl.arange(0, BLOCK_SIZE)
        mask = col_offs < n_cols
        chunk = tl.load(row_input_ptr + col_offs, mask=mask, other=-float("inf"))
        chunk_sum = tl.sum(tl.exp(chunk - row_max), axis=0)
        row_sum += chunk_sum

    # ========== Pass 3: Normalize and store ==========
    for start in range(0, n_cols, BLOCK_SIZE):
        col_offs = start + tl.arange(0, BLOCK_SIZE)
        mask = col_offs < n_cols
        chunk = tl.load(row_input_ptr + col_offs, mask=mask, other=-float("inf"))
        softmax_chunk = tl.exp(chunk - row_max) / row_sum
        tl.store(row_output_ptr + col_offs, softmax_chunk, mask=mask)


def softmax(x: torch.Tensor) -> torch.Tensor:
    """
    Host wrapper for Triton softmax.

    Applies softmax along the last dimension (row-wise).
    Equivalent to CUDA launch_softmax function.

    Args:
        x: Input tensor of shape [..., n_cols]

    Returns:
        Softmax output of same shape
    """
    # Validate input
    assert x.is_cuda, "Input must be on CUDA"

    # Reshape to 2D for kernel
    original_shape = x.shape
    x = x.contiguous()
    x_2d = x.view(-1, x.shape[-1])

    n_rows, n_cols = x_2d.shape

    # Allocate output
    output = torch.empty_like(x_2d)

    # Choose BLOCK_SIZE (must be power of 2 for Triton)
    BLOCK_SIZE = triton.next_power_of_2(n_cols)

    # Grid: one program per row
    # CUDA equivalent: int grid_size = num_rows;
    grid = (n_rows,)

    # Choose kernel based on row size
    if n_cols <= 8192:  # Single-pass kernel for smaller rows
        # Launch kernel
        softmax_kernel[grid](
            x_2d,
            output,
            x_2d.stride(0),
            output.stride(0),
            n_cols,
            BLOCK_SIZE=BLOCK_SIZE,
        )
    else:  # Multi-pass kernel for larger rows
        BLOCK_SIZE = 4096  # Fixed block size for multi-pass
        softmax_kernel_multiblock[grid](
            x_2d,
            output,
            x_2d.stride(0),
            output.stride(0),
            n_cols,
            BLOCK_SIZE=BLOCK_SIZE,
        )

    # Reshape back to original shape
    return output.view(original_shape)


def test_softmax():
    """Test function to verify correctness."""
    print("Testing Triton softmax implementation...")

    # Test parameters
    test_cases = [
        (4, 1024),  # Small rows
        (8, 4096),  # Medium rows
        (2, 8192),  # Large rows (single-pass limit)
        (4, 16384),  # Very large rows (multi-pass)
    ]

    all_passed = True

    for num_rows, row_size in test_cases:
        print(f"\nTest case: {num_rows} rows x {row_size} cols")

        # Create test input
        x = torch.randn(num_rows, row_size, device="cuda", dtype=torch.float32)

        # Run Triton kernel
        y_triton = softmax(x)

        # Reference (PyTorch)
        y_ref = torch.softmax(x, dim=-1)

        # Verify
        max_diff = (y_triton - y_ref).abs().max().item()

        # Check softmax properties
        row_sums = y_triton.sum(dim=-1)
        sum_error = (row_sums - 1.0).abs().max().item()

        passed = max_diff < 1e-5 and sum_error < 1e-5
        all_passed = all_passed and passed

        print(f"  Max difference from PyTorch: {max_diff:.2e}")
        print(f"  Max row sum error: {sum_error:.2e}")
        print(f"  Status: {'PASSED' if passed else 'FAILED'}")

    print(f"\n{'=' * 50}")
    print(f"Overall: {'ALL TESTS PASSED' if all_passed else 'SOME TESTS FAILED'}")

    return all_passed


def benchmark_softmax():
    """Benchmark Triton vs PyTorch softmax."""
    print("\nBenchmarking softmax implementations...")

    # Benchmark parameters
    num_rows = 1024
    row_size = 4096
    num_warmup = 10
    num_iters = 100

    x = torch.randn(num_rows, row_size, device="cuda", dtype=torch.float32)

    # Warmup
    for _ in range(num_warmup):
        _ = softmax(x)
        _ = torch.softmax(x, dim=-1)
    torch.cuda.synchronize()

    # Benchmark Triton
    import time

    torch.cuda.synchronize()
    start = time.perf_counter()
    for _ in range(num_iters):
        _ = softmax(x)
    torch.cuda.synchronize()
    triton_time = (time.perf_counter() - start) / num_iters * 1000

    # Benchmark PyTorch
    torch.cuda.synchronize()
    start = time.perf_counter()
    for _ in range(num_iters):
        _ = torch.softmax(x, dim=-1)
    torch.cuda.synchronize()
    pytorch_time = (time.perf_counter() - start) / num_iters * 1000

    print(f"\nInput shape: ({num_rows}, {row_size})")
    print(f"Triton:  {triton_time:.3f} ms")
    print(f"PyTorch: {pytorch_time:.3f} ms")
    print(f"Speedup: {pytorch_time / triton_time:.2f}x")


if __name__ == "__main__":
    test_softmax()
    benchmark_softmax()
