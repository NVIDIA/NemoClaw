# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0

#

"""
Layer Normalization - Triton Implementation

This file demonstrates the Triton equivalent of the CUDA layernorm kernel.
Key translation patterns:
- CUDA warp/block reductions → tl.sum() for mean/variance
- __shfl_down_sync → Triton handles reduction internally
- rsqrtf → tl.sqrt with reciprocal
- Shared memory → Triton manages automatically

Focuses on reduction pattern translation from CUDA to Triton.
"""

import torch
import triton
import triton.language as tl


@triton.jit
def layernorm_forward_kernel(
    x_ptr,  # Input: [batch_size, normalized_size]
    gamma_ptr,  # Weight: [normalized_size]
    beta_ptr,  # Bias: [normalized_size]
    y_ptr,  # Output: [batch_size, normalized_size]
    mean_ptr,  # Mean output: [batch_size] (for backward)
    rstd_ptr,  # Reciprocal std output: [batch_size] (for backward)
    stride_x,  # Stride for x rows
    stride_y,  # Stride for y rows
    normalized_size,
    eps,
    BLOCK_SIZE: tl.constexpr,  # Must be >= normalized_size
):
    """
    Triton kernel for layer normalization forward pass.

    Translation from CUDA:
    - warp_reduce_sum + block_reduce_sum → tl.sum()
    - __syncthreads() → Triton handles synchronization
    - __shared__ float mean → local variable (Triton broadcasts)
    - rsqrtf(var + eps) → 1.0 / tl.sqrt(var + eps)

    Each program processes one row (batch element).
    """
    # Get row index (equivalent to blockIdx.x in CUDA)
    row = tl.program_id(axis=0)

    # Calculate offsets for this row
    # CUDA: const float* x_row = x + row * normalized_size;
    row_start = row * stride_x
    offs = tl.arange(0, BLOCK_SIZE)

    # Mask for boundary handling
    mask = offs < normalized_size

    # Load input row
    # CUDA: for (int i = threadIdx.x; i < normalized_size; i += blockDim.x) sum += x_row[i];
    x = tl.load(x_ptr + row_start + offs, mask=mask, other=0.0)

    # Step 1: Compute mean using tl.sum
    # CUDA equivalent: block_reduce_sum(sum, shared) then mean = sum / normalized_size
    # Triton's tl.sum handles the entire reduction automatically
    mean = tl.sum(x, axis=0) / normalized_size

    # Step 2: Compute variance using tl.sum
    # CUDA: var_sum += diff * diff; then block_reduce_sum
    x_centered = x - mean
    var = tl.sum(x_centered * x_centered, axis=0) / normalized_size

    # Compute reciprocal standard deviation
    # CUDA: rstd = rsqrtf(variance + eps);
    rstd = 1.0 / tl.sqrt(var + eps)

    # Store mean and rstd for backward pass (optional)
    if mean_ptr is not None:
        tl.store(mean_ptr + row, mean)
    if rstd_ptr is not None:
        tl.store(rstd_ptr + row, rstd)

    # Step 3: Normalize
    x_norm = x_centered * rstd

    # Load gamma and beta (weight and bias)
    gamma = tl.load(gamma_ptr + offs, mask=mask, other=1.0)
    beta = tl.load(beta_ptr + offs, mask=mask, other=0.0)

    # Apply affine transformation
    # CUDA: y_row[i] = gamma[i] * x_norm + beta[i];
    y = gamma * x_norm + beta

    # Store output
    tl.store(y_ptr + row * stride_y + offs, y, mask=mask)


@triton.jit
def layernorm_backward_kernel(
    dy_ptr,  # Gradient of output: [batch_size, normalized_size]
    x_ptr,  # Input: [batch_size, normalized_size]
    gamma_ptr,  # Weight: [normalized_size]
    mean_ptr,  # Saved mean: [batch_size]
    rstd_ptr,  # Saved rstd: [batch_size]
    dx_ptr,  # Gradient of input: [batch_size, normalized_size]
    stride,  # Row stride
    normalized_size,
    BLOCK_SIZE: tl.constexpr,
):
    """
    Triton kernel for layer normalization backward pass.

    Computes dx given dy, using saved mean and rstd from forward pass.

    Translation from CUDA:
    - Multiple block_reduce_sum calls → multiple tl.sum calls
    - Shared memory broadcasts → Triton handles automatically
    """
    row = tl.program_id(axis=0)
    row_start = row * stride
    offs = tl.arange(0, BLOCK_SIZE)
    mask = offs < normalized_size

    # Load saved statistics
    row_mean = tl.load(mean_ptr + row)
    row_rstd = tl.load(rstd_ptr + row)
    n = normalized_size

    # Load inputs
    dy = tl.load(dy_ptr + row_start + offs, mask=mask, other=0.0)
    x = tl.load(x_ptr + row_start + offs, mask=mask, other=0.0)
    gamma = tl.load(gamma_ptr + offs, mask=mask, other=1.0)

    # Compute normalized input
    x_hat = (x - row_mean) * row_rstd

    # Compute partial sums for gradient
    # CUDA: sum_dy += dy_row[i] * gamma[i];
    # CUDA: sum_dy_xhat += dy_row[i] * gamma[i] * x_hat;
    dy_gamma = dy * gamma
    sum_dy = tl.sum(dy_gamma, axis=0)
    sum_dy_xhat = tl.sum(dy_gamma * x_hat, axis=0)

    # Compute dx
    # CUDA: dx_row[i] = row_rstd * (dy_gamma - (s_sum_dy + x_hat * s_sum_dy_xhat) / n);
    dx = row_rstd * (dy_gamma - (sum_dy + x_hat * sum_dy_xhat) / n)

    # Store result
    tl.store(dx_ptr + row_start + offs, dx, mask=mask)


