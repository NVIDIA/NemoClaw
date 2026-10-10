// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Schema-1 scalar machine-code emission fixture, not a complete Rust backend.
// Each CUDA thread counts/emits one independent straight-line leaf function.
// Counts and the CUB prefix scan remain device-owned. Host validation, capture,
// transfers, completion, and copying the actual written output are timed.

#include "codegen_bridge.h"
#include <cuda_runtime.h>
#include <cub/device/device_scan.cuh>
#include <algorithm>
#include <chrono>
#include <climits>
#include <cstdio>
#include <cstring>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
using Clock = std::chrono::steady_clock;
using U32 = uint32_t;
constexpr size_t kStorageBudget = 512 * 1024 * 1024;
constexpr U32 kThreads = 128;
static_assert(sizeof(GPUEmitInstruction) == 24, "instruction ABI changed");
static_assert(sizeof(GPUEmitFunction) == 16, "function ABI changed");
static_assert(sizeof(GPUEmitStats) == 64, "timing ABI changed");

void diagnostic(char *output, size_t capacity, const char *message) {
    if (output && capacity) std::snprintf(output, capacity, "%s", message);
}
void check(cudaError_t status, const char *operation) {
    if (status != cudaSuccess)
        throw std::runtime_error(std::string(operation) + ": " + cudaGetErrorString(status));
}
double elapsed(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}
size_t array_bytes(U32 count, size_t element_size) {
    if (count > std::numeric_limits<size_t>::max() / element_size)
        throw std::runtime_error("array size overflows host address space");
    const size_t bytes = size_t(count) * element_size;
    if (bytes > kStorageBudget)
        throw std::runtime_error("scalar emission array exceeds 512 MiB storage budget");
    return bytes;
}

// Rust's independently implemented emit_function is the byte oracle.
__device__ U32 instruction_size(U32 opcode, U32 target) {
    if (target == 0) {
        switch (opcode) {
            case 0: return 7;   // argument -> stack home
            case 1: return 17;  // movabs + store
            case 2: return 14;  // load + store
            case 3: case 4: return 24;
            case 5: return 25;
            case 6: return 9;
        }
    } else {
        switch (opcode) {
            case 0: return 4;
            case 1: return 20;  // MOVZ + three MOVKs + store
            case 2: return 8;
            case 3: case 4: case 5: return 16;
            case 6: return 16;
        }
    }
    return 0; // Host rejects unsupported opcodes before launching.
}

__global__ void count_functions(const GPUEmitFunction *functions,
                               const GPUEmitInstruction *instructions,
                               U32 function_count, U32 target, U32 *lengths) {
    const U32 index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= function_count) return;
    const GPUEmitFunction function = functions[index];
    U32 size = target == 0 ? 11 : 12;
    for (U32 offset = 0; offset < function.count; ++offset)
        size += instruction_size(instructions[function.start + offset].opcode, target);
    lengths[index] = size;
}

__device__ void byte(uint8_t *output, U32 &cursor, uint8_t value) {
    output[cursor++] = value;
}
__device__ void word(uint8_t *output, U32 &cursor, U32 value) {
    for (U32 part = 0; part < 4; ++part) byte(output, cursor, uint8_t(value >> (part * 8)));
}
__device__ void x86_home(uint8_t *output, U32 &cursor,
                        uint8_t first, uint8_t second, uint8_t third, U32 slot) {
    byte(output, cursor, first); byte(output, cursor, second); byte(output, cursor, third);
    word(output, cursor, U32(-8 * (int(slot) + 1)));
}

