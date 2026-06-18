# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


# Matrix multiplication — cuTile.jl
#
#   C = A * B
#
# Standard Julia layout (column-major):
#   A(M, K), B(K, N), C(M, N)
#
# Uses 1D grid with 2D swizzle for better L2 cache locality.
# Matches julia/kernels/matmul.jl

using CUDA
import cuTile as ct

# 2D swizzle for better L2 cache locality.
# Groups blocks to access nearby memory regions together.
@inline function swizzle_2d(M, N, tm, tn, GROUP_SIZE_M, bid)
    num_bid_m = cld(M, Int32(tm))
    num_bid_n = cld(N, Int32(tn))
    num_bid_in_group = Int32(GROUP_SIZE_M) * num_bid_n
    group_id = fld(bid, num_bid_in_group)
    first_bid_m = group_id * Int32(GROUP_SIZE_M)
    group_size_m = min(num_bid_m - first_bid_m, Int32(GROUP_SIZE_M))
    bid_m = first_bid_m + rem(bid, group_size_m)
    bid_n = fld(rem(bid, num_bid_in_group), group_size_m)
    return bid_m, bid_n
end

# ── Matmul Kernel: C = A * B ────────────────────────────────────────────────
# Uses 1D grid with 2D swizzle for cache locality.

function matmul_kernel(A::ct.TileArray{T,2}, B::ct.TileArray{T,2},
                       C::ct.TileArray{T,2},
                       tm::Int, tn::Int, tk::Int) where {T}
    ct.@compiler_options num_ctas=ct.ByTarget(v"10.0" => 2)

    # 1D grid with 2D swizzle for better L2 cache locality
    bid = ct.bid(1)
    M = size(A, 1)
    N = size(B, 2)
    # swizzle_2d expects 0-indexed bid, returns 0-indexed tile coords
    bid_m_0, bid_n_0 = swizzle_2d(M, N, tm, tn, 8, bid - Int32(1))
    bid_m = bid_m_0 + Int32(1)
    bid_n = bid_n_0 + Int32(1)

    num_k = ct.num_tiles(A, 2, (tm, tk))

    acc = zeros(Float32, tm, tn)

    for k in Int32(1):num_k
        a = ct.load(A; index=(bid_m, k), shape=(tm, tk), padding_mode=ct.PaddingMode.Zero)
        b = ct.load(B; index=(k, bid_n), shape=(tk, tn), padding_mode=ct.PaddingMode.Zero)
        # Convert to TF32 for tensor cores (Float32 inputs only)
        if T === Float32
            a = convert(ct.Tile{ct.TFloat32}, a)
            b = convert(ct.Tile{ct.TFloat32}, b)
        end
        acc = muladd(a, b, acc)
    end

    ct.store(C; index=(bid_m, bid_n), tile=convert(ct.Tile{T}, acc))
    return
end

# ── Host function ────────────────────────────────────────────────────────────

"""
    matmul!(C, A, B; tm=128, tn=128, tk=64)

Launch matmul kernel: C = A * B.

Memory layout (column-major):
  A shape: (M, K), B shape: (K, N), C shape: (M, N)
"""
function matmul!(C::CuMatrix{T}, A::CuMatrix{T}, B::CuMatrix{T};
                 tm::Int=128, tn::Int=128, tk::Int=64) where {T}
    M = size(A, 1)
    N = size(B, 2)
    grid = cld(M, tm) * cld(N, tn)
    ct.launch(matmul_kernel, grid, A, B, C,
              ct.Constant(tm), ct.Constant(tn), ct.Constant(tk))
    CUDA.synchronize()
    return
end

# ── Verify ───────────────────────────────────────────────────────────────────

function verify()
    test_cases = [
        (M=64,  K=64,  N=64),
        (M=128, K=128, N=128),
        (M=256, K=256, N=256),
        (M=100, K=200, N=150),
    ]
    tm, tn, tk = 128, 128, 64
    for tc in test_cases
        A = CUDA.rand(Float32, tc.M, tc.K)
        B = CUDA.rand(Float32, tc.K, tc.N)
        C = CUDA.zeros(Float32, tc.M, tc.N)

        matmul!(C, A, B; tm, tn, tk)

        expected = Array(A) * Array(B)
        result = Array(C)
        @assert isapprox(result, expected; atol=1e-1, rtol=1e-2) (
            "matmul failed ($(tc.M)x$(tc.K)) * ($(tc.K)x$(tc.N))")
        println("  ($(tc.M)x$(tc.K)) * ($(tc.K)x$(tc.N)): passed")
    end
end

function main()
    println("--- cuTile.jl Matmul Examples ---\n")
    verify()
    println("\n--- All matmul examples passed ---")
end

isinteractive() || main()
