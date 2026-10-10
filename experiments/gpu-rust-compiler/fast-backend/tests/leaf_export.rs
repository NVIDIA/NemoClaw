// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static ID: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "gem-export-test-{}-{}",
            std::process::id(),
            ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn export(&self, body: &str) -> (std::process::ExitStatus, String, Option<Vec<u8>>) {
        let input = self.0.join("input.ll");
        let output = self.0.join("output.gem");
        let source = format!("target datalayout = \"e-p:64:64-i64:64-n8:16:32:64-S128\"\ntarget triple = \"x86_64-unknown-linux-gnu\"\n{body}\n!llvm.ident = !{{!0}}\n!0 = !{{!\"rustc version 1.98.1 (48a229cea 2026-09-01)\"}}\n");
        fs::write(&input, source).unwrap();
        let bridge = std::env::var_os("NEMO_FAST_BACKEND_BRIDGE")
            .expect("set NEMO_FAST_BACKEND_BRIDGE to the built native bridge");
        let result = Command::new(bridge)
            .args(["--export-leaf"])
            .arg(input)
            .arg(&output)
            .output()
            .unwrap();
        (
            result.status,
            String::from_utf8_lossy(&result.stderr).into_owned(),
            fs::read(output).ok(),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn u32_field(bytes: &mut Vec<u8>, v: u32) {
    bytes.extend_from_slice(&v.to_le_bytes());
}
fn text_field(bytes: &mut Vec<u8>, v: &str) {
    u32_field(bytes, v.len() as u32);
    bytes.extend_from_slice(v.as_bytes());
}
fn instruction(bytes: &mut Vec<u8>, op: u32, result: u32, a: u32, b: u32, imm: i64) {
    for v in [op, result, a, b] {
        u32_field(bytes, v);
    }
    bytes.extend_from_slice(&imm.to_le_bytes());
}

#[test]
#[ignore = "requires the native LLVM 22.1.8 bridge"]
fn scalar_leaf_packet_preserves_the_target_symbol_unwind_requirement_and_exact_opcode_contract() {
    let f = Fixture::new();
    let (status, error, packet) = f.export("define i64 @leaf(i64 %x) uwtable \"probe-stack\"=\"inline-asm\" {\nentry:\n %m = mul i64 %x, 7\n %r = add i64 %m, 3\n ret i64 %r\n}");
    assert!(status.success(), "{error}");
    let mut expected = b"GEM1".to_vec();
    text_field(&mut expected, "x86_64-unknown-linux-gnu");
    u32_field(&mut expected, 1);
    text_field(&mut expected, "leaf");
    for v in [1, 1, 5, 6] {
        u32_field(&mut expected, v);
    }
    instruction(&mut expected, 0, 0, 0, 0, 0);
    instruction(&mut expected, 1, 1, 0, 0, 7);
    instruction(&mut expected, 5, 2, 0, 1, 0);
    instruction(&mut expected, 1, 3, 0, 0, 3);
    instruction(&mut expected, 3, 4, 2, 3, 0);
    instruction(&mut expected, 6, u32::MAX, 4, 0, 0);
    assert_eq!(packet.unwrap(), expected);
}

#[test]
#[ignore = "requires the native LLVM 22.1.8 bridge"]
fn unsafe_or_unrepresentable_module_contracts_are_rejected_without_a_packet() {
    let bodies = [
        "define internal i64 @leaf(i64 %x) { ret i64 %x }",
        "define hidden i64 @leaf(i64 %x) { ret i64 %x }",
        "define weak i64 @leaf(i64 %x) { ret i64 %x }",
        "define fastcc i64 @leaf(i64 %x) { ret i64 %x }",
        "define i64 @leaf(i64 inreg %x) { ret i64 %x }",
        "define i64 @leaf(i64 %x, i64 %y) { ret i64 %x }",
        "define i32 @leaf(i64 %x) { ret i32 42 }",
        "define i64 @leaf(i64 %x) section \"custom\" { ret i64 %x }",
        "declare i32 @personality(...)\ndefine i64 @leaf(i64 %x) personality ptr @personality { ret i64 %x }",
        "define i64 @leaf(i64 %x) \"probe-stack\"=\"inline-asm\" \"stack-probe-size\"=\"2048\" { ret i64 %x }",
        "define i64 @leaf(i64 %x) { %r = add nsw i64 %x, 1\n ret i64 %r }",
        "@state = global i64 0\ndefine i64 @leaf(i64 %x) { ret i64 %x }",
        "declare i64 @external(i64)\ndefine i64 @leaf(i64 %x) { %r = call i64 @external(i64 %x)\n ret i64 %r }",
        "define i64 @leaf(i64 %x) \"sign-return-address\"=\"all\" { ret i64 %x }",
        "define i64 @leaf(i64 %x) \"branch-target-enforcement\" { ret i64 %x }",
        "define i64 @leaf(i64 %x) sanitize_address { ret i64 %x }",
    ];
    for body in bodies {
        let f = Fixture::new();
        let (status, error, packet) = f.export(body);
        assert_eq!(status.code(), Some(20), "{body}: {error}");
        assert!(packet.is_none(), "rejected module left a packet: {body}");
    }
}

#[test]
#[ignore = "requires the native LLVM 22.1.8 bridge"]
fn constant_return_without_an_argument_uses_no_argument_instruction() {
    let f = Fixture::new();
    let (status, error, packet) = f.export("define i64 @constant() { ret i64 -1 }");
    assert!(status.success(), "{error}");
    let mut expected = b"GEM1".to_vec();
    text_field(&mut expected, "x86_64-unknown-linux-gnu");
    u32_field(&mut expected, 1);
    text_field(&mut expected, "constant");
    for v in [0, 0, 1, 2] {
        u32_field(&mut expected, v);
    }
    instruction(&mut expected, 1, 0, 0, 0, -1);
    instruction(&mut expected, 6, u32::MAX, 0, 0, 0);
    assert_eq!(packet.unwrap(), expected);
}

#[test]
#[ignore = "requires the native LLVM 22.1.8 bridge"]
fn normal_runtime_got_module_flag_does_not_block_a_leaf_without_runtime_calls() {
    let f = Fixture::new();
    let (status, error, packet) = f.export("define i64 @constant() nonlazybind { ret i64 42 }\n!llvm.module.flags = !{!1}\n!1 = !{i32 1, !\"RtLibUseGOT\", i32 1}");
    assert!(status.success(), "{error}");
    assert!(packet.unwrap().starts_with(b"GEM1"));
}
