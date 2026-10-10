// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#include "cuda_bridge.h"
#include <cuda_runtime.h>
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {
using Clock = std::chrono::steady_clock;
using U32 = uint32_t;
using U64 = unsigned long long;
static_assert(sizeof(GPULabCudaGroup) == 20, "CUDA group ABI changed");
struct Progress { U64 visits, edges, bits; U32 sweeps, converged; };

double elapsed(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}
void check(cudaError_t status, const char *operation) {
    if (status != cudaSuccess) throw std::runtime_error(std::string(operation) + ": " + cudaGetErrorString(status));
}
void error(char *out, size_t count, const char *message) {
    if (out && count) std::snprintf(out, count, "%s", message);
}

/* Each CUDA block owns exactly one function-word pair. Dense Jacobi uses a
 * pair of immutable/current snapshots. Every thread reaches each barrier and
 * the shared termination flag is read only after the writers synchronize.
 */
__global__ void dense(const GPULabCudaGroup *groups, const U32 *offsets,
                      const U32 *successors, const U32 *uses, const U32 *defs,
                      const U32 *phi, U32 *result, Progress *progress) {
    const auto group = groups[blockIdx.x];
    const U32 n = group.block_count;
    extern __shared__ U32 storage[];
    U32 *current = storage, *next = current + n;
    __shared__ U32 changed;
    for (U32 row = threadIdx.x; row < n; row += blockDim.x) current[row] = 0;
    __syncthreads();
    U32 sweeps = 0;
    bool converged = false;
    for (U32 round = 0; round <= n; ++round) {
        if (threadIdx.x == 0) changed = 0;
        __syncthreads();
        for (U32 row = threadIdx.x; row < n; row += blockDim.x) {
            const U32 block = group.block_base + row;
            const U32 cell = group.row_base + row * group.words + group.word;
            U32 out = phi[cell];
            for (U32 e = offsets[block]; e < offsets[block + 1]; ++e)
                out |= current[successors[e] - group.block_base];
            const U32 value = uses[cell] | (out & ~defs[cell]);
            next[row] = value;
            if (value != current[row]) atomicOr(&changed, 1U);
        }
        __syncthreads();
        ++sweeps;
        U32 *swap = current; current = next; next = swap;
        if (!changed) { converged = true; break; }
    }
    U64 local_bits = 0;
    for (U32 row = threadIdx.x; row < n; row += blockDim.x) {
        result[group.row_base + row * group.words + group.word] = current[row];
        local_bits += __popc(current[row]);
    }
    __shared__ U64 bits;
    if (threadIdx.x == 0) bits = 0;
    __syncthreads();
    atomicAdd(&bits, local_bits);
    __syncthreads();
    if (threadIdx.x == 0) progress[blockIdx.x] = {
        U64(n) * sweeps,
        U64(offsets[group.block_base + n] - offsets[group.block_base]) * sweeps,
        bits, sweeps, converged ? 1U : 0U};
}

/* Delta frontier proof: seed GEN = USE | (PHIOUT & ~DEF). A source frontier
 * contains only bits that first appeared in that row in the previous round.
 * atomicOr(values[p], delta & ~DEF[p]) assigns each new bit to exactly one
 * predecessor update; those new bits are atomicOr'ed into the next frontier.
 * Concurrent parents cannot lose facts. Frontier clearing precedes propagation
 * and a uniform barrier precedes reading it. No queue capacity or producer /
 * consumer termination race exists. Each bit advances along a shortest path
 * of at most n-1 edges, so n+1 rounds include a final empty frontier check.
 */
__global__ void sparse(const GPULabCudaGroup *groups, const U32 *offsets,
                       const U32 *predecessors, const U32 *uses, const U32 *defs,
                       const U32 *phi, U32 *result, Progress *progress) {
    const auto group = groups[blockIdx.x];
    const U32 n = group.block_count;
    extern __shared__ U32 storage[];
    U32 *values = storage, *frontier = values + n, *next = frontier + n;
    __shared__ U32 changed;
    __shared__ U64 visits, edges;
    U64 local_visits = 0, local_edges = 0;
    if (threadIdx.x == 0) { visits = 0; edges = 0; }
    for (U32 row = threadIdx.x; row < n; row += blockDim.x) {
        const U32 cell = group.row_base + row * group.words + group.word;
        values[row] = frontier[row] = uses[cell] | (phi[cell] & ~defs[cell]);
    }
    __syncthreads();
    U32 sweeps = 0;
    bool converged = false;
    for (U32 round = 0; round <= n; ++round) {
        if (threadIdx.x == 0) changed = 0;
        for (U32 row = threadIdx.x; row < n; row += blockDim.x) next[row] = 0;
        __syncthreads();
        for (U32 row = threadIdx.x; row < n; row += blockDim.x) {
            const U32 delta = frontier[row];
            if (!delta) continue;
            ++local_visits;
            const U32 block = group.block_base + row;
            for (U32 e = offsets[block]; e < offsets[block + 1]; ++e) {
                const U32 pred = predecessors[e] - group.block_base;
                const U32 cell = group.row_base + pred * group.words + group.word;
                const U32 candidate = delta & ~defs[cell];
                if (!candidate) continue;
                const U32 old = atomicOr(&values[pred], candidate);
                const U32 added = candidate & ~old;
                if (added) { atomicOr(&next[pred], added); atomicOr(&changed, 1U); }
            }
            local_edges += offsets[block + 1] - offsets[block];
        }
        __syncthreads();
        ++sweeps;
        U32 *swap = frontier; frontier = next; next = swap;
        if (!changed) { converged = true; break; }
    }
    U64 local_bits = 0;
    for (U32 row = threadIdx.x; row < n; row += blockDim.x) {
        result[group.row_base + row * group.words + group.word] = values[row];
        local_bits += __popc(values[row]);
    }
    __shared__ U64 bits;
    if (threadIdx.x == 0) bits = 0;
    __syncthreads();
    atomicAdd(&bits, local_bits);
    atomicAdd(&visits, local_visits);
    atomicAdd(&edges, local_edges);
    __syncthreads();
    if (threadIdx.x == 0) progress[blockIdx.x] = {visits, edges, bits, sweeps, converged ? 1U : 0U};
}

struct Buffer {
    void *device = nullptr, *host = nullptr;
    size_t capacity = 0;
    ~Buffer() { if (device) cudaFree(device); if (host) cudaFreeHost(host); }
    void ensure(size_t bytes, GPULabCudaStats &stats) {
        if (bytes <= capacity) return;
        const size_t grown = capacity > std::numeric_limits<size_t>::max() / 2 ? bytes : std::max(bytes, capacity * 2);
        void *new_device = nullptr, *new_host = nullptr;
        check(cudaMalloc(&new_device, grown), "allocate CUDA device buffer");
        try { check(cudaHostAlloc(&new_host, grown, cudaHostAllocDefault), "allocate CUDA pinned staging"); }
        catch (...) { cudaFree(new_device); throw; }
        if (device) cudaFree(device);
        if (host) cudaFreeHost(host);
        device = new_device; host = new_host; capacity = grown;
        ++stats.device_allocations; ++stats.pinned_allocations;
    }
    template<class T> T *gpu() { return static_cast<T *>(device); }
    template<class T> T *cpu() { return static_cast<T *>(host); }
    void capture(const void *source, size_t bytes) { if (bytes) std::memcpy(host, source, bytes); }
    void upload(size_t bytes, cudaStream_t stream) { if (bytes) check(cudaMemcpyAsync(device, host, bytes, cudaMemcpyHostToDevice, stream), "upload CUDA input"); }
    void download(size_t bytes, cudaStream_t stream) { if (bytes) check(cudaMemcpyAsync(host, device, bytes, cudaMemcpyDeviceToHost, stream), "download CUDA output"); }
};

struct Bucket { U32 offset, count, max_blocks; };
struct Context {
    cudaStream_t stream = nullptr;
    cudaEvent_t begin = nullptr, uploaded = nullptr, solved = nullptr, done = nullptr;
    GPULabCudaCapabilities capabilities{};
    cudaDeviceProp properties{};
    Buffer groups, successors_offsets, successors, predecessors_offsets, predecessors, uses, defs, phi, output, progress;
    GPULabCudaInput dimensions{};
    GPULabCudaStats stats{};
    std::vector<Bucket> buckets;
    Clock::time_point start;
    double initialization_ms = 0;
    size_t submissions = 0;
    bool in_flight = false, resident = false;
    ~Context() {
        if (stream) cudaStreamSynchronize(stream);
        if (begin) cudaEventDestroy(begin);
        if (uploaded) cudaEventDestroy(uploaded);
        if (solved) cudaEventDestroy(solved);
        if (done) cudaEventDestroy(done);
        if (stream) cudaStreamDestroy(stream);
    }
    void initialize() {
        const auto started = Clock::now();
        check(cudaFree(nullptr), "initialize CUDA runtime");
        int device = 0; check(cudaGetDevice(&device), "query CUDA device");
        check(cudaGetDeviceProperties(&properties, device), "query CUDA properties");
        std::snprintf(capabilities.device_name, sizeof(capabilities.device_name), "%s", properties.name);
        char *uuid = capabilities.device_uuid;
        for (size_t i = 0; i < sizeof(properties.uuid.bytes); ++i) {
            std::snprintf(uuid + i * 2, sizeof(capabilities.device_uuid) - i * 2,
                          "%02x", static_cast<unsigned char>(properties.uuid.bytes[i]));
        }
        check(cudaDriverGetVersion(&capabilities.driver_version), "query CUDA driver version");
        check(cudaRuntimeGetVersion(&capabilities.runtime_version), "query CUDA runtime version");
        capabilities.compute_major = properties.major; capabilities.compute_minor = properties.minor;
        const auto attribute = [&](cudaDeviceAttr attr) { int value = 0; check(cudaDeviceGetAttribute(&value, attr, device), "query CUDA memory capability"); return value; };
        capabilities.unified_addressing = attribute(cudaDevAttrUnifiedAddressing);
        capabilities.managed_memory = attribute(cudaDevAttrManagedMemory);
        capabilities.concurrent_managed_access = attribute(cudaDevAttrConcurrentManagedAccess);
        capabilities.pageable_memory_access = attribute(cudaDevAttrPageableMemoryAccess);
        capabilities.host_page_tables = attribute(cudaDevAttrPageableMemoryAccessUsesHostPageTables);
        capabilities.direct_managed_access = attribute(cudaDevAttrDirectManagedMemAccessFromHost);
        capabilities.async_engine_count = attribute(cudaDevAttrAsyncEngineCount);
        capabilities.coherent_placement_verified = 0;
        check(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking), "create persistent CUDA stream");
        check(cudaEventCreate(&begin), "create CUDA timing event");
        check(cudaEventCreate(&uploaded), "create CUDA upload event");
        check(cudaEventCreate(&solved), "create CUDA solve event");
        check(cudaEventCreate(&done), "create CUDA completion event");
        initialization_ms = elapsed(started);
    }
    void drain() noexcept {
        if (stream) cudaStreamSynchronize(stream);
        in_flight = false; resident = false;
        /* Read the runtime's last error before a subsequent attempted request. */
        cudaGetLastError();
    }
    void reset_stats(bool replay) {
        start = Clock::now(); stats = {};
        stats.initialization_ms = initialization_ms;
        stats.reused_context = submissions ? 1U : 0U;
        stats.resident_input = replay ? 1U : 0U;
    }
    void launch(U32 algorithm) {
        if (algorithm != GPULAB_CUDA_DENSE && algorithm != GPULAB_CUDA_SPARSE)
            throw std::runtime_error("unknown CUDA liveness algorithm");
        const U32 factor = algorithm == GPULAB_CUDA_SPARSE ? 3 : 2;
        for (const auto &bucket : buckets) {
            const size_t dynamic_bytes = size_t(bucket.max_blocks) * factor * sizeof(U32);
            if (dynamic_bytes + 64 > properties.sharedMemPerBlock)
                throw std::runtime_error("function exceeds CUDA per-block shared memory; route it to CPU");
            U32 threads = 32;
            while (threads < bucket.max_blocks && threads < 256) threads *= 2;
            if (algorithm == GPULAB_CUDA_DENSE)
                dense<<<bucket.count, threads, dynamic_bytes, stream>>>(
                    groups.gpu<GPULabCudaGroup>() + bucket.offset, successors_offsets.gpu<U32>(), successors.gpu<U32>(),
                    uses.gpu<U32>(), defs.gpu<U32>(), phi.gpu<U32>(), output.gpu<U32>(), progress.gpu<Progress>() + bucket.offset);
            else
                sparse<<<bucket.count, threads, dynamic_bytes, stream>>>(
                    groups.gpu<GPULabCudaGroup>() + bucket.offset, predecessors_offsets.gpu<U32>(), predecessors.gpu<U32>(),
                    uses.gpu<U32>(), defs.gpu<U32>(), phi.gpu<U32>(), output.gpu<U32>(), progress.gpu<Progress>() + bucket.offset);
            check(cudaGetLastError(), "launch CUDA liveness kernel");
        }
        check(cudaEventRecord(solved, stream), "record CUDA solve event");
        output.download(size_t(dimensions.cell_count) * sizeof(U32), stream);
        progress.download(size_t(dimensions.group_count) * sizeof(Progress), stream);
        check(cudaEventRecord(done, stream), "record CUDA completion event");
        in_flight = true; ++submissions;
    }
};

