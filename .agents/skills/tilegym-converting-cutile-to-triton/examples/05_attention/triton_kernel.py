# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0

#

"""
Fused Multi-Head Attention - Triton Implementation (Flash Attention Style)

This file demonstrates the Triton equivalent of the CUDA attention kernel,
using the Flash Attention algorithm with online softmax for memory efficiency.

Key algorithmic differences from standard attention:
- Online softmax: Compute softmax incrementally without materializing full attention matrix
- Tiled computation: Process K/V in blocks, accumulating results
- Memory efficient: O(N) memory instead of O(N^2) for attention matrix

Translation patterns:
- CUDA global memory attention matrix → Triton online accumulation
- CUDA two-pass softmax → Triton single-pass online softmax
- CUDA explicit tiling → Triton block-based processing

Reference: "FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness"
"""

import torch
import triton
import triton.language as tl


@triton.jit
def flash_attention_forward_kernel(
    Q_ptr,  # Query: [B, H, N, d]
    K_ptr,  # Key: [B, H, N, d]
    V_ptr,  # Value: [B, H, N, d]
    O_ptr,  # Output: [B, H, N, d]
    L_ptr,  # Log-sum-exp for backward: [B, H, N]
    stride_qb,
    stride_qh,
    stride_qn,
    stride_qd,  # Q strides
    stride_kb,
    stride_kh,
    stride_kn,
    stride_kd,  # K strides
    stride_vb,
    stride_vh,
    stride_vn,
    stride_vd,  # V strides
    stride_ob,
    stride_oh,
    stride_on,
    stride_od,  # O strides
    stride_lb,
    stride_lh,
    stride_ln,  # L strides
    seq_len,
    head_dim,
    scale,  # 1/sqrt(head_dim)
    BLOCK_M: tl.constexpr,  # Block size for queries
    BLOCK_N: tl.constexpr,  # Block size for keys/values
    BLOCK_D: tl.constexpr,  # Block size for head dimension (must be >= head_dim)
):
    """
    Flash Attention forward pass with online softmax.

    Key insight: Instead of computing full attention matrix then softmax,
    we compute softmax incrementally as we iterate over K/V blocks.

    Online softmax algorithm:
    1. For each K/V block, compute partial attention scores
    2. Update running max and sum for numerical stability
    3. Rescale previous accumulator and add new contribution

    This avoids materializing the O(N^2) attention matrix.

    Translation from CUDA:
    - CUDA: Store full attn_scores[N, N] in global memory
    - Triton: Keep running m (max), l (sum), acc (output) in registers

    - CUDA: Two-pass softmax (compute max, then exp/sum)
    - Triton: Single-pass online softmax with rescaling
    """
    # Get program indices
    batch_head_idx = tl.program_id(0)
    query_block_idx = tl.program_id(1)

    batch_idx = batch_head_idx // tl.num_programs(0)  # Will be set by grid
    head_idx = batch_head_idx % tl.num_programs(0)

    # This is a simplified version - in practice we'd compute batch/head from program_id
    # For this example, we assume batch_head_idx encodes both

    # Calculate base pointers for this batch and head
    Q_block_ptr = Q_ptr + batch_head_idx * stride_qh
    K_block_ptr = K_ptr + batch_head_idx * stride_kh
    V_block_ptr = V_ptr + batch_head_idx * stride_vh
    O_block_ptr = O_ptr + batch_head_idx * stride_oh
    L_block_ptr = L_ptr + batch_head_idx * stride_lh

    # Query block start position
    q_start = query_block_idx * BLOCK_M

    # Offsets for this query block
    q_offs = q_start + tl.arange(0, BLOCK_M)
    d_offs = tl.arange(0, BLOCK_D)

    # Mask for valid query positions
    q_mask = q_offs < seq_len
    d_mask = d_offs < head_dim

    # Load Q block: [BLOCK_M, BLOCK_D]
    # CUDA equivalent: Loading Q_row in the naive kernel
    q_ptrs = Q_block_ptr + q_offs[:, None] * stride_qn + d_offs[None, :] * stride_qd
    q = tl.load(q_ptrs, mask=q_mask[:, None] & d_mask[None, :], other=0.0)

    # Initialize online softmax accumulators
    # m: running max for numerical stability
    # l: running sum of exp(scores - m)
    # acc: running weighted sum of values
    m = tl.full([BLOCK_M], float("-inf"), dtype=tl.float32)
    l = tl.zeros([BLOCK_M], dtype=tl.float32)
    acc = tl.zeros([BLOCK_M, BLOCK_D], dtype=tl.float32)

    # Iterate over K/V blocks
    # CUDA equivalent: The loop over key_pos in attention_forward_naive_cuda
    # But here we process in blocks and use online softmax
    for kv_start in range(0, seq_len, BLOCK_N):
        kv_offs = kv_start + tl.arange(0, BLOCK_N)
        kv_mask = kv_offs < seq_len

        # Load K block: [BLOCK_N, BLOCK_D]
        k_ptrs = K_block_ptr + kv_offs[:, None] * stride_kn + d_offs[None, :] * stride_kd
        k = tl.load(k_ptrs, mask=kv_mask[:, None] & d_mask[None, :], other=0.0)

        # Compute Q @ K^T for this block: [BLOCK_M, BLOCK_N]
        # CUDA equivalent: The dot product loop in attention_forward_naive_cuda
        # score += Q_row[d] * K_row[d];
        scores = tl.dot(q, tl.trans(k)) * scale

        # Apply causal mask if needed (optional, shown for completeness)
        # scores = tl.where(q_offs[:, None] >= kv_offs[None, :], scores, float("-inf"))

        # Mask out invalid positions
        scores = tl.where(kv_mask[None, :], scores, float("-inf"))

        # Online softmax update
        # This is the key difference from CUDA's two-pass approach

        # Step 1: Find new max for this block
        # CUDA equivalent: max_score = fmaxf(max_score, score);
        m_new = tl.maximum(m, tl.max(scores, axis=1))

        # Step 2: Compute scaling factors
        # When max changes, we need to rescale previous accumulator
        alpha = tl.exp(m - m_new)  # Scale for previous accumulator

        # Step 3: Compute exp(scores - m_new) for current block
        # CUDA equivalent: float exp_score = expf(score - s_max);
        p = tl.exp(scores - m_new[:, None])

        # Step 4: Update running sum
        # CUDA equivalent: sum_exp += exp_score;
        l_new = alpha * l + tl.sum(p, axis=1)

        # Step 5: Load V block and accumulate weighted values
        # CUDA equivalent: out_val += attn_row[key_pos] * V_base[key_pos * head_dim + d];
        v_ptrs = V_block_ptr + kv_offs[:, None] * stride_vn + d_offs[None, :] * stride_vd
        v = tl.load(v_ptrs, mask=kv_mask[:, None] & d_mask[None, :], other=0.0)

        # Rescale previous accumulator and add new contribution
        # This is the online softmax magic - we can update incrementally
        acc = alpha[:, None] * acc + tl.dot(p.to(v.dtype), v)

        # Update state for next iteration
        m = m_new
        l = l_new

    # Final normalization: divide by sum of exponentials
    # CUDA equivalent: attn_row[key_pos] /= s_sum;
    acc = acc / l[:, None]

    # Store output
    o_ptrs = O_block_ptr + q_offs[:, None] * stride_on + d_offs[None, :] * stride_od
    tl.store(o_ptrs, acc, mask=q_mask[:, None] & d_mask[None, :])

    # Store log-sum-exp for backward pass
    # L = m + log(l) is used in backward to avoid recomputing softmax
    l_ptrs = L_block_ptr + q_offs * stride_ln
    tl.store(l_ptrs, m + tl.log(l), mask=q_mask)


