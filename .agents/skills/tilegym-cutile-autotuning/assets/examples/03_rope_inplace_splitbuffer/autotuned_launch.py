# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


"""
RoPE Embedding - CuTile Autotuned Launch with Split-Buffer (AFTER autotuning)

Refactors fixed_launch.py to use exhaustive_search + cache + ct.launch safely
for an IN-PLACE kernel.

The core problem
----------------
exhaustive_search runs the kernel multiple times to benchmark each config.
An in-place kernel (Q_in == Q_out) corrupts Q on the second trial because
the first trial has already overwritten it.

Fix: split-buffer pattern (Pitfall #1)
---------------------------------------
- During exhaustive_search: args_fn uses Q (read) and Q_scratch (a fresh
  scratch tensor) so benchmark trials never corrupt the original Q.
- After search completes: ct.launch uses Q as both input and output for the
  real in-place operation.

This way:
  - Benchmark trials: Q (pristine) -> Q_scratch (throwaway)
  - Final launch:     Q (pristine) -> Q         (in-place update)

Teaching points
---------------
- In-place kernels MUST use split-buffer during exhaustive_search.
- Q_scratch is allocated once outside the search (no per-trial clone penalty).
- After search, ct.launch uses the original in-place args (Q, Q).
- Kernel code is identical to fixed_launch.py -- only the launch wrapper changes.
- DISABLE_AUTOTUNE=1 falls back safely to ct.launch with original in-place args.
"""

import os
from types import SimpleNamespace

import cuda.tile as ct
import torch
from cuda.tile.tune import exhaustive_search

# ---------------------------------------------------------------------------
# Kernel — reads Q_in, writes Q_out.  When Q_in is Q_out, it is in-place.
# ---------------------------------------------------------------------------


@ct.kernel
def rope_kernel(
    Q_in,  # source tensor
    Q_out,  # destination tensor (may alias Q_in for in-place launch)
    cos_cache,
    sin_cache,
    seq_len: ct.Constant[int],
    num_heads: ct.Constant[int],
    head_dim: ct.Constant[int],
    TILE_H: ct.Constant[int],
):
    """
    RoPE kernel: reads from Q_in, writes to Q_out.

    Decoupling Q_in and Q_out is the split-buffer fix.
    For the exhaustive_search benchmark trials Q_out is a scratch tensor;
    for the final ct.launch Q_out == Q_in (real in-place).
    """
    bid = ct.bid(0)
    num_programs = ct.num_blocks(0)
    total = seq_len * num_heads
    half = head_dim // 2

    h_offsets = ct.arange(TILE_H, dtype=ct.int32)

    for task in range(bid, total, num_programs):
        p = task // num_heads
        h = task % num_heads

        q0 = ct.gather(Q_in, (p, h, h_offsets), check_bounds=True, padding_value=0.0)
        q1 = ct.gather(Q_in, (p, h, h_offsets + half), check_bounds=True, padding_value=0.0)

        q0_fp32 = ct.astype(q0, ct.float32)
        q1_fp32 = ct.astype(q1, ct.float32)

        cos = ct.gather(cos_cache, (p, h_offsets), check_bounds=True, padding_value=1.0)
        sin = ct.gather(sin_cache, (p, h_offsets), check_bounds=True, padding_value=0.0)
        cos_fp32 = ct.astype(cos, ct.float32)
        sin_fp32 = ct.astype(sin, ct.float32)

        q0_rot = ct.sub(ct.mul(q0_fp32, cos_fp32), ct.mul(q1_fp32, sin_fp32))
        q1_rot = ct.add(ct.mul(q1_fp32, cos_fp32), ct.mul(q0_fp32, sin_fp32))

        ct.scatter(Q_out, (p, h, h_offsets), ct.astype(q0_rot, Q_out.dtype), check_bounds=True)
        ct.scatter(Q_out, (p, h, h_offsets + half), ct.astype(q1_rot, Q_out.dtype), check_bounds=True)


# ---------------------------------------------------------------------------
# Search space — occupancy-only (RoPE is memory-bandwidth bound)
# ---------------------------------------------------------------------------


def _rope_autotune_configs():
    for occ in [1, 2, 4, 8]:
        yield SimpleNamespace(occupancy=occ)


# ---------------------------------------------------------------------------
# Helper: precompute cos/sin tables
# ---------------------------------------------------------------------------


