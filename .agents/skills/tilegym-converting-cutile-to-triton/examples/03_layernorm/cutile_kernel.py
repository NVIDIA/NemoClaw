# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0

#

"""
Layer Normalization - cuTile Implementation

This file demonstrates the cuTile equivalent of the CUDA/Triton layernorm kernel.
Key translation patterns:
- Triton tl.sum → cuTile ct.sum for mean/variance
- Triton tl.sqrt → cuTile ct.rsqrt
- Triton tl.load/store → cuTile ct.gather/scatter with flattened tensors
- Online normalization across the C dimension with blocked iteration

cuTile uses explicit gather/scatter for flexible memory access patterns.
"""

import cuda.tile as ct
import torch


def _squash_axis(x, start_dim, end_dim):
    """
    Squashes x to shape (N, C, W) where C are axes from start_dim to end_dim.
    """
    shape = x.shape
    # correct negative indexing
    if start_dim < 0:
        start_dim += len(shape)
    if end_dim < 0:
        end_dim += len(shape)
    assert start_dim < end_dim

    # squash N
    N = 1
    for i in range(start_dim):
        N *= shape[i]
    # squash C
    C = 1
    for i in range(start_dim, end_dim):
        C *= shape[i]

    return x.view(N, C, -1)


@ct.kernel
def layer_norm_fwd_kernel(
    x,
    y,
    w,
    b,
    mean,
    rstd,
    stride_n: ct.Constant[int],
    stride_c: ct.Constant[int],
    stride_w: ct.Constant[int],
    C: ct.Constant[int],
    W: ct.Constant[int],
    eps: ct.Constant[float],
    weight_shift: ct.Constant[float],
    BLOCK_SIZE_C: ct.Constant[int],
    BLOCK_SIZE_W: ct.Constant[int],
):
    """
    cuTile kernel for layer normalization forward pass.

    Translation from Triton:
    - tl.sum → ct.sum for mean/variance reduction
    - tl.rsqrt → ct.rsqrt
    - tl.load/store with offsets → ct.gather/scatter with explicit indices

    Each program (block) processes one row (batch element).
    Iterates over the C dimension in blocks of BLOCK_SIZE_C.

    Grids(N, 1, W // BLOCK_SIZE_W)
    Each block gets (1, C, BLOCK_SIZE_W) input data, matching (C,) weights.
    """
    row = ct.bid(0)
    tub_start = ct.bid(1) * BLOCK_SIZE_W

    # compute mean
    if BLOCK_SIZE_W == 1:
        _mean = ct.zeros((BLOCK_SIZE_C,), dtype=ct.float32)
    else:
        _mean = ct.zeros((BLOCK_SIZE_C, BLOCK_SIZE_W), dtype=ct.float32)

    tub_offsets = tub_start + ct.arange(BLOCK_SIZE_W, dtype=ct.int32)
    mask_W = ct.less(tub_offsets, W)
    tub_offsets_strided = ct.mul(tub_offsets, stride_w)

    for col_start in range(0, C, BLOCK_SIZE_C):
        col_offsets = col_start + ct.arange(BLOCK_SIZE_C, dtype=ct.int32)
        mask_C = ct.less(col_offsets, C)

        if BLOCK_SIZE_W == 1:
            indices = row * stride_n + col_offsets * stride_c
            x_tile = ct.gather(x, indices, padding_value=0)
            x_tile = ct.astype(x_tile, ct.float32)
            _mean = ct.add(_mean, x_tile)
        else:
            offsets = ct.add(
                ct.reshape(col_offsets, (BLOCK_SIZE_C, 1)) * stride_c,
                ct.reshape(tub_offsets_strided, (1, BLOCK_SIZE_W)),
            )
            offsets = ct.add(row * stride_n, offsets)
            mask = ct.bitwise_and(
                ct.reshape(mask_C, (BLOCK_SIZE_C, 1)),
                ct.reshape(mask_W, (1, BLOCK_SIZE_W)),
            )

            x_tile = ct.gather(x, offsets, padding_value=0)
            x_tile = ct.astype(x_tile, ct.float32)
            _mean = ct.add(_mean, x_tile)

    mean_val = ct.truediv(ct.sum(_mean, axis=0), C)

    if BLOCK_SIZE_W == 1:
        mean_offsets = ct.full((1,), row * W, dtype=ct.int32)
        mean_val_reshaped = ct.reshape(mean_val, (1,))
        ct.scatter(mean, mean_offsets, mean_val_reshaped)
    else:
        mean_offsets = row * W + tub_offsets
        ct.scatter(mean, mean_offsets, mean_val)

    # compute std
    if BLOCK_SIZE_W == 1:
        _var = ct.zeros((BLOCK_SIZE_C,), dtype=ct.float32)
    else:
        _var = ct.zeros((BLOCK_SIZE_C, BLOCK_SIZE_W), dtype=ct.float32)

    for col_start in range(0, C, BLOCK_SIZE_C):
        col_offsets = col_start + ct.arange(BLOCK_SIZE_C, dtype=ct.int32)
        mask_C = ct.less(col_offsets, C)

        if BLOCK_SIZE_W == 1:
            indices = row * stride_n + col_offsets * stride_c
            x_tile = ct.gather(x, indices, padding_value=0)
            x_tile = ct.astype(x_tile, ct.float32)
            x_centered = ct.where(
                mask_C,
                ct.sub(x_tile, mean_val),
                ct.zeros((BLOCK_SIZE_C,), dtype=ct.float32),
            )
        else:
            offsets = ct.add(
                ct.reshape(col_offsets, (BLOCK_SIZE_C, 1)) * stride_c,
                ct.reshape(tub_offsets_strided, (1, BLOCK_SIZE_W)),
            )
            offsets = ct.add(row * stride_n, offsets)
            mask = ct.bitwise_and(
                ct.reshape(mask_C, (BLOCK_SIZE_C, 1)),
                ct.reshape(mask_W, (1, BLOCK_SIZE_W)),
            )

            x_tile = ct.gather(x, offsets, padding_value=0)
            x_tile = ct.astype(x_tile, ct.float32)
            mean_val_reshaped = ct.reshape(mean_val, (1, BLOCK_SIZE_W))
            x_centered = ct.where(
                mask,
                ct.sub(x_tile, mean_val_reshaped),
                ct.zeros((BLOCK_SIZE_C, BLOCK_SIZE_W), dtype=ct.float32),
            )

        _var = ct.add(_var, ct.mul(x_centered, x_centered))

    var_val = ct.truediv(ct.sum(_var, axis=0), C)
    rstd_val = ct.rsqrt(ct.add(var_val, eps))

    if BLOCK_SIZE_W == 1:
        rstd_offsets = ct.full((1,), row * W, dtype=ct.int32)
        rstd_val_reshaped = ct.reshape(rstd_val, (1,))
        ct.scatter(rstd, rstd_offsets, rstd_val_reshaped)
    else:
        rstd_offsets = row * W + tub_offsets
        ct.scatter(rstd, rstd_offsets, rstd_val)

    # normalization and affine transformation
    if BLOCK_SIZE_W != 1:
        mean_val = ct.reshape(mean_val, (1, BLOCK_SIZE_W))
        rstd_val = ct.reshape(rstd_val, (1, BLOCK_SIZE_W))

    for col_start in range(0, C, BLOCK_SIZE_C):
        col_offsets = col_start + ct.arange(BLOCK_SIZE_C, dtype=ct.int32)
        mask_C = ct.less(col_offsets, C)

        if BLOCK_SIZE_W == 1:
            indices = row * stride_n + col_offsets * stride_c
            x_tile = ct.gather(x, indices, padding_value=0)
            x_tile = ct.astype(x_tile, ct.float32)
            w_tile = ct.gather(w, col_offsets, padding_value=0)
            w_tile = ct.add(w_tile, weight_shift)
            b_tile = ct.gather(b, col_offsets, padding_value=0)
        else:
            offsets = ct.add(
                ct.reshape(col_offsets, (BLOCK_SIZE_C, 1)) * stride_c,
                ct.reshape(tub_offsets_strided, (1, BLOCK_SIZE_W)),
            )
            offsets = ct.add(row * stride_n, offsets)
            mask = ct.bitwise_and(
                ct.reshape(mask_C, (BLOCK_SIZE_C, 1)),
                ct.reshape(mask_W, (1, BLOCK_SIZE_W)),
            )

            x_tile = ct.gather(x, offsets, padding_value=0)
            x_tile = ct.astype(x_tile, ct.float32)
            w_tile = ct.gather(w, col_offsets, padding_value=0)
            w_tile = ct.reshape(w_tile, (BLOCK_SIZE_C, 1))
            w_tile = ct.add(w_tile, weight_shift)
            b_tile = ct.gather(b, col_offsets, padding_value=0)
            b_tile = ct.reshape(b_tile, (BLOCK_SIZE_C, 1))

        x_hat = ct.mul(ct.sub(x_tile, mean_val), rstd_val)
        y_tile = ct.add(ct.mul(x_hat, w_tile), b_tile)
        y_tile = ct.astype(y_tile, x.dtype)

        if BLOCK_SIZE_W == 1:
            indices = row * stride_n + col_offsets * stride_c
            ct.scatter(y, indices, y_tile)
        else:
            ct.scatter(y, offsets, y_tile)