__device__ void emit_x86(uint8_t *output, const GPUEmitFunction &function,
                        const GPUEmitInstruction *instructions) {
    U32 cursor = 0;
    const U32 frame = (function.values * 8 + 15) & ~U32(15);
    byte(output, cursor, 0x55);
    byte(output, cursor, 0x48); byte(output, cursor, 0x89); byte(output, cursor, 0xe5);
    byte(output, cursor, 0x48); byte(output, cursor, 0x81); byte(output, cursor, 0xec);
    word(output, cursor, frame);
    for (U32 offset = 0; offset < function.count; ++offset) {
        const GPUEmitInstruction instruction = instructions[function.start + offset];
        switch (instruction.opcode) {
            case 0:
                x86_home(output, cursor, 0x48, 0x89, 0xbd, instruction.result);
                break;
            case 1: {
                byte(output, cursor, 0x48); byte(output, cursor, 0xb8);
                const uint64_t value = uint64_t(instruction.immediate);
                for (U32 part = 0; part < 8; ++part)
                    byte(output, cursor, uint8_t(value >> (part * 8)));
                x86_home(output, cursor, 0x48, 0x89, 0x85, instruction.result);
                break;
            }
            case 2:
                x86_home(output, cursor, 0x48, 0x8b, 0x85, instruction.a);
                x86_home(output, cursor, 0x48, 0x89, 0x85, instruction.result);
                break;
            case 3: case 4: case 5:
                x86_home(output, cursor, 0x48, 0x8b, 0x85, instruction.a);
                x86_home(output, cursor, 0x4c, 0x8b, 0x95, instruction.b);
                if (instruction.opcode == 5) {
                    byte(output, cursor, 0x49); byte(output, cursor, 0x0f);
                    byte(output, cursor, 0xaf); byte(output, cursor, 0xc2);
                } else {
                    byte(output, cursor, 0x4c);
                    byte(output, cursor, instruction.opcode == 3 ? 0x01 : 0x29);
                    byte(output, cursor, 0xd0);
                }
                x86_home(output, cursor, 0x48, 0x89, 0x85, instruction.result);
                break;
            case 6:
                x86_home(output, cursor, 0x48, 0x8b, 0x85, instruction.a);
                byte(output, cursor, 0xc9); byte(output, cursor, 0xc3);
                break;
        }
    }
}

__device__ void emit_arm(uint8_t *output, const GPUEmitFunction &function,
                        const GPUEmitInstruction *instructions) {
    U32 cursor = 0;
    const U32 frame = (function.values * 8 + 15) & ~U32(15);
    word(output, cursor, 0xa9bf7bfd);
    word(output, cursor, 0x910003fd);
    word(output, cursor, 0xd10003ff | (frame << 10));
    for (U32 offset = 0; offset < function.count; ++offset) {
        const GPUEmitInstruction instruction = instructions[function.start + offset];
        switch (instruction.opcode) {
            case 0:
                word(output, cursor, 0xf90003e0 | (instruction.result << 10));
                break;
            case 1: {
                const uint64_t value = uint64_t(instruction.immediate);
                for (U32 part = 0; part < 4; ++part)
                    word(output, cursor, (part == 0 ? 0xd2800009 : 0xf2800009)
                         | (part << 21) | (U32((value >> (part * 16)) & 0xffff) << 5));
                word(output, cursor, 0xf90003e9 | (instruction.result << 10));
                break;
            }
            case 2:
                word(output, cursor, 0xf94003e9 | (instruction.a << 10));
                word(output, cursor, 0xf90003e9 | (instruction.result << 10));
                break;
            case 3: case 4: case 5:
                word(output, cursor, 0xf94003e9 | (instruction.a << 10));
                word(output, cursor, 0xf94003ea | (instruction.b << 10));
                word(output, cursor, instruction.opcode == 3 ? 0x8b0a0129
                     : instruction.opcode == 4 ? 0xcb0a0129 : 0x9b0a7d29);
                word(output, cursor, 0xf90003e9 | (instruction.result << 10));
                break;
            case 6:
                word(output, cursor, 0xf94003e0 | (instruction.a << 10));
                word(output, cursor, 0x910003bf);
                word(output, cursor, 0xa8c17bfd);
                word(output, cursor, 0xd65f03c0);
                break;
        }
    }
}

__global__ void emit_functions(const GPUEmitFunction *functions,
                              const GPUEmitInstruction *instructions,
                              const U32 *offsets, U32 function_count,
                              U32 target, uint8_t *output) {
    const U32 index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index >= function_count) return;
    uint8_t *destination = output + offsets[index];
    if (target == 0) emit_x86(destination, functions[index], instructions);
    else emit_arm(destination, functions[index], instructions);
}