void validate(const GPULabCudaInput &in) {
    if (!in.function_count || !in.block_count || !in.cell_count || !in.group_count ||
        !in.groups || !in.successor_offsets || !in.predecessor_offsets || !in.uses || !in.defs || !in.phi_out ||
        (in.edge_count && (!in.successors || !in.predecessors))) throw std::runtime_error("invalid CUDA input dimensions or pointers");
    if (in.successor_offsets[0] || in.predecessor_offsets[0] ||
        in.successor_offsets[in.block_count] != in.edge_count || in.predecessor_offsets[in.block_count] != in.edge_count)
        throw std::runtime_error("CUDA CSR offsets do not span edges");
    for (U32 row = 0; row < in.block_count; ++row) {
        if (in.successor_offsets[row] > in.successor_offsets[row + 1] || in.predecessor_offsets[row] > in.predecessor_offsets[row + 1] ||
            in.successor_offsets[row + 1] > in.edge_count || in.predecessor_offsets[row + 1] > in.edge_count)
            throw std::runtime_error("nonmonotone CUDA CSR offsets");
    }
    for (U32 e = 0; e < in.edge_count; ++e)
        if (in.successors[e] >= in.block_count || in.predecessors[e] >= in.block_count)
            throw std::runtime_error("CUDA CFG edge exceeds block range");
    U32 next_block = 0, next_group = 0, functions = 0, largest = 0;
    uint64_t next_cell = 0;
    while (next_group < in.group_count) {
        const U32 g = next_group;
        const auto group = in.groups[g];
        if (!group.block_count || !group.words || group.word >= group.words ||
            uint64_t(group.block_base) + group.block_count > in.block_count ||
            uint64_t(group.row_base) + uint64_t(group.block_count) * group.words > in.cell_count)
            throw std::runtime_error("invalid CUDA function-word group");
        if (group.block_base != next_block || group.row_base != next_cell || group.word != 0 ||
            uint64_t(g) + group.words > in.group_count)
            throw std::runtime_error("CUDA function-word groups must cover each cell in packed order");
        for (U32 word = 0; word < group.words; ++word) {
            const auto other = in.groups[g + word];
            if (other.block_base != group.block_base || other.block_count != group.block_count ||
                other.row_base != group.row_base || other.words != group.words || other.word != word)
                throw std::runtime_error("duplicate or inconsistent CUDA function-word group");
        }
        for (U32 row = group.block_base; row < group.block_base + group.block_count; ++row) {
            for (U32 e = in.successor_offsets[row]; e < in.successor_offsets[row + 1]; ++e)
                if (in.successors[e] < group.block_base || in.successors[e] >= group.block_base + group.block_count)
                    throw std::runtime_error("CUDA successor escapes function");
            for (U32 e = in.predecessor_offsets[row]; e < in.predecessor_offsets[row + 1]; ++e)
                if (in.predecessors[e] < group.block_base || in.predecessors[e] >= group.block_base + group.block_count)
                    throw std::runtime_error("CUDA predecessor escapes function");
        }
        next_block += group.block_count;
        next_cell += uint64_t(group.block_count) * group.words;
        next_group += group.words; ++functions; largest = std::max(largest, group.block_count);
    }
    if (next_block != in.block_count || next_cell != in.cell_count || functions != in.function_count || largest != in.max_blocks)
        throw std::runtime_error("CUDA function-word groups leave uncovered blocks or cells");
    std::vector<std::pair<U32, U32>> forward, reverse;
    forward.reserve(in.edge_count); reverse.reserve(in.edge_count);
    for (U32 row = 0; row < in.block_count; ++row) {
        for (U32 e = in.successor_offsets[row]; e < in.successor_offsets[row + 1]; ++e)
            forward.emplace_back(row, in.successors[e]);
        for (U32 e = in.predecessor_offsets[row]; e < in.predecessor_offsets[row + 1]; ++e)
            reverse.emplace_back(in.predecessors[e], row);
    }
    std::sort(forward.begin(), forward.end()); std::sort(reverse.begin(), reverse.end());
    if (forward != reverse) throw std::runtime_error("CUDA predecessor CSR does not reverse successor CSR");
}
U32 bucket_key(U32 blocks) { U32 value = 1; while (value < blocks && value <= UINT32_MAX / 2) value *= 2; return value; }
} // namespace

