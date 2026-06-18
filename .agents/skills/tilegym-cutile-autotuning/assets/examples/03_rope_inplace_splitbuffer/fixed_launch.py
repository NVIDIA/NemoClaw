# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


"""
RoPE Embedding - CuTile Fixed-Config In-Place Launch (BEFORE autotuning)

Demonstrates an IN-PLACE RoPE kernel with a hardcoded ct.launch.
The kernel reads from Q and writes the rotated result back to Q
(same tensor — in-place update).

Formula:
  For each token position p and each pair of dims (2i, 2i+1):
    theta_i   = p / (base ** (2i / head_dim))
    Q[p, 2i]  =  Q[p, 2i]   * cos(theta_i) - Q[p, 2i+1] * sin(theta_i)
    Q[p, 2i+1]= Q[p, 2i+1] * cos(theta_i) + Q[p, 2i]   * sin(theta_i)

Tensor layout:
  Q: (seq_len, num_heads, head_dim)  — will be written in-place
  cos_cache, sin_cache: (seq_len, head_dim // 2) — precomputed

The autotuned version (autotuned_launch.py) fixes the in-place corruption
issue by using the split-buffer pattern with launch_args_fn.
"""

import math

import cuda.tile as ct
import torch

# ---------------------------------------------------------------------------
# Kernel (in-place: reads and writes same Q tensor)
# ---------------------------------------------------------------------------


@ct.kernel(occupancy=4)
def rope_kernel_inplace(
    Q,  # (seq_len, num_heads, head_dim) — IN-PLACE: both src and dst
    cos_cache,  # (seq_len, head_dim // 2)
    sin_cache,  # (seq_len, head_dim // 2)
    seq_len: ct.Constant[int],
    num_heads: ct.Constant[int],
    head_dim: ct.Constant[int],
    TILE_H: ct.Constant[int],  # tile over head pairs (head_dim // 2)
):
    """
    In-place RoPE: one block handles one (token, head) pair.
    Persistent loop over (seq_len * num_heads) tasks.
    """
    bid = ct.bid(0)
    num_programs = ct.num_blocks(0)
    total = seq_len * num_heads
    half = head_dim // 2

    h_offsets = ct.arange(TILE_H, dtype=ct.int32)  # indices into [0, half)

    for task in range(bid, total, num_programs):
        p = task // num_heads  # token position
        h = task % num_heads  # head index

        # Load the two halves of the head vector
        q0 = ct.gather(Q, (p, h, h_offsets), check_bounds=True, padding_value=0.0)
        q1 = ct.gather(Q, (p, h, h_offsets + half), check_bounds=True, padding_value=0.0)

        q0_fp32 = ct.astype(q0, ct.float32)
        q1_fp32 = ct.astype(q1, ct.float32)

        # Load precomputed cos/sin for this position
        cos = ct.gather(cos_cache, (p, h_offsets), check_bounds=True, padding_value=1.0)
        sin = ct.gather(sin_cache, (p, h_offsets), check_bounds=True, padding_value=0.0)
        cos_fp32 = ct.astype(cos, ct.float32)
        sin_fp32 = ct.astype(sin, ct.float32)

        # Rotate: q_rot = [q0*cos - q1*sin, q1*cos + q0*sin]
        q0_rot = ct.sub(ct.mul(q0_fp32, cos_fp32), ct.mul(q1_fp32, sin_fp32))
        q1_rot = ct.add(ct.mul(q1_fp32, cos_fp32), ct.mul(q0_fp32, sin_fp32))

        # Write back in-place (same Q tensor)
        ct.scatter(Q, (p, h, h_offsets), ct.astype(q0_rot, Q.dtype), check_bounds=True)
        ct.scatter(Q, (p, h, h_offsets + half), ct.astype(q1_rot, Q.dtype), check_bounds=True)


# ---------------------------------------------------------------------------
# Host wrapper
# ---------------------------------------------------------------------------


def precompute_freqs(seq_len: int, head_dim: int, base: float = 10000.0, device="cuda"):
    """Precompute RoPE cos/sin tables."""
    half = head_dim // 2
    positions = torch.arange(seq_len, device=device, dtype=torch.float32)
    freqs = 1.0 / (base ** (torch.arange(0, half, device=device, dtype=torch.float32) / head_dim))
    theta = positions.unsqueeze(1) * freqs.unsqueeze(0)  # (seq_len, half)
    return theta.cos(), theta.sin()


def rope_inplace(
    Q: torch.Tensor,
    cos_cache: torch.Tensor,
    sin_cache: torch.Tensor,
) -> None:
    """
    Apply RoPE in-place to Q.  Q is modified directly.

    Args:
        Q:         (seq_len, num_heads, head_dim)
        cos_cache: (seq_len, head_dim // 2)
        sin_cache: (seq_len, head_dim // 2)

    WARNING: Using this pattern with exhaustive_search causes data corruption
    because autotuning benchmarks multiple trials on the same Q.
    See autotuned_launch.py for the correct split-buffer fix.
    """
    assert Q.is_cuda
    assert Q.ndim == 3, "Q must be (seq_len, num_heads, head_dim)"
    seq_len, num_heads, head_dim = Q.shape
    assert head_dim % 2 == 0, "head_dim must be even"
    half = head_dim // 2

    # TILE_H: tile over the half-dim; must be power-of-2 and >= half
    TILE_H = 1 if half == 0 else 2 ** (half - 1).bit_length()
    TILE_H = max(TILE_H, half)

    NUM_SM = torch.cuda.get_device_properties(Q.device).multi_processor_count
    OCCUPANCY = 4
    total = seq_len * num_heads
    num_programs = min(NUM_SM * OCCUPANCY, total)

    ct.launch(
        torch.cuda.current_stream(),
        (num_programs, 1, 1),
        rope_kernel_inplace,
        (Q, cos_cache, sin_cache, seq_len, num_heads, head_dim, TILE_H),
    )


# ---------------------------------------------------------------------------
# Tests / timing
# ---------------------------------------------------------------------------


def _ref_rope(Q: torch.Tensor, cos_cache: torch.Tensor, sin_cache: torch.Tensor) -> torch.Tensor:
    """Reference RoPE using PyTorch ops (returns new tensor, not in-place)."""
    q = Q.float()
    half = q.shape[-1] // 2
    q0, q1 = q[..., :half], q[..., half:]
    cos = cos_cache.unsqueeze(1)  # (seq, 1, half)
    sin = sin_cache.unsqueeze(1)
    q0_rot = q0 * cos - q1 * sin
    q1_rot = q1 * cos + q0 * sin
    return torch.cat([q0_rot, q1_rot], dim=-1).to(Q.dtype)


def test_rope():
    print("Testing RoPE in-place fixed-launch implementation...")
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
    print(f"Overall: {'ALL TESTS PASSED' if all_passed else 'SOME TESTS FAILED'}")
    return all_passed


def benchmark_rope(
    S: int = 2048, H: int = 32, D: int = 128, dtype=torch.bfloat16, n_warmup: int = 20, n_rep: int = 100
):
    Q = torch.randn(S, H, D, device="cuda", dtype=dtype)
    cos_cache, sin_cache = precompute_freqs(S, D, device="cuda")

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
    # read + write Q, read cos/sin
    bytes_io = 2 * S * H * D * Q.element_size() + 2 * S * (D // 2) * 4
    bw = bytes_io / (ms * 1e-3) / 1e9
    print(f"Fixed-launch RoPE S={S} H={H} D={D}: {ms:.3f} ms  BW={bw:.1f} GB/s")


if __name__ == "__main__":
    test_rope()
    print()
    benchmark_rope()
