# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


"""
Fused Multi-Head Attention (FMHA) - cuTile Implementation

This implementation follows the Flash Attention algorithm with online softmax.
Based on the official TileGym implementation.

Key patterns:
- ct.load with index/shape matching source tensor dimensions, then reshape
- ct.mma for tensor core accelerated matrix multiply
- Online softmax with exp2 optimization
- Grouped Query Attention (GQA) support
"""

import math

import cuda.tile as ct
import torch

INV_LOG_2 = 1.0 / math.log(2)

ConstInt = ct.Constant[int]
ConstBool = ct.Constant[bool]


@ct.kernel
def fmha_kernel(
    Q,
    K,
    V,
    Out,
    qk_scale: float,
    input_pos: int,
    TILE_D: ConstInt,
    H: ConstInt,
    TILE_M: ConstInt,
    TILE_N: ConstInt,
    QUERY_GROUP_SIZE: ConstInt,
    CAUSAL: ConstBool,
    EVEN_K: ConstBool,
):
    """
    cuTile kernel for Fused Multi-Head Attention.

    Args:
        Q: Query tensor [batch, num_heads, seq_len, head_dim]
        K: Key tensor [batch, num_kv_heads, seq_len, head_dim]
        V: Value tensor [batch, num_kv_heads, seq_len, head_dim]
        Out: Output tensor [batch, num_heads, seq_len, head_dim]
        qk_scale: Scale factor (typically 1/sqrt(head_dim))
        input_pos: Starting position for causal masking
        TILE_D: Head dimension
        H: Number of heads
        TILE_M: Query tile size
        TILE_N: Key/Value tile size
        QUERY_GROUP_SIZE: Number of query heads per KV head (for GQA)
        CAUSAL: Whether to apply causal masking
        EVEN_K: Whether K sequence length is divisible by TILE_N
    """
    # Block indices
    bid_x = ct.bid(0)  # Query tile index
    bid_y = ct.bid(1)  # Batch * Head index
    batch_idx = bid_y // H
    head_idx = bid_y % H
    off_kv_h = head_idx // QUERY_GROUP_SIZE  # KV head index for GQA

    # Adjust scale for exp2 optimization
    qk_scale = qk_scale * INV_LOG_2

    # Offsets for masking
    offs_m = bid_x * TILE_M + ct.arange(TILE_M, dtype=ct.int32)
    offs_m = offs_m + input_pos
    offs_m = offs_m[:, None]  # [TILE_M, 1]

    offs_n_tile = ct.arange(TILE_N, dtype=ct.int32)
    offs_n_tile = offs_n_tile[None, :]  # [1, TILE_N]

    # Initialize online softmax accumulators
    m_i = ct.full((TILE_M, 1), -math.inf, dtype=ct.float32)
    l_i = ct.full((TILE_M, 1), 0.0, dtype=ct.float32)
    acc = ct.full((TILE_M, TILE_D), 0.0, dtype=ct.float32)

    # Load Q tile: [TILE_M, TILE_D]
    # Note: index and shape must match source tensor dimensions (4D)
    q = ct.load(Q, index=(batch_idx, head_idx, bid_x, 0), shape=(1, 1, TILE_M, TILE_D)).reshape((TILE_M, TILE_D))

    # Compute loop bounds
    m_end = input_pos + (bid_x + 1) * TILE_M
    k_seqlen = K.shape[2]

    if CAUSAL:
        mask_start = (input_pos + bid_x * TILE_M) // TILE_N
        mask_start = min(mask_start, k_seqlen // TILE_N)
        Tc = ct.cdiv(min(m_end, k_seqlen), TILE_N)
    else:
        Tc = ct.cdiv(k_seqlen, TILE_N)
        mask_start = k_seqlen // TILE_N

    # Main attention loop
    for j in range(0, Tc):
        # Load K tile (transposed): [TILE_D, TILE_N]
        k = ct.load(
            K,
            index=(batch_idx, off_kv_h, 0, j),
            shape=(1, 1, TILE_D, TILE_N),
            order=(0, 1, 3, 2),  # Transpose last two dims
            latency=2,
        ).reshape((TILE_D, TILE_N))

        # Compute QK: [TILE_M, TILE_N]
        qk = ct.full((TILE_M, TILE_N), 0.0, dtype=ct.float32)
        qk = ct.mma(q, k, acc=qk)

        # Apply masking
        if (CAUSAL or not EVEN_K) and j >= mask_start:
            offs_n = j * TILE_N + offs_n_tile
            mask = ct.full((TILE_M, TILE_N), True, dtype=ct.bool_)
            if not EVEN_K:
                mask = mask & (offs_n < k_seqlen)
            if CAUSAL:
                mask = mask & (offs_m >= offs_n)
            mask = ct.where(mask, 0.0, -math.inf)
            qk = qk + mask

        # Online softmax update
        m_ij = max(m_i, ct.max(qk, axis=-1, keepdims=True) * qk_scale)
        qk = qk * qk_scale - m_ij

        p = ct.exp2(qk, flush_to_zero=True)
        l_ij = ct.sum(p, axis=-1, keepdims=True)
        alpha = ct.exp2(m_i - m_ij, flush_to_zero=True)

        l_i = l_i * alpha + l_ij
        acc = acc * alpha

        # Load V tile: [TILE_N, TILE_D]
        v = ct.load(
            V,
            index=(batch_idx, off_kv_h, j, 0),
            shape=(1, 1, TILE_N, TILE_D),
            latency=4,
        ).reshape((TILE_N, TILE_D))

        # Accumulate: acc += p @ v
        p = p.astype(Q.dtype)
        acc = ct.mma(p, v, acc=acc)
        m_i = m_ij

    # Normalize and store
    acc = ct.truediv(acc, l_i, flush_to_zero=True)
    acc = acc.reshape((1, 1, TILE_M, TILE_D)).astype(Out.dtype)
    ct.store(Out, index=(batch_idx, head_idx, bid_x, 0), tile=acc)


def fmha_forward(
    q: torch.Tensor,
    k: torch.Tensor,
    v: torch.Tensor,
    sm_scale: float = None,
    is_causal: bool = True,
    TILE_M: int = 128,
    TILE_N: int = 64,
) -> torch.Tensor:
    """
    Host wrapper for FMHA forward pass.

    Args:
        q: Query tensor [batch, num_heads, seq_len, head_dim]
        k: Key tensor [batch, num_kv_heads, seq_len, head_dim]
        v: Value tensor [batch, num_kv_heads, seq_len, head_dim]
        sm_scale: Softmax scale (default: 1/sqrt(head_dim))
        is_causal: Whether to use causal masking
        TILE_M: Query tile size
        TILE_N: Key/Value tile size

    Returns:
        Output tensor [batch, num_heads, seq_len, head_dim]
    """
    assert q.is_cuda and k.is_cuda and v.is_cuda

    batch_size, num_heads, q_len, head_dim = q.shape
    _, num_kv_heads, k_len, _ = k.shape

    assert num_heads % num_kv_heads == 0
    query_group_size = num_heads // num_kv_heads

    if sm_scale is None:
        sm_scale = 1.0 / math.sqrt(head_dim)

    q = q.contiguous()
    k = k.contiguous()
    v = v.contiguous()
    out = torch.empty_like(q)

    input_pos = 0
    EVEN_K = (k_len % TILE_N) == 0

    grid = (
        (q_len + TILE_M - 1) // TILE_M,
        batch_size * num_heads,
        1,
    )

    ct.launch(
        torch.cuda.current_stream(),
        grid,
        fmha_kernel,
        (
            q,
            k,
            v,
            out,
            sm_scale,
            input_pos,
            head_dim,
            num_heads,
            TILE_M,
            TILE_N,
            query_group_size,
            is_causal,
            EVEN_K,
        ),
    )

    return out


def test_fmha():
    """Test FMHA against PyTorch reference."""
    torch.manual_seed(42)

    batch, heads, seq_len, head_dim = 2, 8, 128, 64
    kv_heads = 2  # GQA: 4 query heads per KV head

    q = torch.randn(batch, heads, seq_len, head_dim, device="cuda", dtype=torch.float16)
    k = torch.randn(batch, kv_heads, seq_len, head_dim, device="cuda", dtype=torch.float16)
    v = torch.randn(batch, kv_heads, seq_len, head_dim, device="cuda", dtype=torch.float16)

    # Expand K, V for reference
    k_expanded = k.repeat_interleave(heads // kv_heads, dim=1)
    v_expanded = v.repeat_interleave(heads // kv_heads, dim=1)

    sm_scale = 1.0 / math.sqrt(head_dim)

    # cuTile result
    out_cutile = fmha_forward(q, k, v, sm_scale, is_causal=True)

    # PyTorch reference (causal)
    scores = torch.matmul(q.float(), k_expanded.float().transpose(-2, -1)) * sm_scale
    causal_mask = torch.triu(torch.ones(seq_len, seq_len, device="cuda"), diagonal=1).bool()
    scores = scores.masked_fill(causal_mask, float("-inf"))
    attn = torch.softmax(scores, dim=-1)
    out_ref = torch.matmul(attn, v_expanded.float()).half()

    passed = torch.allclose(out_cutile, out_ref, atol=1e-2, rtol=1e-2)
    print(f"FMHA Test: {'PASSED' if passed else 'FAILED'}")
    if not passed:
        print(f"  Max diff: {(out_cutile - out_ref).abs().max()}")

    return passed


if __name__ == "__main__":
    test_fmha()
