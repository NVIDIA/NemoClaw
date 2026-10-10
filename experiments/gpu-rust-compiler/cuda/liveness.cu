// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// CUDA backend for the same exact block-liveness equations as liveness.metal.
// INPUT: GLC1, six little-endian uint32 counts, then the documented arrays.
// OUTPUT: GLR1, little-endian uint32 cell count, then live-in uint32 cells.
// GLC_FORMAT_CHECK_ONLY builds a host parser checker. It never runs liveness.

#ifndef GLC_FORMAT_CHECK_ONLY
#include <cuda_runtime.h>
#endif

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

struct Group {
    std::uint32_t block_base;
    std::uint32_t block_count;
    std::uint32_t row_base;
    std::uint32_t words;
    std::uint32_t word;
};
static_assert(sizeof(Group) == 5 * sizeof(std::uint32_t), "Group layout changed");

struct Input {
    std::uint32_t functions, blocks, cells, groups, max_blocks, edges;
    std::vector<Group> descriptors;
    std::vector<std::uint32_t> successor_offsets, successors, uses, defs, phi_out;
};

class Reader {
public:
    explicit Reader(const std::string& path) {
        std::ifstream file(path, std::ios::binary | std::ios::ate);
        if (!file) throw std::runtime_error("cannot open input: " + path);
        const auto length = file.tellg();
        if (length < 0 || static_cast<std::uint64_t>(length) >
                              std::numeric_limits<std::size_t>::max()) {
            throw std::runtime_error("invalid input length");
        }
        data.resize(static_cast<std::size_t>(length));
        file.seekg(0);
        if (!data.empty() && !file.read(reinterpret_cast<char*>(data.data()), length)) {
            throw std::runtime_error("failed reading input");
        }
    }

    void magic(const char* expected) {
        require(4);
        if (!std::equal(data.begin() + position, data.begin() + position + 4,
                        reinterpret_cast<const unsigned char*>(expected))) {
            throw std::runtime_error("expected GLC1 input magic");
        }
        position += 4;
    }

    std::uint32_t word() {
        require(4);
        const auto value = std::uint32_t(data[position]) |
                           (std::uint32_t(data[position + 1]) << 8) |
                           (std::uint32_t(data[position + 2]) << 16) |
                           (std::uint32_t(data[position + 3]) << 24);
        position += 4;
        return value;
    }

    std::vector<std::uint32_t> words(std::uint64_t count) {
        if (count > (data.size() - position) / 4) {
            throw std::runtime_error("truncated input array");
        }
        std::vector<std::uint32_t> result(static_cast<std::size_t>(count));
        for (auto& value : result) value = word();
        return result;
    }

    std::size_t remaining() const { return data.size() - position; }

private:
    std::vector<unsigned char> data;
    std::size_t position = 0;
    void require(std::size_t count) const {
        if (count > data.size() - position) throw std::runtime_error("truncated input");
    }
};

