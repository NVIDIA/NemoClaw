// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include "codegen_bridge.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <exception>
#include <mutex>
#include <string>
#include <vector>

static_assert(sizeof(GPUEmitInstruction) == 24 && offsetof(GPUEmitInstruction, immediate) == 16,
              "Instruction shader ABI changed");
static_assert(sizeof(GPUEmitFunction) == 16 && sizeof(GPUEmitStats) == 64,
              "Function or statistics ABI changed");

namespace {
using Clock = std::chrono::steady_clock;
constexpr uint64_t Budget = 512ULL * 1024 * 1024;
constexpr uint32_t MaxFunctions = 1024 * 1024;
constexpr uint32_t MaxInstructions = 16 * 1024 * 1024;
enum Buffer { Functions, Instructions, Lengths, Offsets, Output, Statuses, BufferCount };
struct Parameters { uint32_t functions, target, output_capacity, reserved; };

struct Context {
    id<MTLDevice> device;
    id<MTLCommandQueue> queue;
    id<MTLLibrary> library;
    id<MTLComputePipelineState> count_pipeline, emit_pipeline;
    id<MTLBuffer> buffers[BufferCount] = {};
    size_t capacities[BufferCount] = {};
    id<MTLCommandBuffer> pending;
    std::mutex mutex;
    Clock::time_point started;
    uint32_t functions = 0, target = 0, allocations = 0, reused = 0;
    size_t output_capacity = 0;
    uint64_t submitted = 0;
};

void diagnostic(char *error, size_t capacity, const std::string &message) {
    if (error && capacity) std::snprintf(error, capacity, "%s", message.c_str());
}

std::string metal_error(const char *operation, NSError *error) {
    return std::string(operation) + ": " +
           (error.localizedDescription.UTF8String ?: "Metal supplied no diagnostic");
}

bool validate(const GPUEmitInput *input, const std::vector<GPUEmitFunction> &functions,
              const std::vector<GPUEmitInstruction> &instructions, std::string &error) {
    if (input->target > 1 || input->reserved != 0) {
        error = "Target must be x86-64 SysV (0) or AArch64 (1), with reserved zero";
        return false;
    }
    uint64_t next = 0, maximum_output = 0;
    for (const auto &function : functions) {
        if (function.start != next || !function.count || function.count > 257 ||
            !function.values || function.values > 256 ||
            function.count > instructions.size() - next) {
            error = "Functions must densely cover instructions with 1..256 values and 1..257 operations";
            return false;
        }
        bool defined[256] = {};
        for (uint32_t position = 0; position < function.count; ++position) {
            const auto &instruction = instructions[size_t(next) + position];
            if (instruction.opcode > 6 ||
                ((instruction.opcode == 6) != (position + 1 == function.count))) {
                error = "Each function must end in its only return and use supported opcodes";
                return false;
            }
            const uint32_t count = instruction.opcode <= 1 ? 0 :
                                   (instruction.opcode == 2 || instruction.opcode == 6 ? 1 : 2);
            const uint32_t operands[2] = {instruction.a, instruction.b};
            for (uint32_t operand = 0; operand < count; ++operand) {
                if (operands[operand] >= function.values || !defined[operands[operand]]) {
                    error = "An instruction reads an undefined or out-of-range value";
                    return false;
                }
            }
            if (instruction.opcode != 6) {
                if (instruction.result >= function.values || defined[instruction.result]) {
                    error = "Instruction results must define distinct in-range values";
                    return false;
                }
                defined[instruction.result] = true;
            }
            if (instruction.opcode == 0 && instruction.immediate != 0) {
                error = "Only argument index zero is supported";
                return false;
            }
        }
        next += function.count;
        maximum_output += 12 + 25ULL * function.count;
    }
    if (next != instructions.size()) {
        error = "Function coverage does not match instruction_count";
        return false;
    }
    if (maximum_output > Budget || !input->output_capacity || input->output_capacity > Budget) {
        error = "Output capacity and worst-case output must fit the 512 MiB budget";
        return false;
    }
    return true;
}

bool ensure_buffer(Context &context, Buffer index, size_t bytes,
                   const char *label, std::string &error) {
    bytes = std::max(bytes, size_t(4));
    if (bytes > context.device.maxBufferLength || bytes > Budget) {
        error = std::string(label) + " exceeds the Metal buffer or experiment budget";
        return false;
    }
    if (context.capacities[index] >= bytes) return true;
    size_t capacity = std::max(context.capacities[index], size_t(4));
    const size_t maximum = std::min(size_t(context.device.maxBufferLength), size_t(Budget));
    while (capacity < bytes && capacity <= maximum / 2) capacity *= 2;
    capacity = std::max(capacity, bytes);
    id<MTLBuffer> buffer = [context.device newBufferWithLength:capacity
                                      options:MTLResourceStorageModeShared];
    if (!buffer || !buffer.contents) {
        error = std::string("Could not allocate Metal buffer for ") + label;
        return false;
    }
    buffer.label = [NSString stringWithUTF8String:label];
    context.buffers[index] = buffer;
    context.capacities[index] = capacity;
    ++context.allocations;
    return true;
}

void dispatch(id<MTLComputeCommandEncoder> encoder, id<MTLComputePipelineState> pipeline,
              uint32_t functions) {
    const NSUInteger threads = std::max(NSUInteger(1),
        std::min(pipeline.threadExecutionWidth, pipeline.maxTotalThreadsPerThreadgroup));
    [encoder dispatchThreads:MTLSizeMake(functions, 1, 1)
       threadsPerThreadgroup:MTLSizeMake(threads, 1, 1)];
}

bool completed(id<MTLCommandBuffer> command, double &gpu_ms, std::string &error) {
    [command waitUntilCompleted];
    if (command.status != MTLCommandBufferStatusCompleted) {
        error = metal_error("Metal code generation command failed", command.error);
        return false;
    }
    gpu_ms = (command.GPUEndTime - command.GPUStartTime) * 1000.0;
    if (!std::isfinite(gpu_ms) || gpu_ms <= 0) {
        error = "Metal GPU timestamps are unavailable; physical execution time is unverified";
        return false;
    }
    return true;
}

int submit(Context &context, const GPUEmitInput *input, char *error, size_t capacity) {
    std::lock_guard<std::mutex> lock(context.mutex);
    if (context.pending) {
        diagnostic(error, capacity, "One request is already pending; finish it before submitting another");
        return -1;
    }
    const auto started = Clock::now();
    if (!input || !input->functions || !input->instructions || !input->function_count ||
        !input->instruction_count || input->function_count > MaxFunctions ||
        input->instruction_count > MaxInstructions) {
        diagnostic(error, capacity, "Input arrays/counts must be nonempty and within the declared budgets");
        return -1;
    }
    // Validate an owned snapshot and then copy that same snapshot into device-
    // owned shared buffers. Caller mutation after submit cannot change work.
    const std::vector<GPUEmitFunction> functions(input->functions,
                                                input->functions + input->function_count);
    const std::vector<GPUEmitInstruction> instructions(input->instructions,
                                                      input->instructions + input->instruction_count);
    std::string detail;
    if (!validate(input, functions, instructions, detail)) {
        diagnostic(error, capacity, detail); return -1;
    }
    const size_t bytes[BufferCount] = {
        functions.size() * sizeof(GPUEmitFunction), instructions.size() * sizeof(GPUEmitInstruction),
        functions.size() * sizeof(uint32_t), functions.size() * sizeof(uint32_t),
        size_t(input->output_capacity), functions.size() * sizeof(uint32_t)
    };
    const char *labels[BufferCount] = {"codegen functions", "codegen instructions", "GPU code lengths",
                                     "CPU exclusive offsets", "GPU machine code", "GPU emit status"};
    context.allocations = 0;
    for (uint32_t index = 0; index < BufferCount; ++index) {
        if (!ensure_buffer(context, Buffer(index), bytes[index], labels[index], detail)) {
            diagnostic(error, capacity, detail); return -1;
        }
    }
    std::memcpy(context.buffers[Functions].contents, functions.data(), bytes[Functions]);
    std::memcpy(context.buffers[Instructions].contents, instructions.data(), bytes[Instructions]);
    std::memset(context.buffers[Lengths].contents, 0, bytes[Lengths]);
    std::memset(context.buffers[Statuses].contents, 0, bytes[Statuses]);
    id<MTLCommandBuffer> command = [context.queue commandBuffer];
    if (!command) { diagnostic(error, capacity, "Could not create GPU count command"); return -1; }
    id<MTLComputeCommandEncoder> encoder = [command computeCommandEncoder];
    if (!encoder) { diagnostic(error, capacity, "Could not create GPU count encoder"); return -1; }
    command.label = @"GPU baseline machine-code size counting";
    [encoder setComputePipelineState:context.count_pipeline];
    [encoder setBuffer:context.buffers[Functions] offset:0 atIndex:0];
    [encoder setBuffer:context.buffers[Instructions] offset:0 atIndex:1];
    [encoder setBuffer:context.buffers[Lengths] offset:0 atIndex:2];
    const Parameters parameters = {input->function_count, input->target, uint32_t(input->output_capacity), 0};
    [encoder setBytes:&parameters length:sizeof(parameters) atIndex:3];
    dispatch(encoder, context.count_pipeline, input->function_count);
    [encoder endEncoding];
    context.functions = input->function_count;
    context.target = input->target;
    context.output_capacity = size_t(input->output_capacity);
    context.started = started;
    context.reused = context.submitted ? 1 : 0;
    context.pending = command;
    ++context.submitted;
    [command commit];
    return 0;
}

int finish(Context &context, uint8_t *output, size_t output_capacity,
           uint32_t *offsets, uint32_t *lengths, size_t function_count,
           GPUEmitStats *stats, char *error, size_t capacity) {
    std::lock_guard<std::mutex> lock(context.mutex);
    if (!context.pending) { diagnostic(error, capacity, "No pending code generation request"); return -1; }
    if (!output || output_capacity < context.output_capacity || !offsets || !lengths ||
        function_count < context.functions) {
        diagnostic(error, capacity, "Output/offset/length buffers are short or NULL; pending request retained");
        return -1;
    }
    std::string detail;
    double count_gpu_ms = 0, emit_gpu_ms = 0;
    if (!completed(context.pending, count_gpu_ms, detail)) {
        context.pending = nil; diagnostic(error, capacity, detail); return -1;
    }
    const auto prefix_started = Clock::now();
    const uint32_t *gpu_lengths = static_cast<const uint32_t *>(context.buffers[Lengths].contents);
    uint32_t *host_offsets = static_cast<uint32_t *>(context.buffers[Offsets].contents);
    const auto *functions = static_cast<const GPUEmitFunction *>(context.buffers[Functions].contents);
    uint64_t total = 0;
    for (uint32_t index = 0; index < context.functions; ++index) {
        if (!gpu_lengths[index] || gpu_lengths[index] > 12 + 25ULL * functions[index].count ||
            gpu_lengths[index] > context.output_capacity - total) {
            context.pending = nil;
            diagnostic(error, capacity, "GPU counts exceed the declared output capacity or function budget");
            return -1;
        }
        host_offsets[index] = uint32_t(total);
        total += gpu_lengths[index];
    }
    const double prefix_ms = std::chrono::duration<double, std::milli>(Clock::now() - prefix_started).count();
    // Prefix offsets are a CPU stage in this implementation. Actual lengths
    // originate in the count kernel; the emit kernel produces every code byte.
    id<MTLCommandBuffer> command = [context.queue commandBuffer];
    if (!command) { context.pending = nil; diagnostic(error, capacity, "Could not create GPU emit command"); return -1; }
    id<MTLComputeCommandEncoder> encoder = [command computeCommandEncoder];
    if (!encoder) { context.pending = nil; diagnostic(error, capacity, "Could not create GPU emit encoder"); return -1; }
    command.label = @"GPU baseline native machine-code emission";
    [encoder setComputePipelineState:context.emit_pipeline];
    [encoder setBuffer:context.buffers[Functions] offset:0 atIndex:0];
    [encoder setBuffer:context.buffers[Instructions] offset:0 atIndex:1];
    [encoder setBuffer:context.buffers[Offsets] offset:0 atIndex:2];
    [encoder setBuffer:context.buffers[Lengths] offset:0 atIndex:3];
    [encoder setBuffer:context.buffers[Output] offset:0 atIndex:4];
    [encoder setBuffer:context.buffers[Statuses] offset:0 atIndex:5];
    const Parameters parameters = {context.functions, context.target, uint32_t(context.output_capacity), 0};
    [encoder setBytes:&parameters length:sizeof(parameters) atIndex:6];
    dispatch(encoder, context.emit_pipeline, context.functions);
    [encoder endEncoding];
    context.pending = command;
    [command commit];
    const bool success = completed(command, emit_gpu_ms, detail);
    context.pending = nil;
    if (!success) { diagnostic(error, capacity, detail); return -1; }
    const uint32_t *statuses = static_cast<const uint32_t *>(context.buffers[Statuses].contents);
    for (uint32_t index = 0; index < context.functions; ++index) {
        if (statuses[index] != 1) {
            diagnostic(error, capacity, "GPU emission did not match its counted function length");
            return -1;
        }
    }
    std::memcpy(output, context.buffers[Output].contents, size_t(total));
    std::memcpy(offsets, host_offsets, size_t(context.functions) * sizeof(uint32_t));
    std::memcpy(lengths, gpu_lengths, size_t(context.functions) * sizeof(uint32_t));
    if (stats) {
        stats->gpu_ms = count_gpu_ms + emit_gpu_ms;
        stats->count_gpu_ms = count_gpu_ms;
        stats->emit_gpu_ms = emit_gpu_ms;
        stats->host_prefix_ms = prefix_ms;
        stats->total_ms = std::chrono::duration<double, std::milli>(Clock::now() - context.started).count();
        stats->kernel_dispatches = 2;
        stats->output_bytes = total;
        stats->buffer_allocations = context.allocations;
        stats->reused_pipeline = context.reused;
    }
    return 0;
}
} // namespace