// Every array grows only while no request is pending. Inputs are captured into
// pinned storage before submit returns, so callers can release their packets.
struct Buffer {
    void *device = nullptr;
    void *host = nullptr;
    size_t capacity = 0;
    ~Buffer() { if (device) cudaFree(device); if (host) cudaFreeHost(host); }
    void abandon() { device = nullptr; host = nullptr; capacity = 0; }
    void ensure(size_t bytes, GPUEmitStats &stats, bool pinned = true) {
        if (bytes <= capacity) return;
        if (bytes > kStorageBudget) throw std::runtime_error("buffer exceeds 512 MiB budget");
        const size_t grown = std::min(kStorageBudget, std::max(bytes, capacity * 2));
        void *new_device = nullptr, *new_host = nullptr;
        check(cudaMalloc(&new_device, grown), "allocate device emission buffer");
        ++stats.buffer_allocations;
        try {
            if (pinned) {
                check(cudaHostAlloc(&new_host, grown, cudaHostAllocDefault), "allocate pinned emission staging");
                ++stats.buffer_allocations;
            }
        } catch (...) { cudaFree(new_device); throw; }
        void *old_device = device, *old_host = host;
        device = new_device; host = new_host; capacity = grown;
        if (old_device) check(cudaFree(old_device), "release prior emission buffer");
        if (old_host) check(cudaFreeHost(old_host), "release prior pinned staging");
    }
    template<class T> T *gpu() { return static_cast<T *>(device); }
    template<class T> T *cpu() { return static_cast<T *>(host); }
    void upload(size_t bytes, cudaStream_t stream) {
        check(cudaMemcpyAsync(device, host, bytes, cudaMemcpyHostToDevice, stream), "upload captured emission input");
    }
    void download(size_t bytes, cudaStream_t stream) {
        if (bytes) check(cudaMemcpyAsync(host, device, bytes, cudaMemcpyDeviceToHost, stream), "download initialized emission output");
    }
};

struct Context {
    int device = 0;
    cudaStream_t stream = nullptr;
    cudaEvent_t begin = nullptr, counted = nullptr, scanned = nullptr;
    cudaEvent_t emitted = nullptr, metadata_ready = nullptr;
    Buffer functions, instructions, lengths, offsets, output, scan_storage;
    std::string identity;
    GPUEmitStats stats{};
    Clock::time_point start;
    U32 function_count = 0;
    U32 max_grid_x = 0;
    size_t output_capacity = 0;
    uint64_t submissions = 0;
    bool pending = false, poisoned = false;

    // Failed synchronization is not used as proof that host staging is safe to
    // free. An unresolved failed context leaks its owned allocations rather
    // than freeing storage still potentially used by a kernel or DMA operation.
    bool quiesce() noexcept {
        if (cudaSetDevice(device) != cudaSuccess) { poisoned = true; return false; }
        if (stream && cudaStreamSynchronize(stream) != cudaSuccess) { poisoned = true; return false; }
        pending = false;
        return true;
    }
    ~Context() {
        if (!quiesce()) {
            functions.abandon(); instructions.abandon(); lengths.abandon();
            offsets.abandon(); output.abandon(); scan_storage.abandon();
            return;
        }
        for (cudaEvent_t event : {begin, counted, scanned, emitted, metadata_ready})
            if (event) cudaEventDestroy(event);
        if (stream) cudaStreamDestroy(stream);
    }
    void select() {
        check(cudaSetDevice(device), "select owning CUDA emission device");
        if (poisoned) throw std::runtime_error("CUDA emission context is poisoned after an unresolved device failure");
    }
};

void validate_dimensions(const GPUEmitInput &input) {
    if (input.reserved != 0 || input.target > 1 || input.function_count == 0
        || input.instruction_count == 0 || input.function_count > U32(INT_MAX)
        || !input.functions || !input.instructions)
        throw std::runtime_error("invalid scalar emission dimensions, target, reserved field, or input pointer");
    array_bytes(input.function_count, sizeof(GPUEmitFunction));
    array_bytes(input.instruction_count, sizeof(GPUEmitInstruction));
    const uint64_t bound = 12ULL * input.function_count + 25ULL * input.instruction_count;
    if (input.output_capacity < bound || input.output_capacity > kStorageBudget)
        throw std::runtime_error("output capacity must cover the bounded scalar emission plan and fit 512 MiB");
}

