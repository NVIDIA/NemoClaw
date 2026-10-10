// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include "metal_bridge.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <exception>
#include <mutex>
#include <new>
#include <string>

static_assert(sizeof(GPULabStats) == 32 && alignof(GPULabStats) == 8, "C ABI stats layout changed");
static_assert(sizeof(GPULabGroup) == 5 * sizeof(uint32_t), "Metal Group layout changed");
static_assert(offsetof(GPULabGroup, word) == 4 * sizeof(uint32_t), "Metal Group offsets changed");

namespace {
using Clock = std::chrono::steady_clock;

struct Context {
    id<MTLDevice> device;
    id<MTLCommandQueue> queue;
    id<MTLLibrary> library;
    id<MTLComputePipelineState> pipeline;
    id<MTLBuffer> buffers[9] = {};
    size_t capacities[9] = {};
    id<MTLCommandBuffer> pending;
    Clock::time_point started;
    std::mutex mutex;
    uint32_t cells = 0;
    uint32_t groups = 0;
    uint32_t allocations = 0;
    uint32_t reused_pipeline = 0;
    uint64_t submitted_batches = 0;
    NSUInteger threads = 0;
};

void diagnostic(char *err, size_t capacity, const std::string &message) {
    if (err && capacity) std::snprintf(err, capacity, "%s", message.c_str());
}

std::string metal_error(const char *operation, NSError *error) {
    if (!error) return std::string(operation) + ": Metal returned no diagnostic";
    NSString *description = error.localizedDescription;
    NSString *domain = error.domain;
    return std::string(operation) + ": " + (description.UTF8String ?: "unknown error") +
           " [" + (domain.UTF8String ?: "unknown domain") + ":" +
           std::to_string(error.code) + "]";
}

bool validate(const GPULabInput *input, uint32_t &largest, std::string &error) {
    if (!input) { error = "Input descriptor is NULL"; return false; }
    if (!input->function_count || !input->block_count || !input->cell_count ||
        !input->group_count || !input->max_blocks) {
        error = "GPU input must contain nonzero functions, blocks, cells, groups and max_blocks";
        return false;
    }
    if (!input->groups || !input->successor_offsets || !input->uses || !input->defs ||
        !input->phi_out || (input->edge_count && !input->successors)) {
        error = "GPU input contains a NULL array with a nonzero declared length";
        return false;
    }
    if (input->successor_offsets[0] != 0 ||
        input->successor_offsets[input->block_count] != input->edge_count) {
        error = "Successor offsets must begin at zero and end at edge_count";
        return false;
    }
    // Packed functions and their words are dense and ordered. Validate this
    // once per function to prevent overlaps, uncovered output, and CFG reads
    // outside the corresponding threadgroup scratch allocation.
    uint64_t next_block = 0, next_row = 0, functions = 0;
    largest = 0;
    for (uint64_t index = 0; index < input->group_count;) {
        const GPULabGroup &group = input->groups[index];
        if (!group.block_count || !group.words || group.word != 0 ||
            group.block_base != next_block || group.row_base != next_row ||
            group.words > input->group_count - index) {
            error = "Invalid dense function-word group at index " + std::to_string(index);
            return false;
        }
        const uint64_t end_block = next_block + group.block_count;
        const uint64_t end_row = next_row + uint64_t(group.block_count) * group.words;
        if (end_block > input->block_count || end_row > input->cell_count) {
            error = "Function group dimensions exceed the declared blocks or cells";
            return false;
        }
        for (uint64_t word = 0; word < group.words; ++word) {
            const GPULabGroup &current = input->groups[index + word];
            if (current.block_base != group.block_base || current.block_count != group.block_count ||
                current.row_base != group.row_base || current.words != group.words || current.word != word) {
                error = "Function-word groups are incomplete or overlapping";
                return false;
            }
        }
        for (uint64_t block = next_block; block < end_block; ++block) {
            const uint32_t begin = input->successor_offsets[block];
            const uint32_t end = input->successor_offsets[block + 1];
            if (begin > end || end > input->edge_count) {
                error = "Successor offsets are not monotonic or exceed edge_count";
                return false;
            }
            for (uint64_t edge = begin; edge < end; ++edge) {
                const uint32_t successor = input->successors[edge];
                if (successor < next_block || successor >= end_block) {
                    error = "CFG successor leaves its function at block " + std::to_string(block);
                    return false;
                }
            }
        }
        largest = std::max(largest, group.block_count);
        next_block = end_block;
        next_row = end_row;
        ++functions;
        index += group.words;
    }
    if (next_block != input->block_count || next_row != input->cell_count ||
        functions != input->function_count || largest > input->max_blocks) {
        error = "Group coverage disagrees with function_count, block_count, cell_count or max_blocks";
        return false;
    }
    return true;
}

bool ensure_buffer(Context &context, NSUInteger index, size_t bytes,
                   const char *label, std::string &error) {
    bytes = std::max(bytes, sizeof(uint32_t));
    if (bytes > context.device.maxBufferLength) {
        error = std::string(label) + " exceeds Metal maxBufferLength";
        return false;
    }
    if (context.capacities[index] >= bytes) return true;
    size_t capacity = std::max(context.capacities[index], sizeof(uint32_t));
    while (capacity < bytes && capacity <= context.device.maxBufferLength / 2) capacity *= 2;
    capacity = std::max(capacity, bytes);
    id<MTLBuffer> buffer = [context.device newBufferWithLength:capacity options:MTLResourceStorageModeShared];
    if (!buffer || !buffer.contents) {
        error = std::string("Metal buffer allocation failed for ") + label +
                " (" + std::to_string(capacity) + " bytes)";
        return false;
    }
    buffer.label = [NSString stringWithUTF8String:label];
    context.buffers[index] = buffer;
    context.capacities[index] = capacity;
    ++context.allocations;
    return true;
}

int submit(Context &context, const GPULabInput *input, char *err, size_t capacity) {
    std::lock_guard<std::mutex> lock(context.mutex);
    if (context.pending) {
        diagnostic(err, capacity, "Only one in-flight GPU pass per context is supported; finish the pending pass first");
        return -1;
    }
    const auto started = Clock::now();
    std::string error;
    uint32_t largest;
    if (!validate(input, largest, error)) { diagnostic(err, capacity, error); return -1; }
    const size_t scratch_bytes = (size_t(largest) * sizeof(uint32_t) + 15) & ~size_t(15);
    const size_t static_bytes = context.pipeline.staticThreadgroupMemoryLength;
    if (static_bytes > context.device.maxThreadgroupMemoryLength ||
        scratch_bytes > (context.device.maxThreadgroupMemoryLength - static_bytes) / 2) {
        diagnostic(err, capacity, "Function with " + std::to_string(largest) +
                   " blocks requires " + std::to_string(2 * scratch_bytes + static_bytes) +
                   " bytes of threadgroup memory; GPU limit is " +
                   std::to_string(context.device.maxThreadgroupMemoryLength));
        return -1;
    }
    const size_t sizes[9] = {
        size_t(input->group_count) * sizeof(GPULabGroup),
        (size_t(input->block_count) + 1) * sizeof(uint32_t),
        size_t(input->edge_count) * sizeof(uint32_t),
        size_t(input->cell_count) * sizeof(uint32_t),
        size_t(input->cell_count) * sizeof(uint32_t),
        size_t(input->cell_count) * sizeof(uint32_t),
        size_t(input->cell_count) * sizeof(uint32_t),
        size_t(input->group_count) * sizeof(uint32_t),
        size_t(input->group_count) * sizeof(uint32_t)
    };
    const char *labels[9] = {"function-word groups", "successor offsets", "CFG edges",
                            "local uses", "local defs", "phi edge uses", "live-in result",
                            "fixed-point sweeps", "convergence flags"};
    context.allocations = 0;
    for (NSUInteger index = 0; index < 9; ++index) {
        if (!ensure_buffer(context, index, sizes[index], labels[index], error)) {
            diagnostic(err, capacity, error); return -1;
        }
    }
    const void *sources[6] = {input->groups, input->successor_offsets, input->successors,
                              input->uses, input->defs, input->phi_out};
    for (NSUInteger index = 0; index < 6; ++index) {
        if (sizes[index]) std::memcpy(context.buffers[index].contents, sources[index], sizes[index]);
    }
    // Every output cell has exactly one writer. Reset status buffers so an
    // incomplete dispatch cannot pass convergence validation using old data.
    std::memset(context.buffers[7].contents, 0, sizes[7]);
    std::memset(context.buffers[8].contents, 0, sizes[8]);
    id<MTLCommandBuffer> command = [context.queue commandBuffer];
    if (!command) { diagnostic(err, capacity, "Metal command buffer creation failed"); return -1; }
    id<MTLComputeCommandEncoder> encoder = [command computeCommandEncoder];
    if (!encoder) { diagnostic(err, capacity, "Metal compute command encoder creation failed"); return -1; }
    command.label = @"Persistent native Rust IR liveness";
    encoder.label = @"Batched exact bitset fixed point";
    [encoder setComputePipelineState:context.pipeline];
    for (NSUInteger index = 0; index < 9; ++index) {
        [encoder setBuffer:context.buffers[index] offset:0 atIndex:index];
    }
    [encoder setThreadgroupMemoryLength:scratch_bytes atIndex:0];
    [encoder setThreadgroupMemoryLength:scratch_bytes atIndex:1];
    [encoder dispatchThreadgroups:MTLSizeMake(input->group_count, 1, 1)
           threadsPerThreadgroup:MTLSizeMake(context.threads, 1, 1)];
    [encoder endEncoding];
    context.started = started;
    context.cells = input->cell_count;
    context.groups = input->group_count;
    context.reused_pipeline = context.submitted_batches ? 1 : 0;
    context.pending = command;
    ++context.submitted_batches;
    [command commit];
    return 0;
}

int finish(Context &context, uint32_t *out, size_t out_count, GPULabStats *stats,
           char *err, size_t capacity) {
    std::lock_guard<std::mutex> lock(context.mutex);
    if (!context.pending) { diagnostic(err, capacity, "No in-flight GPU pass"); return -1; }
    if (!out || out_count < context.cells) {
        diagnostic(err, capacity, "Output buffer must contain at least " +
                   std::to_string(context.cells) + " uint32_t entries; pending pass retained");
        return -1;
    }
    id<MTLCommandBuffer> command = context.pending;
    [command waitUntilCompleted];
    context.pending = nil;
    if (command.status != MTLCommandBufferStatusCompleted) {
        diagnostic(err, capacity, metal_error("GPU command failed", command.error)); return -1;
    }
    const double gpu_ms = (command.GPUEndTime - command.GPUStartTime) * 1000.0;
    if (!std::isfinite(gpu_ms) || gpu_ms <= 0.0) {
        diagnostic(err, capacity, "GPU timestamps are unavailable; cannot verify GPU execution time");
        return -1;
    }
    const uint32_t *statuses = static_cast<const uint32_t *>(context.buffers[8].contents);
    const uint32_t *sweeps = static_cast<const uint32_t *>(context.buffers[7].contents);
    uint32_t max_sweeps = 0;
    for (uint32_t index = 0; index < context.groups; ++index) {
        if (statuses[index] != 1) {
            diagnostic(err, capacity, "GPU fixed point did not converge for group " + std::to_string(index));
            return -1;
        }
        max_sweeps = std::max(max_sweeps, sweeps[index]);
    }
    std::memcpy(out, context.buffers[6].contents, size_t(context.cells) * sizeof(uint32_t));
    if (stats) {
        stats->gpu_ms = gpu_ms;
        stats->total_ms = std::chrono::duration<double, std::milli>(Clock::now() - context.started).count();
        stats->max_sweeps = max_sweeps;
        stats->reused_pipeline = context.reused_pipeline;
        stats->buffer_allocations = context.allocations;
    }
    return 0;
}
} // namespace

