#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


"""
Element-wise addition with alpha scaling — cuTile Python

  output = x + y * alpha        (tensor + tensor)
  output = x + scalar * alpha   (tensor + scalar)

Uses 1D ct.load/ct.store TMA pattern with block indexing.
"""

import cuda.tile as ct
import cupy as cp
import numpy as np

# ── Tensor + Tensor kernel: output = x + y * alpha ──────────────────────────


@ct.kernel
def add_kernel(x, y, output, alpha: ct.Constant[float], BLOCK_SIZE: ct.Constant[int]):
    pid = ct.bid(0)

    x_tile = ct.load(x, index=(pid,), shape=(BLOCK_SIZE,))
    y_tile = ct.load(y, index=(pid,), shape=(BLOCK_SIZE,))

    x_f32 = x_tile.astype(ct.float32)
    y_f32 = y_tile.astype(ct.float32)

    alpha_tile = ct.full((BLOCK_SIZE,), alpha, dtype=ct.float32)
    y_scaled = y_f32 * alpha_tile
    output_f32 = x_f32 + y_scaled

    ct.store(output, index=(pid,), tile=output_f32.astype(x.dtype))


# ── Tensor + Scalar kernel: output = x + scalar_val * alpha ─────────────────


@ct.kernel
def add_scalar_kernel(
    x, output, scalar_val: ct.Constant[float], alpha: ct.Constant[float], BLOCK_SIZE: ct.Constant[int]
):
    pid = ct.bid(0)

    x_tile = ct.load(x, index=(pid,), shape=(BLOCK_SIZE,))
    x_f32 = x_tile.astype(ct.float32)

    scaled = scalar_val * alpha
    scalar_tile = ct.full((BLOCK_SIZE,), scaled, dtype=ct.float32)
    output_f32 = x_f32 + scalar_tile

    ct.store(output, index=(pid,), tile=output_f32.astype(x.dtype))


# ── Host harness ─────────────────────────────────────────────────────────────


def run_add(x, y, alpha=1.0, BLOCK_SIZE=1024):
    n = x.shape[0]
    padded_n = int(np.ceil(n / BLOCK_SIZE)) * BLOCK_SIZE
    x_pad = cp.zeros(padded_n, dtype=x.dtype)
    y_pad = cp.zeros(padded_n, dtype=y.dtype)
    out = cp.zeros(padded_n, dtype=x.dtype)
    x_pad[:n] = x
    y_pad[:n] = y

    stream = cp.cuda.get_current_stream()
    grid = (padded_n // BLOCK_SIZE, 1, 1)
    ct.launch(stream, grid, add_kernel, (x_pad, y_pad, out, alpha, BLOCK_SIZE))
    cp.cuda.runtime.deviceSynchronize()
    return out[:n]


def run_add_scalar(x, scalar_val, alpha=1.0, BLOCK_SIZE=1024):
    n = x.shape[0]
    padded_n = int(np.ceil(n / BLOCK_SIZE)) * BLOCK_SIZE
    x_pad = cp.zeros(padded_n, dtype=x.dtype)
    out = cp.zeros(padded_n, dtype=x.dtype)
    x_pad[:n] = x

    stream = cp.cuda.get_current_stream()
    grid = (padded_n // BLOCK_SIZE, 1, 1)
    ct.launch(stream, grid, add_scalar_kernel, (x_pad, out, scalar_val, alpha, BLOCK_SIZE))
    cp.cuda.runtime.deviceSynchronize()
    return out[:n]


def verify():
    for n in [128, 1024, 4096, 513]:
        x = cp.random.rand(n).astype(np.float32)
        y = cp.random.rand(n).astype(np.float32)

        result = run_add(x, y, alpha=1.0)
        expected = cp.asnumpy(x) + cp.asnumpy(y)
        assert np.allclose(cp.asnumpy(result), expected, atol=1e-5), f"add failed n={n}"

        result = run_add(x, y, alpha=0.5)
        expected = cp.asnumpy(x) + cp.asnumpy(y) * 0.5
        assert np.allclose(cp.asnumpy(result), expected, atol=1e-5), f"add alpha=0.5 failed"

        result = run_add_scalar(x, 3.14, alpha=1.0)
        expected = cp.asnumpy(x) + 3.14
        assert np.allclose(cp.asnumpy(result), expected, atol=1e-5), f"add_scalar failed"

        print(f"  n={n}: passed")


def main():
    print("--- cuTile Add Examples ---\n")
    verify()
    print("\n--- All add examples passed ---")


if __name__ == "__main__":
    main()
