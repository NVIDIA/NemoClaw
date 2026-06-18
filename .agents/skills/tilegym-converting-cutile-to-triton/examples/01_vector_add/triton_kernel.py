# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0

#

"""
Vector Addition - Triton Implementation

This file demonstrates the Triton equivalent of the CUDA vector_add kernel.
Direct translation from cuda_kernel.cu showing the paradigm shift from
thread-based to tile-based programming.
"""

import torch
import triton
import triton.language as tl


@triton.jit
def vector_add_kernel(
    a_ptr,  # Pointer to input vector A
    b_ptr,  # Pointer to input vector B
    c_ptr,  # Pointer to output vector C
    n,  # Vector length
    BLOCK_SIZE: tl.constexpr,  # Block size (tile size)
):
    """
    Triton kernel for vector addition: C = A + B

    Translation from CUDA:
    - blockIdx.x * blockDim.x + threadIdx.x → pid * BLOCK_SIZE + tl.arange(0, BLOCK_SIZE)
    - if (idx < n) → mask = offs < n
    - c[idx] = a[idx] + b[idx] → tl.store(c_ptr + offs, a + b, mask=mask)
    """
    # Get program ID (equivalent to blockIdx.x)
    pid = tl.program_id(axis=0)

    # Calculate offsets for this program/block
    # CUDA equivalent: int idx = blockIdx.x * blockDim.x + threadIdx.x;
    # But Triton operates on BLOCK_SIZE elements at once
    offs = pid * BLOCK_SIZE + tl.arange(0, BLOCK_SIZE)

    # Create mask for boundary handling
    # CUDA equivalent: if (idx < n)
    mask = offs < n

    # Load input tiles with mask
    # CUDA equivalent: a[idx], b[idx] - but loads BLOCK_SIZE elements
    a = tl.load(a_ptr + offs, mask=mask, other=0.0)
    b = tl.load(b_ptr + offs, mask=mask, other=0.0)

    # Compute addition (element-wise on the tile)
    c = a + b

    # Store result with mask
    # CUDA equivalent: c[idx] = ... - but stores BLOCK_SIZE elements
    tl.store(c_ptr + offs, c, mask=mask)


def vector_add(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    """
    Host wrapper for Triton vector addition.

    Equivalent to CUDA launch_vector_add function.
    """
    # Validate inputs
    assert a.shape == b.shape, "Input shapes must match"
    # assert a.is_cuda and b.is_cuda, "Inputs must be on CUDA"
    assert a.is_contiguous() and b.is_contiguous(), "Inputs must be contiguous"

    # Allocate output
    c = torch.empty_like(a)
    n = a.numel()

    # Configure launch parameters
    # CUDA equivalent: const int BLOCK_SIZE = 256;
    BLOCK_SIZE = 256

    # Calculate grid size
    # CUDA equivalent: int grid_size = (n + BLOCK_SIZE - 1) / BLOCK_SIZE;
    grid = (triton.cdiv(n, BLOCK_SIZE),)

    # Launch kernel
    # CUDA equivalent: vector_add_cuda<<<grid_size, BLOCK_SIZE>>>(...)
    vector_add_kernel[grid](
        a,
        b,
        c,
        n,
        BLOCK_SIZE=BLOCK_SIZE,
    )

    return c


def test_vector_add():
    """Test function to verify correctness."""
    # Test parameters
    N = 1024

    # Create test inputs
    a = torch.arange(N, dtype=torch.float32, device="cuda")
    b = torch.arange(N, dtype=torch.float32, device="cuda") * 2

    # Run Triton kernel
    c_triton = vector_add(a, b)

    # Reference (PyTorch)
    c_ref = a + b

    # Verify
    if torch.allclose(c_triton, c_ref):
        print("Test PASSED")
        return True
    else:
        diff = (c_triton - c_ref).abs().max()
        print(f"Test FAILED - Max difference: {diff}")
        return False


if __name__ == "__main__":
    test_vector_add()