def layer_norm_forward(
    x: torch.Tensor,
    weight: torch.Tensor,
    bias: torch.Tensor,
    eps: float = 1e-5,
) -> tuple:
    """
    Host wrapper for cuTile layer normalization forward pass.

    Args:
        x: Input tensor [batch_size, normalized_size]
        weight: Weight tensor [normalized_size]
        bias: Bias tensor [normalized_size]
        eps: Epsilon for numerical stability

    Returns:
        y: Normalized output
        mean: Mean per row
        rstd: Reciprocal std per row
    """
    assert x.is_cuda and weight.is_cuda and bias.is_cuda

    # For simple 2D case
    if x.dim() == 2:
        batch_size, normalized_size = x.shape
        start_dim, end_dim = 1, 2
    else:
        # Default to normalizing last dimension
        start_dim = -1
        end_dim = x.dim()

    y = torch.empty_like(x)

    # Squash to (N, C, W) format
    x_squashed = _squash_axis(x, start_dim, end_dim)
    N, C, W = x_squashed.shape
    stride_n, stride_c, stride_w = x_squashed.stride()

    mean = torch.empty((N, W), dtype=torch.float32, device="cuda")
    rstd = torch.empty((N, W), dtype=torch.float32, device="cuda")

    # Compute block sizes
    def next_power_of_2(n):
        return 1 if n == 0 else 2 ** (n - 1).bit_length()

    BLOCK_SIZE_W = min(1024, next_power_of_2(W))
    MAX_FUSED_SIZE = 65536 // BLOCK_SIZE_W // x.element_size()
    BLOCK_SIZE_C = min(MAX_FUSED_SIZE, next_power_of_2(C))

    grid = (N, 1, (W + BLOCK_SIZE_W - 1) // BLOCK_SIZE_W)

    # Flatten tensors for gather/scatter
    x_flat = x_squashed.reshape(-1)
    y_flat = y.reshape(-1)
    mean_flat = mean.reshape(-1)
    rstd_flat = rstd.reshape(-1)

    ct.launch(
        torch.cuda.current_stream(),
        grid,
        layer_norm_fwd_kernel,
        (
            x_flat,
            y_flat,
            weight,
            bias,
            mean_flat,
            rstd_flat,
            stride_n,
            stride_c,
            stride_w,
            C,
            W,
            eps,
            0.0,  # weight_shift
            BLOCK_SIZE_C,
            BLOCK_SIZE_W,
        ),
    )

    return y, mean, rstd


def test_layer_norm():
    """Test function to verify correctness against PyTorch."""
    torch.manual_seed(42)

    # Test parameters
    BATCH_SIZE = 4
    NORMALIZED_SIZE = 256
    EPS = 1e-5

    # Create test inputs
    x = torch.randn(BATCH_SIZE, NORMALIZED_SIZE, device="cuda", dtype=torch.float32)
    weight = torch.ones(NORMALIZED_SIZE, device="cuda", dtype=torch.float32)
    bias = torch.zeros(NORMALIZED_SIZE, device="cuda", dtype=torch.float32)

    # Run cuTile forward
    y_cutile, mean, rstd = layer_norm_forward(x, weight, bias, EPS)

    # Reference (PyTorch)
    y_ref = torch.nn.functional.layer_norm(x, (NORMALIZED_SIZE,), weight, bias, EPS)

    # Verify
    passed = torch.allclose(y_cutile, y_ref, atol=1e-4, rtol=1e-4)
    if passed:
        print("Layer norm test PASSED")
    else:
        diff = (y_cutile - y_ref).abs().max()
        print(f"Layer norm test FAILED - Max difference: {diff}")

    return passed


if __name__ == "__main__":
    test_layer_norm()
