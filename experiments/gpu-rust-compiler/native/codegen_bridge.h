// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#ifndef GPUEMIT_BRIDGE_H
#define GPUEMIT_BRIDGE_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct GPUEmitInstruction {
    uint32_t opcode, result, a, b;
    int64_t immediate;
} GPUEmitInstruction;
typedef struct GPUEmitFunction {uint32_t start, count, values, symbol;} GPUEmitFunction;
typedef struct GPUEmitInput {
    uint32_t function_count, instruction_count, target, reserved;
    uint64_t output_capacity;
    const GPUEmitFunction *functions;
    const GPUEmitInstruction *instructions;
} GPUEmitInput;
typedef struct GPUEmitStats {
    double gpu_ms, total_ms;
    double host_prefix_ms, count_gpu_ms, emit_gpu_ms;
    uint64_t kernel_dispatches, output_bytes;
    uint32_t buffer_allocations, reused_pipeline;
} GPUEmitStats;
/* Schema 1: straight-line wrapping i64 leaf C functions, one argument maximum,
 * no calls/code relocations. The CPU object writer supplies required fixed-frame
 * unwind metadata. target=0 x86-64 SysV; target=1 ARM64.
 * submit captures inputs. A context has one outstanding request. finish requires
 * output_capacity bytes plus function_count offsets and lengths. A short result
 * buffer leaves the request pending. destroy fences pending work before freeing
 * storage. Different device-owned contexts may run concurrently.
 * Shader path is required for Metal and unused by CUDA. Every failure writes a
 * bounded NUL-terminated diagnostic. This is not a complete Rust backend.
 */
void *gpuemit_create(const char *shader_path, uint32_t device_index, char *error, size_t capacity);
int gpuemit_device_id(void *context, char *output, size_t capacity);
int gpuemit_submit(void *context, const GPUEmitInput *input, char *error, size_t capacity);
int gpuemit_finish(void *context, uint8_t *output, size_t output_capacity,
    uint32_t *offsets, uint32_t *lengths, size_t function_count,
    GPUEmitStats *stats, char *error, size_t capacity);
void gpuemit_destroy(void *context);
#ifdef __cplusplus
}
#endif
#endif