@triton.jit
def flash_attention_backward_kernel(
    Q_ptr,
    K_ptr,
    V_ptr,  # Inputs from forward
    O_ptr,
    L_ptr,  # Outputs from forward (O and log-sum-exp)
    dO_ptr,  # Gradient of output
    dQ_ptr,
    dK_ptr,
    dV_ptr,  # Gradients to compute
    stride_qb,
    stride_qh,
    stride_qn,
    stride_qd,
    stride_kb,
    stride_kh,
    stride_kn,
    stride_kd,
    stride_vb,
    stride_vh,
    stride_vn,
    stride_vd,
    stride_ob,
    stride_oh,
    stride_on,
    stride_od,
    stride_lb,
    stride_lh,
    stride_ln,
    seq_len,
    head_dim,
    scale,
    BLOCK_M: tl.constexpr,
    BLOCK_N: tl.constexpr,
    BLOCK_D: tl.constexpr,
):
    """
    Flash Attention backward pass.

    Key insight: Recompute attention weights on-the-fly instead of storing them.
    This trades compute for memory, enabling training with longer sequences.

    Gradients:
    - dV = Attn^T @ dO  (accumulated over query blocks)
    - dQ = dAttn @ K    (computed per query block)
    - dK = dAttn^T @ Q  (accumulated over query blocks)

    where dAttn = softmax_backward(Attn, dO @ V^T)

    Translation from CUDA:
    - CUDA: Load stored attention weights from global memory
    - Triton: Recompute attention weights using saved L (log-sum-exp)
    """
    batch_head_idx = tl.program_id(0)
    kv_block_idx = tl.program_id(1)

    # Base pointers
    Q_block_ptr = Q_ptr + batch_head_idx * stride_qh
    K_block_ptr = K_ptr + batch_head_idx * stride_kh
    V_block_ptr = V_ptr + batch_head_idx * stride_vh
    O_block_ptr = O_ptr + batch_head_idx * stride_oh
    L_block_ptr = L_ptr + batch_head_idx * stride_lh
    dO_block_ptr = dO_ptr + batch_head_idx * stride_oh
    dQ_block_ptr = dQ_ptr + batch_head_idx * stride_qh
    dK_block_ptr = dK_ptr + batch_head_idx * stride_kh
    dV_block_ptr = dV_ptr + batch_head_idx * stride_vh

    # K/V block position
    kv_start = kv_block_idx * BLOCK_N
    kv_offs = kv_start + tl.arange(0, BLOCK_N)
    kv_mask = kv_offs < seq_len
    d_offs = tl.arange(0, BLOCK_D)
    d_mask = d_offs < head_dim

    # Load K and V for this block
    k_ptrs = K_block_ptr + kv_offs[:, None] * stride_kn + d_offs[None, :] * stride_kd
    v_ptrs = V_block_ptr + kv_offs[:, None] * stride_vn + d_offs[None, :] * stride_vd
    k = tl.load(k_ptrs, mask=kv_mask[:, None] & d_mask[None, :], other=0.0)
    v = tl.load(v_ptrs, mask=kv_mask[:, None] & d_mask[None, :], other=0.0)

    # Initialize gradient accumulators for K and V
    dk = tl.zeros([BLOCK_N, BLOCK_D], dtype=tl.float32)
    dv = tl.zeros([BLOCK_N, BLOCK_D], dtype=tl.float32)

    # Iterate over query blocks
    for q_start in range(0, seq_len, BLOCK_M):
        q_offs = q_start + tl.arange(0, BLOCK_M)
        q_mask = q_offs < seq_len

        # Load Q, O, dO, L for this query block
        q_ptrs = Q_block_ptr + q_offs[:, None] * stride_qn + d_offs[None, :] * stride_qd
        o_ptrs = O_block_ptr + q_offs[:, None] * stride_on + d_offs[None, :] * stride_od
        do_ptrs = dO_block_ptr + q_offs[:, None] * stride_on + d_offs[None, :] * stride_od
        l_ptrs = L_block_ptr + q_offs * stride_ln

        q = tl.load(q_ptrs, mask=q_mask[:, None] & d_mask[None, :], other=0.0)
        o = tl.load(o_ptrs, mask=q_mask[:, None] & d_mask[None, :], other=0.0)
        do = tl.load(do_ptrs, mask=q_mask[:, None] & d_mask[None, :], other=0.0)
        l = tl.load(l_ptrs, mask=q_mask, other=0.0)

        # Recompute attention weights
        # P = softmax(Q @ K^T * scale)
        # Using saved L = m + log(sum(exp(scores - m)))
        scores = tl.dot(q, tl.trans(k)) * scale
        scores = tl.where(kv_mask[None, :], scores, float("-inf"))
        p = tl.exp(scores - l[:, None])  # Attention weights

        # Compute dV: dV += P^T @ dO
        dv += tl.dot(tl.trans(p.to(do.dtype)), do)

        # Compute dP: dP = dO @ V^T
        dp = tl.dot(do, tl.trans(v))

        # Softmax backward: dS = P * (dP - sum(P * dP))
        # where S = scores before softmax
        d_sum = tl.sum(p * dp, axis=1)
        ds = p * (dp - d_sum[:, None]) * scale

        # Compute dK: dK += dS^T @ Q
        dk += tl.dot(tl.trans(ds.to(q.dtype)), q)

        # Compute dQ: dQ = dS @ K (stored directly)
        dq = tl.dot(ds.to(k.dtype), k)
        dq_ptrs = dQ_block_ptr + q_offs[:, None] * stride_qn + d_offs[None, :] * stride_qd
        # Note: This is a simplified version - full implementation would use atomics
        # or separate kernel for dQ accumulation
        tl.atomic_add(dq_ptrs, dq, mask=q_mask[:, None] & d_mask[None, :])

    # Store dK and dV
    dk_ptrs = dK_block_ptr + kv_offs[:, None] * stride_kn + d_offs[None, :] * stride_kd
    dv_ptrs = dV_block_ptr + kv_offs[:, None] * stride_vn + d_offs[None, :] * stride_vd
    tl.store(dk_ptrs, dk, mask=kv_mask[:, None] & d_mask[None, :])
    tl.store(dv_ptrs, dv, mask=kv_mask[:, None] & d_mask[None, :])