extern "C" void *gpulab_create(const char *shader_path, char *err, size_t err_capacity) {
    @autoreleasepool {
        diagnostic(err, err_capacity, "");
        if (!shader_path || !*shader_path) {
            diagnostic(err, err_capacity, "Shader path must not be empty"); return nullptr;
        }
        try {
            NSString *path = [NSString stringWithUTF8String:shader_path];
            if (!path) { diagnostic(err, err_capacity, "Shader path is not UTF-8"); return nullptr; }
            NSError *error = nil;
            NSString *source = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:&error];
            if (!source) {
                diagnostic(err, err_capacity, metal_error("Could not read Metal shader", error)); return nullptr;
            }
            id<MTLDevice> device = MTLCreateSystemDefaultDevice();
            if (!device) { diagnostic(err, err_capacity, "No Metal GPU is available"); return nullptr; }
            id<MTLCommandQueue> queue = [device newCommandQueue];
            if (!queue) { diagnostic(err, err_capacity, "Metal command queue creation failed"); return nullptr; }
            id<MTLLibrary> library = [device newLibraryWithSource:source options:nil error:&error];
            if (!library) {
                diagnostic(err, err_capacity, metal_error("Metal shader compilation failed", error)); return nullptr;
            }
            id<MTLFunction> function = [library newFunctionWithName:@"liveness"];
            if (!function) { diagnostic(err, err_capacity, "Metal shader has no liveness kernel"); return nullptr; }
            id<MTLComputePipelineState> pipeline = [device newComputePipelineStateWithFunction:function error:&error];
            if (!pipeline) {
                diagnostic(err, err_capacity, metal_error("Metal pipeline creation failed", error)); return nullptr;
            }
            const NSUInteger width = pipeline.threadExecutionWidth;
            const NSUInteger limit = std::min(pipeline.maxTotalThreadsPerThreadgroup,
                                               device.maxThreadsPerThreadgroup.width);
            if (!width || width > limit) {
                diagnostic(err, err_capacity, "Metal pipeline cannot support one SIMD threadgroup"); return nullptr;
            }
            Context *context = new Context;
            context->device = device;
            context->queue = queue;
            context->library = library;
            context->pipeline = pipeline;
            context->threads = std::max(width, std::min(NSUInteger(64), limit) / width * width);
            return context;
        } catch (const std::exception &exception) {
            diagnostic(err, err_capacity, std::string("Native Metal context creation failed: ") + exception.what());
            return nullptr;
        }
    }
}

