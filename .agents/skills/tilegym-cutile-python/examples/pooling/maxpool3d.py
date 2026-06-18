# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


"""3D max pooling.

Optimized implementation using static persistent scheduling.

Key techniques
  1. Static persistent scheduling over all output elements
  2. occupancy=4 (pooling is memory-bound)
  3. Gather-based access for non-aligned kernel windows with dilation
"""

import math

import cuda.tile as ct
import torch


@ct.kernel(occupancy=4)
def maxpool3d_kernel(
    input,
    output,
    num_channels: ct.Constant[int],
    depth: ct.Constant[int],
    height: ct.Constant[int],
    width: ct.Constant[int],
    kernel_size_d: ct.Constant[int],
    kernel_size_h: ct.Constant[int],
    kernel_size_w: ct.Constant[int],
    kernel_size_p_d: ct.Constant[int],
    kernel_size_p_h: ct.Constant[int],
    kernel_size_p_w: ct.Constant[int],
    stride_d: ct.Constant[int],
    stride_h: ct.Constant[int],
    stride_w: ct.Constant[int],
    padding_d: ct.Constant[int],
    padding_h: ct.Constant[int],
    padding_w: ct.Constant[int],
    dilation_d: ct.Constant[int],
    dilation_h: ct.Constant[int],
    dilation_w: ct.Constant[int],
    D_out: ct.Constant[int],
    H_out: ct.Constant[int],
    W_out: ct.Constant[int],
    total_work: ct.Constant[int],
):
    """Compute 3D max pooling with dilation using gather-based window access."""
    pid = ct.bid(0)
    num_programs = ct.num_blocks(0)

    for work_id in range(pid, total_work, num_programs):
        # Decode linear index to (n, c, d, h, w)
        bid_n = work_id // (num_channels * D_out * H_out * W_out)
        rem = work_id % (num_channels * D_out * H_out * W_out)
        bid_c = rem // (D_out * H_out * W_out)
        rem2 = rem % (D_out * H_out * W_out)
        bid_d = rem2 // (H_out * W_out)
        rem3 = rem2 % (H_out * W_out)
        bid_h = rem3 // W_out
        bid_w = rem3 % W_out

        # compute the left-top corner of the kernel for pooling with dilation
        dilated_kernel_size_d = dilation_d * (kernel_size_d - 1) + 1
        dilated_kernel_size_h = dilation_h * (kernel_size_h - 1) + 1
        dilated_kernel_size_w = dilation_w * (kernel_size_w - 1) + 1
        d_start = bid_d * stride_d - padding_d
        h_start = bid_h * stride_h - padding_h
        w_start = bid_w * stride_w - padding_w

        range_d = d_start + ct.arange(kernel_size_p_d, dtype=ct.int32) * dilation_d
        range_h = h_start + ct.arange(kernel_size_p_h, dtype=ct.int32) * dilation_h
        range_w = w_start + ct.arange(kernel_size_p_w, dtype=ct.int32) * dilation_w

        mask_d = (range_d >= 0) & (range_d < min(depth, d_start + dilated_kernel_size_d))
        mask_h = (range_h >= 0) & (range_h < min(height, h_start + dilated_kernel_size_h))
        mask_w = (range_w >= 0) & (range_w < min(width, w_start + dilated_kernel_size_w))

        mask = mask_d[None, None, :, None, None] & mask_h[None, None, None, :, None] & mask_w[None, None, None, None, :]

        index_n = ct.full(1, bid_n, dtype=ct.int32)[:, None, None, None, None]
        index_c = ct.full(1, bid_c, dtype=ct.int32)[None, :, None, None, None]
        index_d = range_d[None, None, :, None, None]
        index_h = range_h[None, None, None, :, None]
        index_w = range_w[None, None, None, None, :]
        indices = (index_n, index_c, index_d, index_h, index_w)
        mask_float = mask.astype(input.dtype)
        tx_raw = ct.gather(input, indices, padding_value=0)
        # Mask out invalid positions with a large negative value
        tx = tx_raw * mask_float - (1 - mask_float) * 1e30
        max_val = ct.max(tx, axis=(2, 3, 4), keepdims=True)
        result = ct.astype(max_val, output.dtype)
        ct.store(output, (bid_n, bid_c, bid_d, bid_h, bid_w), result)


