# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


"""2D convolution transpose with bias, dilation, groups, and output_padding.

Optimized implementation using implicit im2col GEMM (transposed-conv variant).

Key techniques
  1. Implicit im2col GEMM (transposed-conv variant)
       Each block covers a TILE_M x TILE_N tile of the (M, N) output matrix where
       M = N * H_out * W_out and N_col = C_out.  The transposed im2col index
       decode (with stride-divisibility check) is done on-the-fly.
  2. Static persistent scheduling
       Grid = (NUM_SM x 2, 1, 1) with a software loop over all tiles.
  3. Tensor-core MMA  (ct.mma with fp16 inputs, fp32 accumulator)
  4. TMA weight loads  (weights permuted+reshaped to 2-D, loaded via ct.load TMA path)
  5. num_ctas=2 hint for Blackwell (SM 10.x)
  6. L2 tile swizzle  (GROUP_SIZE_M groups consecutive M-tiles to share
       N-tile weight loads, improving L2 cache reuse)
  7. Heuristic tile selection  (TILE_M x TILE_K ~ 4096 optimal gather footprint)

Weight layout for transposed conv:
  Original: (C_in, C_out_per_group, KH, KW)
  Reshaped: view(groups, icpg, ocpg, KH, KW).permute(0,2,1,3,4).reshape(C_out, K_total)
  This gives weight_2d[oc, k] = original_weight[ic, oc_in_group, kh, kw]

Transposed conv im2col:
  For output position (h_out, w_out) and kernel position (kh, kw):
    h_in = (h_out + pad_h - kh * dil_h) / stride_h  (must be exact integer)
    w_in = (w_out + pad_w - kw * dil_w) / stride_w  (must be exact integer)
"""

import math

import cuda.tile as ct
import torch


def next_power_of_2(x: int) -> int:
    """Return the smallest power of 2 >= x."""
    if x == 0:
        return 1
    return 1 << (x - 1).bit_length()


def _adjust_group_size(num_tiles_m, group_size_m):
    """Adjust GROUP_SIZE_M to divide num_tiles_m for swizzle correctness."""
    gsm = min(group_size_m, num_tiles_m)
    while num_tiles_m % gsm != 0 and gsm > 1:
        gsm -= 1
    return max(gsm, 1)


def _select_tile_config_trans2d(M_total, C_out, K_total, ocpg):
    """Heuristic tile config selection based on problem dimensions.

    Key insights from systematic tuning on Blackwell (150 SMs):
    - TILE_N = min(C_out, 256) maximises output-channel reuse per M-tile
    - TILE_M x TILE_K ~ 4096 is the optimal gather footprint
    - L2 swizzle (GROUP_SIZE_M) helps when num_tiles_m is large
    """
    # -- TILE_N: cover as many output channels as possible --
    TILE_N = min(C_out, 256)
    # Round down to power of 2
    tn = 1
    while tn * 2 <= TILE_N:
        tn *= 2
    TILE_N = tn

    # Groups correctness: TILE_N must not exceed C_out_per_group
    if TILE_N > ocpg:
        TILE_N = next_power_of_2(ocpg)
        while TILE_N > ocpg:
            TILE_N //= 2

    # -- TILE_M + TILE_K: jointly selected --
    # Key insight: optimal gather footprint is ~4096 elements per iteration
    # (TILE_M x TILE_K ~ 4096). This balances cache line utilisation with
    # register pressure.
    if M_total >= 10000:
        TILE_M = 256
        TILE_K = 16  # 256 x 16 = 4096 elements per gather
    elif M_total >= 1000:
        TILE_M = 128
        TILE_K = 32  # 128 x 32 = 4096 elements per gather
    else:
        TILE_M = 64
        TILE_K = 32  # 64 x 32 = 2048 (small problem, keep simple)

    GROUP_SIZE_M = 8

    return TILE_M, TILE_N, TILE_K, GROUP_SIZE_M