extern "C" void *gpuemit_create(const char *shader_path, uint32_t device_index,
                               char *error, size_t capacity) {
    @autoreleasepool {
        diagnostic(error, capacity, "");
        if (!shader_path || !*shader_path) {
            diagnostic(error, capacity, "Metal shader path is required"); return nullptr;
        }
        try {
            NSArray<id<MTLDevice>> *devices = MTLCopyAllDevices();
            if (device_index >= devices.count) {
                diagnostic(error, capacity, "Metal device index is unavailable; physical device count is " + std::to_string(devices.count));
                return nullptr;
            }
            id<MTLDevice> device = devices[device_index];
            NSError *detail = nil;
            NSString *path = [NSString stringWithUTF8String:shader_path];
            if (!path) { diagnostic(error, capacity, "Shader path is not UTF-8"); return nullptr; }
            NSString *source = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:&detail];
            if (!source) { diagnostic(error, capacity, metal_error("Could not read codegen shader", detail)); return nullptr; }
            id<MTLLibrary> library = [device newLibraryWithSource:source options:nil error:&detail];
            if (!library) { diagnostic(error, capacity, metal_error("Could not compile codegen shader", detail)); return nullptr; }
            id<MTLFunction> count = [library newFunctionWithName:@"gpuemit_count"];
            id<MTLFunction> emit = [library newFunctionWithName:@"gpuemit_emit"];
            if (!count || !emit) { diagnostic(error, capacity, "Shader must expose gpuemit_count and gpuemit_emit"); return nullptr; }
            id<MTLComputePipelineState> count_pipeline = [device newComputePipelineStateWithFunction:count error:&detail];
            if (!count_pipeline) { diagnostic(error, capacity, metal_error("Could not create count pipeline", detail)); return nullptr; }
            id<MTLComputePipelineState> emit_pipeline = [device newComputePipelineStateWithFunction:emit error:&detail];
            if (!emit_pipeline) { diagnostic(error, capacity, metal_error("Could not create emit pipeline", detail)); return nullptr; }
            id<MTLCommandQueue> queue = [device newCommandQueue];
            if (!queue) { diagnostic(error, capacity, "Could not create Metal codegen queue"); return nullptr; }
            Context *context = new Context;
            context->device = device; context->queue = queue; context->library = library;
            context->count_pipeline = count_pipeline; context->emit_pipeline = emit_pipeline;
            return context;
        } catch (const std::exception &exception) {
            diagnostic(error, capacity, std::string("Metal creation failed: ") + exception.what());
            return nullptr;
        }
    }
}