@triton.jit
def layernorm_dgamma_dbeta_kernel(
    dy_ptr,  # Gradient of output: [batch_size, normalized_size]
    x_ptr,  # Input: [batch_size, normalized_size]
    mean_ptr,  # Saved mean: [batch_size]
    rstd_ptr,  # Saved rstd: [batch_size]
    dgamma_ptr,  # Gradient of gamma: [normalized_size]
    dbeta_ptr,  # Gradient of beta: [normalized_size]
    batch_size,
    stride,
    normalized_size,
    BLOCK_SIZE_BATCH: tl.constexpr,
):
    """
    Compute gradients for gamma and beta by reducing across batch dimension.

    Each program handles one element of gamma/beta, reducing across all batch elements.
    """
    # Each program handles one position in normalized dimension
    col = tl.program_id(axis=0)
    if col >= normalized_size:
        return

    # Accumulate gradients across batch
    dgamma_acc = 0.0
    dbeta_acc = 0.0

    for batch_start in range(0, batch_size, BLOCK_SIZE_BATCH):
        batch_offs = batch_start + tl.arange(0, BLOCK_SIZE_BATCH)
        batch_mask = batch_offs < batch_size

        # Load dy, x, mean, rstd for this batch chunk
        dy = tl.load(dy_ptr + batch_offs * stride + col, mask=batch_mask, other=0.0)
        x = tl.load(x_ptr + batch_offs * stride + col, mask=batch_mask, other=0.0)
        mean = tl.load(mean_ptr + batch_offs, mask=batch_mask, other=0.0)
        rstd = tl.load(rstd_ptr + batch_offs, mask=batch_mask, other=0.0)

        # Compute x_hat and accumulate
        x_hat = (x - mean) * rstd
        dgamma_acc += tl.sum(dy * x_hat, axis=0)
        dbeta_acc += tl.sum(dy, axis=0)

    # Store accumulated gradients
    tl.store(dgamma_ptr + col, dgamma_acc)
    tl.store(dbeta_ptr + col, dbeta_acc)


def layernorm_forward(
    x: torch.Tensor,
    gamma: torch.Tensor,
    beta: torch.Tensor,
    eps: float = 1e-5,
    save_stats: bool = True,
) -> tuple:
    """
    Host wrapper for Triton layer normalization forward pass.

    Args:
        x: Input tensor [batch_size, normalized_size]
        gamma: Weight tensor [normalized_size]
        beta: Bias tensor [normalized_size]
        eps: Epsilon for numerical stability
        save_stats: Whether to save mean/rstd for backward pass

    Returns:
        y: Normalized output
        mean: Mean per row (if save_stats)
        rstd: Reciprocal std per row (if save_stats)
    """
    assert x.is_cuda and gamma.is_cuda and beta.is_cuda
    assert x.is_contiguous()

    batch_size, normalized_size = x.shape
    assert gamma.shape == (normalized_size,)
    assert beta.shape == (normalized_size,)

    # Allocate output
    y = torch.empty_like(x)

    # Allocate stats tensors if needed
    mean = torch.empty(batch_size, device=x.device, dtype=x.dtype) if save_stats else None
    rstd = torch.empty(batch_size, device=x.device, dtype=x.dtype) if save_stats else None

    # Block size must be power of 2 and >= normalized_size
    BLOCK_SIZE = triton.next_power_of_2(normalized_size)

    # Launch kernel - one program per row
    grid = (batch_size,)
    layernorm_forward_kernel[grid](
        x,
        gamma,
        beta,
        y,
        mean,
        rstd,
        x.stride(0),
        y.stride(0),
        normalized_size,
        eps,
        BLOCK_SIZE=BLOCK_SIZE,
    )

    return y, mean, rstd


