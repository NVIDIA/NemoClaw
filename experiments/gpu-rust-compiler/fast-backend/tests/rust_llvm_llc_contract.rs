// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);

fn temporary() -> std::path::PathBuf {
    loop {
        let path = std::env::temp_dir().join(format!(
            "rust-llvm-llc-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        match fs::create_dir(&path) {
            Ok(()) => return path,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => panic!("{error}"),
        }
    }
}

#[test]
fn version_reports_the_loaded_llvm_instead_of_a_compiled_in_placeholder() {
    let output = Command::new(env!("CARGO_BIN_EXE_rust-llvm-llc"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("LLVM version 22.1.8"), "{text}");
    assert!(text.contains("Existing Rust LLVM library:"), "{text}");
    assert!(text.contains("Supported codegen levels: 0,1,2,3"), "{text}");
}

#[test]
fn missing_library_and_unsupported_options_fail_without_creating_output() {
    let root = temporary();
    let output = root.join("out.o");
    let result = Command::new(env!("CARGO_BIN_EXE_rust-llvm-llc"))
        .env("RUST_LLVM_LIBRARY", root.join("missing.dylib"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(!result.status.success());
    let result = Command::new(env!("CARGO_BIN_EXE_rust-llvm-llc"))
        .args(["-O=4", "-filetype=obj", "-o"])
        .arg(&output)
        .args(["--", "input.ll"])
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("unsupported LLVM emitter option"));
    assert!(!output.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn valid_linux_ir_emits_an_elf_object_without_a_second_llvm_distribution() {
    let root = temporary();
    let input = root.join("input.ll");
    let output = root.join("out.o");
    fs::write(&input,"target triple = \"x86_64-unknown-linux-gnu\"\ndefine i64 @answer(i64 %x) { %y = add i64 %x, 42\n ret i64 %y }\n").unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_rust-llvm-llc"))
        .args(["-filetype=obj", "-O=0", "-o"])
        .arg(&output)
        .arg("--")
        .arg(&input)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(fs::read(&output).unwrap().starts_with(b"\x7fELF"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn real_rust_bitcode_preserves_generic_calls_atomics_caught_panics_and_unwind_drops() {
    check_semantic_codegen("0", "0");
}

#[test]
fn codegen_o1_preserves_real_rust_generics_atomics_and_unwind_drops() {
    check_semantic_codegen("1", "1");
}

#[test]
fn codegen_o2_preserves_real_rust_generics_atomics_and_unwind_drops() {
    check_semantic_codegen("1", "2");
}

#[test]
fn codegen_o3_preserves_real_rust_generics_atomics_and_unwind_drops() {
    check_semantic_codegen("1", "3");
}

#[test]
fn absent_codegen_option_matches_explicit_o0_and_conflicting_options_fail() {
    let root = temporary();
    let input = root.join("input.ll");
    fs::write(&input,"target triple = \"x86_64-unknown-linux-gnu\"\ndefine i64 @answer(i64 %x) { %y = mul i64 %x, 7\n ret i64 %y }\n").unwrap();
    let emit = |flags: &[&str], name: &str| {
        let output = root.join(name);
        let result = Command::new(env!("CARGO_BIN_EXE_rust-llvm-llc"))
            .args(flags)
            .args(["-filetype=obj", "-o"])
            .arg(&output)
            .arg("--")
            .arg(&input)
            .output()
            .unwrap();
        (result, output)
    };
    let (default, default_path) = emit(&[], "default.o");
    let (explicit, explicit_path) = emit(&["-O=0"], "explicit.o");
    assert!(
        default.status.success(),
        "{}",
        String::from_utf8_lossy(&default.stderr)
    );
    assert!(
        explicit.status.success(),
        "{}",
        String::from_utf8_lossy(&explicit.stderr)
    );
    assert_eq!(
        fs::read(default_path).unwrap(),
        fs::read(explicit_path).unwrap()
    );
    let (conflict, conflict_path) = emit(&["-O=1", "-O=2"], "conflict.o");
    assert!(!conflict.status.success());
    assert!(!conflict_path.exists());
    assert!(String::from_utf8_lossy(&conflict.stderr).contains("duplicate code-generation"));
    fs::remove_dir_all(root).unwrap();
}

fn check_semantic_codegen(frontend_level: &str, codegen_level: &str) {
    let root = temporary();
    let input = root.join("semantic.bc");
    let output = root.join("semantic.o");
    let executable = root.join("semantic-driver");
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
    let result = Command::new("rustup")
        .args([
            "run",
            "1.98.1",
            "rustc",
            "--edition=2021",
            "--crate-type=lib",
            "--emit=llvm-bc",
            "-Ccodegen-units=1",
            "-Cpanic=unwind",
        ])
        .arg(format!("-Copt-level={frontend_level}"))
        .arg(fixtures.join("semantic.rs"))
        .arg("-o")
        .arg(&input)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(
        fs::read(&input).unwrap().starts_with(b"BC\xc0\xde")
            || fs::read(&input).unwrap().starts_with(b"\xde\xc0\x17\x0b")
    );
    let result = Command::new(env!("CARGO_BIN_EXE_rust-llvm-llc"))
        .arg(format!("-O={codegen_level}"))
        .args(["-filetype=obj", "-o"])
        .arg(&output)
        .arg("--")
        .arg(&input)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let result = Command::new("rustup")
        .args(["run", "1.98.1", "rustc", "--edition=2021"])
        .arg(fixtures.join("semantic-driver.rs"))
        .arg(format!("-Clink-arg={}", output.display()))
        .arg("-o")
        .arg(&executable)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let result = Command::new(&executable).output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8(result.stdout)
        .unwrap()
        .contains("generic calls, atomics, caught panics and unwind drops matched"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn malformed_ir_and_existing_outputs_never_publish_partial_or_replace_prior_objects() {
    let root = temporary();
    let input = root.join("invalid.ll");
    let output = root.join("out.o");
    fs::write(
        &input,
        "target triple = \"x86_64-unknown-linux-gnu\"\nnot valid LLVM IR\n",
    )
    .unwrap();
    let command = || {
        let mut command = Command::new(env!("CARGO_BIN_EXE_rust-llvm-llc"));
        command
            .args(["-filetype=obj", "-O=0", "-o"])
            .arg(&output)
            .arg("--")
            .arg(&input);
        command
    };
    assert!(!command().status().unwrap().success());
    assert!(!output.exists());
    fs::write(&output, b"existing-object").unwrap();
    assert!(!command().status().unwrap().success());
    assert_eq!(fs::read(&output).unwrap(), b"existing-object");
    fs::remove_dir_all(root).unwrap();
}