extern "C" uint32_t gpulab_cuda_abi_version(void) { return 1; }
extern "C" void *gpulab_cuda_create(char *err, size_t capacity) {
    try { auto context = std::make_unique<Context>(); context->initialize(); return context.release(); }
    catch (const std::exception &e) { error(err, capacity, e.what()); return nullptr; }
}
extern "C" int gpulab_cuda_capabilities(void *pointer, GPULabCudaCapabilities *out, char *err, size_t capacity) {
    if (!pointer || !out) { error(err, capacity, "null CUDA context or capabilities output"); return -1; }
    *out = static_cast<Context *>(pointer)->capabilities; return 0;
}
extern "C" int gpulab_cuda_submit(void *pointer, const GPULabCudaInput *input, U32 algorithm, char *err, size_t capacity) {
    if (!pointer || !input) { error(err, capacity, "null CUDA context or input"); return -1; }
    auto &ctx = *static_cast<Context *>(pointer);
    if (ctx.in_flight) { error(err, capacity, "CUDA context already has an in-flight request"); return -1; }
    try {
        ctx.reset_stats(false);
        if (algorithm != GPULAB_CUDA_DENSE && algorithm != GPULAB_CUDA_SPARSE)
            throw std::runtime_error("unknown CUDA liveness algorithm");
        validate(*input);
        const auto &in = *input;
        ctx.dimensions = in; ctx.resident = false;
        const size_t offsets_bytes = (size_t(in.block_count) + 1) * sizeof(U32), edge_bytes = size_t(in.edge_count) * sizeof(U32);
        const size_t cell_bytes = size_t(in.cell_count) * sizeof(U32), group_bytes = size_t(in.group_count) * sizeof(GPULabCudaGroup);
        ctx.groups.ensure(group_bytes, ctx.stats);
        ctx.successors_offsets.ensure(offsets_bytes, ctx.stats); ctx.predecessors_offsets.ensure(offsets_bytes, ctx.stats);
        ctx.successors.ensure(edge_bytes, ctx.stats); ctx.predecessors.ensure(edge_bytes, ctx.stats);
        ctx.uses.ensure(cell_bytes, ctx.stats); ctx.defs.ensure(cell_bytes, ctx.stats); ctx.phi.ensure(cell_bytes, ctx.stats);
        ctx.output.ensure(cell_bytes, ctx.stats); ctx.progress.ensure(size_t(in.group_count) * sizeof(Progress), ctx.stats);
        ctx.groups.capture(in.groups, group_bytes);
        auto *groups = ctx.groups.cpu<GPULabCudaGroup>();
        std::sort(groups, groups + in.group_count, [](const auto &a, const auto &b) { return bucket_key(a.block_count) < bucket_key(b.block_count); });
        ctx.buckets.clear();
        for (U32 g = 0; g < in.group_count;) {
            U32 end = g + 1, largest = groups[g].block_count, key = bucket_key(largest);
            while (end < in.group_count && bucket_key(groups[end].block_count) == key) { largest = std::max(largest, groups[end].block_count); ++end; }
            ctx.buckets.push_back({g, end - g, largest}); g = end;
        }
        ctx.successors_offsets.capture(in.successor_offsets, offsets_bytes); ctx.predecessors_offsets.capture(in.predecessor_offsets, offsets_bytes);
        ctx.successors.capture(in.successors, edge_bytes); ctx.predecessors.capture(in.predecessors, edge_bytes);
        ctx.uses.capture(in.uses, cell_bytes); ctx.defs.capture(in.defs, cell_bytes); ctx.phi.capture(in.phi_out, cell_bytes);
        ctx.stats.staging_ms = elapsed(ctx.start);
        check(cudaEventRecord(ctx.begin, ctx.stream), "record CUDA upload start");
        ctx.groups.upload(group_bytes, ctx.stream);
        ctx.successors_offsets.upload(offsets_bytes, ctx.stream); ctx.predecessors_offsets.upload(offsets_bytes, ctx.stream);
        ctx.successors.upload(edge_bytes, ctx.stream); ctx.predecessors.upload(edge_bytes, ctx.stream);
        ctx.uses.upload(cell_bytes, ctx.stream); ctx.defs.upload(cell_bytes, ctx.stream); ctx.phi.upload(cell_bytes, ctx.stream);
        check(cudaEventRecord(ctx.uploaded, ctx.stream), "record CUDA upload completion");
        ctx.launch(algorithm); ctx.resident = true; return 0;
    } catch (const std::exception &e) { ctx.drain(); error(err, capacity, e.what()); return -1; }
}
extern "C" int gpulab_cuda_submit_resident(void *pointer, U32 algorithm, char *err, size_t capacity) {
    if (!pointer) { error(err, capacity, "null CUDA context"); return -1; }
    auto &ctx = *static_cast<Context *>(pointer);
    if (ctx.in_flight) { error(err, capacity, "CUDA context already has an in-flight request"); return -1; }
    if (!ctx.resident) { error(err, capacity, "no CUDA input is resident"); return -1; }
    try {
        ctx.reset_stats(true);
        check(cudaEventRecord(ctx.begin, ctx.stream), "record resident CUDA request");
        check(cudaEventRecord(ctx.uploaded, ctx.stream), "record resident CUDA solve start");
        ctx.launch(algorithm); return 0;
    } catch (const std::exception &e) { ctx.drain(); error(err, capacity, e.what()); return -1; }
}
extern "C" int gpulab_cuda_finish(void *pointer, U32 *out, size_t count, GPULabCudaStats *stats, char *err, size_t capacity) {
    if (!pointer || !out || !stats) { error(err, capacity, "null CUDA context or result"); return -1; }
    auto &ctx = *static_cast<Context *>(pointer);
    if (!ctx.in_flight) { error(err, capacity, "no CUDA request is in flight"); return -1; }
    if (count < ctx.dimensions.cell_count) { error(err, capacity, "CUDA output buffer is too short"); return -1; }
    try {
        check(cudaEventSynchronize(ctx.done), "wait for CUDA completion event");
        float upload_ms = 0, solve_ms = 0, download_ms = 0;
        check(cudaEventElapsedTime(&upload_ms, ctx.begin, ctx.uploaded), "measure CUDA upload");
        check(cudaEventElapsedTime(&solve_ms, ctx.uploaded, ctx.solved), "measure CUDA solve");
        check(cudaEventElapsedTime(&download_ms, ctx.solved, ctx.done), "measure CUDA download");
        ctx.stats.host_to_device_ms = ctx.stats.resident_input ? 0 : upload_ms;
        ctx.stats.gpu_ms = solve_ms; ctx.stats.device_to_host_ms = download_ms;
        for (U32 g = 0; g < ctx.dimensions.group_count; ++g) {
            const auto p = ctx.progress.cpu<Progress>()[g];
            if (!p.converged) throw std::runtime_error("CUDA liveness exceeded its finite monotone convergence bound");
            ctx.stats.max_sweeps = std::max(ctx.stats.max_sweeps, p.sweeps);
            ctx.stats.frontier_visits += p.visits; ctx.stats.edges_examined += p.edges; ctx.stats.discovered_bits += p.bits;
        }
        std::memcpy(out, ctx.output.host, size_t(ctx.dimensions.cell_count) * sizeof(U32));
        ctx.stats.total_ms = elapsed(ctx.start); *stats = ctx.stats; ctx.in_flight = false; return 0;
    } catch (const std::exception &e) { ctx.drain(); error(err, capacity, e.what()); return -1; }
}
extern "C" int gpulab_cuda_pending(void *pointer, U32 *out_pending, char *err, size_t capacity) {
    if (!pointer || !out_pending) { error(err, capacity, "null CUDA context or pending output"); return -1; }
    auto &ctx = *static_cast<Context *>(pointer);
    *out_pending = 0;
    if (!ctx.in_flight) return 0;
    const auto status = cudaEventQuery(ctx.done);
    if (status == cudaErrorNotReady) { *out_pending = 1; return 0; }
    if (status == cudaSuccess) return 0;
    ctx.drain(); error(err, capacity, cudaGetErrorString(status)); return -1;
}
extern "C" void gpulab_cuda_destroy(void *pointer) { delete static_cast<Context *>(pointer); }
