// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#include <metal_stdlib>
using namespace metal;

// Each group owns a function and one 32-value word. Words and functions are
// independent, so all fixed-point barriers stay inside this threadgroup.
struct Group {
    uint block_base;
    uint block_count;
    uint row_base;
    uint words;
    uint word;
};

kernel void liveness(
    device const Group *groups [[buffer(0)]],
    device const uint *successor_offsets [[buffer(1)]],
    device const uint *successors [[buffer(2)]],
    device const uint *uses [[buffer(3)]],
    device const uint *defs [[buffer(4)]],
    device const uint *phi_out [[buffer(5)]],
    device uint *result [[buffer(6)]],
    device uint *iterations [[buffer(7)]],
    device uint *converged [[buffer(8)]],
    threadgroup uint *previous [[threadgroup(0)]],
    threadgroup uint *next [[threadgroup(1)]],
    uint3 group_id [[threadgroup_position_in_grid]],
    uint lane [[thread_index_in_threadgroup]],
    uint3 group_size [[threads_per_threadgroup]]) {
    Group group = groups[group_id.x];
    threadgroup atomic_uint changed;
    for (uint block = lane; block < group.block_count; block += group_size.x) {
        previous[block] = 0;
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);

    bool stable = false;
    uint sweeps = 0;
    // With zero initialization each bit propagates along a simple CFG path.
    // N + 1 sweeps includes the final no-change sweep, even with cycles.
    for (uint round = 0; round <= group.block_count; ++round) {
        if (lane == 0) atomic_store_explicit(&changed, 0, memory_order_relaxed);
        threadgroup_barrier(mem_flags::mem_threadgroup);
        for (uint block = lane; block < group.block_count; block += group_size.x) {
            uint global_block = group.block_base + block;
            uint cell = group.row_base + block * group.words + group.word;
            uint live_out = phi_out[cell];
            for (uint edge = successor_offsets[global_block];
                 edge < successor_offsets[global_block + 1]; ++edge) {
                live_out |= previous[successors[edge] - group.block_base];
            }
            uint value = uses[cell] | (live_out & ~defs[cell]);
            next[block] = value;
            if (value != previous[block]) {
                atomic_fetch_or_explicit(&changed, 1, memory_order_relaxed);
            }
        }
        threadgroup_barrier(mem_flags::mem_threadgroup);
        sweeps = round + 1;
        if (atomic_load_explicit(&changed, memory_order_relaxed) == 0) {
            stable = true;
            break;
        }
        for (uint block = lane; block < group.block_count; block += group_size.x) {
            previous[block] = next[block];
        }
        threadgroup_barrier(mem_flags::mem_threadgroup);
    }
    for (uint block = lane; block < group.block_count; block += group_size.x) {
        uint cell = group.row_base + block * group.words + group.word;
        result[cell] = previous[block];
    }
    if (lane == 0) {
        iterations[group_id.x] = sweeps;
        converged[group_id.x] = stable ? 1 : 0;
    }
}