def flash_attention_forward(
    Q: torch.Tensor,
    K: torch.Tensor,
    V: torch.Tensor,
) -> tuple:
    """
    Host wrapper for Flash Attention forward pass.

    Args:
        Q: Query tensor [batch_size, num_heads, seq_len, head_dim]
        K: Key tensor [batch_size, num_heads, seq_len, head_dim]
        V: Value tensor [batch_size, num_heads, seq_len, head_dim]

    Returns:
        O: Output tensor [batch_size, num_heads, seq_len, head_dim]
        L: Log-sum-exp for backward [batch_size, num_heads, seq_len]
    """
    assert Q.is_cuda and K.is_cuda and V.is_cuda
    assert Q.shape == K.shape == V.shape

    batch_size, num_heads, seq_len, head_dim = Q.shape

    # Allocate output tensors
    O = torch.empty_like(Q)
    L = torch.empty(batch_size, num_heads, seq_len, device=Q.device, dtype=torch.float32)

    # Block sizes
    BLOCK_M = 64
    BLOCK_N = 64
    BLOCK_D = triton.next_power_of_2(head_dim)

    # Scale factor
    scale = 1.0 / (head_dim**0.5)

    # Grid: one program per (batch, head) pair, tiled over query positions
    num_query_blocks = triton.cdiv(seq_len, BLOCK_M)
    grid = (batch_size * num_heads, num_query_blocks)

    flash_attention_forward_kernel[grid](
        Q,
        K,
        V,
        O,
        L,
        Q.stride(0),
        Q.stride(1),
        Q.stride(2),
        Q.stride(3),
        K.stride(0),
        K.stride(1),
        K.stride(2),
        K.stride(3),
        V.stride(0),
        V.stride(1),
        V.stride(2),
        V.stride(3),
        O.stride(0),
        O.stride(1),
        O.stride(2),
        O.stride(3),
        L.stride(0),
        L.stride(1),
        L.stride(2),
        seq_len,
        head_dim,
        scale,
        BLOCK_M=BLOCK_M,
        BLOCK_N=BLOCK_N,
        BLOCK_D=BLOCK_D,
    )

    return O, L


