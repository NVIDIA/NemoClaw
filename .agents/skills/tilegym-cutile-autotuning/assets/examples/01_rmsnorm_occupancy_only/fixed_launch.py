# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


"""
RMSNorm - CuTile Fixed-Config Launch (BEFORE autotuning)

Demonstrates a CuTile RMSNorm kernel with a hardcoded ct.launch.
The occupancy is fixed at 4; no search is performed.

Formula: output = x / sqrt(mean(x^2) + eps) * weight

Kernel shape:
  Input:  (M, N)   — M rows, N = hidden_dim
  Output: (M, N)
  Weight: (N,)     — per-channel scale (gamma)

One block per row, persistent scheduling over M rows.
"""

import math

import cuda.tile as ct
import torch


@ct.kernel(occupancy=4)
def rmsnorm_kernel(
    output,  # (M, N) float16/bfloat16
    x,  # (M, N) same dtype
    weight,  # (N,)   float32 gamma
    eps: ct.Constant[float],
    M: ct.Constant[int],
    N: ct.Constant[int],
    TILE_N: ct.Constant[int],
):
    """
    RMSNorm kernel.  Each block handles one or more rows (persistent loop).

    For each row:
      1. Load row tile (possibly padded if N is not a multiple of TILE_N).
      2. Compute sum(x^2) and mean squared, then rms = sqrt(mean_sq + eps).
      3. Normalise: x_norm = x / rms.
      4. Scale:     out    = x_norm * weight.
      5. Store result.
    """
    bid = ct.bid(0)
    num_programs = ct.num_blocks(0)
    offsets = ct.arange(TILE_N, dtype=ct.int32)

    for row in range(bid, M, num_programs):
        # Load one row; out-of-bounds elements padded with 0 (safe for squared sum)
        x_row = ct.gather(x, (row, offsets), check_bounds=True, padding_value=0.0)
        x_fp32 = ct.astype(x_row, ct.float32)

        # mean(x^2)
        sq = ct.mul(x_fp32, x_fp32)
        mean_sq = ct.truediv(ct.sum(sq, 0, keepdims=True), float(N))

        # rms denominator
        rms = ct.sqrt(ct.add(mean_sq, eps))

        # Normalize
        x_norm = ct.truediv(x_fp32, rms)

        # Load weight and apply scale
        w = ct.gather(weight, (offsets,), check_bounds=True, padding_value=0.0)
        w_fp32 = ct.astype(w, ct.float32)
        out_fp32 = ct.mul(x_norm, w_fp32)

        # Cast back to input dtype and store
        out_row = ct.astype(out_fp32, x.dtype)
        ct.scatter(output, (row, offsets), out_row, check_bounds=True)


def rmsnorm(x: torch.Tensor, weight: torch.Tensor, eps: float = 1e-6) -> torch.Tensor:
    """
    Host wrapper: RMSNorm with a fixed occupancy=4 ct.launch.

    Args:
        x:      Input tensor (M, N)
        weight: Scale tensor (N,)
        eps:    Epsilon for numerical stability

    Returns:
        Normalised + scaled tensor (M, N)
    """
    assert x.is_cuda, "x must be on CUDA"
    assert x.ndim == 2, "x must be 2-D (M, N)"
    M, N = x.shape

    x = x.contiguous()
    weight = weight.contiguous().to(torch.float32)

    output = torch.empty_like(x)

    # TILE_N must be a power of 2 for ct.sum reduction to work correctly
    TILE_N = 1 if N == 0 else 2 ** (N - 1).bit_length()

    NUM_SM = torch.cuda.get_device_properties(x.device).multi_processor_count
    # Fixed occupancy = 4 (hardcoded; see autotuned_launch.py for the tuned version)
    OCCUPANCY = 4
    num_programs = min(NUM_SM * OCCUPANCY, M)
    grid = (num_programs, 1, 1)

    ct.launch(
        torch.cuda.current_stream(),
        grid,
        rmsnorm_kernel,
        (output, x, weight, eps, M, N, TILE_N),
    )

    return output


# ---------------------------------------------------------------------------
# Tests / timing
# ---------------------------------------------------------------------------


def _ref_rmsnorm(x: torch.Tensor, weight: torch.Tensor, eps: float) -> torch.Tensor:
    """Reference implementation using PyTorch ops."""
    x_fp32 = x.float()
    mean_sq = (x_fp32**2).mean(dim=-1, keepdim=True)
    x_norm = x_fp32 / torch.sqrt(mean_sq + eps)
    return (x_norm * weight.float()).to(x.dtype)


def test_rmsnorm():
    print("Testing RMSNorm fixed-launch implementation...")
    torch.manual_seed(42)
    eps = 1e-6

    test_cases = [
        (128, 512, torch.float16),
        (512, 4096, torch.bfloat16),
        (1, 256, torch.float16),  # edge: single row
    ]

    all_passed = True
    for M, N, dtype in test_cases:
        x = torch.randn(M, N, device="cuda", dtype=dtype)
        w = torch.randn(N, device="cuda", dtype=torch.float32)

        out_ct = rmsnorm(x, w, eps)
        out_ref = _ref_rmsnorm(x, w, eps)

        atol = 1e-2 if dtype == torch.float16 else 2e-2
        passed = torch.allclose(out_ct.float(), out_ref.float(), atol=atol, rtol=1e-2)
        max_diff = (out_ct.float() - out_ref.float()).abs().max().item()
        all_passed = all_passed and passed
        print(f"  M={M:4d} N={N:4d} {str(dtype):15s}  max_diff={max_diff:.3e}  {'PASSED' if passed else 'FAILED'}")

    print()
    print(f"Overall: {'ALL TESTS PASSED' if all_passed else 'SOME TESTS FAILED'}")
    return all_passed


def benchmark_rmsnorm(M: int = 2048, N: int = 4096, dtype=torch.bfloat16, n_warmup: int = 20, n_rep: int = 100):
    """Simple timing benchmark."""
    x = torch.randn(M, N, device="cuda", dtype=dtype)
    w = torch.randn(N, device="cuda", dtype=torch.float32)

    for _ in range(n_warmup):
        rmsnorm(x, w)

    torch.cuda.synchronize()
    start = torch.cuda.Event(enable_timing=True)
    end = torch.cuda.Event(enable_timing=True)
    start.record()
    for _ in range(n_rep):
        rmsnorm(x, w)
    end.record()
    torch.cuda.synchronize()

    ms = start.elapsed_time(end) / n_rep
    gb = 2 * M * N * x.element_size() / 1e9  # read x + write output
    bw = gb / (ms * 1e-3)
    print(f"Fixed-launch RMSNorm M={M} N={N}: {ms:.3f} ms  BW={bw:.1f} GB/s")


if __name__ == "__main__":
    test_rmsnorm()
    print()
    benchmark_rmsnorm()