@ct.kernel(num_ctas=ct.ByTarget(sm_100=2), occupancy=1)
def conv_transpose_2d_implicit_gemm_kernel(
    input,  # (N, C_in, H_in, W_in)
    weights_2d,  # (C_out, K_total)   K_total = C_in_per_group * KH * KW
    conv_bias,  # (C_out,)
    model_bias,  # (C_out,)  flattened from (C_out, 1, 1)
    output,  # (N, C_out, H_out, W_out)
    N: ct.Constant[int],
    H_in: ct.Constant[int],
    W_in: ct.Constant[int],
    H_out: ct.Constant[int],
    W_out: ct.Constant[int],
    C_out: ct.Constant[int],
    KH: ct.Constant[int],
    KW: ct.Constant[int],
    stride_h: ct.Constant[int],
    stride_w: ct.Constant[int],
    padding_h: ct.Constant[int],
    padding_w: ct.Constant[int],
    dilation_h: ct.Constant[int],
    dilation_w: ct.Constant[int],
    C_in_per_group: ct.Constant[int],
    C_out_per_group: ct.Constant[int],
    M_total: ct.Constant[int],
    K_total: ct.Constant[int],
    TILE_M: ct.Constant[int],
    TILE_N: ct.Constant[int],
    TILE_K: ct.Constant[int],
    GROUP_SIZE_M: ct.Constant[int],
):
    """Compute 2D transposed convolution via implicit im2col GEMM on tensor cores."""
    pid = ct.bid(0)
    num_programs = ct.num_blocks(0)

    num_tiles_m = ct.cdiv(M_total, TILE_M)
    num_tiles_n = ct.cdiv(C_out, TILE_N)
    total_tiles = num_tiles_m * num_tiles_n

    for tile_id in range(pid, total_tiles, num_programs):
        # L2 tile swizzle
        tiles_per_group = GROUP_SIZE_M * num_tiles_n
        group_id_sw = tile_id // tiles_per_group
        tile_in_group = tile_id % tiles_per_group
        bid_m = group_id_sw * GROUP_SIZE_M + tile_in_group % GROUP_SIZE_M
        bid_n = tile_in_group // GROUP_SIZE_M

        m_base = bid_m * TILE_M
        n_base = bid_n * TILE_N

        group_id = n_base // C_out_per_group
        c_in_offset = group_id * C_in_per_group

        m_range = m_base + ct.arange(TILE_M, dtype=ct.int32)
        batch_idx = m_range // (H_out * W_out)
        hw = m_range % (H_out * W_out)
        h_out_idx = hw // W_out
        w_out_idx = hw % W_out
        n_range = n_base + ct.arange(TILE_N, dtype=ct.int32)

        acc = ct.full((TILE_M, TILE_N), 0.0, dtype=ct.float32)
        zero_tile = ct.full((TILE_M, TILE_K), 0.0, dtype=ct.float16)

        num_k_tiles = ct.num_tiles(weights_2d, axis=1, shape=(TILE_N, TILE_K))

        for k_tile in range(num_k_tiles):
            k_base = k_tile * TILE_K
            k_range = k_base + ct.arange(TILE_K, dtype=ct.int32)

            c_local = k_range // (KH * KW)
            khkw = k_range % (KH * KW)
            kh = khkw // KW
            kw = khkw % KW
            c_in_idx = c_in_offset + c_local

            h_num = h_out_idx[:, None] + padding_h - kh[None, :] * dilation_h
            w_num = w_out_idx[:, None] + padding_w - kw[None, :] * dilation_w
            h_in = h_num // stride_h
            w_in = w_num // stride_w

            valid = (
                (h_num % stride_h == 0)
                & (w_num % stride_w == 0)
                & (h_in >= 0)
                & (h_in < H_in)
                & (w_in >= 0)
                & (w_in < W_in)
            )

            h_cl = ct.maximum(ct.minimum(h_in, H_in - 1), 0)
            w_cl = ct.maximum(ct.minimum(w_in, W_in - 1), 0)

            raw = ct.gather(
                input,
                (batch_idx[:, None], c_in_idx[None, :], h_cl, w_cl),
                padding_value=0.0,
            )
            a = ct.where(valid, ct.astype(raw, ct.float16), zero_tile)

            w = ct.load(weights_2d, (bid_n, k_tile), shape=(TILE_N, TILE_K), padding_mode=ct.PaddingMode.ZERO)
            b = ct.transpose(ct.astype(w, ct.float16))

            acc = ct.mma(a, b, acc)

        # Conv bias + model bias
        cb = ct.astype(ct.load(conv_bias, (bid_n,), shape=(TILE_N,), padding_mode=ct.PaddingMode.ZERO), ct.float32)
        acc = acc + ct.reshape(cb, (1, TILE_N))

        mb = ct.astype(ct.load(model_bias, (bid_n,), shape=(TILE_N,), padding_mode=ct.PaddingMode.ZERO), ct.float32)
        acc = acc + ct.reshape(mb, (1, TILE_N))

        acc_out = ct.astype(acc, output.dtype)
        batch_out = m_range // (H_out * W_out)
        hw_out = m_range % (H_out * W_out)
        h_out = hw_out // W_out
        w_out_s = hw_out % W_out
        ct.scatter(
            output,
            (batch_out[:, None], n_range[None, :], h_out[:, None], w_out_s[:, None]),
            acc_out,
        )