def flash_attention_backward(
    Q: torch.Tensor,
    K: torch.Tensor,
    V: torch.Tensor,
    O: torch.Tensor,
    L: torch.Tensor,
    dO: torch.Tensor,
) -> tuple:
    """
    Host wrapper for Flash Attention backward pass.

    Args:
        Q, K, V: Input tensors from forward
        O: Output from forward
        L: Log-sum-exp from forward
        dO: Gradient of output

    Returns:
        dQ, dK, dV: Gradients of inputs
    """
    batch_size, num_heads, seq_len, head_dim = Q.shape

    # Allocate gradient tensors
    dQ = torch.zeros_like(Q)
    dK = torch.empty_like(K)
    dV = torch.empty_like(V)

    # Block sizes
    BLOCK_M = 64
    BLOCK_N = 64
    BLOCK_D = triton.next_power_of_2(head_dim)

    scale = 1.0 / (head_dim**0.5)

    # Grid: one program per (batch, head) pair, tiled over K/V positions
    num_kv_blocks = triton.cdiv(seq_len, BLOCK_N)
    grid = (batch_size * num_heads, num_kv_blocks)

    flash_attention_backward_kernel[grid](
        Q,
        K,
        V,
        O,
        L,
        dO,
        dQ,
        dK,
        dV,
        Q.stride(0),
        Q.stride(1),
        Q.stride(2),
        Q.stride(3),
        K.stride(0),
        K.stride(1),
        K.stride(2),
        K.stride(3),
        V.stride(0),
        V.stride(1),
        V.stride(2),
        V.stride(3),
        O.stride(0),
        O.stride(1),
        O.stride(2),
        O.stride(3),
        L.stride(0),
        L.stride(1),
        L.stride(2),
        seq_len,
        head_dim,
        scale,
        BLOCK_M=BLOCK_M,
        BLOCK_N=BLOCK_N,
        BLOCK_D=BLOCK_D,
    )

    return dQ, dK, dV


