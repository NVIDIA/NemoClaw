// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::machine_codegen::MachineTarget;
use object::write::{Object, SectionId, SymbolId};

pub struct Sections {
    frame: SectionId,
    compact: SectionId,
    pairs: Vec<(u64, SymbolId, SymbolId, MachineTarget)>,
}

impl Sections {
    pub fn new(object: &mut Object<'_>) -> Self {
        // Each exported leaf is an independent atom. Without this flag, Apple's
        // linker can give the last function a zero-sized compact unwind range.
        let flags = match object.flags {
            object::FileFlags::MachO { flags } => flags,
            _ => 0,
        };
        object.flags = object::FileFlags::MachO {
            flags: flags | object::macho::MH_SUBSECTIONS_VIA_SYMBOLS,
        };
        let frame = object.add_section(
            b"__TEXT".to_vec(),
            b"__eh_frame".to_vec(),
            object::SectionKind::ReadOnlyData,
        );
        object.section_mut(frame).flags = object::SectionFlags::MachO {
            flags: object::macho::S_COALESCED
                | object::macho::S_ATTR_NO_TOC
                | object::macho::S_ATTR_STRIP_STATIC_SYMS
                | object::macho::S_ATTR_LIVE_SUPPORT,
        };
        let compact = object.add_section(
            b"__LD".to_vec(),
            b"__compact_unwind".to_vec(),
            object::SectionKind::ReadOnlyData,
        );
        object.section_mut(compact).flags = object::SectionFlags::MachO {
            flags: object::macho::S_ATTR_DEBUG,
        };
        Self {
            frame,
            compact,
            pairs: Vec::new(),
        }
    }