static void validate(const Input& input) {
    if (!input.functions || !input.blocks || !input.cells || !input.groups) {
        throw std::runtime_error("empty workload dimensions");
    }
    if (input.successor_offsets.front() != 0 ||
        input.successor_offsets.back() != input.edges) {
        throw std::runtime_error("successor offsets do not span the edges array");
    }
    for (std::size_t i = 1; i < input.successor_offsets.size(); ++i) {
        if (input.successor_offsets[i] < input.successor_offsets[i - 1] ||
            input.successor_offsets[i] > input.edges) {
            throw std::runtime_error("invalid successor offsets");
        }
    }

    struct Shape {
        std::uint32_t blocks, row, words;
        std::vector<bool> seen;
    };
    std::map<std::uint32_t, Shape> functions;
    std::uint32_t largest = 0;
    for (const auto& group : input.descriptors) {
        if (!group.block_count || !group.words || group.words > input.groups ||
            group.word >= group.words ||
            std::uint64_t(group.block_base) + group.block_count > input.blocks ||
            std::uint64_t(group.row_base) + std::uint64_t(group.block_count) * group.words > input.cells) {
            throw std::runtime_error("invalid function-word group");
        }
        largest = std::max(largest, group.block_count);
        auto found = functions.find(group.block_base);
        if (found == functions.end()) {
            found = functions.emplace(group.block_base, Shape{
                group.block_count, group.row_base, group.words,
                std::vector<bool>(group.words, false),
            }).first;
        }
        auto& shape = found->second;
        if (shape.blocks != group.block_count || shape.row != group.row_base ||
            shape.words != group.words || shape.seen[group.word]) {
            throw std::runtime_error("duplicate or inconsistent function-word group");
        }
        shape.seen[group.word] = true;
    }
    if (functions.size() != input.functions || largest != input.max_blocks) {
        throw std::runtime_error("function count or maximum block count does not match descriptors");
    }
    std::uint64_t next_block = 0, next_cell = 0;
    for (const auto& entry : functions) {
        const auto base = entry.first;
        const auto& shape = entry.second;
        if (base != next_block || shape.row != next_cell ||
            std::find(shape.seen.begin(), shape.seen.end(), false) != shape.seen.end()) {
            throw std::runtime_error("function groups do not cover every block and output cell exactly once");
        }
        const auto end = std::uint64_t(base) + shape.blocks;
        for (std::uint64_t block = base; block < end; ++block) {
            for (auto edge = input.successor_offsets[block];
                 edge < input.successor_offsets[block + 1]; ++edge) {
                const auto successor = input.successors[edge];
                if (successor < base || successor >= end) {
                    throw std::runtime_error("CFG successor escapes its owning function");
                }
            }
        }
        next_block = end;
        next_cell += std::uint64_t(shape.blocks) * shape.words;
    }
    if (next_block != input.blocks || next_cell != input.cells) {
        throw std::runtime_error("function groups leave uncovered blocks or cells");
    }
}

static Input read_input(const std::string& path) {
    Reader reader(path);
    reader.magic("GLC1");
    Input input;
    input.functions = reader.word(); input.blocks = reader.word();
    input.cells = reader.word(); input.groups = reader.word();
    input.max_blocks = reader.word(); input.edges = reader.word();
    const std::uint64_t expected_words = std::uint64_t(input.groups) * 5 +
        std::uint64_t(input.blocks) + 1 + input.edges + std::uint64_t(input.cells) * 3;
    if (expected_words * 4 != reader.remaining()) {
        throw std::runtime_error("binary length does not match header dimensions");
    }
    input.descriptors.resize(input.groups);
    for (auto& group : input.descriptors) {
        group = {reader.word(), reader.word(), reader.word(), reader.word(), reader.word()};
    }
    input.successor_offsets = reader.words(std::uint64_t(input.blocks) + 1);
    input.successors = reader.words(input.edges);
    input.uses = reader.words(input.cells);
    input.defs = reader.words(input.cells);
    input.phi_out = reader.words(input.cells);
    validate(input);
    return input;
}

static std::string json_string(const std::string& value) {
    std::ostringstream result;
    result << '"';
    for (const unsigned char ch : value) {
        switch (ch) {
            case '"': result << "\\\""; break;
            case '\\': result << "\\\\"; break;
            case '\n': result << "\\n"; break;
            case '\r': result << "\\r"; break;
            case '\t': result << "\\t"; break;
            default:
                if (ch < 0x20) {
                    result << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                           << static_cast<unsigned>(ch) << std::dec;
                } else result << ch;
        }
    }
    return result.str() + '"';
}

#ifndef GLC_FORMAT_CHECK_ONLY

class CudaError : public std::runtime_error {
public:
    const cudaError_t code;
    CudaError(cudaError_t code, const std::string& operation)
        : std::runtime_error(operation + ": " + cudaGetErrorString(code)), code(code) {}
};

static void cuda_check(cudaError_t code, const char* operation) {
    if (code != cudaSuccess) throw CudaError(code, operation);
}

