# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


"""Example 4: matrix multiplication with 4D tensors - note the difference from 3D tensors

Optimized implementation using static persistent scheduling.

Key techniques
  1. Static persistent scheduling with flattened (P*Q, m, n) tile space
  2. Tensor-core MMA  (ct.mma with fp16 inputs, fp32 accumulator)
  3. TMA loads
  4. num_ctas=2 hint for Blackwell (SM 10.x)
  5. L2 tile swizzle
  6. Heuristic tile selection
"""

import math

import cuda.tile as ct
import torch


def _select_tile_config(M, N, K):
    """Heuristic tile config selection."""
    if M >= 1024:
        TILE_M, TILE_N, TILE_K = 128, 128, 32
    elif M >= 256:
        TILE_M, TILE_N, TILE_K = 64, 64, 32
    else:
        TILE_M, TILE_N, TILE_K = 32, 32, 32
    return TILE_M, TILE_N, TILE_K, 8


def _adjust_group_size(num_tiles_m, group_size_m):
    """Adjust GROUP_SIZE_M to evenly divide num_tiles_m."""
    gsm = min(group_size_m, num_tiles_m)
    while num_tiles_m % gsm != 0 and gsm > 1:
        gsm -= 1
    return max(gsm, 1)


# A has shape (P, Q, M, K)
# B has shape (P, Q, K, N)
# output has shape (P, Q, M, N)
@ct.kernel(num_ctas=ct.ByTarget(sm_100=2), occupancy=1)
def matmul_kernel(
    A,
    B,
    output,
    PQ: ct.Constant[int],
    Q: ct.Constant[int],
    M: ct.Constant[int],
    N: ct.Constant[int],
    TILE_M: ct.Constant[int],
    TILE_K: ct.Constant[int],
    TILE_N: ct.Constant[int],
    GROUP_SIZE_M: ct.Constant[int],
):
    """Compute matrix multiplication over 4D tensors using tiled MMA."""
    pid = ct.bid(0)
    num_programs = ct.num_blocks(0)

    num_tiles_m = ct.cdiv(M, TILE_M)
    num_tiles_n = ct.cdiv(N, TILE_N)
    tiles_per_pq = num_tiles_m * num_tiles_n
    total_tiles = PQ * tiles_per_pq

    for tile_id in range(pid, total_tiles, num_programs):
        pq_idx = tile_id // tiles_per_pq
        bid_p = pq_idx // Q
        bid_q = pq_idx % Q
        remainder = tile_id % tiles_per_pq

        # L2 tile swizzle
        tiles_per_group = GROUP_SIZE_M * num_tiles_n
        group_id_sw = remainder // tiles_per_group
        tile_in_group = remainder % tiles_per_group
        bid_m = group_id_sw * GROUP_SIZE_M + tile_in_group % GROUP_SIZE_M
        bid_n = tile_in_group // GROUP_SIZE_M

        acc = ct.full((TILE_M, TILE_N), 0.0, dtype=ct.float32)
        num_k_tiles = ct.num_tiles(A, axis=3, shape=(1, 1, TILE_M, TILE_K))
        for k in range(num_k_tiles):
            a = ct.load(
                A, index=(bid_p, bid_q, bid_m, k), shape=(1, 1, TILE_M, TILE_K), padding_mode=ct.PaddingMode.ZERO
            )
            b = ct.load(
                B, index=(bid_p, bid_q, k, bid_n), shape=(1, 1, TILE_K, TILE_N), padding_mode=ct.PaddingMode.ZERO
            )
            a = ct.reshape(a, (TILE_M, TILE_K))
            b = ct.reshape(b, (TILE_K, TILE_N))
            acc = ct.mma(a, b, acc)

        acc = ct.astype(acc, output.dtype)
        acc = ct.reshape(acc, (1, 1, TILE_M, TILE_N))
        ct.store(output, index=(bid_p, bid_q, bid_m, bid_n), tile=acc)


def reference_matmul(A, B):
    """Compute reference matrix multiplication using torch.matmul."""
    return torch.matmul(A, B)


if __name__ == "__main__":
    P = 11
    Q = 5
    M = 1024
    K = 1024
    N = 512
    A = torch.rand(P, Q, M, K, dtype=torch.float16, device="cuda")
    B = torch.rand(P, Q, K, N, dtype=torch.float16, device="cuda")
    cutile_output = torch.zeros(P, Q, M, N, dtype=torch.float16, device="cuda")

    TILE_M, TILE_N, TILE_K, GROUP_SIZE_M = _select_tile_config(M, N, K)

    num_tiles_m = math.ceil(M / TILE_M)
    GROUP_SIZE_M = _adjust_group_size(num_tiles_m, GROUP_SIZE_M)

    NUM_SM = torch.cuda.get_device_properties("cuda").multi_processor_count
    total_tiles = P * Q * num_tiles_m * math.ceil(N / TILE_N)
    num_programs = min(NUM_SM * 2, total_tiles)
    grid = (num_programs, 1, 1)

    ct.launch(
        torch.cuda.current_stream(),
        grid,
        matmul_kernel,
        (A, B, cutile_output, P * Q, Q, M, N, TILE_M, TILE_K, TILE_N, GROUP_SIZE_M),
    )
    reference_output = reference_matmul(A, B)

    assert torch.allclose(cutile_output, reference_output, atol=1e-2, rtol=1e-2)
    print("Test passed!")
