// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#ifndef GPULAB_CUDA_BRIDGE_H
#define GPULAB_CUDA_BRIDGE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct GPULabCudaGroup {
    uint32_t block_base, block_count, row_base, words, word;
} GPULabCudaGroup;

typedef struct GPULabCudaInput {
    uint32_t function_count, block_count, cell_count, group_count, max_blocks, edge_count;
    const GPULabCudaGroup *groups;
    const uint32_t *successor_offsets, *successors;
    const uint32_t *predecessor_offsets, *predecessors;
    const uint32_t *uses, *defs, *phi_out;
} GPULabCudaInput;

typedef struct GPULabCudaStats {
    /* initialization_ms is the context's one-time creation cost, retained on
     * later requests for provenance. total_ms excludes that creation cost. */
    double initialization_ms, staging_ms, host_to_device_ms, gpu_ms, device_to_host_ms, total_ms;
    uint32_t max_sweeps, reused_context, device_allocations, pinned_allocations, resident_input;
    uint64_t frontier_visits, edges_examined, discovered_bits;
} GPULabCudaStats;

typedef struct GPULabCudaCapabilities {
    char device_name[256];
    char device_uuid[64];
    int32_t driver_version, runtime_version, compute_major, compute_minor;
    int32_t unified_addressing, managed_memory, concurrent_managed_access;
    int32_t pageable_memory_access, host_page_tables, direct_managed_access, async_engine_count;
    /* Capability discovery does not establish coherent placement performance. */
    int32_t coherent_placement_verified;
} GPULabCudaCapabilities;

enum { GPULAB_CUDA_DENSE = 0, GPULAB_CUDA_SPARSE = 1 };

/* ABI version 1. Callers must serialize all calls on each context; this API
 * does not provide synchronization between concurrent host callers.
 * The caller owns arrays until submit returns, at which point
 * every input is captured in context-owned pinned memory. Groups occur in
 * function order and then word order, covering each cell exactly once; both
 * CSR arrays must describe the same edge multiset. One submit may be in
 * flight. Finish waits for its stream event and copies a complete result.
 * Destroy drains work before releasing device/pinned buffers and CUDA state.
 * Errors drain outstanding work and invalidate resident replay. There is no
 * CPU fallback. A rejected concurrent submit leaves existing work pending.
 * Resident replay accepts no new facts: it solves the last uploaded snapshot
 * again, reseeding values/frontiers, with zero host/device input transfers.
 * A too-short finish output leaves the request pending.
 */
uint32_t gpulab_cuda_abi_version(void);
void *gpulab_cuda_create(char *err, size_t err_capacity);
int gpulab_cuda_capabilities(void *context, GPULabCudaCapabilities *out,
                             char *err, size_t err_capacity);
int gpulab_cuda_submit(void *context, const GPULabCudaInput *input, uint32_t algorithm,
                       char *err, size_t err_capacity);
int gpulab_cuda_submit_resident(void *context, uint32_t algorithm,
                                char *err, size_t err_capacity);
/* Query the completion event without waiting or consuming the result. A zero
 * pending value also covers an already completed request awaiting finish. */
int gpulab_cuda_pending(void *context, uint32_t *out_pending,
                        char *err, size_t err_capacity);
int gpulab_cuda_finish(void *context, uint32_t *out, size_t out_count,
                       GPULabCudaStats *stats, char *err, size_t err_capacity);
void gpulab_cuda_destroy(void *context);

#ifdef __cplusplus
}
#endif
#endif
