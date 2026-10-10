// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use gpu_rust_compiler::{codegen_service::*, machine_codegen::*};
use std::{
    fs,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(1);

fn fixture(target: &str) -> FlatBatch {
    FlatBatch::new(
        BatchIdentity {
            workload_id: "native-arithmetic".into(),
            toolchain_id: "rust1.98.1".into(),
            policy_id: "fast-leaf-v1".into(),
            target_abi: target.into(),
            source_revision: "test".into(),
        },
        BatchKey {
            logical_id: "leaf".into(),
            generation: 1,
        },
        vec![Function {
            symbol: 0,
            instruction_start: 0,
            instruction_count: 6,
            value_count: 5,
            abi: 0,
        }],
        vec![
            Instruction {
                opcode: Opcode::Argument,
                result: Some(0),
                operands: [0, 0],
                immediate: 0,
            },
            Instruction {
                opcode: Opcode::Const,
                result: Some(1),
                operands: [0, 0],
                immediate: -7,
            },
            Instruction {
                opcode: Opcode::Mul,
                result: Some(2),
                operands: [0, 1],
                immediate: 0,
            },
            Instruction {
                opcode: Opcode::Const,
                result: Some(3),
                operands: [0, 0],
                immediate: 19,
            },
            Instruction {
                opcode: Opcode::Add,
                result: Some(4),
                operands: [2, 3],
                immediate: 0,
            },
            Instruction {
                opcode: Opcode::Return,
                result: None,
                operands: [4, 0],
                immediate: 0,
            },
        ],
        vec![Symbol {
            name: "gpu_leaf".into(),
        }],
        vec![Abi {
            calling_convention: if target.contains("apple") && target.starts_with("aarch64") {
                CallingConvention::AppleAarch64
            } else {
                CallingConvention::SystemV
            },
            parameter_count: 1,
            returns_i64: true,
            requires_unwind: false,
        }],
    )
    .unwrap()
}

#[test]
fn target_identity_must_match_the_machine_code_target() {
    let input = fixture("x86_64-unknown-linux-gnu");
    assert!(pack(&input, MachineTarget::Aarch64).is_err());
}

#[test]
fn externally_visible_rust_definitions_remain_public_in_native_objects() {
    use object::{Object as _, ObjectSymbol as _};
    for (triple, target) in [
        ("x86_64-unknown-linux-gnu", MachineTarget::X86_64),
        ("aarch64-apple-darwin", MachineTarget::Aarch64),
    ] {
        let input = fixture(triple);
        let emission = cpu_emit(&input, target).unwrap();
        let data = write_object(&input, target, &emission).unwrap();
        let object = object::File::parse(data.as_slice()).unwrap();
        let symbol = object
            .symbols()
            .find(|s| s.name().unwrap_or("").trim_start_matches('_') == "gpu_leaf")
            .unwrap();
        assert_eq!(symbol.scope(), object::SymbolScope::Dynamic);
    }
}

#[test]
fn required_unwind_emits_metadata_for_fixed_native_frames() {
    use object::{Object as _, ObjectSection as _};
    for (triple, target, section) in [
        (
            "x86_64-unknown-linux-gnu",
            MachineTarget::X86_64,
            ".eh_frame",
        ),
        (
            "aarch64-unknown-linux-gnu",
            MachineTarget::Aarch64,
            ".eh_frame",
        ),
        (
            "aarch64-apple-darwin",
            MachineTarget::Aarch64,
            "__compact_unwind",
        ),
        ("aarch64-apple-darwin", MachineTarget::Aarch64, "__eh_frame"),
        ("x86_64-apple-darwin", MachineTarget::X86_64, "__eh_frame"),
    ] {
        let base = fixture(triple);
        let mut abis = base.abis().to_vec();
        abis[0].requires_unwind = true;
        let input = FlatBatch::new(
            base.identity().clone(),
            base.key().clone(),
            base.functions().to_vec(),
            base.instructions().to_vec(),
            base.symbols().to_vec(),
            abis,
        )
        .unwrap();
        let emission = cpu_emit(&input, target).unwrap();
        assert!(!emission.functions[0].unwind.is_empty());
        let bytes = write_object(&input, target, &emission).unwrap();
        let object = object::File::parse(bytes.as_slice()).unwrap();
        assert!(!object
            .section_by_name(section)
            .unwrap()
            .data()
            .unwrap()
            .is_empty());
    }
}

#[test]
fn emitted_cpu_object_links_and_runs_wrapping_arithmetic() {
    let target = MachineTarget::host().unwrap();
    let triple = target.host_triple();
    let input = fixture(triple);
    let emission = cpu_emit(&input, target).unwrap();
    let bytes = write_object(&input, target, &emission).unwrap();
    let dir = std::env::temp_dir().join(format!(
        "gpuemit-object-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("leaf.o"), bytes).unwrap();
    fs::write(dir.join("main.c"),"#include <stdint.h>\n#include <stdio.h>\n#include <inttypes.h>\nextern uint64_t gpu_leaf(uint64_t);\nint main(void){uint64_t inputs[]={0,1,UINT64_MAX,INT64_MAX,(uint64_t)INT64_MIN};for(int i=0;i<5;i++)printf(\"%\" PRIu64 \"\\n\",gpu_leaf(inputs[i]));return 0;}\n").unwrap();
    let out = Command::new("clang")
        .arg(dir.join("main.c"))
        .arg(dir.join("leaf.o"))
        .arg("-o")
        .arg(dir.join("probe"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let output = Command::new(dir.join("probe")).output().unwrap();
    assert!(output.status.success());
    let expected = [0i64, 1, -1, i64::MAX, i64::MIN]
        .iter()
        .map(|v| format!("{}\n", v.wrapping_mul(-7).wrapping_add(19) as u64))
        .collect::<String>();
    assert_eq!(String::from_utf8(output.stdout).unwrap(), expected);
    fs::remove_dir_all(dir).unwrap();
}
