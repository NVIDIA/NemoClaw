#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


"""
Matrix multiplication — cuTile Python

  C = A @ B  where A(M,K), B(K,N), C(M,N)  (row-major)

Uses 2D grid, K-reduction loop, TF32 tensor cores for Float32 inputs.
"""

from math import ceil

import cuda.tile as ct
import cupy as cp
import numpy as np


@ct.kernel
def matmul_kernel(A, B, C, tm: ct.Constant[int], tn: ct.Constant[int], tk: ct.Constant[int]):
    bid_m = ct.bid(0)
    bid_n = ct.bid(1)
    M = A.shape[0]
    K = A.shape[1]

    num_k = ct.num_tiles(A, axis=1, shape=(tm, tk))
    acc = ct.full((tm, tn), 0, dtype=ct.float32)

    dtype = ct.tfloat32 if A.dtype == ct.float32 else A.dtype

    for k in range(num_k):
        a = ct.load(A, index=(bid_m, k), shape=(tm, tk), padding_mode=ct.PaddingMode.ZERO)
        b = ct.load(B, index=(k, bid_n), shape=(tk, tn), padding_mode=ct.PaddingMode.ZERO)
        a = a.astype(dtype)
        b = b.astype(dtype)
        acc = ct.mma(a, b, acc)

    acc = ct.astype(acc, C.dtype)
    ct.store(C, index=(bid_m, bid_n), tile=acc)


# ── Host harness ─────────────────────────────────────────────────────────────


def run_matmul(A, B, tm=128, tn=128, tk=64):
    M, K = A.shape
    _, N = B.shape
    C = cp.zeros((M, N), dtype=A.dtype)

    grid_m = ceil(M / tm)
    grid_n = ceil(N / tn)
    grid = (grid_m, grid_n, 1)
    stream = cp.cuda.get_current_stream()

    ct.launch(stream, grid, matmul_kernel, (A, B, C, tm, tn, tk))
    cp.cuda.runtime.deviceSynchronize()
    return C


def verify():
    test_cases = [
        (64, 64, 64),
        (128, 128, 128),
        (256, 256, 256),
        (100, 200, 150),
    ]
    for M, K, N in test_cases:
        A = cp.random.randn(M, K).astype(np.float32)
        B = cp.random.randn(K, N).astype(np.float32)
        C = run_matmul(A, B)
        expected = cp.asnumpy(A) @ cp.asnumpy(B)
        assert np.allclose(cp.asnumpy(C), expected, rtol=1e-2, atol=1e-1), f"matmul failed ({M}x{K})@({K}x{N})"
        print(f"  ({M}x{K}) @ ({K}x{N}): passed")


def main():
    print("--- cuTile Matmul Examples ---\n")
    verify()
    print("\n--- All matmul examples passed ---")


if __name__ == "__main__":
    main()
