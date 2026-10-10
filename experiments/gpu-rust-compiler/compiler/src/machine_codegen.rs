// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::codegen_service::{
    CallingConvention, Emission, ExecutionRecord, FlatBatch, FunctionEmission, Opcode,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MachineTarget {
    X86_64,
    Aarch64,
}

impl MachineTarget {
    pub fn number(self) -> u32 {
        match self {
            Self::X86_64 => 0,
            Self::Aarch64 => 1,
        }
    }
    pub fn host() -> Result<Self, String> {
        if cfg!(target_arch = "x86_64") {
            Ok(Self::X86_64)
        } else if cfg!(target_arch = "aarch64") {
            Ok(Self::Aarch64)
        } else {
            Err("native emission supports x86-64 and AArch64 only".into())
        }
    }
    pub fn host_triple(self) -> &'static str {
        match (self, cfg!(target_os = "macos")) {
            (Self::X86_64, true) => "x86_64-apple-darwin",
            (Self::X86_64, false) => "x86_64-unknown-linux-gnu",
            (Self::Aarch64, true) => "aarch64-apple-darwin",
            (Self::Aarch64, false) => "aarch64-unknown-linux-gnu",
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct PackedInstruction {
    pub opcode: u32,
    pub result: u32,
    pub a: u32,
    pub b: u32,
    pub immediate: i64,
}

pub const ARGUMENT: u32 = 0;
pub const CONSTANT: u32 = 1;
pub const COPY: u32 = 2;
pub const ADD: u32 = 3;
pub const SUB: u32 = 4;
pub const MUL: u32 = 5;
pub const RETURN: u32 = 6;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct PackedFunction {
    pub start: u32,
    pub count: u32,
    pub values: u32,
    pub symbol: u32,
}

pub struct Packet {
    pub target: MachineTarget,
    pub functions: Vec<PackedFunction>,
    pub instructions: Vec<PackedInstruction>,
    pub output_capacity: usize,
}

pub fn pack(batch: &FlatBatch, target: MachineTarget) -> Result<Packet, String> {
    let supported = match target {
        MachineTarget::X86_64 => matches!(
            batch.identity().target_abi.as_str(),
            "x86_64-unknown-linux-gnu" | "x86_64-apple-darwin"
        ),
        MachineTarget::Aarch64 => matches!(
            batch.identity().target_abi.as_str(),
            "aarch64-unknown-linux-gnu" | "aarch64-apple-darwin"
        ),
    };
    if !supported {
        return Err("batch target identity does not match machine-code target".into());
    }
    let mut functions = Vec::with_capacity(batch.functions().len());
    let mut output_capacity = 0usize;
    for f in batch.functions() {
        let abi = &batch.abis()[f.abi as usize];
        let compatible = match target {
            MachineTarget::X86_64 => abi.calling_convention == CallingConvention::SystemV,
            MachineTarget::Aarch64 => matches!(
                abi.calling_convention,
                CallingConvention::AppleAarch64 | CallingConvention::SystemV
            ),
        };
        if !compatible || !abi.returns_i64 || abi.parameter_count > 1 {
            return Err(
                "scalar emission requires matching C ABI and at most one i64 argument/result"
                    .into(),
            );
        }
        if f.value_count == 0 || f.value_count > 256 {
            return Err("scalar emission supports 1..256 value slots".into());
        }
        output_capacity = output_capacity
            .checked_add(12 + 25 * f.instruction_count as usize)
            .ok_or("output size overflow")?;
        functions.push(PackedFunction {
            start: f.instruction_start,
            count: f.instruction_count,
            values: f.value_count,
            symbol: f.symbol,
        });
    }
    if output_capacity > 512 * 1024 * 1024 {
        return Err("scalar emission output exceeds 512 MiB budget".into());
    }
    let instructions = batch
        .instructions()
        .iter()
        .map(|i| PackedInstruction {
            opcode: match i.opcode {
                Opcode::Argument => ARGUMENT,
                Opcode::Const => CONSTANT,
                Opcode::Copy => COPY,
                Opcode::Add => ADD,
                Opcode::Sub => SUB,
                Opcode::Mul => MUL,
                Opcode::Return => RETURN,
            },
            result: i.result.unwrap_or(u32::MAX),
            a: i.operands[0],
            b: i.operands[1],
            immediate: i.immediate,
        })
        .collect();
    Ok(Packet {
        target,
        functions,
        instructions,
        output_capacity,
    })
}

fn validate(values: u32, instructions: &[PackedInstruction]) -> Result<(), String> {
    if values == 0 || values > 256 || instructions.is_empty() {
        return Err("invalid scalar frame or empty function".into());
    }
    let mut definitions = vec![false; values as usize];
    for (pos, i) in instructions.iter().enumerate() {
        if (i.opcode == RETURN) != (pos + 1 == instructions.len()) {
            return Err("function must end with its only return".into());
        }
        let operands = match i.opcode {
            ARGUMENT | CONSTANT => 0,
            COPY | RETURN => 1,
            ADD | SUB | MUL => 2,
            _ => return Err("unsupported opcode".into()),
        };
        for value in [i.a, i.b].into_iter().take(operands) {
            if value >= values || !definitions[value as usize] {
                return Err("undefined operand".into());
            }
        }
        if i.opcode != RETURN {
            if i.result >= values || definitions[i.result as usize] {
                return Err("invalid or repeated definition".into());
            }
            definitions[i.result as usize] = true;
        }
        if i.opcode == ARGUMENT && i.immediate != 0 {
            return Err("only argument zero is supported".into());
        }
    }
    Ok(())
}

pub fn emit_function(
    target: MachineTarget,
    values: u32,
    instructions: &[PackedInstruction],
) -> Result<Vec<u8>, String> {
    validate(values, instructions)?;
    Ok(emit_validated(target, values, instructions))
}

fn emit_validated(
    target: MachineTarget,
    values: u32,
    instructions: &[PackedInstruction],
) -> Vec<u8> {
    let frame = (values * 8 + 15) & !15;
    let mut code = Vec::new();
    if target == MachineTarget::X86_64 {
        code.extend_from_slice(&[0x55, 0x48, 0x89, 0xe5, 0x48, 0x81, 0xec]);
        code.extend_from_slice(&frame.to_le_bytes());
        fn mem(out: &mut Vec<u8>, bytes: &[u8], slot: u32) {
            out.extend_from_slice(bytes);
            out.extend_from_slice(&(-8i32 * (slot as i32 + 1)).to_le_bytes());
        }
        for i in instructions {
            match i.opcode {
                ARGUMENT => mem(&mut code, &[0x48, 0x89, 0xbd], i.result),
                CONSTANT => {
                    code.extend_from_slice(&[0x48, 0xb8]);
                    code.extend_from_slice(&i.immediate.to_le_bytes());
                    mem(&mut code, &[0x48, 0x89, 0x85], i.result);
                }
                COPY => {
                    mem(&mut code, &[0x48, 0x8b, 0x85], i.a);
                    mem(&mut code, &[0x48, 0x89, 0x85], i.result);
                }
                ADD | SUB | MUL => {
                    mem(&mut code, &[0x48, 0x8b, 0x85], i.a);
                    mem(&mut code, &[0x4c, 0x8b, 0x95], i.b);
                    code.extend_from_slice(match i.opcode {
                        ADD => &[0x4c, 0x01, 0xd0][..],
                        SUB => &[0x4c, 0x29, 0xd0][..],
                        _ => &[0x49, 0x0f, 0xaf, 0xc2][..],
                    });
                    mem(&mut code, &[0x48, 0x89, 0x85], i.result);
                }
                RETURN => {
                    mem(&mut code, &[0x48, 0x8b, 0x85], i.a);
                    code.extend_from_slice(&[0xc9, 0xc3]);
                }
                _ => unreachable!(),
            }
        }
    } else {
        fn word(out: &mut Vec<u8>, value: u32) {
            out.extend_from_slice(&value.to_le_bytes());
        }
        word(&mut code, 0xa9bf7bfd);
        word(&mut code, 0x910003fd);
        word(&mut code, 0xd10003ff | (frame << 10));
        for i in instructions {
            match i.opcode {
                ARGUMENT => word(&mut code, 0xf90003e0 | (i.result << 10)),
                CONSTANT => {
                    let value = i.immediate as u64;
                    for part in 0..4 {
                        word(
                            &mut code,
                            (if part == 0 { 0xd2800009 } else { 0xf2800009 })
                                | (part << 21)
                                | (((value >> (part * 16)) as u32 & 0xffff) << 5),
                        );
                    }
                    word(&mut code, 0xf90003e9 | (i.result << 10));
                }
                COPY => {
                    word(&mut code, 0xf94003e9 | (i.a << 10));
                    word(&mut code, 0xf90003e9 | (i.result << 10));
                }
                ADD | SUB | MUL => {
                    word(&mut code, 0xf94003e9 | (i.a << 10));
                    word(&mut code, 0xf94003ea | (i.b << 10));
                    word(
                        &mut code,
                        match i.opcode {
                            ADD => 0x8b0a0129,
                            SUB => 0xcb0a0129,
                            _ => 0x9b0a7d29,
                        },
                    );
                    word(&mut code, 0xf90003e9 | (i.result << 10));
                }
                RETURN => {
                    word(&mut code, 0xf94003e0 | (i.a << 10));
                    word(&mut code, 0x910003bf);
                    word(&mut code, 0xa8c17bfd);
                    word(&mut code, 0xd65f03c0);
                }
                _ => unreachable!(),
            }
        }
    }
    code
}

pub fn cpu_emit(batch: &FlatBatch, target: MachineTarget) -> Result<Emission, String> {
    let packet = pack(batch, target)?;
    let functions = packet
        .functions
        .iter()
        .enumerate()
        .map(|(index, f)| {
            let code = emit_validated(
                target,
                f.values,
                &packet.instructions[f.start as usize..(f.start + f.count) as usize],
            );
            let unwind = if batch.abis()[batch.functions()[index].abi as usize].requires_unwind {
                unwind_descriptor(target, code.len())
            } else {
                Vec::new()
            };
            FunctionEmission {
                symbol: f.symbol,
                code,
                relocations: Vec::new(),
                unwind,
            }
        })
        .collect();
    Ok(Emission {
        functions,
        execution: ExecutionRecord::Cpu,
    })
}

/// Metadata describing the encoder's fixed frame. The object writer expands
/// this to platform records; it is not itself a serialized DWARF program.
pub fn unwind_descriptor(target: MachineTarget, length: usize) -> Vec<u8> {
    let mut descriptor = b"GUF1".to_vec();
    descriptor.extend_from_slice(&target.number().to_le_bytes());
    descriptor.extend_from_slice(&(length as u32).to_le_bytes());
    descriptor
}

fn dwarf_frame(target: MachineTarget, length: usize) -> (Vec<u8>, u64) {
    let mut out = vec![0; 4];
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&[1, b'z', b'R', 0, 1, 0x78]);
    out.extend_from_slice(&[
        if target == MachineTarget::X86_64 {
            16
        } else {
            30
        },
        1,
        0x1b,
    ]);
    out.extend_from_slice(if target == MachineTarget::X86_64 {
        &[0x0c, 7, 8, 0x90, 1, 0x08, 6]
    } else {
        &[0x0c, 31, 0, 0x08, 30, 0x08, 29]
    });
    while !out.len().is_multiple_of(4) {
        out.push(0);
    }
    let len = (out.len() - 4) as u32;
    out[..4].copy_from_slice(&len.to_le_bytes());
    let fde = out.len();
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&((fde + 4) as u32).to_le_bytes());
    let location = out.len() as u64;
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&(length as u32).to_le_bytes());
    out.push(0);
    if target == MachineTarget::X86_64 {
        // push rbp; mov rbp,rsp; ...; leave; ret. CFA follows rsp at entry,
        // then rbp+16, then rsp+8 after leave restores the caller's frame.
        out.extend_from_slice(&[0x41, 0x0e, 16, 0x86, 2, 0x43, 0x0d, 6, 0x04]);
        out.extend_from_slice(&((length - 5) as u32).to_le_bytes());
        out.extend_from_slice(&[0x0c, 7, 8, 0xc6]);
    } else {
        // stp fp,lr,[sp,-16]!; mov fp,sp; ...; ldp fp,lr,[sp],16; ret.
        out.extend_from_slice(&[0x44, 0x0e, 16, 0x9d, 2, 0x9e, 1, 0x44, 0x0d, 29, 0x04]);
        out.extend_from_slice(&((length - 12) as u32).to_le_bytes());
        out.extend_from_slice(&[0x0c, 31, 0, 0xdd, 0xde]);
    }
    while !out.len().is_multiple_of(4) {
        out.push(0);
    }
    let len = (out.len() - fde - 4) as u32;
    out[fde..fde + 4].copy_from_slice(&len.to_le_bytes());
    (out, location)
}

