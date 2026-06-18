# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0

#

"""
Row-wise Softmax - cuTile Implementation

This file demonstrates the cuTile equivalent of the CUDA/Triton softmax kernel.
Softmax is computed row-wise with numerical stability (subtract max before exp).

Key cuTile patterns:
- ct.max() for reduction to find maximum
- ct.sum() for reduction to compute sum
- ct.exp() for exponential
- ct.truediv() for division
"""

import math

import cuda.tile as ct
import torch


def next_power_of_2(n):
    """Return the smallest power of 2 >= n."""
    return 1 if n == 0 else 2 ** (n - 1).bit_length()


@ct.kernel
def softmax_kernel(
    output,
    input,
    n_rows: ct.Constant[int],
    TILE_SIZE: ct.Constant[int],
    n_cols: ct.Constant[int],
):
    """
    cuTile kernel for row-wise softmax.

    Each block processes multiple rows using static persistent scheduling.

    Translation from Triton:
    - tl.program_id(0) → ct.bid(0)
    - tl.max(row, axis=0) → ct.max(row, 0, keepdims=True)
    - tl.sum(row, axis=0) → ct.sum(row, 0, keepdims=True)
    - tl.exp(x) → ct.exp(x)
    """
    # Static persistent scheduling: each block processes multiple rows
    bid = ct.bid(0)
    num_programs = ct.num_blocks(0)
    offsets = ct.arange(TILE_SIZE, dtype=ct.int32)

    for row_idx in range(bid, n_rows, num_programs):
        # Load the row tile using index-based access
        # Use -inf for padding to handle boundary correctly in max
        row = ct.gather(input, (row_idx, offsets), check_bounds=True, padding_value=-math.inf)

        # Convert to float32 for computation (numerical stability)
        row = ct.astype(row, ct.float32)

        # Subtract maximum for numerical stability
        # Triton: row_max = tl.max(row, axis=0)
        row_max = ct.max(row, 0, keepdims=True)
        row_minus_max = ct.sub(row, row_max)

        # Compute exponential
        # Triton: numerator = tl.exp(row - row_max)
        numerator = ct.exp(row_minus_max)

        # Compute sum for normalization
        # Triton: denominator = tl.sum(numerator, axis=0)
        denominator = ct.sum(numerator, 0, keepdims=True)

        # Final softmax computation
        softmax_output = ct.truediv(numerator, denominator)

        # Convert back to original dtype
        softmax_output = ct.astype(softmax_output, input.dtype)

        # Store result using index-based access
        ct.scatter(output, (row_idx, offsets), softmax_output, check_bounds=True)


def softmax(x: torch.Tensor) -> torch.Tensor:
    """
    Host wrapper for cuTile softmax.

    Applies softmax along the last dimension (row-wise).

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

    # Choose TILE_SIZE (must be power of 2 for reductions)
    TILE_SIZE = next_power_of_2(n_cols)

    # Calculate grid
    NUM_SM = torch.cuda.get_device_properties(x.device).multi_processor_count
    occupancy = 4  # In practice, use cfg.occupancy from autotune
    num_programs = min(NUM_SM * occupancy, n_rows)
    grid = (num_programs, 1, 1)

    # Launch kernel
    ct.launch(
        torch.cuda.current_stream(),
        grid,
        softmax_kernel,
        (output, x_2d, n_rows, TILE_SIZE, n_cols),
    )

    # Reshape back to original shape
    return output.view(original_shape)


def test_softmax():
    """Test function to verify correctness."""
    print("Testing cuTile softmax implementation...")

    # Test parameters
    test_cases = [
        (4, 1024),  # Small rows
        (8, 4096),  # Medium rows
    ]

    all_passed = True

    for num_rows, row_size in test_cases:
        print(f"\nTest case: {num_rows} rows x {row_size} cols")

        # Create test input
        x = torch.randn(num_rows, row_size, device="cuda", dtype=torch.float32)

        # Run cuTile kernel
        y_cutile = softmax(x)

        # Reference (PyTorch)
        y_ref = torch.softmax(x, dim=-1)

        # Verify
        max_diff = (y_cutile - y_ref).abs().max().item()

        # Check softmax properties (rows sum to 1)
        row_sums = y_cutile.sum(dim=-1)
        sum_error = (row_sums - 1.0).abs().max().item()

        passed = max_diff < 1e-5 and sum_error < 1e-5
        all_passed = all_passed and passed

        print(f"  Max difference from PyTorch: {max_diff:.2e}")
        print(f"  Max row sum error: {sum_error:.2e}")
        print(f"  Status: {'PASSED' if passed else 'FAILED'}")

    print(f"\n{'=' * 50}")
    print(f"Overall: {'ALL TESTS PASSED' if all_passed else 'SOME TESTS FAILED'}")

    return all_passed


if __name__ == "__main__":
    test_softmax()
