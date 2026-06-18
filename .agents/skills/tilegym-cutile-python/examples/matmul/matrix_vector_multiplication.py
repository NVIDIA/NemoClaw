# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


"""Example 2: matrix vector multiplication

Optimized implementation using static persistent scheduling.

Key techniques
  1. Static persistent scheduling with occupancy=4 (GEMV is memory-bound)
  2. Tensor-core MMA
  3. TMA loads
  4. Larger tile sizes (BLOCK_M=64, BLOCK_K=128)
"""

import math

import cuda.tile as ct
import torch


# A has shape (M, K)
# B has shape (K)
# output has shape (M)
@ct.kernel(occupancy=4)
def cutile_gemv_kernel(
    A,
    B,
    output,
    M: ct.Constant[int],
    BLOCK_M: ct.Constant[int],
    BLOCK_K: ct.Constant[int],
):
    """Compute matrix-vector multiplication using tiled MMA with persistent scheduling."""
    pid = ct.bid(0)
    num_programs = ct.num_blocks(0)
    num_tiles_m = ct.cdiv(M, BLOCK_M)

    for tile_m in range(pid, num_tiles_m, num_programs):
        acc = ct.full((BLOCK_M, 1), 0.0, dtype=ct.float32)
        num_k_tiles = ct.num_tiles(A, axis=1, shape=(BLOCK_M, BLOCK_K))
        for k in range(num_k_tiles):
            a = ct.load(A, index=(tile_m, k), shape=(BLOCK_M, BLOCK_K), padding_mode=ct.PaddingMode.ZERO)
            b = ct.load(B, index=(k,), shape=(BLOCK_K,), padding_mode=ct.PaddingMode.ZERO)
            b2 = ct.reshape(b, (BLOCK_K, 1))
            acc = ct.mma(a, b2, acc)

        acc = ct.astype(acc, output.dtype)
        acc = ct.reshape(acc, (BLOCK_M,))
        ct.store(output, index=(tile_m,), tile=acc)


def reference_matmul(A, B):
    """Compute reference matrix-vector multiplication using torch.matmul."""
    return torch.matmul(A, B)


if __name__ == "__main__":
    M = 1024
    K = 1024
    A = torch.rand(M, K, dtype=torch.float16, device="cuda")
    B = torch.rand(K, dtype=torch.float16, device="cuda")
    cutile_output = torch.zeros(M, dtype=torch.float16, device="cuda")

    BLOCK_M = 64
    BLOCK_K = 128

    NUM_SM = torch.cuda.get_device_properties("cuda").multi_processor_count
    num_tiles_m = math.ceil(M / BLOCK_M)
    num_programs = min(NUM_SM * 4, num_tiles_m)
    grid = (num_programs, 1)

    ct.launch(torch.cuda.current_stream(), grid, cutile_gemv_kernel, (A, B, cutile_output, M, BLOCK_M, BLOCK_K))
    reference_output = reference_matmul(A, B)

    assert torch.allclose(cutile_output, reference_output, atol=1e-2, rtol=1e-2)
    print("Test passed!")