void validate(const GPUEmitInput &input) {
    std::vector<uint8_t> symbols(input.function_count, 0);
    uint64_t next = 0;
    for (U32 index = 0; index < input.function_count; ++index) {
        const GPUEmitFunction &function = input.functions[index];
        const uint64_t end = uint64_t(function.start) + function.count;
        if (function.start != next || function.count == 0 || end > input.instruction_count
            || function.values == 0 || function.values > 256 || function.values > function.count
            || function.symbol >= input.function_count || symbols[function.symbol]++)
            throw std::runtime_error("function ranges, symbols, or scalar frame are invalid");
        bool defined[256] = {};
        U32 definitions = 0;
        for (U32 offset = 0; offset < function.count; ++offset) {
            const GPUEmitInstruction &instruction = input.instructions[function.start + offset];
            if (instruction.opcode > 6 || ((instruction.opcode == 6) != (offset + 1 == function.count)))
                throw std::runtime_error("function must end with its only Return and use supported opcodes");
            const U32 operands = instruction.opcode <= 1 ? 0 : instruction.opcode == 2 || instruction.opcode == 6 ? 1 : 2;
            if ((operands >= 1 && (instruction.a >= function.values || !defined[instruction.a]))
                || (operands == 2 && (instruction.b >= function.values || !defined[instruction.b])))
                throw std::runtime_error("instruction reads an undefined scalar value");
            if ((operands == 0 && instruction.a != 0) || (operands < 2 && instruction.b != 0)
                || (instruction.opcode != 1 && instruction.immediate != 0))
                throw std::runtime_error("unused instruction operands must be zero; only argument zero is supported");
            if (instruction.opcode == 6) {
                if (instruction.result != UINT32_MAX)
                    throw std::runtime_error("Return cannot define a scalar value");
            } else {
                if (instruction.result >= function.values || defined[instruction.result])
                    throw std::runtime_error("instruction result is invalid or already defined");
                defined[instruction.result] = true;
                ++definitions;
            }
        }
        if (definitions != function.values)
            throw std::runtime_error("scalar frame contains undefined value slots");
        next = end;
    }
    if (next != input.instruction_count)
        throw std::runtime_error("instruction array has records outside function ranges");
}
float event_ms(cudaEvent_t begin, cudaEvent_t end) {
    float milliseconds = 0;
    check(cudaEventElapsedTime(&milliseconds, begin, end), "measure CUDA emission event interval");
    return milliseconds;
}
} // namespace

extern "C" void *gpuemit_create(const char *, U32 device_index, char *error, size_t capacity) {
    try {
        if (device_index > U32(INT_MAX)) throw std::runtime_error("CUDA device index is out of range");
        int count = 0;
        check(cudaGetDeviceCount(&count), "enumerate physical CUDA devices");
        if (device_index >= U32(count)) throw std::runtime_error("requested CUDA emission device is unavailable");
        std::unique_ptr<Context> context(new Context);
        context->device = int(device_index);
        context->select();
        cudaDeviceProp properties{};
        check(cudaGetDeviceProperties(&properties, context->device), "read physical CUDA device properties and UUID");
        context->max_grid_x = U32(properties.maxGridSize[0]);
        char identity[64] = {};
        const auto *u = reinterpret_cast<const unsigned char *>(properties.uuid.bytes);
        std::snprintf(identity, sizeof(identity),
            "CUDA:%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
            u[0],u[1],u[2],u[3],u[4],u[5],u[6],u[7],u[8],u[9],u[10],u[11],u[12],u[13],u[14],u[15]);
        context->identity = identity;
        check(cudaStreamCreateWithFlags(&context->stream, cudaStreamNonBlocking), "create persistent emission stream");
        for (cudaEvent_t *event : {&context->begin, &context->counted, &context->scanned,
                                 &context->emitted, &context->metadata_ready})
            check(cudaEventCreate(event), "create persistent emission timing event");
        diagnostic(error, capacity, "");
        return context.release();
    } catch (const std::exception &e) { diagnostic(error, capacity, e.what()); return nullptr; }
}