template <typename T> class DeviceBuffer {
public:
    T* pointer = nullptr;
    const std::size_t count;
    explicit DeviceBuffer(std::size_t count) : count(count) {
        if (count) cuda_check(cudaMalloc(reinterpret_cast<void**>(&pointer), count * sizeof(T)), "cudaMalloc");
    }
    explicit DeviceBuffer(const std::vector<T>& values) : DeviceBuffer(values.size()) {
        if (count) cuda_check(cudaMemcpy(pointer, values.data(), count * sizeof(T), cudaMemcpyHostToDevice), "cudaMemcpy H2D");
    }
    ~DeviceBuffer() { if (pointer) cudaFree(pointer); }
    DeviceBuffer(const DeviceBuffer&) = delete;
    DeviceBuffer& operator=(const DeviceBuffer&) = delete;
    void upload(const std::vector<T>& source) const {
        if (source.size() != count) throw std::runtime_error("upload size mismatch");
        if (count) cuda_check(cudaMemcpy(pointer, source.data(), count * sizeof(T), cudaMemcpyHostToDevice), "cudaMemcpy H2D");
    }
    void download(std::vector<T>& destination) const {
        if (destination.size() != count) throw std::runtime_error("download size mismatch");
        if (count) cuda_check(cudaMemcpy(destination.data(), pointer, count * sizeof(T), cudaMemcpyDeviceToHost), "cudaMemcpy D2H");
    }
};

class Event {
public:
    cudaEvent_t value = nullptr;
    Event() { cuda_check(cudaEventCreate(&value), "cudaEventCreate"); }
    ~Event() { if (value) cudaEventDestroy(value); }
    Event(const Event&) = delete;
    Event& operator=(const Event&) = delete;
};

__global__ void liveness(
    const Group* groups,
    const std::uint32_t* successor_offsets,
    const std::uint32_t* successors,
    const std::uint32_t* uses,
    const std::uint32_t* defs,
    const std::uint32_t* phi_out,
    std::uint32_t* result,
    std::uint32_t* iterations,
    std::uint32_t* converged) {
    const Group group = groups[blockIdx.x];
    extern __shared__ std::uint32_t slab[];
    std::uint32_t* previous = slab;
    std::uint32_t* next = slab + group.block_count;
    __shared__ unsigned int changed;
    const unsigned int lane = threadIdx.x;
    for (std::uint32_t block = lane; block < group.block_count; block += blockDim.x) {
        previous[block] = 0;
    }
    __syncthreads();

    bool stable = false;
    std::uint32_t sweeps = 0;
    // N+1 includes the no-change sweep after propagation along a simple path.
    for (std::uint32_t round = 0; round <= group.block_count; ++round) {
        if (lane == 0) changed = 0;
        __syncthreads();
        for (std::uint32_t block = lane; block < group.block_count; block += blockDim.x) {
            const auto global_block = group.block_base + block;
            const auto cell = group.row_base + block * group.words + group.word;
            std::uint32_t live_out = phi_out[cell];
            for (auto edge = successor_offsets[global_block];
                 edge < successor_offsets[global_block + 1]; ++edge) {
                live_out |= previous[successors[edge] - group.block_base];
            }
            const auto value = uses[cell] | (live_out & ~defs[cell]);
            next[block] = value;
            if (value != previous[block]) atomicOr(&changed, 1u);
        }
        __syncthreads();
        sweeps = round + 1;
        // changed is block-uniform after the barrier, so every thread takes
        // the same exit and every remaining barrier is reached together.
        if (changed == 0) {
            stable = true;
            break;
        }
        for (std::uint32_t block = lane; block < group.block_count; block += blockDim.x) {
            previous[block] = next[block];
        }
        __syncthreads();
    }
    for (std::uint32_t block = lane; block < group.block_count; block += blockDim.x) {
        const auto cell = group.row_base + block * group.words + group.word;
        result[cell] = previous[block];
    }
    if (lane == 0) {
        iterations[blockIdx.x] = sweeps;
        converged[blockIdx.x] = stable ? 1u : 0u;
    }
}

static double elapsed_ms(std::chrono::steady_clock::time_point start) {
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
}

static void write_result(const std::string& path, const std::vector<std::uint32_t>& values) {
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    if (!output) throw std::runtime_error("cannot open output: " + path);
    output.write("GLR1", 4);
    auto write_word = [&output](std::uint32_t word) {
        const unsigned char bytes[4] = {
            static_cast<unsigned char>(word), static_cast<unsigned char>(word >> 8),
            static_cast<unsigned char>(word >> 16), static_cast<unsigned char>(word >> 24),
        };
        output.write(reinterpret_cast<const char*>(bytes), 4);
    };
    write_word(static_cast<std::uint32_t>(values.size()));
    for (const auto value : values) write_word(value);
    output.close();
    if (!output) throw std::runtime_error("failed writing output: " + path);
}