extern "C" int gpulab_submit(void *context, const GPULabInput *input,
                              char *err, size_t err_capacity) {
    @autoreleasepool {
        diagnostic(err, err_capacity, "");
        if (!context) { diagnostic(err, err_capacity, "GPU context is NULL"); return -1; }
        try { return submit(*static_cast<Context *>(context), input, err, err_capacity); }
        catch (const std::exception &exception) {
            diagnostic(err, err_capacity, std::string("Native Metal submit failed: ") + exception.what());
            return -1;
        }
    }
}

extern "C" int gpulab_finish(void *context, uint32_t *out, size_t out_count,
                              GPULabStats *stats, char *err, size_t err_capacity) {
    @autoreleasepool {
        diagnostic(err, err_capacity, "");
        if (stats) std::memset(stats, 0, sizeof(*stats));
        if (!context) { diagnostic(err, err_capacity, "GPU context is NULL"); return -1; }
        try { return finish(*static_cast<Context *>(context), out, out_count, stats, err, err_capacity); }
        catch (const std::exception &exception) {
            diagnostic(err, err_capacity, std::string("Native Metal finish failed: ") + exception.what());
            return -1;
        }
    }
}

extern "C" void gpulab_destroy(void *context) {
    @autoreleasepool {
        if (!context) return;
        Context *owned = static_cast<Context *>(context);
        if (owned->pending) [owned->pending waitUntilCompleted];
        delete owned;
    }
}
