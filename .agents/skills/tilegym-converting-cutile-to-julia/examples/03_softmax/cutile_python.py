#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


"""
Row-wise Softmax — cuTile Python

Three strategies (forward only):
  1. TMA single-tile:  ct.load/ct.store, persistent scheduling, TILE_SIZE >= N
  2. Online 2-pass:    ct.load/ct.store, running max + sum, one block per row
  3. Chunked 3-pass:   ct.gather/ct.scatter, explicit max → sum → normalize

Demonstrates the key patterns each Julia translation must replicate.
"""

import math

import cuda.tile as ct
import cupy as cp
import numpy as np

# =============================================================================
# Strategy 1: TMA Single-Tile  (small N where TILE_SIZE >= N)
# Uses ct.load/ct.store with persistent scheduling.
# =============================================================================


@ct.kernel(occupancy=2)
def softmax_kernel_tma(
    output,
    input,
    n_rows: ct.Constant[int],
    n_cols: ct.Constant[int],
    TILE_SIZE: ct.Constant[int],
):
    pid = ct.bid(0)
    num_programs = ct.num_blocks(0)

    for row_idx in range(pid, n_rows, num_programs):
        row = ct.load(input, index=(row_idx, 0), shape=(1, TILE_SIZE), padding_mode=ct.PaddingMode.NEG_INF)
        row = ct.astype(row, ct.float32)

        row_max = ct.max(row, 1, keepdims=True)
        row_minus_max = ct.sub(row, row_max)
        numerator = ct.exp(row_minus_max)
        denominator = ct.sum(numerator, 1, keepdims=True)
        softmax_output = ct.truediv(numerator, denominator)

        softmax_output = ct.astype(softmax_output, input.dtype)
        ct.store(output, index=(row_idx, 0), tile=softmax_output)


# =============================================================================
# Strategy 2: Online 2-Pass  (large N, one block per row)
# Uses ct.load/ct.store with running max/sum (m_prev, l_prev).
# =============================================================================


@ct.kernel(occupancy=2)
def online_softmax_kernel_tma(
    output,
    input,
    n_cols: ct.Constant[int],
    TILE_SIZE: ct.Constant[int],
    tile_num_per_row: ct.Constant[int],
):
    row_idx = ct.bid(0)

    m_prev = ct.full((1, 1), -math.inf, dtype=ct.float32)
    l_prev = ct.full((1, 1), 0.0, dtype=ct.float32)

    # Pass 1: running max and sum
    for col_idx in range(tile_num_per_row):
        row_tile = ct.load(input, index=(row_idx, col_idx), shape=(1, TILE_SIZE))
        row_tile = ct.astype(row_tile, ct.float32)

        tile_max = ct.max(row_tile, axis=1, keepdims=True)
        m_curr = ct.maximum(tile_max, m_prev)

        exp_diff = ct.exp(ct.sub(m_prev, m_curr))
        l_prev = ct.mul(l_prev, exp_diff)

        p = ct.exp(ct.sub(row_tile, m_curr))
        l_curr = ct.sum(p, axis=1, keepdims=True)

        l_prev = ct.add(l_curr, l_prev)
        m_prev = m_curr

    # Pass 2: normalize
    for col_idx in range(tile_num_per_row):
        row_tile = ct.load(input, index=(row_idx, col_idx), shape=(1, TILE_SIZE))
        row_tile = ct.astype(row_tile, ct.float32)

        row_minus_max = ct.sub(row_tile, m_prev)
        numerator = ct.exp(row_minus_max)
        softmax_output = ct.truediv(numerator, l_prev)

        softmax_output = ct.astype(softmax_output, input.dtype)
        ct.store(output, index=(row_idx, col_idx), tile=softmax_output)


# =============================================================================
# Strategy 3: Chunked 3-Pass  (general, persistent scheduling)
# Uses ct.gather/ct.scatter with column offsets.
# =============================================================================