def launch(
    input_tensor,
    weights_2d,
    conv_bias,
    model_bias_1d,
    out_channels,
    out_height,
    out_width,
    kernel_size_h,
    kernel_size_w,
    stride_h,
    stride_w,
    padding_h,
    padding_w,
    dilation_h,
    dilation_w,
    height,
    width,
    batch_size,
    in_channels,
    groups,
):
    """Launch the optimized implicit GEMM kernel with heuristic tile selection."""
    output = torch.zeros(
        [batch_size, out_channels, out_height, out_width],
        dtype=torch.float32,
        device="cuda",
    )
    icpg = in_channels // groups
    ocpg = out_channels // groups
    M_total = batch_size * out_height * out_width
    K_total = icpg * kernel_size_h * kernel_size_w

    TILE_M, TILE_N, TILE_K, GROUP_SIZE_M = _select_tile_config_trans2d(M_total, out_channels, K_total, ocpg)

    if groups > 1 and TILE_N > ocpg:
        TILE_N = next_power_of_2(ocpg)
        while TILE_N > ocpg:
            TILE_N //= 2

    num_tiles_m = math.ceil(M_total / TILE_M)
    GROUP_SIZE_M = _adjust_group_size(num_tiles_m, GROUP_SIZE_M)

    NUM_SM = torch.cuda.get_device_properties("cuda").multi_processor_count
    num_tiles = num_tiles_m * math.ceil(out_channels / TILE_N)
    num_programs = min(NUM_SM * 2, num_tiles)
    grid = (num_programs, 1, 1)

    ct.launch(
        torch.cuda.current_stream(),
        grid,
        conv_transpose_2d_implicit_gemm_kernel,
        (
            input_tensor,
            weights_2d,
            conv_bias,
            model_bias_1d,
            output,
            batch_size,
            height,
            width,
            out_height,
            out_width,
            out_channels,
            kernel_size_h,
            kernel_size_w,
            stride_h,
            stride_w,
            padding_h,
            padding_w,
            dilation_h,
            dilation_w,
            icpg,
            ocpg,
            M_total,
            K_total,
            TILE_M,
            TILE_N,
            TILE_K,
            GROUP_SIZE_M,
        ),
    )
    return output


# PyTorch reference implementation
def pytorch_reference(x, model):
    """Run the PyTorch reference model for validation."""
    with torch.no_grad():
        return model(x)


