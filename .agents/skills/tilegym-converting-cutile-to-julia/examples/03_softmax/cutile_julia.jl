# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
#
# SPDX-License-Identifier: CC-BY-4.0 AND Apache-2.0


# Row-wise Softmax — cuTile.jl
#
# Three strategies (forward only):
#   1. TMA single-tile:  ct.load/ct.store, persistent scheduling, TILE_SIZE >= N
#   2. Online 2-pass:    ct.load/ct.store, running max + sum, one block per row
#   3. Chunked 3-pass:   ct.gather/ct.scatter, explicit max → sum → normalize
#
# Matches julia/kernels/softmax.jl
#
# Key translation patterns demonstrated:
#   - Broadcast dot syntax: exp.(), .-, ./, max.()
#   - ct.PaddingMode.NegInf  (Python: ct.PaddingMode.NEG_INF)
#   - maximum(tile; dims=2)   (Python: ct.max(tile, 1, keepdims=True))
#   - fill(-Inf32, (1, 1)) for scalar accumulators
#   - zeros(Float32, 1, 1) for zero-initialized accumulators
#   - ct.Constant() at launch, plain ::Int in kernel signature
#   - Host functions accept CuMatrix{T} directly

using CUDA
import cuTile as ct

#=============================================================================
 Strategy 1: TMA Single-Tile  (TILE_SIZE >= N)
 Loads entire row in one ct.load with NegInf padding.
 Uses persistent scheduling: each block processes multiple rows.
=============================================================================#
function softmax_kernel_tma(output::ct.TileArray{T,2}, input::ct.TileArray{T,2},
                            TILE_SIZE::Int) where {T}
    ct.@compiler_options occupancy=2

    pid = ct.bid(1)
    num_programs = ct.num_blocks(1)
    n_rows = size(input, 1)

    row_idx = pid
    while row_idx <= n_rows
        row = ct.load(input; index=(row_idx, Int32(1)), shape=(1, TILE_SIZE),
                      padding_mode=ct.PaddingMode.NegInf)
        row = convert(ct.Tile{Float32}, row)

        row_max = maximum(row; dims=2)
        numerator = exp.(row .- row_max)
        denominator = sum(numerator; dims=2)
        softmax_output = numerator ./ denominator

        ct.store(output; index=(row_idx, Int32(1)),
                 tile=convert(ct.Tile{T}, softmax_output))
        row_idx += num_programs
    end
    return
end

#=============================================================================
 Strategy 2: Online 2-Pass  (large N, one block per row)
 Pass 1: running max + sum via online algorithm (m_prev, l_prev)
 Pass 2: normalize each tile chunk
=============================================================================#
function softmax_kernel_online(output::ct.TileArray{T,2}, input::ct.TileArray{T,2},
                               TILE_SIZE::Int) where {T}
    row_idx = ct.bid(1)
    num_col_tiles = ct.num_tiles(input, 2, (1, TILE_SIZE))

    m_prev = fill(-Inf32, (1, 1))
    l_prev = zeros(Float32, 1, 1)

    # Pass 1: compute running max and sum
    for col_idx in Int32(1):num_col_tiles
        row_tile = ct.load(input; index=(row_idx, col_idx), shape=(1, TILE_SIZE),
                          padding_mode=ct.PaddingMode.NegInf)
        row_tile = convert(ct.Tile{Float32}, row_tile)

        tile_max = maximum(row_tile; dims=2)
        m_curr = max.(tile_max, m_prev)

        # Correct old sum: l_prev *= exp(m_prev - m_curr)
        l_prev = l_prev .* exp.(m_prev .- m_curr)

        # Update with current tile
        p = exp.(row_tile .- m_curr)
        l_prev = sum(p; dims=2) .+ l_prev
        m_prev = m_curr
    end

    # Pass 2: compute actual softmax values
    for col_idx in Int32(1):num_col_tiles
        row_tile = ct.load(input; index=(row_idx, col_idx), shape=(1, TILE_SIZE),
                          padding_mode=ct.PaddingMode.NegInf)
        row_tile = convert(ct.Tile{Float32}, row_tile)

        numerator = exp.(row_tile .- m_prev)
        softmax_output = numerator ./ l_prev

        ct.store(output; index=(row_idx, col_idx),
                 tile=convert(ct.Tile{T}, softmax_output))
    end
    return
end

#=============================================================================
 Strategy 3: Chunked 3-Pass  (one block per row, gather/scatter)
 Pass 1: row max across all chunks
 Pass 2: sum of exp(x - max)
 Pass 3: normalize and scatter back