static std::string statistics(const std::vector<double>& values) {
    auto sorted = values;
    std::sort(sorted.begin(), sorted.end());
    std::ostringstream result;
    result << std::setprecision(10) << "{\"median_ms\":" << sorted[sorted.size() / 2]
           << ",\"min_ms\":" << sorted.front() << ",\"max_ms\":" << sorted.back()
           << ",\"samples_ms\":[";
    for (std::size_t i = 0; i < values.size(); ++i) {
        if (i) result << ',';
        result << values[i];
    }
    result << "]}";
    return result.str();
}

static int run_cuda(int argc, char** argv) {
    if (argc < 3 || argc > 4) {
        std::cerr << "Usage: cuda-liveness INPUT.bin OUTPUT.bin [repeats]\n";
        return 2;
    }
    if (std::string(argv[1]) == argv[2]) throw std::runtime_error("output must not overwrite input");
    int repeats = 7;
    if (argc == 4) {
        std::size_t consumed = 0;
        repeats = std::stoi(argv[3], &consumed);
        if (consumed != std::string(argv[3]).size() || repeats < 1 || repeats > 10000) {
            throw std::runtime_error("repeats must be between 1 and 10000");
        }
    }
    const auto input = read_input(argv[1]);
    const auto initialization_start = std::chrono::steady_clock::now();
    cuda_check(cudaSetDevice(0), "cudaSetDevice(0)");
    cudaDeviceProp properties{};
    cuda_check(cudaGetDeviceProperties(&properties, 0), "cudaGetDeviceProperties");
    constexpr unsigned int threads = 64;
    if (properties.maxThreadsPerBlock < threads || input.groups > static_cast<std::uint32_t>(properties.maxGridSize[0])) {
        throw std::runtime_error("launch dimensions exceed the device limits");
    }
    cudaFuncAttributes attributes{};
    cuda_check(cudaFuncGetAttributes(&attributes, liveness), "cudaFuncGetAttributes");
    const auto dynamic_bytes = std::uint64_t(input.max_blocks) * 2 * sizeof(std::uint32_t);
    const auto available_shared = std::max(properties.sharedMemPerBlock, properties.sharedMemPerBlockOptin);
    if (dynamic_bytes + attributes.sharedSizeBytes > available_shared ||
        dynamic_bytes > std::numeric_limits<int>::max()) {
        throw std::runtime_error("function exceeds device shared memory; CUDA pass cannot run this input");
    }
    if (dynamic_bytes + attributes.sharedSizeBytes > properties.sharedMemPerBlock) {
        cuda_check(cudaFuncSetAttribute(liveness, cudaFuncAttributeMaxDynamicSharedMemorySize,
                                      static_cast<int>(dynamic_bytes)), "cudaFuncSetAttribute shared memory");
    }

    DeviceBuffer<Group> descriptors(input.descriptors);
    DeviceBuffer<std::uint32_t> offsets(input.successor_offsets), successors(input.successors);
    DeviceBuffer<std::uint32_t> uses(input.uses), defs(input.defs), phi(input.phi_out);
    DeviceBuffer<std::uint32_t> result(input.cells), iterations(input.groups), converged(input.groups);
    std::vector<std::uint32_t> host_result(input.cells), host_iterations(input.groups), host_converged(input.groups);
    Event begin, end;
    const auto initialization_ms = elapsed_ms(initialization_start);
    std::uint32_t maximum_sweeps = 0;

    auto run = [&]() {
        const auto start = std::chrono::steady_clock::now();
        cuda_check(cudaEventRecord(begin.value), "cudaEventRecord begin");
        liveness<<<input.groups, threads, static_cast<std::size_t>(dynamic_bytes)>>>(
            descriptors.pointer, offsets.pointer, successors.pointer, uses.pointer,
            defs.pointer, phi.pointer, result.pointer, iterations.pointer, converged.pointer);
        cuda_check(cudaGetLastError(), "liveness launch");
        cuda_check(cudaEventRecord(end.value), "cudaEventRecord end");
        cuda_check(cudaEventSynchronize(end.value), "cudaEventSynchronize");
        float execution_ms = 0;
        cuda_check(cudaEventElapsedTime(&execution_ms, begin.value, end.value), "cudaEventElapsedTime");
        converged.download(host_converged);
        iterations.download(host_iterations);
        result.download(host_result);
        for (std::size_t i = 0; i < host_converged.size(); ++i) {
            if (host_converged[i] != 1) throw std::runtime_error("CUDA fixed point failed to converge for group " + std::to_string(i));
            maximum_sweeps = std::max(maximum_sweeps, host_iterations[i]);
        }
        return std::pair<double, double>{elapsed_ms(start), execution_ms};
    };

    const auto first = run();
    const auto reference = host_result;
    std::vector<double> elapsed, execution;
    for (int repeat = 0; repeat < repeats; ++repeat) {
        const auto timing = run();
        if (host_result != reference) throw std::runtime_error("CUDA output changed between identical repetitions");
        elapsed.push_back(timing.first); execution.push_back(timing.second);
    }
    // A compilation produces new input. Time uploading all input arrays as well
    // as solving and returning the output, while retaining device allocations.
    std::vector<double> input_update_elapsed;
    for (int repeat = 0; repeat < repeats; ++repeat) {
        const auto start = std::chrono::steady_clock::now();
        descriptors.upload(input.descriptors);
        offsets.upload(input.successor_offsets); successors.upload(input.successors);
        uses.upload(input.uses); defs.upload(input.defs); phi.upload(input.phi_out);
        run();
        input_update_elapsed.push_back(elapsed_ms(start));
        if (host_result != reference) throw std::runtime_error("CUDA output changed after input upload");
    }
    write_result(argv[2], host_result);
    std::cout << std::setprecision(10)
              << "{\"backend\":\"cuda\",\"device_name\":" << json_string(properties.name)
              << ",\"device_ordinal\":0,\"threads\":" << threads
              << ",\"functions\":" << input.functions << ",\"blocks\":" << input.blocks
              << ",\"cells\":" << input.cells << ",\"groups\":" << input.groups
              << ",\"max_blocks\":" << input.max_blocks << ",\"shared_memory_bytes\":" << dynamic_bytes
              << ",\"repeats\":" << repeats << ",\"max_sweeps\":" << maximum_sweeps
              << ",\"converged\":true,\"repeat_outputs_equal\":true"
              << ",\"initialization_ms\":" << initialization_ms
              << ",\"first_pass_end_to_end_ms\":" << first.first
              << ",\"gpu_execution_ms\":" << statistics(execution)
              << ",\"warm_pass_end_to_end_ms\":" << statistics(elapsed)
              << ",\"warm_input_update_end_to_end_ms\":" << statistics(input_update_elapsed)
              << ",\"timing_scope\":\"Warm elapsed includes launch, event wait, convergence checks and device-to-host result copies; excludes initialization, input uploads, file IO and cross-backend verification. Input-update elapsed additionally uploads all input arrays and reuses device allocations.\"}\n";
    return 0;
}

#endif

int main(int argc, char** argv) {
    try {
#ifdef GLC_FORMAT_CHECK_ONLY
        if (argc != 2) {
            std::cerr << "Usage: cuda-format-check INPUT.bin\n";
            return 2;
        }
        const auto input = read_input(argv[1]);
        std::cout << "{\"format_validated\":true,\"gpu_executed\":false,\"functions\":"
                  << input.functions << ",\"blocks\":" << input.blocks
                  << ",\"cells\":" << input.cells << ",\"groups\":" << input.groups << "}\n";
        return 0;
#else
        return run_cuda(argc, argv);
#endif
    }
#ifndef GLC_FORMAT_CHECK_ONLY
    catch (const CudaError& error) {
        std::cerr << "{\"error\":" << json_string(error.what())
                  << ",\"cuda_error_code\":" << static_cast<int>(error.code) << "}\n";
        const int code = static_cast<int>(error.code);
        return code > 0 && code <= 255 ? code : 1;
    }
#endif
    catch (const std::exception& error) {
        std::cerr << "{\"error\":" << json_string(error.what()) << "}\n";
        return 1;
    }
}
