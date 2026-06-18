# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0

#

"""
Vector Addition - cuTile Implementation

This file demonstrates the cuTile equivalent of the CUDA/Triton vector_add kernel.
cuTile is NVIDIA's tile-based GPU programming framework.

Key differences from Triton:
- Uses `import cuda.tile as ct` instead of `import triton.language as tl`
- Uses `@ct.kernel` instead of `@triton.jit`
- Uses `ct.bid(0)` instead of `tl.program_id(0)`
- Uses `ct.gather/ct.scatter` instead of `tl.load/tl.store`
- Uses `ct.arange` instead of `tl.arange`
"""

import math

import cuda.tile as ct
import torch


@ct.kernel
def vector_add_kernel(
    a,  # Input tensor A (flattened)
    b,  # Input tensor B (flattened)
    c,  # Output tensor C (flattened)
    n_elements: ct.Constant[int],  # Total number of elements
    BLOCK_SIZE: ct.Constant[int],  # Block size (tile size)
):
    """
    cuTile kernel for vector addition: C = A + B

    Translation from Triton:
    - tl.program_id(0) → ct.bid(0)
    - tl.arange(0, BLOCK_SIZE) → ct.arange(BLOCK_SIZE, dtype=ct.int32)
    - tl.load(ptr + offs, mask=mask) → ct.gather(tensor, offsets, padding_value=0)
    - tl.store(ptr + offs, val, mask=mask) → ct.scatter(tensor, offsets, val)
    """
    # Get block ID (equivalent to tl.program_id(0) in Triton)
    bid = ct.bid(0)

    # Calculate block start offset
    block_start = bid * BLOCK_SIZE

    # Create offset tile (equivalent to tl.arange in Triton)
    # CRITICAL: Use Python + operator for index math, NOT ct.add()!
    # ct.add() promotes to float which breaks integer indexing
    offsets = block_start + ct.arange(BLOCK_SIZE, dtype=ct.int32)

    # Load data using gather (equivalent to tl.load in Triton)
    # cuTile uses gather/scatter for 1D indexed access
    # padding_value=0 handles out-of-bounds accesses
    a_tile = ct.gather(a, offsets, padding_value=0)
    b_tile = ct.gather(b, offsets, padding_value=0)

    # Compute addition (element-wise on the tile)
    c_tile = a_tile + b_tile

    # Store result using scatter (equivalent to tl.store in Triton)
    ct.scatter(c, offsets, c_tile)


def vector_add(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    """
    Host wrapper for cuTile vector addition.

    Args:
        a: Input tensor A
        b: Input tensor B

    Returns:
        c: Output tensor C = A + B
    """
    # Validate inputs
    assert a.shape == b.shape, "Input shapes must match"
    assert a.is_cuda and b.is_cuda, "Inputs must be on CUDA"
    assert a.is_contiguous() and b.is_contiguous(), "Inputs must be contiguous"

    # Allocate output
    c = torch.empty_like(a)
    n_elements = a.numel()

    # Flatten tensors for 1D gather/scatter operations
    a_flat = a.reshape(-1)
    b_flat = b.reshape(-1)
    c_flat = c.reshape(-1)

    # Configure launch parameters
    BLOCK_SIZE = 1024

    # Calculate grid size
    grid = (math.ceil(n_elements / BLOCK_SIZE), 1, 1)

    # Launch kernel
    ct.launch(
        torch.cuda.current_stream(),
        grid,
        vector_add_kernel,
        (a_flat, b_flat, c_flat, n_elements, BLOCK_SIZE),
    )

    return c


def test_vector_add():
    """Test function to verify correctness."""
    # Test parameters
    N = 1024

    # Create test inputs
    a = torch.arange(N, dtype=torch.float32, device="cuda")
    b = torch.arange(N, dtype=torch.float32, device="cuda") * 2

    # Run cuTile kernel
    c_cutile = vector_add(a, b)

    # Reference (PyTorch)
    c_ref = a + b

    # Verify
    if torch.allclose(c_cutile, c_ref):
        print("Test PASSED")
        return True
    else:
        diff = (c_cutile - c_ref).abs().max()
        print(f"Test FAILED - Max difference: {diff}")
        return False


if __name__ == "__main__":
    test_vector_add()
