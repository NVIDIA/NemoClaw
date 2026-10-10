// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#include <metal_stdlib>
using namespace metal;

struct EmitFunction { uint start, count, values, symbol; };
// The two words preserve the host i64 bit pattern without requiring GPU i64
// arithmetic. The CPU/shader ABI is 24 bytes with immediate at byte 16.
struct EmitInstruction { uint opcode, result, a, b; uint2 immediate; };
struct EmitParameters { uint function_count, target, output_capacity, reserved; };

kernel void gpuemit_count(
    device const EmitFunction *functions [[buffer(0)]],
    device const EmitInstruction *instructions [[buffer(1)]],
    device uint *lengths [[buffer(2)]],
    constant EmitParameters &parameters [[buffer(3)]],
    uint index [[thread_position_in_grid]]) {
    if (index >= parameters.function_count) return;
    EmitFunction function = functions[index];
    uint length = parameters.target == 0 ? 11 : 12;
    for (uint position = 0; position < function.count; ++position) {
        uint opcode = instructions[function.start + position].opcode;
        if (parameters.target == 0) {
            switch (opcode) {
                case 0: length += 7; break;
                case 1: length += 17; break;
                case 2: length += 14; break;
                case 3: case 4: length += 24; break;
                case 5: length += 25; break;
                case 6: length += 9; break;
                default: lengths[index] = 0; return;
            }
        } else {
            switch (opcode) {
                case 0: length += 4; break;
                case 1: length += 20; break;
                case 2: length += 8; break;
                case 3: case 4: case 5: length += 16; break;
                case 6: length += 16; break;
                default: lengths[index] = 0; return;
            }
        }
    }
    lengths[index] = length;
}

void emit_byte(device uchar *output, thread uint &position, uchar value) {
    output[position++] = value;
}

void emit_word(device uchar *output, thread uint &position, uint value) {
    for (uint byte = 0; byte < 4; ++byte) emit_byte(output, position, uchar(value >> (byte * 8)));
}

void x86_memory(device uchar *output, thread uint &position,
                uchar rex, uchar operation, uchar mode, uint slot) {
    emit_byte(output, position, rex);
    emit_byte(output, position, operation);
    emit_byte(output, position, mode);
    emit_word(output, position, uint(-8 * int(slot + 1)));
}

void x86_emit(device uchar *output, thread uint &position,
              EmitFunction function, device const EmitInstruction *instructions) {
    emit_byte(output, position, 0x55);
    emit_byte(output, position, 0x48);
    emit_byte(output, position, 0x89);
    emit_byte(output, position, 0xe5);
    emit_byte(output, position, 0x48);
    emit_byte(output, position, 0x81);
    emit_byte(output, position, 0xec);
    emit_word(output, position, (function.values * 8 + 15) & ~15u);
    for (uint number = 0; number < function.count; ++number) {
        EmitInstruction instruction = instructions[function.start + number];
        switch (instruction.opcode) {
            case 0:
                x86_memory(output, position, 0x48, 0x89, 0xbd, instruction.result);
                break;
            case 1:
                emit_byte(output, position, 0x48); emit_byte(output, position, 0xb8);
                emit_word(output, position, instruction.immediate.x);
                emit_word(output, position, instruction.immediate.y);
                x86_memory(output, position, 0x48, 0x89, 0x85, instruction.result);
                break;
            case 2:
                x86_memory(output, position, 0x48, 0x8b, 0x85, instruction.a);
                x86_memory(output, position, 0x48, 0x89, 0x85, instruction.result);
                break;
            case 3: case 4: case 5:
                x86_memory(output, position, 0x48, 0x8b, 0x85, instruction.a);
                x86_memory(output, position, 0x4c, 0x8b, 0x95, instruction.b);
                if (instruction.opcode == 5) {
                    emit_byte(output, position, 0x49); emit_byte(output, position, 0x0f);
                    emit_byte(output, position, 0xaf); emit_byte(output, position, 0xc2);
                } else {
                    emit_byte(output, position, 0x4c);
                    emit_byte(output, position, instruction.opcode == 3 ? 0x01 : 0x29);
                    emit_byte(output, position, 0xd0);
                }
                x86_memory(output, position, 0x48, 0x89, 0x85, instruction.result);
                break;
            case 6:
                x86_memory(output, position, 0x48, 0x8b, 0x85, instruction.a);
                emit_byte(output, position, 0xc9); emit_byte(output, position, 0xc3);
                break;
        }
    }
}

void arm_emit(device uchar *output, thread uint &position,
              EmitFunction function, device const EmitInstruction *instructions) {
    emit_word(output, position, 0xa9bf7bfd);
    emit_word(output, position, 0x910003fd);
    emit_word(output, position, 0xd10003ff | (((function.values * 8 + 15) & ~15u) << 10));
    for (uint number = 0; number < function.count; ++number) {
        EmitInstruction instruction = instructions[function.start + number];
        switch (instruction.opcode) {
            case 0:
                emit_word(output, position, 0xf90003e0 | (instruction.result << 10));
                break;
            case 1:
                for (uint part = 0; part < 4; ++part) {
                    uint value = part < 2 ? instruction.immediate.x : instruction.immediate.y;
                    uint chunk = (value >> ((part & 1) * 16)) & 0xffff;
                    emit_word(output, position, (part == 0 ? 0xd2800009 : 0xf2800009) |
                              (part << 21) | (chunk << 5));
                }
                emit_word(output, position, 0xf90003e9 | (instruction.result << 10));
                break;
            case 2:
                emit_word(output, position, 0xf94003e9 | (instruction.a << 10));
                emit_word(output, position, 0xf90003e9 | (instruction.result << 10));
                break;
            case 3: case 4: case 5:
                emit_word(output, position, 0xf94003e9 | (instruction.a << 10));
                emit_word(output, position, 0xf94003ea | (instruction.b << 10));
                emit_word(output, position, instruction.opcode == 3 ? 0x8b0a0129 :
                          (instruction.opcode == 4 ? 0xcb0a0129 : 0x9b0a7d29));
                emit_word(output, position, 0xf90003e9 | (instruction.result << 10));
                break;
            case 6:
                emit_word(output, position, 0xf94003e0 | (instruction.a << 10));
                emit_word(output, position, 0x910003bf);
                emit_word(output, position, 0xa8c17bfd);
                emit_word(output, position, 0xd65f03c0);
                break;
        }
    }
}

kernel void gpuemit_emit(
    device const EmitFunction *functions [[buffer(0)]],
    device const EmitInstruction *instructions [[buffer(1)]],
    device const uint *offsets [[buffer(2)]],
    device const uint *lengths [[buffer(3)]],
    device uchar *output [[buffer(4)]],
    device uint *statuses [[buffer(5)]],
    constant EmitParameters &parameters [[buffer(6)]],
    uint index [[thread_position_in_grid]]) {
    if (index >= parameters.function_count) return;
    uint offset = offsets[index], length = lengths[index];
    statuses[index] = 0;
    if (!length || offset > parameters.output_capacity || length > parameters.output_capacity - offset) return;
    uint position = 0;
    if (parameters.target == 0) x86_emit(output + offset, position, functions[index], instructions);
    else arm_emit(output + offset, position, functions[index], instructions);
    statuses[index] = position == length ? 1 : 0;
}