extern "C" int gpuemit_device_id(void *pointer, char *output, size_t capacity) {
    if (!pointer || !output || capacity == 0) return -1;
    auto &context = *static_cast<Context *>(pointer);
    try {
        context.select();
        if (capacity <= context.identity.size()) { output[0] = '\0'; return -1; }
        std::memcpy(output, context.identity.c_str(), context.identity.size() + 1);
        return 0;
    } catch (const std::exception &e) { diagnostic(output, capacity, e.what()); return -1; }
}

extern "C" int gpuemit_submit(void *pointer, const GPUEmitInput *input, char *error, size_t capacity) {
    if (!pointer || !input) { diagnostic(error, capacity, "null CUDA emission context or input"); return -1; }
    auto &context = *static_cast<Context *>(pointer);
    try {
        const auto entry_time = Clock::now();
        context.select();
        // This error must not cancel the already submitted request.
        if (context.pending) { diagnostic(error, capacity, "a CUDA emission request is already pending"); return -1; }
        context.start = entry_time;
        validate_dimensions(*input);
        const U32 blocks = (input->function_count + kThreads - 1) / kThreads;
        if (blocks > context.max_grid_x) throw std::runtime_error("emission batch exceeds this device's kernel grid capacity");
        context.stats = {};
        context.stats.reused_pipeline = context.submissions != 0;
        const size_t function_bytes = array_bytes(input->function_count, sizeof(GPUEmitFunction));
        const size_t instruction_bytes = array_bytes(input->instruction_count, sizeof(GPUEmitInstruction));
        const size_t index_bytes = array_bytes(input->function_count, sizeof(U32));
        context.functions.ensure(function_bytes, context.stats);
        context.instructions.ensure(instruction_bytes, context.stats);
        context.lengths.ensure(index_bytes, context.stats);
        context.offsets.ensure(index_bytes, context.stats);
        context.output.ensure(size_t(input->output_capacity), context.stats);
        size_t scan_bytes = 0;
        check(cub::DeviceScan::ExclusiveSum(nullptr, scan_bytes,
            context.lengths.gpu<U32>(), context.offsets.gpu<U32>(), int(input->function_count), context.stream), "size CUB device prefix scan");
        // CUB's null pointer denotes the size-query mode even if a future scan
        // implementation needs no scratch bytes. Execute with a nonnull pointer.
        context.scan_storage.ensure(std::max(size_t(1), scan_bytes), context.stats, false);
        std::memcpy(context.functions.host, input->functions, function_bytes);
        std::memcpy(context.instructions.host, input->instructions, instruction_bytes);
        GPUEmitInput snapshot = *input;
        snapshot.functions = context.functions.cpu<GPUEmitFunction>();
        snapshot.instructions = context.instructions.cpu<GPUEmitInstruction>();
        // Validate the captured records that the GPU will actually consume,
        // rather than rereading caller storage between validation and upload.
        validate(snapshot);
        context.function_count = input->function_count;
        context.output_capacity = size_t(input->output_capacity);
        context.pending = true;
        context.functions.upload(function_bytes, context.stream);
        context.instructions.upload(instruction_bytes, context.stream);
        check(cudaEventRecord(context.begin, context.stream), "record emission kernel start");
        count_functions<<<blocks, kThreads, 0, context.stream>>>(
            context.functions.gpu<GPUEmitFunction>(), context.instructions.gpu<GPUEmitInstruction>(),
            input->function_count, input->target, context.lengths.gpu<U32>());
        check(cudaGetLastError(), "launch scalar instruction-count kernel");
        check(cudaEventRecord(context.counted, context.stream), "record instruction-count completion");
        check(cub::DeviceScan::ExclusiveSum(context.scan_storage.device, scan_bytes,
            context.lengths.gpu<U32>(), context.offsets.gpu<U32>(), int(input->function_count), context.stream), "scan function emission offsets on device");
        check(cudaEventRecord(context.scanned, context.stream), "record prefix-scan completion");
        emit_functions<<<blocks, kThreads, 0, context.stream>>>(
            context.functions.gpu<GPUEmitFunction>(), context.instructions.gpu<GPUEmitInstruction>(),
            context.offsets.gpu<U32>(), input->function_count, input->target, context.output.gpu<uint8_t>());
        check(cudaGetLastError(), "launch scalar machine-code emission kernel");
        check(cudaEventRecord(context.emitted, context.stream), "record machine-code emission completion");
        context.lengths.download(index_bytes, context.stream);
        context.offsets.download(index_bytes, context.stream);
        check(cudaEventRecord(context.metadata_ready, context.stream), "record emission-length download completion");
        // Counts only the two explicit application kernels. CUB may internally
        // launch additional kernels, all included in gpu_ms, not in this count.
        context.stats.kernel_dispatches = 2;
        ++context.submissions;
        diagnostic(error, capacity, "");
        return 0;
    } catch (const std::exception &e) {
        if (context.pending) context.quiesce();
        diagnostic(error, capacity, e.what());
        return -1;
    }
}