    pub fn append(
        &mut self,
        object: &mut Object<'_>,
        target: MachineTarget,
        symbol: SymbolId,
        length: usize,
    ) -> Result<(), String> {
        if length < 20
            || length > u32::MAX as usize
            || (target == MachineTarget::Aarch64 && (length < 28 || !length.is_multiple_of(4)))
        {
            return Err("invalid fixed-frame code length for unwind records".into());
        }
        let (frame, pointer) = dwarf_record(target, length);
        let offset = object.append_section_data(self.frame, &frame, 8);
        let location = offset + pointer as u64;
        let anchor = object.add_symbol(object::write::Symbol {
            name: format!("L_gpu_fde_{location}").into_bytes(),
            value: location,
            size: 0,
            kind: object::SymbolKind::Data,
            scope: object::SymbolScope::Compilation,
            weak: false,
            section: object::write::SymbolSection::Section(self.frame),
            flags: object::SymbolFlags::None,
        });
        self.pairs.push((location, anchor, symbol, target));
        let mut compact = vec![0; 8];
        compact.extend_from_slice(&(length as u32).to_le_bytes());
        compact.extend_from_slice(
            &(if target == MachineTarget::Aarch64 {
                0x0300_0000u32
            } else {
                0x0400_0000u32
            })
            .to_le_bytes(),
        );
        compact.extend_from_slice(&[0; 16]);
        let offset = object.append_section_data(self.compact, &compact, 8);
        object
            .add_relocation(
                self.compact,
                object::write::Relocation {
                    offset,
                    symbol,
                    addend: 0,
                    flags: object::RelocationFlags::Generic {
                        kind: object::RelocationKind::Absolute,
                        encoding: object::RelocationEncoding::Generic,
                        size: 64,
                    },
                },
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn finish(self, object: &mut Object<'_>) -> Result<(), String> {
        // object 0.37 reverses ascending relocation vectors wholesale. Descending
        // groups preserve the required SUBTRACTOR followed by UNSIGNED pair.
        for (offset, anchor, symbol, target) in self.pairs.into_iter().rev() {
            let (subtractor, unsigned) = if target == MachineTarget::Aarch64 {
                (
                    object::macho::ARM64_RELOC_SUBTRACTOR,
                    object::macho::ARM64_RELOC_UNSIGNED,
                )
            } else {
                (
                    object::macho::X86_64_RELOC_SUBTRACTOR,
                    object::macho::X86_64_RELOC_UNSIGNED,
                )
            };
            for (r_type, symbol) in [(subtractor, anchor), (unsigned, symbol)] {
                object
                    .add_relocation(
                        self.frame,
                        object::write::Relocation {
                            offset,
                            symbol,
                            addend: 0,
                            flags: object::RelocationFlags::MachO {
                                r_type,
                                r_pcrel: false,
                                r_length: 3,
                            },
                        },
                    )
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
}

fn dwarf_record(target: MachineTarget, length: usize) -> (Vec<u8>, usize) {
    let mut out = vec![0; 4];
    out.extend_from_slice(&0u32.to_le_bytes());
    // DWARF32 CIE v1, zR augmentation, code alignment 1/data alignment -8.
    // Mach-O ld requires PC-relative target-width pointers (DW_EH_PE_pcrel).
    out.extend_from_slice(&[
        1,
        b'z',
        b'R',
        0,
        1,
        0x78,
        if target == MachineTarget::X86_64 {
            16
        } else {
            30
        },
        1,
        0x10,
    ]);
    out.extend_from_slice(if target == MachineTarget::X86_64 {
        &[0x0c, 7, 8, 0x90, 1, 0x08, 6]
    } else {
        &[0x0c, 31, 0, 0x08, 30, 0x08, 29]
    });
    while !out.len().is_multiple_of(8) {
        out.push(0);
    }
    let size = (out.len() - 4) as u32;
    out[..4].copy_from_slice(&size.to_le_bytes());
    let fde = out.len();
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&((fde + 4) as u32).to_le_bytes());
    let pointer = out.len();
    out.extend_from_slice(&0u64.to_le_bytes());
    out.extend_from_slice(&(length as u64).to_le_bytes());
    out.push(0);
    if target == MachineTarget::X86_64 {
        out.extend_from_slice(&[0x41, 0x0e, 16, 0x86, 2, 0x43, 0x0d, 6, 0x04]);
        out.extend_from_slice(&((length - 5) as u32).to_le_bytes());
        out.extend_from_slice(&[0x0c, 7, 8, 0xc6]);
    } else {
        out.extend_from_slice(&[0x44, 0x0e, 16, 0x9d, 2, 0x9e, 1, 0x44, 0x0d, 29, 0x04]);
        out.extend_from_slice(&((length - 12) as u32).to_le_bytes());
        out.extend_from_slice(&[0x0c, 31, 0, 0xdd, 0xde]);
    }
    while !out.len().is_multiple_of(8) {
        out.push(0);
    }
    let size = (out.len() - fde - 4) as u32;
    out[fde..fde + 4].copy_from_slice(&size.to_le_bytes());
    (out, pointer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use object::write::{StandardSection, Symbol, SymbolSection};
    use object::{Object as _, ObjectSection as _};

    #[test]
    fn fixed_frame_uses_dwarf_compact_mode_and_retains_precise_eh_frame_rows() {
        for (target, architecture, encoding, length) in [
            (
                MachineTarget::Aarch64,
                object::Architecture::Aarch64,
                0x0300_0000u32,
                48,
            ),
            (
                MachineTarget::X86_64,
                object::Architecture::X86_64,
                0x0400_0000u32,
                37,
            ),
        ] {
            let mut object = Object::new(
                object::BinaryFormat::MachO,
                architecture,
                object::Endianness::Little,
            );
            let text = object.section_id(StandardSection::Text);
            let mut sections = Sections::new(&mut object);
            for name in [b"async_leaf".as_slice(), b"async_leaf_second".as_slice()] {
                let offset = object.append_section_data(text, &vec![0u8; length], 16);
                let symbol = object.add_symbol(Symbol {
                    name: name.to_vec(),
                    value: offset,
                    size: length as u64,
                    kind: object::SymbolKind::Text,
                    scope: object::SymbolScope::Dynamic,
                    weak: false,
                    section: SymbolSection::Section(text),
                    flags: object::SymbolFlags::None,
                });
                sections
                    .append(&mut object, target, symbol, length)
                    .unwrap();
            }
            sections.finish(&mut object).unwrap();
            let bytes = object.write().unwrap();
            let file = object::File::parse(bytes.as_slice()).unwrap();
            assert!(matches!(
                file.flags(),
                object::FileFlags::MachO { flags }
                    if flags & object::macho::MH_SUBSECTIONS_VIA_SYMBOLS != 0
            ));
            let frame = file.section_by_name("__eh_frame").unwrap();
            assert!(!frame.data().unwrap().is_empty());
            let relocations: Vec<_> = frame.relocations().collect();
            assert_eq!(relocations.len(), 4);
            let (subtractor, unsigned) = if target == MachineTarget::Aarch64 {
                (
                    object::macho::ARM64_RELOC_SUBTRACTOR,
                    object::macho::ARM64_RELOC_UNSIGNED,
                )
            } else {
                (
                    object::macho::X86_64_RELOC_SUBTRACTOR,
                    object::macho::X86_64_RELOC_UNSIGNED,
                )
            };
            for pair in relocations.as_chunks::<2>().0 {
                assert_eq!(pair[0].0, pair[1].0);
                for (relocation, r_type) in pair.iter().zip([subtractor, unsigned]) {
                    assert_eq!(
                        relocation.1.flags(),
                        object::RelocationFlags::MachO {
                            r_type,
                            r_pcrel: false,
                            r_length: 3,
                        }
                    );
                }
            }
            assert!(relocations[0].0 > relocations[2].0);
            let compact = file.section_by_name("__compact_unwind").unwrap();
            assert_eq!(compact.data().unwrap().len(), 64);
            for entry in compact.data().unwrap().as_chunks::<32>().0 {
                assert_eq!(
                    u32::from_le_bytes(entry[12..16].try_into().unwrap()),
                    encoding
                );
            }
        }
    }
}
