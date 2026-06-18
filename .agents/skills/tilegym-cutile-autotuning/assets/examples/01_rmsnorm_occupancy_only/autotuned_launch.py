# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


"""
RMSNorm - CuTile Autotuned Launch (AFTER autotuning)

Shows the same RMSNorm kernel (identical to fixed_launch.py) refactored to
use exhaustive_search + cache + ct.launch with an occupancy-only search space.

Teaching points
---------------
- Most common autotune pattern: occupancy-only, grid fixed at NUM_SM * cfg.occupancy.
- Kernel is NOT in-place (reads x, writes output) — no split-buffer needed.
- exhaustive_search returns the best config; we cache (best_cfg, tuned_kernel) keyed on
  (shape, dtype, device) so replace_hints is only called once (Pitfall #7).
- Subsequent calls with the same key skip the search and go straight to ct.launch.
- DISABLE_AUTOTUNE=1 falls back to ct.launch with the first config for CI.

Formula: output = x / sqrt(mean(x^2) + eps) * weight
"""

import os
from types import SimpleNamespace

import cuda.tile as ct
import torch
from cuda.tile.tune import exhaustive_search

# ---------------------------------------------------------------------------
# Kernel — identical to fixed_launch.py; the decorator has no fixed occupancy
# ---------------------------------------------------------------------------


@ct.kernel
def rmsnorm_kernel(
    output,
    x,
    weight,
    eps: ct.Constant[float],
    M: ct.Constant[int],
    N: ct.Constant[int],
    TILE_N: ct.Constant[int],
):
    """
    RMSNorm kernel.  Occupancy is supplied at runtime via replace_hints.

    Steps per row:
      1. Load row tile (padded with 0 for squared-sum safety).
      2. Compute mean(x^2), then rms = sqrt(mean_sq + eps).
      3. Normalize: x_norm = x / rms.
      4. Scale:     out    = x_norm * weight.
      5. Store result.
    """
    bid = ct.bid(0)
    num_programs = ct.num_blocks(0)
    offsets = ct.arange(TILE_N, dtype=ct.int32)

    for row in range(bid, M, num_programs):
        x_row = ct.gather(x, (row, offsets), check_bounds=True, padding_value=0.0)
        x_fp32 = ct.astype(x_row, ct.float32)

        sq = ct.mul(x_fp32, x_fp32)
        mean_sq = ct.truediv(ct.sum(sq, 0, keepdims=True), float(N))
        rms = ct.sqrt(ct.add(mean_sq, eps))
        x_norm = ct.truediv(x_fp32, rms)

        w = ct.gather(weight, (offsets,), check_bounds=True, padding_value=0.0)
        w_fp32 = ct.astype(w, ct.float32)
        out_fp32 = ct.mul(x_norm, w_fp32)

        out_row = ct.astype(out_fp32, x.dtype)
        ct.scatter(output, (row, offsets), out_row, check_bounds=True)


# ---------------------------------------------------------------------------
# Search space — occupancy-only (most common pattern for elementwise/reduction)
# ---------------------------------------------------------------------------


def _rmsnorm_autotune_configs():
    """Occupancy-only search: try 1, 2, 4, 8 CTAs per SM."""
    for occ in [1, 2, 4, 8]:
        yield SimpleNamespace(occupancy=occ)


# ---------------------------------------------------------------------------
# Host wrapper
# ---------------------------------------------------------------------------

_autotune_cache = {}  # (M, N, dtype, device_str) -> (best_cfg, tuned_kernel)


def rmsnorm(x: torch.Tensor, weight: torch.Tensor, eps: float = 1e-6) -> torch.Tensor:
    """
    Host wrapper: RMSNorm with exhaustive_search + cache (occupancy-only search).

    On first call for a given (M, N, dtype, device), exhaustive_search benchmarks
    all configs and picks the best occupancy.  Both the config and the tuned kernel
    are cached so subsequent calls go straight to ct.launch with zero overhead.

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

    TILE_N = 1 if N == 0 else 2 ** (N - 1).bit_length()
    NUM_SM = torch.cuda.get_device_properties(x.device).multi_processor_count
    stream = torch.cuda.current_stream()

    # DISABLE_AUTOTUNE=1: use first config via ct.launch (standard CI practice)
    if os.environ.get("DISABLE_AUTOTUNE", "0") == "1":
        cfg = next(_rmsnorm_autotune_configs())
        num_programs = min(NUM_SM * cfg.occupancy, M)
        tuned_kernel = rmsnorm_kernel.replace_hints(occupancy=cfg.occupancy)
        ct.launch(
            stream,
            (num_programs, 1, 1),
            tuned_kernel,
            (output, x, weight, eps, M, N, TILE_N),
        )
        return output

    # Tune once, cache (best_cfg, tuned_kernel) keyed on problem shape + dtype + device
    cache_key = (M, N, x.dtype, str(x.device))
    if cache_key not in _autotune_cache:
        configs = list(_rmsnorm_autotune_configs())

        def grid_fn(cfg):
            return (min(NUM_SM * cfg.occupancy, M), 1, 1)

        def args_fn(cfg):
            return (output, x, weight, eps, M, N, TILE_N)

        def hints_fn(cfg):
            return {"occupancy": cfg.occupancy}

        result = exhaustive_search(configs, stream, grid_fn, rmsnorm_kernel, args_fn, hints_fn)
        best_cfg = result.best.config
        tuned_kernel = rmsnorm_kernel.replace_hints(occupancy=best_cfg.occupancy)
        _autotune_cache[cache_key] = (best_cfg, tuned_kernel)

    # Launch with the cached best config + tuned kernel (no replace_hints on hot path)
    cfg, tuned_kernel = _autotune_cache[cache_key]
    num_programs = min(NUM_SM * cfg.occupancy, M)
    ct.launch(
        stream,
        (num_programs, 1, 1),
        tuned_kernel,
        (output, x, weight, eps, M, N, TILE_N),
    )

    return output


# ---------------------------------------------------------------------------
# Tests / timing
# ---------------------------------------------------------------------------


def _ref_rmsnorm(x: torch.Tensor, weight: torch.Tensor, eps: float) -> torch.Tensor:
    x_fp32 = x.float()
    mean_sq = (x_fp32**2).mean(dim=-1, keepdim=True)
    x_norm = x_fp32 / torch.sqrt(mean_sq + eps)
    return (x_norm * weight.float()).to(x.dtype)


def test_rmsnorm():
    print("Testing RMSNorm autotuned-launch implementation...")
    torch.manual_seed(42)
    eps = 1e-6

    test_cases = [
        (128, 512, torch.float16),
        (512, 4096, torch.bfloat16),
        (1, 256, torch.float16),
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
    gb = 2 * M * N * x.element_size() / 1e9
    bw = gb / (ms * 1e-3)
    print(f"Autotuned RMSNorm M={M} N={N}: {ms:.3f} ms  BW={bw:.1f} GB/s")


if __name__ == "__main__":
    test_rmsnorm()
    print()
    benchmark_rmsnorm()