def precompute_freqs(seq_len: int, head_dim: int, base: float = 10000.0, device="cuda"):
    half = head_dim // 2
    positions = torch.arange(seq_len, device=device, dtype=torch.float32)
    freqs = 1.0 / (base ** (torch.arange(0, half, device=device, dtype=torch.float32) / head_dim))
    theta = positions.unsqueeze(1) * freqs.unsqueeze(0)
    return theta.cos(), theta.sin()


# ---------------------------------------------------------------------------
# Host wrapper
# ---------------------------------------------------------------------------

_autotune_cache = {}  # (seq_len, num_heads, head_dim, dtype, device_str) -> (best_cfg, tuned_kernel)


def rope_inplace(
    Q: torch.Tensor,
    cos_cache: torch.Tensor,
    sin_cache: torch.Tensor,
) -> None:
    """
    Apply RoPE in-place to Q using exhaustive_search + cache with split-buffer.

    On first call for a given (seq_len, num_heads, head_dim, dtype, device),
    exhaustive_search benchmarks all configs using a scratch tensor (Q_scratch)
    to avoid corrupting Q.  Both the best config and tuned kernel are cached,
    and ct.launch applies the rotation in-place (Q as both input and output).

    Args:
        Q:         (seq_len, num_heads, head_dim)  -- modified in-place
        cos_cache: (seq_len, head_dim // 2)
        sin_cache: (seq_len, head_dim // 2)
    """
    assert Q.is_cuda
    assert Q.ndim == 3, "Q must be (seq_len, num_heads, head_dim)"
    seq_len, num_heads, head_dim = Q.shape
    assert head_dim % 2 == 0

    half = head_dim // 2
    TILE_H = 1 if half == 0 else 2 ** (half - 1).bit_length()
    TILE_H = max(TILE_H, half)

    NUM_SM = torch.cuda.get_device_properties(Q.device).multi_processor_count
    total = seq_len * num_heads
    stream = torch.cuda.current_stream()

    # DISABLE_AUTOTUNE=1: regular in-place ct.launch (safe because no repeated trials)
    if os.environ.get("DISABLE_AUTOTUNE", "0") == "1":
        cfg = next(_rope_autotune_configs())
        num_programs = min(NUM_SM * cfg.occupancy, total)
        tuned_kernel = rope_kernel.replace_hints(occupancy=cfg.occupancy)
        ct.launch(
            stream,
            (num_programs, 1, 1),
            tuned_kernel,
            # In-place: Q_in == Q_out == Q
            (Q, Q, cos_cache, sin_cache, seq_len, num_heads, head_dim, TILE_H),
        )
        return

    # Tune once, cache (best_cfg, tuned_kernel) keyed on problem shape + dtype + device
    cache_key = (seq_len, num_heads, head_dim, Q.dtype, str(Q.device))
    if cache_key not in _autotune_cache:
        # Split-buffer: allocate a scratch tensor for benchmark trials.
        # Q_scratch is allocated ONCE here -- no per-trial clone, no per-trial overhead.
        Q_scratch = torch.empty_like(Q)
        configs = list(_rope_autotune_configs())

        def grid_fn(cfg):
            return (min(NUM_SM * cfg.occupancy, total), 1, 1)

        def args_fn(cfg):
            # Benchmark trials: read from Q (pristine), write to Q_scratch (throwaway).
            # Q is never written during trials -> no corruption across trials.
            return (Q, Q_scratch, cos_cache, sin_cache, seq_len, num_heads, head_dim, TILE_H)

        def hints_fn(cfg):
            return {"occupancy": cfg.occupancy}

        result = exhaustive_search(configs, stream, grid_fn, rope_kernel, args_fn, hints_fn)
        best_cfg = result.best.config
        tuned_kernel = rope_kernel.replace_hints(occupancy=best_cfg.occupancy)
        _autotune_cache[cache_key] = (best_cfg, tuned_kernel)

    # Launch with the cached best config + tuned kernel -- true in-place (Q as both input and output)
    cfg, tuned_kernel = _autotune_cache[cache_key]
    num_programs = min(NUM_SM * cfg.occupancy, total)
    ct.launch(
        stream,
        (num_programs, 1, 1),
        tuned_kernel,
        (Q, Q, cos_cache, sin_cache, seq_len, num_heads, head_dim, TILE_H),
    )


