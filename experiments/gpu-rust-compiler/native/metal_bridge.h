// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#ifndef GPULAB_METAL_BRIDGE_H
#define GPULAB_METAL_BRIDGE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* This layout is identical to Group in src/liveness.metal. */
typedef struct GPULabGroup {
    uint32_t block_base;
    uint32_t block_count;
    uint32_t row_base;
    uint32_t words;
    uint32_t word;
} GPULabGroup;

typedef struct GPULabInput {
    uint32_t function_count;
    uint32_t block_count;
    uint32_t cell_count;
    uint32_t group_count;
    uint32_t max_blocks;
    uint32_t edge_count;
    const GPULabGroup *groups;
    const uint32_t *successor_offsets; /* block_count + 1 entries */
    const uint32_t *successors;        /* edge_count entries, may be NULL if zero */
    const uint32_t *uses;              /* cell_count entries */
    const uint32_t *defs;              /* cell_count entries */
    const uint32_t *phi_out;           /* cell_count entries */
} GPULabInput;

typedef struct GPULabStats {
    double gpu_ms;   /* Metal command buffer GPU timestamps, not host elapsed time */
    double total_ms; /* submit entry through completed result copy */
    uint32_t max_sweeps;
    uint32_t reused_pipeline;   /* 0 for the first submit, 1 for subsequent submits */
    uint32_t buffer_allocations; /* buffers created or grown by this submit */
} GPULabStats;

/* Every API writes a NUL-terminated diagnostic if err_capacity > 0 and err != NULL.
 * create returns NULL and submit/finish return -1 on error, 0 on success.
 * Input and output arrays must be valid for the declared lengths. Inputs are
 * copied during submit; their storage may be released as soon as submit returns.
 * A context permits one in-flight submit. Finish consumes that submit, including
 * when a completed GPU command fails. A too-small output leaves it pending.
 * Different contexts may be used concurrently; do not destroy a context while
 * another thread is calling it. Destroy waits for an outstanding GPU command.
 */
void *gpulab_create(const char *shader_path, char *err, size_t err_capacity);
int gpulab_submit(void *context, const GPULabInput *input,
                  char *err, size_t err_capacity);
int gpulab_finish(void *context, uint32_t *out, size_t out_count,
                  GPULabStats *stats, char *err, size_t err_capacity);
void gpulab_destroy(void *context);

#ifdef __cplusplus
}
#endif
#endif
