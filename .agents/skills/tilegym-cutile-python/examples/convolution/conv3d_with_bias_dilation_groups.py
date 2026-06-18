# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


"""3D convolution (no bias) with dilation and groups.

Optimized implementation using implicit im2col GEMM.

Key techniques
  1. Implicit im2col GEMM
       Each block covers a TILE_M x TILE_N tile of the (M, N) output matrix where
       M = N * D_out * H_out * W_out and N_col = C_out.  The im2col index decode
       is done on-the-fly inside the k-loop so no extra memory is needed.
  2. Static persistent scheduling
       Grid = (NUM_SM x 2, 1, 1) with a software loop over all tiles.
       This avoids over-subscription and minimises launch overhead.
  3. Tensor-core MMA  (ct.mma with fp16 inputs, fp32 accumulator)
  4. TMA weight loads  (weights reshaped to 2-D, loaded via ct.load TMA path)
  5. num_ctas=2 hint for Blackwell (SM 10.x)
  6. L2 tile swizzle  (GROUP_SIZE_M groups consecutive M-tiles to share
       N-tile weight loads, improving L2 cache reuse)
  7. Heuristic tile selection  (TILE_M x TILE_K ~ 4096 optimal gather footprint)
"""

import math

import cuda.tile as ct
import torch


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------
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


def _select_tile_config_3d(M_total, C_out, K_total, ocpg):
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


# ---------------------------------------------------------------------------
# Optimised implicit im2col GEMM kernel
# ---------------------------------------------------------------------------
@ct.kernel(num_ctas=ct.ByTarget(sm_100=2), occupancy=1)
def conv3d_implicit_gemm_kernel(
    input,  # (N, C_in, D, H, W)
    weights_2d,  # (C_out, K_total)   K_total = C_in_per_group * KD * KH * KW
    output,  # (N, C_out, D_out, H_out, W_out)
    N: ct.Constant[int],
    D: ct.Constant[int],
    H: ct.Constant[int],
    W: ct.Constant[int],
    D_out: ct.Constant[int],
    H_out: ct.Constant[int],
    W_out: ct.Constant[int],
    C_out: ct.Constant[int],
    KD: ct.Constant[int],
    KH: ct.Constant[int],
    KW: ct.Constant[int],
    stride_d: ct.Constant[int],
    stride_h: ct.Constant[int],
    stride_w: ct.Constant[int],
    padding_d: ct.Constant[int],
    padding_h: ct.Constant[int],
    padding_w: ct.Constant[int],
    dilation_d: ct.Constant[int],
    dilation_h: ct.Constant[int],
    dilation_w: ct.Constant[int],
    C_in_per_group: ct.Constant[int],
    C_out_per_group: ct.Constant[int],
    M_total: ct.Constant[int],  # N * D_out * H_out * W_out
    K_total: ct.Constant[int],  # C_in_per_group * KD * KH * KW
    TILE_M: ct.Constant[int],
    TILE_N: ct.Constant[int],
    TILE_K: ct.Constant[int],
    GROUP_SIZE_M: ct.Constant[int],
):
    """Compute 3D convolution (no bias) via implicit im2col GEMM on tensor cores."""
    pid = ct.bid(0)
    num_programs = ct.num_blocks(0)

    num_tiles_m = ct.cdiv(M_total, TILE_M)
    num_tiles_n = ct.cdiv(C_out, TILE_N)
    total_tiles = num_tiles_m * num_tiles_n

    for tile_id in range(pid, total_tiles, num_programs):
        # L2 tile swizzle: group consecutive M-tiles to share N-tile loads
        tiles_per_group = GROUP_SIZE_M * num_tiles_n
        group_id_sw = tile_id // tiles_per_group
        tile_in_group = tile_id % tiles_per_group
        bid_m = group_id_sw * GROUP_SIZE_M + tile_in_group % GROUP_SIZE_M
        bid_n = tile_in_group // GROUP_SIZE_M

        m_base = bid_m * TILE_M
        n_base = bid_n * TILE_N

        # Which group do these output channels belong to?
        group_id = n_base // C_out_per_group
        c_in_offset = group_id * C_in_per_group

        # Decode M indices -> (batch, d_out, h_out, w_out)
        m_range = m_base + ct.arange(TILE_M, dtype=ct.int32)
        batch_idx = m_range // (D_out * H_out * W_out)
        dhw = m_range % (D_out * H_out * W_out)
        d_out_idx = dhw // (H_out * W_out)
        hw = dhw % (H_out * W_out)
        h_out_idx = hw // W_out
        w_out_idx = hw % W_out
        n_range = n_base + ct.arange(TILE_N, dtype=ct.int32)

        # fp32 accumulator
        acc = ct.full((TILE_M, TILE_N), 0.0, dtype=ct.float32)

        # Hoist zero tile outside k-loop
        zero_tile = ct.full((TILE_M, TILE_K), 0.0, dtype=ct.float16)

        num_k_tiles = ct.num_tiles(weights_2d, axis=1, shape=(TILE_N, TILE_K))

        for k_tile in range(num_k_tiles):
            k_base = k_tile * TILE_K
            k_range = k_base + ct.arange(TILE_K, dtype=ct.int32)

            # Decode K -> (c_local, kd, kh, kw)
            c_local = k_range // (KD * KH * KW)
            dkhkw = k_range % (KD * KH * KW)
            kd = dkhkw // (KH * KW)
            khkw = dkhkw % (KH * KW)
            kh = khkw // KW
            kw = khkw % KW
            c_in_idx = c_in_offset + c_local  # absolute input channel [TILE_K]

            # Input spatial positions [TILE_M, TILE_K]
            d_in = d_out_idx[:, None] * stride_d - padding_d + kd[None, :] * dilation_d
            h_in = h_out_idx[:, None] * stride_h - padding_h + kh[None, :] * dilation_h
            w_in = w_out_idx[:, None] * stride_w - padding_w + kw[None, :] * dilation_w

            # Clamp before gather to avoid garbage reads
            d_cl = ct.maximum(ct.minimum(d_in, D - 1), 0)
            h_cl = ct.maximum(ct.minimum(h_in, H - 1), 0)
            w_cl = ct.maximum(ct.minimum(w_in, W - 1), 0)

            # Gather im2col tile [TILE_M, TILE_K]
            raw = ct.gather(
                input,
                (batch_idx[:, None], c_in_idx[None, :], d_cl, h_cl, w_cl),
                padding_value=0.0,
            )
            # Zero out padding / out-of-bounds elements
            valid = (d_in >= 0) & (d_in < D) & (h_in >= 0) & (h_in < H) & (w_in >= 0) & (w_in < W)
            a = ct.where(valid, ct.astype(raw, ct.float16), zero_tile)

            # TMA weight tile [TILE_N, TILE_K] -> transpose -> [TILE_K, TILE_N]
            w = ct.load(weights_2d, (bid_n, k_tile), shape=(TILE_N, TILE_K), padding_mode=ct.PaddingMode.ZERO)
            b = ct.transpose(ct.astype(w, ct.float16))

            # Tensor-core MMA: [TILE_M, TILE_K] x [TILE_K, TILE_N] -> [TILE_M, TILE_N]
            acc = ct.mma(a, b, acc)

        # ReLU (no bias in this model)
        acc = ct.maximum(acc, 0.0)

        # Scatter [TILE_M, TILE_N] -> (N, C_out, D_out, H_out, W_out)
        acc_out = ct.astype(acc, output.dtype)
        batch_out = m_range // (D_out * H_out * W_out)
        dhw_out = m_range % (D_out * H_out * W_out)
        d_out = dhw_out // (H_out * W_out)
        hw_out = dhw_out % (H_out * W_out)
        h_out = hw_out // W_out
        w_out_s = hw_out % W_out
        ct.scatter(
            output,
            (batch_out[:, None], n_range[None, :], d_out[:, None], h_out[:, None], w_out_s[:, None]),
            acc_out,
        )


