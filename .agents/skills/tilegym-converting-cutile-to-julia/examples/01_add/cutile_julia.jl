# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


# Element-wise addition with alpha scaling — cuTile.jl
#
#   output = x + y * alpha        (tensor + tensor)
#   output = x + scalar * alpha   (tensor + scalar)
#
# Uses 1D ct.load/ct.store TMA pattern with block indexing.
# Matches julia/kernels/add.jl

using CUDA
import cuTile as ct

# ── Tensor + Tensor kernel: output = x + y * alpha ──────────────────────────

function add_kernel(x::ct.TileArray{T,1}, y::ct.TileArray{T,1},
                    output::ct.TileArray{T,1},
                    alpha::Float32, BLOCK_SIZE::Int) where {T}
    bid = ct.bid(1)

    x_tile = ct.load(x; index=bid, shape=(BLOCK_SIZE,), padding_mode=ct.PaddingMode.Zero)
    y_tile = ct.load(y; index=bid, shape=(BLOCK_SIZE,), padding_mode=ct.PaddingMode.Zero)

    x_f32 = convert(ct.Tile{Float32}, x_tile)
    y_f32 = convert(ct.Tile{Float32}, y_tile)

    # Scalar alpha broadcasts to tile shape automatically
    output_f32 = x_f32 .+ y_f32 .* alpha
    ct.store(output; index=bid, tile=convert(ct.Tile{T}, output_f32))
    return
end

# ── Tensor + Scalar kernel: output = x + scalar_val * alpha ─────────────────

function add_scalar_kernel(x::ct.TileArray{T,1}, output::ct.TileArray{T,1},
                           scalar_val::Float32, alpha::Float32,
                           BLOCK_SIZE::Int) where {T}
    bid = ct.bid(1)

    x_tile = ct.load(x; index=bid, shape=(BLOCK_SIZE,), padding_mode=ct.PaddingMode.Zero)
    x_f32 = convert(ct.Tile{Float32}, x_tile)

    output_f32 = x_f32 .+ (scalar_val * alpha)
    ct.store(output; index=bid, tile=convert(ct.Tile{T}, output_f32))
    return
end

# ── Host functions ───────────────────────────────────────────────────────────

function add!(output::CuVector{T}, x::CuVector{T}, y::CuVector{T};
              alpha::Float32=1.0f0, block_size::Int=1024) where {T}
    n = length(x)
    grid = cld(n, block_size)
    ct.launch(add_kernel, grid, x, y, output,
              ct.Constant(alpha), ct.Constant(block_size))
    CUDA.synchronize()
    return
end

function add_scalar!(output::CuVector{T}, x::CuVector{T}, scalar_val::Float32;
                     alpha::Float32=1.0f0, block_size::Int=1024) where {T}
    n = length(x)
    grid = cld(n, block_size)
    ct.launch(add_scalar_kernel, grid, x, output,
              ct.Constant(scalar_val), ct.Constant(alpha), ct.Constant(block_size))
    CUDA.synchronize()
    return
end

# ── Verify ───────────────────────────────────────────────────────────────────

function verify()
    for n in [128, 1024, 4096, 513]
        x = CUDA.rand(Float32, n)
        y = CUDA.rand(Float32, n)
        out = CUDA.zeros(Float32, n)

        add!(out, x, y; alpha=1.0f0)
        @assert Array(out) ≈ Array(x) .+ Array(y) atol=1e-5

        add!(out, x, y; alpha=0.5f0)
        @assert Array(out) ≈ Array(x) .+ Array(y) .* 0.5f0 atol=1e-5

        out_scalar = CUDA.zeros(Float32, n)
        add_scalar!(out_scalar, x, 3.0f0; alpha=0.5f0)
        @assert Array(out_scalar) ≈ Array(x) .+ (3.0f0 * 0.5f0) atol=1e-5

        println("  n=$n: passed")
    end
end

function main()
    println("--- cuTile.jl Add Examples ---\n")
    verify()
    println("\n--- All add examples passed ---")
end

isinteractive() || main()