def test_flash_attention():
    """Test function to verify correctness against PyTorch."""
    torch.manual_seed(42)

    # Test parameters
    BATCH_SIZE = 2
    NUM_HEADS = 4
    SEQ_LEN = 64
    HEAD_DIM = 32

    # Create test inputs
    Q = torch.randn(BATCH_SIZE, NUM_HEADS, SEQ_LEN, HEAD_DIM, device="cuda", dtype=torch.float32)
    K = torch.randn(BATCH_SIZE, NUM_HEADS, SEQ_LEN, HEAD_DIM, device="cuda", dtype=torch.float32)
    V = torch.randn(BATCH_SIZE, NUM_HEADS, SEQ_LEN, HEAD_DIM, device="cuda", dtype=torch.float32)

    # Run Flash Attention forward
    O_flash, L = flash_attention_forward(Q, K, V)

    # Reference (PyTorch scaled dot-product attention)
    scale = 1.0 / (HEAD_DIM**0.5)
    attn_scores = torch.matmul(Q, K.transpose(-2, -1)) * scale
    attn_weights = torch.softmax(attn_scores, dim=-1)
    O_ref = torch.matmul(attn_weights, V)

    # Verify forward
    forward_passed = torch.allclose(O_flash, O_ref, atol=1e-2, rtol=1e-2)
    if forward_passed:
        print("Forward test PASSED")
    else:
        diff = (O_flash - O_ref).abs().max()
        print(f"Forward test FAILED - Max difference: {diff}")

    # Test backward
    dO = torch.randn_like(O_flash)

    # Flash Attention backward
    dQ_flash, dK_flash, dV_flash = flash_attention_backward(Q, K, V, O_flash, L, dO)

    # PyTorch backward
    Q_ref = Q.clone().requires_grad_(True)
    K_ref = K.clone().requires_grad_(True)
    V_ref = V.clone().requires_grad_(True)
    attn_scores_ref = torch.matmul(Q_ref, K_ref.transpose(-2, -1)) * scale
    attn_weights_ref = torch.softmax(attn_scores_ref, dim=-1)
    O_ref = torch.matmul(attn_weights_ref, V_ref)
    O_ref.backward(dO)

    # Verify backward
    dQ_passed = torch.allclose(dQ_flash, Q_ref.grad, atol=1e-2, rtol=1e-2)
    dK_passed = torch.allclose(dK_flash, K_ref.grad, atol=1e-2, rtol=1e-2)
    dV_passed = torch.allclose(dV_flash, V_ref.grad, atol=1e-2, rtol=1e-2)

    if dQ_passed and dK_passed and dV_passed:
        print("Backward test PASSED")
    else:
        print(f"Backward test: dQ={dQ_passed}, dK={dK_passed}, dV={dV_passed}")
        if not dQ_passed:
            print(f"  dQ max diff: {(dQ_flash - Q_ref.grad).abs().max()}")
        if not dK_passed:
            print(f"  dK max diff: {(dK_flash - K_ref.grad).abs().max()}")
        if not dV_passed:
            print(f"  dV max diff: {(dV_flash - V_ref.grad).abs().max()}")

    return forward_passed and dQ_passed and dK_passed and dV_passed


if __name__ == "__main__":
    test_flash_attention()