def pytorch_reference(input, kernel_size, stride=None, padding=0, dilation=1, ceil_mode=False):
    """Compute 3D max pooling using PyTorch's built-in function."""
    return torch.nn.functional.max_pool3d(input, kernel_size, stride, padding, dilation, ceil_mode)


if __name__ == "__main__":
    torch.manual_seed(42)
    # Test parameters
    N, num_channels, depth, height, width = 2, 3, 8, 16, 16
    kernel_size = 3
    stride = 2
    padding = 1
    dilation = 2
    ceil_mode = False
    dtype = torch.float32

    # Create test input
    input_tensor = torch.rand(N, num_channels, depth, height, width, dtype=dtype, device="cuda")

    # Test manual implementation
    if not ceil_mode:
        depth_output = (depth + 2 * padding - dilation * (kernel_size - 1) - 1) // stride + 1
        height_output = (height + 2 * padding - dilation * (kernel_size - 1) - 1) // stride + 1
        width_output = (width + 2 * padding - dilation * (kernel_size - 1) - 1) // stride + 1
    else:
        depth_output = math.ceil((depth + 2 * padding - dilation * (kernel_size - 1) - 1) / stride) + 1
        height_output = math.ceil((height + 2 * padding - dilation * (kernel_size - 1) - 1) / stride) + 1
        width_output = math.ceil((width + 2 * padding - dilation * (kernel_size - 1) - 1) / stride) + 1
    assert depth_output > 0, "depth_output must be greater than 0"
    assert height_output > 0, "height_output must be greater than 0"
    assert width_output > 0, "width_output must be greater than 0"

    def next_power_of_2(x: int) -> int:
        """Return the smallest power of 2 >= x."""
        return 1 << (x - 1).bit_length()

    kernel_size_p = next_power_of_2(kernel_size)

    output_cutile = torch.zeros(
        N,
        num_channels,
        depth_output,
        height_output,
        width_output,
        dtype=dtype,
        device="cuda",
    )

    total_work = N * num_channels * depth_output * height_output * width_output
    NUM_SM = torch.cuda.get_device_properties("cuda").multi_processor_count
    num_programs = min(NUM_SM * 4, total_work)
    grid = (num_programs, 1, 1)

    ct.launch(
        torch.cuda.current_stream(),
        grid,
        maxpool3d_kernel,
        (
            input_tensor,
            output_cutile,
            num_channels,
            depth,
            height,
            width,
            kernel_size,
            kernel_size,
            kernel_size,
            kernel_size_p,
            kernel_size_p,
            kernel_size_p,
            stride,
            stride,
            stride,
            padding,
            padding,
            padding,
            dilation,
            dilation,
            dilation,
            depth_output,
            height_output,
            width_output,
            total_work,
        ),
    )

    # Test against PyTorch's built-in max_pool3d
    output_pytorch = pytorch_reference(input_tensor, kernel_size, stride, padding, dilation, ceil_mode)

    # Validate results
    if torch.allclose(output_cutile, output_pytorch, atol=1e-6, rtol=1e-6):
        print("Test passed!")
        print(f"Input shape: {input_tensor.shape}")
        print(f"Output shape: {output_cutile.shape}")
    else:
        print("Test failed!")
        abs_diff = torch.abs(output_cutile - output_pytorch)
        print(f"Max absolute difference: {torch.max(abs_diff).item():.6f}")
        print(f"Mean absolute difference: {torch.mean(abs_diff).item():.6f}")
        print(f"Input shape: {input_tensor.shape}")
        print(f"Manual output shape: {output_cutile.shape}")
        print(f"PyTorch output shape: {output_pytorch.shape}")