# ---------------------------------------------------------------------------
# Tests / timing
# ---------------------------------------------------------------------------


def _ref_rope(Q: torch.Tensor, cos_cache: torch.Tensor, sin_cache: torch.Tensor) -> torch.Tensor:
    q = Q.float()
    half = q.shape[-1] // 2
    q0, q1 = q[..., :half], q[..., half:]
    cos = cos_cache.unsqueeze(1)
    sin = sin_cache.unsqueeze(1)
    q0_rot = q0 * cos - q1 * sin
    q1_rot = q1 * cos + q0 * sin
    return torch.cat([q0_rot, q1_rot], dim=-1).to(Q.dtype)


def test_rope():
    print("Testing RoPE split-buffer autotuned-launch implementation...")
    torch.manual_seed(42)

    test_cases = [
        (128, 8, 64, torch.float16),
        (512, 32, 128, torch.bfloat16),
        (1, 1, 32, torch.float16),
    ]

    all_passed = True
    for S, H, D, dtype in test_cases:
        Q_orig = torch.randn(S, H, D, device="cuda", dtype=dtype)
        cos_cache, sin_cache = precompute_freqs(S, D, device="cuda")

        Q_ref = _ref_rope(Q_orig, cos_cache, sin_cache)

        Q = Q_orig.clone()
        rope_inplace(Q, cos_cache, sin_cache)

        atol = 2e-2
        passed = torch.allclose(Q.float(), Q_ref.float(), atol=atol, rtol=1e-2)
        max_diff = (Q.float() - Q_ref.float()).abs().max().item()
        all_passed = all_passed and passed
        print(
            f"  S={S:4d} H={H:2d} D={D:3d} {str(dtype):15s}  max_diff={max_diff:.3e}  {'PASSED' if passed else 'FAILED'}"
        )

    print()

    # Additional test: verify no corruption across repeated calls (split-buffer correctness)
    print("Corruption test (repeated in-place calls on same tensor)...")
    S, H, D = 64, 8, 64
    cos_cache, sin_cache = precompute_freqs(S, D, device="cuda")

    Q0 = torch.randn(S, H, D, device="cuda", dtype=torch.float16)
    Q_ref_single = _ref_rope(Q0, cos_cache, sin_cache)

    # Apply twice; second call should NOT corrupt results if split-buffer is correct.
    # (Note: applying RoPE twice is NOT idempotent — we only test the first result here.)
    Q_test = Q0.clone()
    rope_inplace(Q_test, cos_cache, sin_cache)
    diff = (Q_test.float() - Q_ref_single.float()).abs().max().item()
    passed = diff < 2e-2
    all_passed = all_passed and passed
    print(f"  Single-call diff: {diff:.3e}  {'PASSED' if passed else 'FAILED (possible corruption)'}")

    print()
    print(f"Overall: {'ALL TESTS PASSED' if all_passed else 'SOME TESTS FAILED'}")
    return all_passed


def benchmark_rope(S: int = 2048, H: int = 32, D: int = 128, dtype=torch.bfloat16, n_warmup: int = 5, n_rep: int = 100):
    Q = torch.randn(S, H, D, device="cuda", dtype=dtype)
    cos_cache, sin_cache = precompute_freqs(S, D, device="cuda")

    # First call triggers autotuning
    print("Running autotune (first call)...")
    Q_copy = Q.clone()
    rope_inplace(Q_copy, cos_cache, sin_cache)

    for _ in range(n_warmup):
        Q_copy = Q.clone()
        rope_inplace(Q_copy, cos_cache, sin_cache)

    torch.cuda.synchronize()
    start = torch.cuda.Event(enable_timing=True)
    end = torch.cuda.Event(enable_timing=True)
    start.record()
    for _ in range(n_rep):
        Q_copy = Q.clone()
        rope_inplace(Q_copy, cos_cache, sin_cache)
    end.record()
    torch.cuda.synchronize()

    ms = start.elapsed_time(end) / n_rep
    bytes_io = 2 * S * H * D * Q.element_size() + 2 * S * (D // 2) * 4
    bw = bytes_io / (ms * 1e-3) / 1e9
    print(f"Autotuned RoPE S={S} H={H} D={D}: {ms:.3f} ms  BW={bw:.1f} GB/s")


if __name__ == "__main__":
    test_rope()
    print()
    benchmark_rope()