extern "C" int gpuemit_finish(void *pointer, uint8_t *output, size_t output_capacity,
    U32 *offsets, U32 *lengths, size_t function_count,
    GPUEmitStats *stats, char *error, size_t capacity) {
    if (!pointer) { diagnostic(error, capacity, "null CUDA emission context"); return -1; }
    auto &context = *static_cast<Context *>(pointer);
    try {
        context.select();
        if (!context.pending) { diagnostic(error, capacity, "no CUDA emission request is pending"); return -1; }
        // A malformed result destination leaves the request intact for retry.
        if (!output || !offsets || !lengths || !stats || output_capacity < context.output_capacity
            || function_count < context.function_count) {
            diagnostic(error, capacity, "CUDA emission result destinations are null or too short"); return -1;
        }
        check(cudaEventSynchronize(context.metadata_ready), "wait for emitted code and output lengths");
        const U32 *device_offsets = context.offsets.cpu<U32>();
        const U32 *device_lengths = context.lengths.cpu<U32>();
        uint64_t written = 0;
        for (U32 index = 0; index < context.function_count; ++index) {
            const auto function = context.functions.cpu<GPUEmitFunction>()[index];
            if (device_offsets[index] != written || device_lengths[index] == 0
                || device_lengths[index] > 12ULL + 25ULL * function.count)
                throw std::runtime_error("GPU instruction counts or prefix offsets violate the output plan");
            written += device_lengths[index];
            if (written > context.output_capacity)
                throw std::runtime_error("GPU-written code exceeds the retained output capacity");
        }
        // Never download the unused capacity: every byte in [0, written) was
        // initialized by its function's emitter after the device prefix scan.
        context.output.download(size_t(written), context.stream);
        check(cudaStreamSynchronize(context.stream), "wait for initialized machine-code download");
        context.stats.count_gpu_ms = event_ms(context.begin, context.counted);
        context.stats.emit_gpu_ms = event_ms(context.scanned, context.emitted);
        context.stats.gpu_ms = event_ms(context.begin, context.emitted);
        context.stats.host_prefix_ms = 0;
        context.stats.output_bytes = written;
        std::memcpy(output, context.output.host, size_t(written));
        const size_t index_bytes = array_bytes(context.function_count, sizeof(U32));
        std::memcpy(offsets, context.offsets.host, index_bytes);
        std::memcpy(lengths, context.lengths.host, index_bytes);
        context.stats.total_ms = elapsed(context.start);
        *stats = context.stats;
        context.pending = false;
        diagnostic(error, capacity, "");
        return 0;
    } catch (const std::exception &e) {
        context.quiesce();
        diagnostic(error, capacity, e.what());
        return -1;
    }
}

extern "C" void gpuemit_destroy(void *pointer) {
    delete static_cast<Context *>(pointer);
}