extern "C" int gpuemit_device_id(void *context, char *output, size_t capacity) {
    @autoreleasepool {
        if (!context || !output || !capacity) return -1;
        const auto *owned = static_cast<Context *>(context);
        const int bytes = std::snprintf(output, capacity, "metal:%016llx:%s",
            static_cast<unsigned long long>(owned->device.registryID), owned->device.name.UTF8String ?: "unknown");
        return bytes >= 0 && size_t(bytes) < capacity ? 0 : -1;
    }
}

extern "C" int gpuemit_submit(void *context, const GPUEmitInput *input, char *error, size_t capacity) {
    @autoreleasepool {
        diagnostic(error, capacity, "");
        if (!context) { diagnostic(error, capacity, "Metal codegen context is NULL"); return -1; }
        try { return submit(*static_cast<Context *>(context), input, error, capacity); }
        catch (const std::exception &exception) {
            diagnostic(error, capacity, std::string("Metal submission failed: ") + exception.what()); return -1;
        }
    }
}

extern "C" int gpuemit_finish(void *context, uint8_t *output, size_t output_capacity,
    uint32_t *offsets, uint32_t *lengths, size_t function_count,
    GPUEmitStats *stats, char *error, size_t capacity) {
    @autoreleasepool {
        diagnostic(error, capacity, "");
        if (stats) std::memset(stats, 0, sizeof(*stats));
        if (!context) { diagnostic(error, capacity, "Metal codegen context is NULL"); return -1; }
        try { return finish(*static_cast<Context *>(context), output, output_capacity,
                            offsets, lengths, function_count, stats, error, capacity); }
        catch (const std::exception &exception) {
            diagnostic(error, capacity, std::string("Metal finish failed: ") + exception.what()); return -1;
        }
    }
}

extern "C" void gpuemit_destroy(void *context) {
    @autoreleasepool {
        if (!context) return;
        auto *owned = static_cast<Context *>(context);
        {
            std::lock_guard<std::mutex> lock(owned->mutex);
            if (owned->pending) [owned->pending waitUntilCompleted];
            owned->pending = nil;
        }
        delete owned;
    }
}