# Main execution and validation
if __name__ == "__main__":
    torch.manual_seed(42)
    height = 5
    width = 5
    batch_size = 8
    in_channels = 64
    out_channels = 128
    kernel_size = (3, 4)
    stride = (2, 2)
    padding = (0, 0)
    output_padding = (0, 0)
    groups = 1
    dilation = (1, 1)

    assert in_channels % groups == 0, f"in_channels ({in_channels}) must be divisible by groups ({groups})"
    assert out_channels % groups == 0, f"out_channels ({out_channels}) must be divisible by groups ({groups})"

    # Define PyTorch model
    class SimpleConvTranspose2D(torch.nn.Module):
        def __init__(self):
            """Initialize transposed conv2d layer with model bias."""
            super(SimpleConvTranspose2D, self).__init__()
            self.conv_transpose1 = torch.nn.ConvTranspose2d(
                in_channels,
                out_channels,
                kernel_size=kernel_size,
                stride=stride,
                padding=padding,
                output_padding=output_padding,
                groups=groups,
                dilation=dilation,
            )
            self.bias = torch.nn.Parameter(torch.rand(out_channels, 1, 1))  # model bias

        def forward(self, x):
            """Run transposed conv2d -> bias add."""
            x = self.conv_transpose1(x)
            x = x + self.bias
            return x

    model = SimpleConvTranspose2D().eval().to("cuda")

    # Create input tensor
    input_tensor = torch.rand(
        batch_size,
        in_channels,
        height,
        width,
        dtype=torch.float32,
        device="cuda",
    )

    # Set kernel dimension parameters
    stride_h, stride_w = stride if isinstance(stride, tuple) else (stride, stride)
    padding_h, padding_w = padding if isinstance(padding, tuple) else (padding, padding)
    output_padding_h, output_padding_w = (
        output_padding if isinstance(output_padding, tuple) else (output_padding, output_padding)
    )
    dilation_h, dilation_w = dilation if isinstance(dilation, tuple) else (dilation, dilation)
    kernel_size_h, kernel_size_w = kernel_size if isinstance(kernel_size, tuple) else (kernel_size, kernel_size)

    # Compute output dimensions
    out_height = (height - 1) * stride_h - 2 * padding_h + (kernel_size_h - 1) * dilation_h + output_padding_h + 1
    out_width = (width - 1) * stride_w - 2 * padding_w + (kernel_size_w - 1) * dilation_w + output_padding_w + 1

    # Get weights from the model and prepare for implicit GEMM
    weights_tensor = model.conv_transpose1.weight.data  # (in_channels, out_channels/groups, KH, KW)
    conv_transpose_bias = model.conv_transpose1.bias.data  # (out_channels,)
    model_bias = model.bias.data  # (out_channels, 1, 1)

    icpg = in_channels // groups
    ocpg = out_channels // groups
    K_total = icpg * kernel_size_h * kernel_size_w

    # Weight permutation for transposed conv implicit GEMM layout:
    #   Original: (C_in, C_out_per_group, KH, KW)
    #   Target:   (C_out, K_total) where K_total = C_in_per_group * KH * KW
    weights_2d = (
        weights_tensor.view(groups, icpg, ocpg, kernel_size_h, kernel_size_w)
        .permute(0, 2, 1, 3, 4)
        .reshape(out_channels, K_total)
        .contiguous()
    )

    # Flatten model bias from (C_out, 1, 1) to (C_out,)
    model_bias_1d = model_bias.reshape(out_channels).contiguous()

    # Launch optimized kernel
    output_cudatile = launch(
        input_tensor,
        weights_2d,
        conv_transpose_bias,
        model_bias_1d,
        out_channels,
        out_height,
        out_width,
        kernel_size_h,
        kernel_size_w,
        stride_h,
        stride_w,
        padding_h,
        padding_w,
        dilation_h,
        dilation_w,
        height,
        width,
        batch_size,
        in_channels,
        groups,
    )

    # PyTorch reference execution
    ref_output = pytorch_reference(input_tensor, model)

    # Numerical validation
    assert not torch.isnan(output_cudatile).any(), "cuTile output contains NaN values"
    assert not torch.isinf(output_cudatile).any(), "cuTile output contains Inf values"
    assert output_cudatile.dtype.is_floating_point, (
        f"cuTile output tensor must be floating point, got {output_cudatile.dtype}"
    )
    assert torch.allclose(output_cudatile, ref_output, atol=1e-2, rtol=1e-2), (
        f"cuTile output does not match PyTorch reference "
        f"(max diff: {torch.max(torch.abs(output_cudatile - ref_output))})"
    )
    print("Test passed!")