# ---------------------------------------------------------------------------
# Launch wrapper
# ---------------------------------------------------------------------------
def launch(
    input_tensor,
    weights_2d,
    out_channels,
    out_depth,
    out_height,
    out_width,
    kernel_size_d,
    kernel_size_h,
    kernel_size_w,
    stride_d,
    stride_h,
    stride_w,
    padding_d,
    padding_h,
    padding_w,
    dilation_d,
    dilation_h,
    dilation_w,
    depth,
    height,
    width,
    batch_size,
    in_channels,
    groups,
    TILE_M=128,
    TILE_N=128,
    TILE_K=32,
    GROUP_SIZE_M=8,
):
    """Launch the conv3d implicit GEMM kernel with persistent scheduling."""
    output = torch.zeros(
        [batch_size, out_channels, out_depth, out_height, out_width],
        dtype=torch.float32,
        device="cuda",
    )
    icpg = in_channels // groups
    ocpg = out_channels // groups
    M_total = batch_size * out_depth * out_height * out_width
    K_total = icpg * kernel_size_d * kernel_size_h * kernel_size_w

    # Groups correctness: each TILE_N block must stay within a single group.
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
        conv3d_implicit_gemm_kernel,
        (
            input_tensor,
            weights_2d,
            output,
            batch_size,
            depth,
            height,
            width,
            out_depth,
            out_height,
            out_width,
            out_channels,
            kernel_size_d,
            kernel_size_h,
            kernel_size_w,
            stride_d,
            stride_h,
            stride_w,
            padding_d,
            padding_h,
            padding_w,
            dilation_d,
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


# ---------------------------------------------------------------------------
# PyTorch reference
# ---------------------------------------------------------------------------
def pytorch_reference(x, model):
    """Run the PyTorch reference model for validation."""
    return model(x)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    torch.manual_seed(42)
    depth = 16
    height = 8
    width = 8
    batch_size = 8
    in_channels = 16
    out_channels = 32
    kernel_size = (3, 4, 4)  # int or tuple
    stride = (1, 1, 1)  # int or tuple
    padding = (0, 0, 0)  # int or tuple
    groups = 2  # int
    dilation = (2, 1, 1)  # int or tuple

    assert in_channels % groups == 0, f"in_channels ({in_channels}) must be divisible by groups ({groups})"
    assert out_channels % groups == 0, f"out_channels ({out_channels}) must be divisible by groups ({groups})"

    # Define PyTorch model
    class SimpleConv3D(torch.nn.Module):
        def __init__(self):
            """Initialize conv3d layer with ReLU."""
            super(SimpleConv3D, self).__init__()
            self.conv1 = torch.nn.Conv3d(
                in_channels,
                out_channels,
                kernel_size=kernel_size,
                stride=stride,
                padding=padding,
                dilation=dilation,
                groups=groups,
                bias=False,
            )
            self.relu = torch.nn.ReLU()

        def forward(self, x):
            """Run conv3d -> ReLU."""
            x = self.conv1(x)
            x = self.relu(x)
            return x

    model = SimpleConv3D().eval().to("cuda")

    # Create input tensor
    input_tensor = torch.rand(
        batch_size,
        in_channels,
        depth,
        height,
        width,
        dtype=torch.float32,
        device="cuda",
    )

    stride_d, stride_h, stride_w = stride if isinstance(stride, tuple) else (stride, stride, stride)
    padding_d, padding_h, padding_w = padding if isinstance(padding, tuple) else (padding, padding, padding)
    dilation_d, dilation_h, dilation_w = dilation if isinstance(dilation, tuple) else (dilation, dilation, dilation)
    kernel_size_d, kernel_size_h, kernel_size_w = (
        kernel_size if isinstance(kernel_size, tuple) else (kernel_size, kernel_size, kernel_size)
    )

    # Compute output dimensions
    out_depth = (depth - dilation_d * (kernel_size_d - 1) - 1 + 2 * padding_d) // stride_d + 1
    out_height = (height - dilation_h * (kernel_size_h - 1) - 1 + 2 * padding_h) // stride_h + 1
    out_width = (width - dilation_w * (kernel_size_w - 1) - 1 + 2 * padding_w) // stride_w + 1

    # Get weights and reshape to 2D for the optimised kernel
    weights = model.conv1.weight.data  # (out_channels, in_channels/groups, KD, KH, KW)
    icpg = in_channels // groups
    ocpg = out_channels // groups
    C_out = out_channels
    K_total = icpg * kernel_size_d * kernel_size_h * kernel_size_w
    M_total = batch_size * out_depth * out_height * out_width
    weights_2d = weights.reshape(C_out, K_total).contiguous()

    # Select tile config via heuristic
    TILE_M, TILE_N, TILE_K, GROUP_SIZE_M = _select_tile_config_3d(M_total, C_out, K_total, ocpg)

    # Launch optimised kernel
    output_cudatile = launch(
        input_tensor,
        weights_2d,
        out_channels,
        out_depth,
        out_height,
        out_width,
        kernel_size_d,
        kernel_size_h,
        kernel_size_w,
        stride_d,
        stride_h,
        stride_w,
        padding_d,
        padding_h,
        padding_w,
        dilation_d,
        dilation_h,
        dilation_w,
        depth,
        height,
        width,
        batch_size,
        in_channels,
        groups,
        TILE_M=TILE_M,
        TILE_N=TILE_N,
        TILE_K=TILE_K,
        GROUP_SIZE_M=GROUP_SIZE_M,
    )

    # PyTorch reference execution
    with torch.no_grad():
        ref_output = pytorch_reference(input_tensor, model)

    # Numerical validation
    assert not torch.isnan(output_cudatile).any(), "cuTile output contains NaN values"
    assert not torch.isinf(output_cudatile).any(), "cuTile output contains Inf values"
    assert output_cudatile.dtype.is_floating_point, (
        f"cuTile output tensor must be floating point, got {output_cudatile.dtype}"
    )
    assert torch.allclose(output_cudatile, ref_output, atol=1e-2, rtol=1e-2), (
        "cuTile output does not match PyTorch reference"
    )
    print("Test passed!")