@ct.kernel(occupancy=4)
def softmax_kernel_chunked(
    output,
    input,
    n_rows: ct.Constant[int],
    n_cols: ct.Constant[int],
    TILE_SIZE: ct.Constant[int],
):
    pid = ct.bid(0)
    num_programs = ct.num_blocks(0)
    offsets = ct.arange(TILE_SIZE, dtype=ct.int32)
    num_chunks = ct.cdiv(n_cols, TILE_SIZE)

    for row_idx in range(pid, n_rows, num_programs):
        # Pass 1: find row max
        row_max = ct.full((1,), -math.inf, dtype=ct.float32)
        for chunk_idx in range(num_chunks):
            col_offsets = chunk_idx * TILE_SIZE + offsets
            chunk = ct.gather(input, (row_idx, col_offsets), check_bounds=True, padding_value=-math.inf)
            chunk = ct.astype(chunk, ct.float32)
            chunk_max = ct.max(chunk, 0, keepdims=True)
            row_max = ct.maximum(row_max, chunk_max)

        # Pass 2: sum of exp(x - max)
        denominator = ct.full((1,), 0.0, dtype=ct.float32)
        for chunk_idx in range(num_chunks):
            col_offsets = chunk_idx * TILE_SIZE + offsets
            chunk = ct.gather(input, (row_idx, col_offsets), check_bounds=True, padding_value=-math.inf)
            chunk = ct.astype(chunk, ct.float32)
            row_minus_max = ct.sub(chunk, row_max)
            numerator = ct.exp(row_minus_max)
            exponentials_sum = ct.sum(numerator, 0, keepdims=True)
            denominator = ct.add(denominator, exponentials_sum)

        # Pass 3: normalize and store
        for chunk_idx in range(num_chunks):
            col_offsets = chunk_idx * TILE_SIZE + offsets
            chunk = ct.gather(input, (row_idx, col_offsets), check_bounds=True, padding_value=-math.inf)
            chunk = ct.astype(chunk, ct.float32)
            row_minus_max = ct.sub(chunk, row_max)
            numerator = ct.exp(row_minus_max)
            softmax_output = ct.truediv(numerator, denominator)
            softmax_output = ct.astype(softmax_output, input.dtype)
            ct.scatter(output, (row_idx, col_offsets), softmax_output, check_bounds=True)


# =============================================================================
# Host harness
# =============================================================================


def _ref_softmax(inp_np):
    row_max = np.max(inp_np, axis=1, keepdims=True)
    exp_vals = np.exp(inp_np - row_max)
    return exp_vals / np.sum(exp_vals, axis=1, keepdims=True)


def run_tma(M, N, TILE_SIZE=None):
    """TMA single-tile strategy (TILE_SIZE >= N)."""
    if TILE_SIZE is None:
        TILE_SIZE = 1 << (N - 1).bit_length()  # next power of 2

    inp = cp.random.randn(M, N).astype(np.float32)
    out = cp.empty_like(inp)
    stream = cp.cuda.get_current_stream()

    NUM_SM = 128
    num_programs = min(NUM_SM * 2, M)
    grid = (num_programs, 1, 1)
    ct.launch(stream, grid, softmax_kernel_tma, (out, inp, M, N, TILE_SIZE))
    cp.cuda.runtime.deviceSynchronize()

    expected = _ref_softmax(cp.asnumpy(inp))
    assert np.allclose(cp.asnumpy(out), expected, rtol=1e-3, atol=1e-3), "TMA mismatch"
    return True


def run_online(M, N, TILE_SIZE=1024):
    """Online 2-pass strategy (one block per row)."""
    tile_num_per_row = (N + TILE_SIZE - 1) // TILE_SIZE
    padded_N = tile_num_per_row * TILE_SIZE

    inp_raw = cp.random.randn(M, N).astype(np.float32)
    # Pad with -inf so extra columns don't affect softmax
    inp = cp.full((M, padded_N), -np.inf, dtype=np.float32)
    inp[:, :N] = inp_raw
    out = cp.empty_like(inp)

    stream = cp.cuda.get_current_stream()
    grid = (M, 1, 1)
    ct.launch(stream, grid, online_softmax_kernel_tma, (out, inp, N, TILE_SIZE, tile_num_per_row))
    cp.cuda.runtime.deviceSynchronize()

    expected = _ref_softmax(cp.asnumpy(inp_raw))
    actual = cp.asnumpy(out[:, :N])
    assert np.allclose(actual, expected, rtol=1e-3, atol=1e-3), "Online mismatch"
    return True


def run_chunked(M, N, TILE_SIZE=256):
    """Chunked 3-pass strategy (persistent scheduling)."""
    inp = cp.random.randn(M, N).astype(np.float32)
    out = cp.empty_like(inp)
    stream = cp.cuda.get_current_stream()

    NUM_SM = 128
    num_programs = min(NUM_SM * 4, M)
    grid = (num_programs, 1, 1)
    ct.launch(stream, grid, softmax_kernel_chunked, (out, inp, M, N, TILE_SIZE))
    cp.cuda.runtime.deviceSynchronize()

    expected = _ref_softmax(cp.asnumpy(inp))
    assert np.allclose(cp.asnumpy(out), expected, rtol=1e-3, atol=1e-3), "Chunked mismatch"
    return True


# =============================================================================
# Main
# =============================================================================


def main():
    print("--- cuTile Softmax Examples (3 strategies) ---\n")

    print("Strategy 1: TMA single-tile")
    run_tma(256, 512)
    print("  PASSED\n")

    print("Strategy 2: Online 2-pass")
    run_online(256, 4096, TILE_SIZE=1024)
    print("  PASSED\n")

    print("Strategy 3: Chunked 3-pass")
    run_chunked(256, 4096, TILE_SIZE=256)
    print("  PASSED\n")

    print("--- All softmax examples completed ---")


if __name__ == "__main__":
    main()
