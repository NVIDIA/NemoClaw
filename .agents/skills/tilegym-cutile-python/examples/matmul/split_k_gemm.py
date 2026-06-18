# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


"""Optimized split-k GEMM implementation in cuTile

Key techniques
  1. Static persistent scheduling over flattened (m, n, k_split) tile space
  2. num_ctas=2 hint for Blackwell (SM 10.x)
  3. Larger tile sizes (BLOCK_M=128, BLOCK_N=128)
  4. L2 tile swizzle within each k-split
"""

import math

import cuda.tile as ct
import torch


def _adjust_group_size(num_tiles_m, group_size_m):
    """Adjust GROUP_SIZE_M to evenly divide num_tiles_m."""
    gsm = min(group_size_m, num_tiles_m)
    while num_tiles_m % gsm != 0 and gsm > 1:
        gsm -= 1
    return max(gsm, 1)


@ct.kernel(num_ctas=ct.ByTarget(sm_100=2), occupancy=1)
def split_gemm(
    A,
    B,
    C,
    num_tiles_m: ct.Constant[int],
    num_tiles_n: ct.Constant[int],
    num_k_splits: ct.Constant[int],
    k_tiles_per_split: ct.Constant[int],
    total_tiles: ct.Constant[int],
    BLOCK_M: ct.Constant[int],
    BLOCK_N: ct.Constant[int],
    BLOCK_K: ct.Constant[int],
    GROUP_SIZE_M: ct.Constant[int],
):
    """Compute a split-K GEMM tile with atomic accumulation into the output."""
    pid = ct.bid(0)
    num_programs = ct.num_blocks(0)

    for tile_id in range(pid, total_tiles, num_programs):
        # Decompose: innermost dimension is k_split
        k_split_id = tile_id % num_k_splits
        mn_tile = tile_id // num_k_splits

        # L2 swizzle on M,N tiles
        tiles_per_group = GROUP_SIZE_M * num_tiles_n
        group_id_sw = mn_tile // tiles_per_group
        tile_in_group = mn_tile % tiles_per_group
        bid_m = group_id_sw * GROUP_SIZE_M + tile_in_group % GROUP_SIZE_M
        bid_n = tile_in_group // GROUP_SIZE_M

        start_k = k_split_id * k_tiles_per_split
        end_k = start_k + k_tiles_per_split

        acc = ct.full((BLOCK_M, BLOCK_N), 0.0, dtype=ct.float32)
        for k in range(start_k, end_k):
            a_tile = ct.load(A, index=(bid_m, k), shape=(BLOCK_M, BLOCK_K), allow_tma=False)
            b_tile = ct.load(B, index=(k, bid_n), shape=(BLOCK_K, BLOCK_N), allow_tma=False)
            acc = ct.mma(a_tile, b_tile, acc)

        # Per-dimension index tuple required for rank-2 arrays
        offset_m = bid_m * BLOCK_M + ct.arange(BLOCK_M, dtype=ct.int32)
        offset_n = bid_n * BLOCK_N + ct.arange(BLOCK_N, dtype=ct.int32)

        ct.atomic_add(C, (offset_m[:, None], offset_n[None, :]), acc)


def launch_split_gemm(A, B, C):
    """Configure and launch the split-K GEMM kernel."""
    BLOCK_M = 128
    BLOCK_N = 128
    BLOCK_K = 64
    SPLIT_K = 4
    GROUP_SIZE_M = 4

    M, K = A.shape
    N_dim = B.shape[1]

    num_tiles_m = math.ceil(M / BLOCK_M)
    num_tiles_n = math.ceil(N_dim / BLOCK_N)

    # The kernel assigns exactly `k_tiles_per_split` iterations per split and
    # loads A/B without OOB padding. Require K to be a whole number of BLOCK_K
    # tiles, and that count to split evenly across SPLIT_K, so no K tiles are
    # silently dropped.
    assert K % BLOCK_K == 0, f"K ({K}) must be divisible by BLOCK_K ({BLOCK_K})"
    total_k_tiles = K // BLOCK_K
    assert total_k_tiles % SPLIT_K == 0, f"total_k_tiles ({total_k_tiles}) must be divisible by SPLIT_K ({SPLIT_K})"
    k_tiles_per_split = total_k_tiles // SPLIT_K

    GROUP_SIZE_M = _adjust_group_size(num_tiles_m, GROUP_SIZE_M)

    total_tiles = num_tiles_m * num_tiles_n * SPLIT_K

    NUM_SM = torch.cuda.get_device_properties("cuda").multi_processor_count
    num_programs = min(NUM_SM * 2, total_tiles)
    grid = (num_programs, 1, 1)

    ct.launch(
        torch.cuda.current_stream(),
        grid,
        split_gemm,
        (
            A,
            B,
            C,
            num_tiles_m,
            num_tiles_n,
            SPLIT_K,
            k_tiles_per_split,
            total_tiles,
            BLOCK_M,
            BLOCK_N,
            BLOCK_K,
            GROUP_SIZE_M,
        ),
    )
    return C


def reference_gemm(A, B):
    """Compute reference matrix multiplication using torch.matmul."""
    return torch.matmul(A, B)


def main():
    """Run split-K GEMM and verify correctness against torch reference."""
    A = torch.rand(512, 10240, dtype=torch.float32, device="cuda")
    B = torch.rand(10240, 256, dtype=torch.float32, device="cuda")

    # Test cuda.tile implementations
    C_split = torch.zeros(512, 256, dtype=torch.float32, device="cuda")
    launch_split_gemm(A, B, C_split)

    C_ref = reference_gemm(A, B)

    # Verification
    print("=== Correctness Verification ===")

    verified = torch.allclose(C_split, C_ref, atol=1e-2, rtol=1e-2)
    if verified:
        print("Test passed! cuda.tile Split GEMM verified")
    else:
        print("cuda.tile Split GEMM failed")
        print(f"Max error: {torch.max(torch.abs(C_split - C_ref))}")


if __name__ == "__main__":
    main()