def layernorm_backward(
    dy: torch.Tensor,
    x: torch.Tensor,
    gamma: torch.Tensor,
    mean: torch.Tensor,
    rstd: torch.Tensor,
) -> tuple:
    """
    Host wrapper for Triton layer normalization backward pass.

    Args:
        dy: Gradient of output [batch_size, normalized_size]
        x: Original input [batch_size, normalized_size]
        gamma: Weight tensor [normalized_size]
        mean: Saved mean from forward [batch_size]
        rstd: Saved rstd from forward [batch_size]

    Returns:
        dx: Gradient of input
        dgamma: Gradient of gamma
        dbeta: Gradient of beta
    """
    batch_size, normalized_size = x.shape

    # Allocate gradients
    dx = torch.empty_like(x)
    dgamma = torch.empty_like(gamma)
    dbeta = torch.empty_like(gamma)

    BLOCK_SIZE = triton.next_power_of_2(normalized_size)

    # Compute dx
    layernorm_backward_kernel[(batch_size,)](
        dy,
        x,
        gamma,
        mean,
        rstd,
        dx,
        x.stride(0),
        normalized_size,
        BLOCK_SIZE=BLOCK_SIZE,
    )

    # Compute dgamma and dbeta
    BLOCK_SIZE_BATCH = min(64, triton.next_power_of_2(batch_size))
    layernorm_dgamma_dbeta_kernel[(normalized_size,)](
        dy,
        x,
        mean,
        rstd,
        dgamma,
        dbeta,
        batch_size,
        x.stride(0),
        normalized_size,
        BLOCK_SIZE_BATCH=BLOCK_SIZE_BATCH,
    )

    return dx, dgamma, dbeta


def test_layernorm():
    """Test function to verify correctness against PyTorch."""
    torch.manual_seed(42)

    # Test parameters
    BATCH_SIZE = 4
    NORMALIZED_SIZE = 256
    EPS = 1e-5

    # Create test inputs
    x = torch.randn(BATCH_SIZE, NORMALIZED_SIZE, device="cuda", dtype=torch.float32)
    gamma = torch.ones(NORMALIZED_SIZE, device="cuda", dtype=torch.float32)
    beta = torch.zeros(NORMALIZED_SIZE, device="cuda", dtype=torch.float32)

    # Run Triton forward
    y_triton, mean, rstd = layernorm_forward(x, gamma, beta, EPS)

    # Reference (PyTorch)
    y_ref = torch.nn.functional.layer_norm(x, (NORMALIZED_SIZE,), gamma, beta, EPS)

    # Verify forward
    forward_passed = torch.allclose(y_triton, y_ref, atol=1e-4, rtol=1e-4)
    if forward_passed:
        print("Forward test PASSED")
    else:
        diff = (y_triton - y_ref).abs().max()
        print(f"Forward test FAILED - Max difference: {diff}")

    # Test backward
    dy = torch.randn_like(y_triton)

    # Triton backward
    dx_triton, dgamma_triton, dbeta_triton = layernorm_backward(dy, x, gamma, mean, rstd)

    # PyTorch backward (using autograd)
    x_ref = x.clone().requires_grad_(True)
    gamma_ref = gamma.clone().requires_grad_(True)
    beta_ref = beta.clone().requires_grad_(True)
    y_ref = torch.nn.functional.layer_norm(x_ref, (NORMALIZED_SIZE,), gamma_ref, beta_ref, EPS)
    y_ref.backward(dy)

    # Verify backward
    dx_passed = torch.allclose(dx_triton, x_ref.grad, atol=1e-3, rtol=1e-3)
    dgamma_passed = torch.allclose(dgamma_triton, gamma_ref.grad, atol=1e-3, rtol=1e-3)
    dbeta_passed = torch.allclose(dbeta_triton, beta_ref.grad, atol=1e-3, rtol=1e-3)

    if dx_passed and dgamma_passed and dbeta_passed:
        print("Backward test PASSED")
    else:
        print(f"Backward test: dx={dx_passed}, dgamma={dgamma_passed}, dbeta={dbeta_passed}")
        if not dx_passed:
            print(f"  dx max diff: {(dx_triton - x_ref.grad).abs().max()}")
        if not dgamma_passed:
            print(f"  dgamma max diff: {(dgamma_triton - gamma_ref.grad).abs().max()}")
        if not dbeta_passed:
            print(f"  dbeta max diff: {(dbeta_triton - beta_ref.grad).abs().max()}")

    return forward_passed and dx_passed and dgamma_passed and dbeta_passed


if __name__ == "__main__":
    test_layernorm()
