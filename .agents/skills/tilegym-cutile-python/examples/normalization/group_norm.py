# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


"""Group normalization with bias.

Optimized implementation using static persistent scheduling.

Key techniques
  1. Static persistent scheduling over flattened (N, num_groups)
  2. occupancy=4 (normalization is memory-bound)
  3. Two-pass optimization: fused mean+variance using E[x^2] - E[x]^2
  4. Larger BLOCK_SIZE (256)
"""

import cuda.tile as ct
import torch


@ct.kernel(occupancy=4)
def group_norm_kernel(
    input,
    output,
    weight,
    bias,
    num_groups: ct.Constant[int],
    C_per_group: ct.Constant[int],
    H: ct.Constant[int],
    W: ct.Constant[int],
    eps: ct.Constant[float],
    total_work: ct.Constant[int],
    BLOCK_SIZE: ct.Constant[int],
):
    """Compute group normalization with fused mean+variance and affine transform."""
    pid = ct.bid(0)
    num_programs = ct.num_blocks(0)

    for work_id in range(pid, total_work, num_programs):
        bid_n = work_id // num_groups
        bid_g = work_id % num_groups
        size = H * W * C_per_group

        # Pass 1: Compute sum and sum_sq simultaneously
        tx_sum = ct.full((1, 1, 1), 0.0, dtype=torch.float32)
        tx_sum_sq = ct.full((1, 1, 1), 0.0, dtype=torch.float32)
        for i in range(size // BLOCK_SIZE):
            tx = ct.load(input, index=(bid_n, bid_g, i), shape=(1, 1, BLOCK_SIZE))
            tx_f32 = ct.astype(tx, ct.float32)
            tx_sum = tx_sum + ct.sum(tx_f32, axis=2, keepdims=True)
            tx_sum_sq = tx_sum_sq + ct.sum(tx_f32 * tx_f32, axis=2, keepdims=True)
        tx_mean = tx_sum / size
        tx_var = tx_sum_sq / size - tx_mean * tx_mean

        # Pass 2: Normalize and apply per-channel affine transformation.
        # GroupNorm's weight and bias are per-channel (shape (C,)), not
        # per-group. Within each group, the flattened axis is channel-major
        # ((C_per_group, H*W)), so when BLOCK_SIZE divides H*W each block lies
        # entirely within one channel and we can load a single scalar
        # weight[channel]/bias[channel] per block.
        inv_std = 1.0 / ct.sqrt(tx_var + eps)
        blocks_per_channel = (H * W) // BLOCK_SIZE
        for i in range(size // BLOCK_SIZE):
            channel_idx = bid_g * C_per_group + i // blocks_per_channel
            tw = ct.load(weight, index=(channel_idx,), shape=(1,))
            tb = ct.load(bias, index=(channel_idx,), shape=(1,))
            tx = ct.load(input, index=(bid_n, bid_g, i), shape=(1, 1, BLOCK_SIZE))
            tx_norm = (tx - tx_mean) * inv_std
            result = tx_norm * tw + tb
            result = result.astype(output.dtype)
            ct.store(output, index=(bid_n, bid_g, i), tile=result)


def cutile_groupnorm(input, weight, bias, num_groups, eps=1e-5):
    """Launch the group normalization kernel on the input tensor."""
    N, C, H, W = input.shape
    C_per_group = C // num_groups
    input = input.view(N, num_groups, -1)
    total_work = N * num_groups
    BLOCK_SIZE = 256

    # The kernel iterates `range(size // BLOCK_SIZE)` for both the statistics
    # pass and the normalization pass, and pass 2 assumes each block stays
    # within a single channel (so per-channel weight/bias can be loaded once
    # per block). Both conditions follow from BLOCK_SIZE dividing H*W.
    spatial = H * W
    assert spatial % BLOCK_SIZE == 0, (
        f"H * W ({spatial}) must be divisible by BLOCK_SIZE ({BLOCK_SIZE}) so each block stays within a single channel"
    )

    NUM_SM = torch.cuda.get_device_properties("cuda").multi_processor_count
    num_programs = min(NUM_SM * 4, total_work)
    grid = (num_programs, 1, 1)

    output = torch.zeros_like(input)
    ct.launch(
        torch.cuda.current_stream(),
        grid,
        group_norm_kernel,
        (input, output, weight, bias, num_groups, C_per_group, H, W, eps, total_work, BLOCK_SIZE),
    )
    return output.view(N, C, H, W)


def pytorch_reference(model, input):
    """Compute group normalization using PyTorch's built-in module."""
    return model(input)


if __name__ == "__main__":
    torch.manual_seed(42)
    N, C, H, W = 4, 64, 32, 64
    num_groups = 8
    dtype = torch.float16

    assert C % num_groups == 0, f"Number of channels ({C}) must be divisible by num_groups ({num_groups})"
    assert dtype == torch.float16, "Only float16 is supported"

    class GroupNorm(torch.nn.Module):
        def __init__(self, num_groups, num_channels):
            """Initialize PyTorch GroupNorm wrapper."""
            super(GroupNorm, self).__init__()
            self.group_norm = torch.nn.GroupNorm(num_groups, num_channels)

        def forward(self, x):
            """Apply group normalization."""
            return self.group_norm(x)

    model = GroupNorm(num_groups, C).eval().to(dtype).to("cuda")

    # Create test input
    input_tensor = torch.rand(N, C, H, W, dtype=dtype, device="cuda")
    weight = model.group_norm.weight.data
    bias = model.group_norm.bias.data

    eps = 1e-5
    output_cutile = cutile_groupnorm(input_tensor, weight, bias, num_groups, eps)

    # Test against PyTorch's built-in GroupNorm
    output_pytorch = pytorch_reference(model, input_tensor)

    # Validate results
    if torch.allclose(output_cutile, output_pytorch, atol=1e-2, rtol=1e-2):
        print("Test passed!")
    else:
        print("Test failed!")
        abs_diff = torch.abs(output_cutile - output_pytorch)
        print(f"Max absolute difference: {torch.max(abs_diff).item():.6f}")
        print(f"Mean absolute difference: {torch.mean(abs_diff).item():.6f}")