=============================================================================#
function softmax_kernel_chunked(output::ct.TileArray{T,2}, input::ct.TileArray{T,2},
                                n_cols::Int, TILE_SIZE::Int) where {T}
    ct.@compiler_options occupancy=4

    row_idx = ct.bid(1)
    num_chunks = (n_cols + TILE_SIZE - Int32(1)) ÷ Int32(TILE_SIZE)
    col_offsets_base = ct.arange(TILE_SIZE)
    row_tile = ct.Tile(row_idx)

    row_max = fill(-Inf32, (1,))
    denominator = zeros(Float32, TILE_SIZE)

    # Pass 1: Find maximum across all chunks
    for chunk_idx in Int32(0):num_chunks - Int32(1)
        col_indices = ct.broadcast_to(ct.Tile(chunk_idx * Int32(TILE_SIZE)), (TILE_SIZE,)) .+ col_offsets_base
        chunk = ct.gather(input, (row_tile, col_indices);
                         check_bounds=true, padding_value=T(-Inf))
        chunk = convert(ct.Tile{Float32}, chunk)
        chunk_max = maximum(chunk)
        row_max = max.(row_max, ct.Tile(chunk_max))
    end

    # Pass 2: Compute denominator (sum of all exp values)
    for chunk_idx in Int32(0):num_chunks - Int32(1)
        col_indices = ct.broadcast_to(ct.Tile(chunk_idx * Int32(TILE_SIZE)), (TILE_SIZE,)) .+ col_offsets_base
        chunk = ct.gather(input, (row_tile, col_indices);
                         check_bounds=true, padding_value=T(-Inf))
        chunk = convert(ct.Tile{Float32}, chunk)
        numerator = exp.(chunk .- row_max)
        denominator = denominator .+ numerator
    end
    denom_sum = ct.Tile(sum(denominator))

    # Pass 3: Compute final softmax and scatter
    for chunk_idx in Int32(0):num_chunks - Int32(1)
        col_indices = ct.broadcast_to(ct.Tile(chunk_idx * Int32(TILE_SIZE)), (TILE_SIZE,)) .+ col_offsets_base
        chunk = ct.gather(input, (row_tile, col_indices);
                         check_bounds=true, padding_value=T(-Inf))
        chunk = convert(ct.Tile{Float32}, chunk)
        softmax_output = exp.(chunk .- row_max) ./ denom_sum
        ct.scatter(output, (row_tile, col_indices), convert(ct.Tile{T}, softmax_output);
                  check_bounds=true)
    end
    return
end

#=============================================================================
 Host Functions
=============================================================================#

"""
    softmax_tma!(output, input; tile_size)

TMA single-tile strategy. tile_size must be >= size(input, 2).
"""
function softmax_tma!(output::CuMatrix{T}, input::CuMatrix{T};
                      tile_size::Int=1024) where {T}
    M = size(input, 1)
    ct.launch(softmax_kernel_tma, M, output, input, ct.Constant(tile_size))
    CUDA.synchronize()
    return
end

"""
    softmax_online!(output, input; tile_size)

Online softmax strategy. Processes row in tile_size chunks.
"""
function softmax_online!(output::CuMatrix{T}, input::CuMatrix{T};
                         tile_size::Int=1024) where {T}
    M = size(input, 1)
    ct.launch(softmax_kernel_online, M, output, input, ct.Constant(tile_size))
    CUDA.synchronize()
    return
end

"""
    softmax_chunked!(output, input; tile_size)

Chunked softmax strategy (3-pass, gather/scatter).
"""
function softmax_chunked!(output::CuMatrix{T}, input::CuMatrix{T};
                          tile_size::Int=1024) where {T}
    M, N = size(input)
    ct.launch(softmax_kernel_chunked, M, output, input,
              ct.Constant(N), ct.Constant(tile_size))
    CUDA.synchronize()
    return
end

#=============================================================================
 Verification
=============================================================================#

function ref_softmax(inp::Matrix{Float32})
    row_max = maximum(inp; dims=2)
    exp_vals = exp.(inp .- row_max)
    return exp_vals ./ sum(exp_vals; dims=2)
end

function test_tma(M, N, TILE_SIZE)
    println("  Strategy 1: TMA single-tile ($M×$N, tile=$TILE_SIZE)")
    inp = CUDA.randn(Float32, M, N)
    out = CUDA.zeros(Float32, M, N)

    softmax_tma!(out, inp; tile_size=TILE_SIZE)

    expected = ref_softmax(Array(inp))
    @assert isapprox(Array(out), expected; rtol=1e-3, atol=1e-3) (
        "TMA mismatch! max diff: $(maximum(abs.(Array(out) .- expected)))"
    )
    println("    PASSED")
end

function test_online(M, N, TILE_SIZE)
    println("  Strategy 2: Online 2-pass ($M×$N, tile=$TILE_SIZE)")
    inp = CUDA.randn(Float32, M, N)
    out = CUDA.zeros(Float32, M, N)

    softmax_online!(out, inp; tile_size=TILE_SIZE)

    expected = ref_softmax(Array(inp))
    @assert isapprox(Array(out), expected; rtol=1e-3, atol=1e-3) (
        "Online mismatch! max diff: $(maximum(abs.(Array(out) .- expected)))"
    )
    println("    PASSED")
end

function test_chunked(M, N, TILE_SIZE)
    println("  Strategy 3: Chunked 3-pass ($M×$N, tile=$TILE_SIZE)")
    inp = CUDA.randn(Float32, M, N)
    out = CUDA.zeros(Float32, M, N)

    softmax_chunked!(out, inp; tile_size=TILE_SIZE)

    expected = ref_softmax(Array(inp))
    @assert isapprox(Array(out), expected; rtol=1e-3, atol=1e-3) (
        "Chunked mismatch! max diff: $(maximum(abs.(Array(out) .- expected)))"
    )
    println("    PASSED")
end

function main()
    println("=== cuTile.jl Softmax Examples (3 strategies) ===\n")

    test_tma(256, 512, 512)
    test_online(256, 4096, 1024)
    test_chunked(256, 4096, 256)

    println("\n=== All softmax examples completed ===")
end

isinteractive() || main()