pub fn write_object(
    batch: &FlatBatch,
    target: MachineTarget,
    emission: &Emission,
) -> Result<Vec<u8>, String> {
    use object::write::{Object, StandardSection, Symbol, SymbolSection};
    let format = if batch.identity().target_abi.contains("apple") {
        object::BinaryFormat::MachO
    } else {
        object::BinaryFormat::Elf
    };
    let architecture = match target {
        MachineTarget::X86_64 => object::Architecture::X86_64,
        MachineTarget::Aarch64 => object::Architecture::Aarch64,
    };
    let mut object = Object::new(format, architecture, object::Endianness::Little);
    let text = object.section_id(StandardSection::Text);
    if emission.functions.len() != batch.functions().len() {
        return Err("incomplete object emission".into());
    }
    let mut functions: Vec<_> = emission.functions.iter().collect();
    functions.sort_by_key(|f| f.symbol);
    let mut unwind_section = None;
    let mut macho_unwind = None;
    for f in functions {
        if !f.relocations.is_empty() {
            return Err("scalar object writer does not support code relocations".into());
        }
        if !f.unwind.is_empty() && f.unwind != unwind_descriptor(target, f.code.len()) {
            return Err("unwind descriptor does not match fixed-frame encoder".into());
        }
        let name = &batch
            .symbols()
            .get(f.symbol as usize)
            .ok_or("unknown symbol")?
            .name;
        if !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
            return Err("fixture symbol must be a C identifier".into());
        }
        let offset = object.append_section_data(text, &f.code, 16);
        let symbol = object.add_symbol(Symbol {
            name: name.as_bytes().to_vec(),
            value: offset,
            size: f.code.len() as u64,
            kind: object::SymbolKind::Text,
            scope: object::SymbolScope::Dynamic,
            weak: false,
            section: SymbolSection::Section(text),
            flags: object::SymbolFlags::None,
        });
        if !f.unwind.is_empty() {
            if format == object::BinaryFormat::MachO {
                let sections = macho_unwind
                    .get_or_insert_with(|| crate::macho_unwind::Sections::new(&mut object));
                sections.append(&mut object, target, symbol, f.code.len())?;
                continue;
            }
            let section = *unwind_section.get_or_insert_with(|| {
                object.add_section(
                    Vec::new(),
                    b".eh_frame".to_vec(),
                    object::SectionKind::ReadOnlyData,
                )
            });
            let (data, location) = dwarf_frame(target, f.code.len());
            let base = object.append_section_data(section, &data, 8);
            object
                .add_relocation(
                    section,
                    object::write::Relocation {
                        offset: base + location,
                        symbol,
                        addend: 0,
                        flags: object::RelocationFlags::Generic {
                            kind: object::RelocationKind::Relative,
                            encoding: object::RelocationEncoding::Generic,
                            size: 32,
                        },
                    },
                )
                .map_err(|e| e.to_string())?;
        }
    }
    if let Some(sections) = macho_unwind {
        sections.finish(&mut object)?;
    }
    if format == object::BinaryFormat::Elf {
        object.add_section(
            Vec::new(),
            b".note.GNU-stack".to_vec(),
            object::SectionKind::Other,
        );
    }
    object.write().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arm_leaf_constant_has_native_return_and_fixed_frame() {
        let input = [
            PackedInstruction {
                opcode: CONSTANT,
                result: 0,
                a: 0,
                b: 0,
                immediate: 42,
            },
            PackedInstruction {
                opcode: RETURN,
                result: u32::MAX,
                a: 0,
                b: 0,
                immediate: 0,
            },
        ];
        let code = emit_function(MachineTarget::Aarch64, 1, &input).unwrap();
        assert_eq!(code.len(), 48);
        assert_eq!(&code[..4], &0xa9bf7bfdu32.to_le_bytes());
        assert_eq!(&code[code.len() - 4..], &0xd65f03c0u32.to_le_bytes());
    }

    #[test]
    fn x86_leaf_constant_has_native_return_and_fixed_frame() {
        let input = [
            PackedInstruction {
                opcode: CONSTANT,
                result: 0,
                a: 0,
                b: 0,
                immediate: 42,
            },
            PackedInstruction {
                opcode: RETURN,
                result: u32::MAX,
                a: 0,
                b: 0,
                immediate: 0,
            },
        ];
        let code = emit_function(MachineTarget::X86_64, 1, &input).unwrap();
        assert_eq!(code.len(), 37);
        assert_eq!(&code[..4], &[0x55, 0x48, 0x89, 0xe5]);
        assert_eq!(&code[code.len() - 2..], &[0xc9, 0xc3]);
    }
}
