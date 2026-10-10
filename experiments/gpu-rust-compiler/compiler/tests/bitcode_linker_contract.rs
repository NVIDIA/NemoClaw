// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[path = "../src/bitcode_linker.rs"]
#[allow(dead_code)]
mod bitcode_linker;

use bitcode_linker::{classify, InvocationKind};
use bitcode_linker::{run_with, GpuOptions, ToolCall, ToolOutput, ToolRunner, WrapperOptions};
use std::ffi::OsString;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

fn args(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

#[test]
fn cargo_link_invocations_use_the_two_phase_bridge() {
    let plan = classify(&args(&[
        "src/main.rs",
        "--crate-name",
        "app",
        "--crate-type",
        "bin",
        "--emit=dep-info,metadata,link",
        "--out-dir",
        "/tmp/cargo-deps",
        "-C",
        "extra-filename=-123",
    ]))
    .unwrap();
    assert!(matches!(plan, InvocationKind::Compile(_)));
}

#[test]
fn actual_crate_optimization_controls_llvm_codegen_including_size_and_package_overrides() {
    for (flags, expected) in [
        (vec!["-C", "opt-level=1"], 1),
        (vec!["-Copt-level=2"], 2),
        (vec!["-Copt-level=3"], 3),
        (vec!["-Copt-level=s"], 2),
        (vec!["-Copt-level=z"], 2),
        (vec!["-O"], 2),
        (vec!["-Copt-level=1", "-C", "opt-level=2"], 2),
    ] {
        let mut values = vec!["src/main.rs", "--out-dir", "/tmp/llvm-level"];
        values.extend(flags);
        let InvocationKind::Compile(plan) = classify(&args(&values)).unwrap() else {
            panic!("compile was not selected");
        };
        assert_eq!(plan.llvm_codegen_opt_level, expected);
    }
}

#[test]
fn metadata_only_and_version_queries_pass_through_without_claiming_codegen() {
    assert!(matches!(
        classify(&args(&["--version"])).unwrap(),
        InvocationKind::PassThrough(_)
    ));
    assert!(matches!(
        classify(&args(&[
            "lib.rs",
            "--emit=dep-info,metadata",
            "--out-dir",
            "/tmp/cargo-deps"
        ]))
        .unwrap(),
        InvocationKind::PassThrough(_)
    ));
}

#[test]
fn response_files_and_explicit_emit_paths_are_left_to_original_rustc() {
    assert!(matches!(
        classify(&args(&["@rustc.args"])).unwrap(),
        InvocationKind::PassThrough(_)
    ));
    assert!(matches!(
        classify(&args(&[
            "lib.rs",
            "--emit=link=/tmp/app",
            "--out-dir",
            "/tmp/deps"
        ]))
        .unwrap(),
        InvocationKind::PassThrough(_)
    ));
}

struct Temporary(PathBuf);
static TEMP_NEXT: AtomicU64 = AtomicU64::new(0);
impl Temporary {
    fn new() -> Self {
        loop {
            let number = TEMP_NEXT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "object-bridge-test-{}-{number}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("test staging: {error}"),
            }
        }
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct FixtureRunner {
    calls: Vec<ToolCall>,
    native_first: bool,
    frontend_exit: i32,
    controller_exit: i32,
    link_exit: i32,
}
impl FixtureRunner {
    fn new() -> Self {
        Self {
            calls: vec![],
            native_first: false,
            frontend_exit: 0,
            controller_exit: 0,
            link_exit: 0,
        }
    }
}
fn after(call: &ToolCall, key: &str) -> PathBuf {
    let index = call.arguments.iter().position(|v| v == key).unwrap();
    PathBuf::from(&call.arguments[index + 1])
}
fn native_object() -> Vec<u8> {
    let mut object = object::write::Object::new(
        object::BinaryFormat::Elf,
        object::Architecture::X86_64,
        object::Endianness::Little,
    );
    let text = object.section_id(object::write::StandardSection::Text);
    object.append_section_data(text, &[0xc3], 1);
    object.write().unwrap()
}
impl ToolRunner for FixtureRunner {
    fn run(&mut self, call: &ToolCall) -> Result<ToolOutput, String> {
        self.calls.push(call.clone());
        let success = |code| ToolOutput {
            exit_code: code,
            stdout: vec![],
            stderr: vec![],
        };
        if call.arguments == [OsString::from("-vV")] {
            return Ok(ToolOutput {
                exit_code: 0,
                stdout: b"rustc 1.98.1\nrelease: 1.98.1\n".to_vec(),
                stderr: vec![],
            });
        }
        if call.arguments.first().is_some_and(|v| v == "--export-leaf") {
            return Ok(ToolOutput {
                exit_code: 9,
                stdout: vec![],
                stderr: b"fixture module contains unsupported globals".to_vec(),
            });
        }
        if call.arguments.iter().any(|v| v == "-Zno-link") {
            if self.frontend_exit != 0 {
                return Ok(success(self.frontend_exit));
            }
            let stage = after(call, "--out-dir");
            fs::write(stage.join("app.rlink"), b"saved-metadata").unwrap();
            fs::write(
                stage.join("app.app-hash-cgu.0.rcgu.o"),
                if self.native_first {
                    native_object()
                } else {
                    b"BC\xc0\xde-fixture".to_vec()
                },
            )
            .unwrap();
            fs::write(stage.join("libapp.rmeta"), b"fixture-metadata").unwrap();
            fs::write(
                stage.join("app.d"),
                format!("{}/app: source.rs\n", stage.display()),
            )
            .unwrap();
            return Ok(success(0));
        }
        if call.arguments.iter().any(|v| v == "-Zlink-only") {
            if self.link_exit == 0 {
                fs::write(after(call, "--out-dir").join("app"), b"linked-fixture").unwrap();
            }
            return Ok(success(self.link_exit));
        }
        if call.program == Path::new("controller") {
            if self.controller_exit != 0 {
                return Ok(success(self.controller_exit));
            }
            let bytes = native_object();
            fs::write(after(call, "--output"), &bytes).unwrap();
            let receipt = serde_json::json!({"backend":"llvm","target":"x86_64-unknown-linux-gnu","gpu_accelerated":false,"object_bytes":bytes.len(),"fallback_reason":null});
            fs::write(
                after(call, "--report"),
                serde_json::to_vec(&receipt).unwrap(),
            )
            .unwrap();
        }
        Ok(success(0))
    }
}
fn setup(temporary: &Temporary) -> (WrapperOptions, Vec<OsString>) {
    let out = temporary.0.join("deps");
    fs::create_dir(&out).unwrap();
    let source = temporary.0.join("source.rs");
    fs::write(&source, "fn main() {}\n").unwrap();
    let options = WrapperOptions {
        controller: "controller".into(),
        bridge: "bridge".into(),
        llc: "llc".into(),
        backend: "llvm".into(),
        allow_fallback: false,
        receipt_directory: temporary.0.join("receipts"),
        quality: "fast".into(),
        gpu: None,
    };
    let args = vec![
        source.into_os_string(),
        "--emit=dep-info,metadata,link".into(),
        "--out-dir".into(),
        out.into_os_string(),
    ];
    (options, args)
}

#[test]
fn compiler_objects_are_replaced_once_before_rust_only_links_saved_metadata() {
    let temporary = Temporary::new();
    let (options, args) = setup(&temporary);
    let mut runner = FixtureRunner::new();
    let outcome = run_with(Path::new("rustc"), &args, &options, &mut runner).unwrap();
    assert_eq!(outcome.exit_code, 0);
    assert_eq!(outcome.report.status, "success");
    assert_eq!(outcome.report.units.len(), 1);
    assert_eq!(outcome.report.units[0].backend, "llvm");
    assert!(!outcome.report.gpu_executed);
    let frontend = runner
        .calls
        .iter()
        .find(|c| c.arguments.iter().any(|v| v == "-Zno-link"))
        .unwrap();
    assert!(frontend.bootstrap);
    assert!(frontend
        .arguments
        .contains(&OsString::from("-Clinker-plugin-lto=yes")));
    let link = runner
        .calls
        .iter()
        .find(|c| c.arguments.iter().any(|v| v == "-Zlink-only"))
        .unwrap();
    assert!(link.bootstrap);
    assert!(link.arguments[0].to_string_lossy().ends_with(".rlink"));
    let out = temporary.0.join("deps");
    assert_eq!(fs::read(out.join("app")).unwrap(), b"linked-fixture");
    assert_eq!(
        fs::read(out.join("libapp.rmeta")).unwrap(),
        b"fixture-metadata"
    );
    assert!(!fs::read_to_string(out.join("app.d"))
        .unwrap()
        .contains("gpu-object-bridge"));
    assert!(!outcome.report.staging_directory.unwrap().exists());
}

#[test]
fn llvm_emission_receives_the_actual_crate_codegen_level() {
    let temporary = Temporary::new();
    let (options, mut arguments) = setup(&temporary);
    arguments.extend(args(&["-C", "opt-level=1"]));
    let mut runner = FixtureRunner::new();
    let outcome = run_with(Path::new("rustc"), &arguments, &options, &mut runner).unwrap();
    assert_eq!(outcome.exit_code, 0);
    let call = runner
        .calls
        .iter()
        .find(|c| c.program == Path::new("controller"))
        .unwrap();
    let index = call
        .arguments
        .iter()
        .position(|v| v == "--llvm-codegen-opt-level")
        .expect("LLVM object emission ignored the actual crate optimization setting");
    assert_eq!(call.arguments[index + 1], OsString::from("1"));
}

#[test]
fn unsupported_gpu_modules_use_explicit_cpu_fallback_without_claiming_hardware_execution() {
    let temporary = Temporary::new();
    let (mut options, args) = setup(&temporary);
    options.backend = "gpu".into();
    options.allow_fallback = true;
    options.gpu = Some(GpuOptions {
        emitter: "gpu-emitter".into(),
        backend: "metal".into(),
        library: "metal-library".into(),
        shader: Some("metal-shader".into()),
        device: 0,
    });
    let mut runner = FixtureRunner::new();
    let outcome = run_with(Path::new("rustc"), &args, &options, &mut runner).unwrap();
    assert_eq!(outcome.exit_code, 0);
    assert!(!outcome.report.gpu_executed);
    let unit = &outcome.report.units[0];
    assert_eq!(unit.backend, "llvm");
    assert!(!unit.physical_gpu);
    assert_eq!(unit.kernel_dispatches, 0);
    assert!(unit
        .fallback_reason
        .as_ref()
        .unwrap()
        .contains("unsupported globals"));
    assert!(runner
        .calls
        .iter()
        .all(|call| call.program != Path::new("gpu-emitter")));
}

#[test]
fn disallowed_gpu_fallback_errors_before_linking_or_publishing_partial_outputs() {
    let temporary = Temporary::new();
    let (mut options, args) = setup(&temporary);
    options.backend = "gpu".into();
    options.gpu = Some(GpuOptions {
        emitter: "gpu-emitter".into(),
        backend: "metal".into(),
        library: "metal-library".into(),
        shader: None,
        device: 0,
    });
    let mut runner = FixtureRunner::new();
    let outcome = run_with(Path::new("rustc"), &args, &options, &mut runner).unwrap();
    assert_ne!(outcome.exit_code, 0);
    assert!(!outcome.report.gpu_executed);
    assert!(outcome
        .report
        .error
        .unwrap()
        .contains("unsupported globals"));
    assert!(runner
        .calls
        .iter()
        .all(|call| call.program != Path::new("controller")));
    assert!(!temporary.0.join("deps/app").exists());
}

#[test]
fn foreign_objects_in_the_shared_output_directory_are_never_scanned_or_modified() {
    let temporary = Temporary::new();
    let (options, args) = setup(&temporary);
    let foreign = temporary.0.join("deps/foreign.rcgu.o");
    fs::write(&foreign, b"foreign-original").unwrap();
    let mut runner = FixtureRunner::new();
    let outcome = run_with(Path::new("rustc"), &args, &options, &mut runner).unwrap();
    assert_eq!(outcome.exit_code, 0);
    assert_eq!(outcome.report.units.len(), 1);
    assert_eq!(fs::read(foreign).unwrap(), b"foreign-original");
}

#[test]
fn frontend_failure_preserves_exit_status_and_does_not_call_an_object_adapter() {
    let temporary = Temporary::new();
    let (options, args) = setup(&temporary);
    let mut runner = FixtureRunner::new();
    runner.frontend_exit = 17;
    let outcome = run_with(Path::new("rustc"), &args, &options, &mut runner).unwrap();
    assert_eq!(outcome.exit_code, 17);
    assert_eq!(outcome.report.status, "failed");
    assert!(outcome.report.units.is_empty());
    assert_eq!(runner.calls.len(), 2);
    assert!(outcome.report.staging_directory.unwrap().exists());
}

#[test]
fn accidental_native_codegen_is_rejected_instead_of_shadow_compilation() {
    let temporary = Temporary::new();
    let (options, args) = setup(&temporary);
    let mut runner = FixtureRunner::new();
    runner.native_first = true;
    let outcome = run_with(Path::new("rustc"), &args, &options, &mut runner).unwrap();
    assert_ne!(outcome.exit_code, 0);
    assert!(outcome
        .report
        .error
        .unwrap()
        .contains("native object before"));
    assert!(runner
        .calls
        .iter()
        .all(|c| c.program != Path::new("controller")));
}

#[test]
fn backend_failure_never_links_partial_objects_or_overwrites_an_existing_executable() {
    let temporary = Temporary::new();
    let (options, args) = setup(&temporary);
    let mut runner = FixtureRunner::new();
    runner.controller_exit = 3;
    let artifact = temporary.0.join("deps/app");
    fs::write(&artifact, b"prior executable").unwrap();
    let outcome = run_with(Path::new("rustc"), &args, &options, &mut runner).unwrap();
    assert_ne!(outcome.exit_code, 0);
    assert!(outcome
        .report
        .error
        .unwrap()
        .contains("object adapter failed"));
    assert!(runner
        .calls
        .iter()
        .all(|c| !c.arguments.iter().any(|v| v == "-Zlink-only")));
    assert_eq!(fs::read(artifact).unwrap(), b"prior executable");
}

#[test]
fn link_failure_preserves_the_real_link_exit_code_and_retains_owned_recovery_files() {
    let temporary = Temporary::new();
    let (options, args) = setup(&temporary);
    let mut runner = FixtureRunner::new();
    runner.link_exit = 23;
    let outcome = run_with(Path::new("rustc"), &args, &options, &mut runner).unwrap();
    assert_eq!(outcome.exit_code, 23);
    assert_eq!(outcome.report.status, "failed");
    assert_eq!(outcome.report.units.len(), 1);
    assert!(outcome.report.staging_directory.unwrap().exists());
    assert!(!temporary.0.join("deps/app").exists());
}

#[test]
fn metadata_only_calls_inherit_original_io_and_never_set_bootstrap_or_claim_an_adapter() {
    let temporary = Temporary::new();
    let (options, _) = setup(&temporary);
    let mut runner = FixtureRunner::new();
    let outcome = run_with(
        Path::new("rustc"),
        &args(&["source.rs", "--emit=metadata", "--out-dir", "/tmp/deps"]),
        &options,
        &mut runner,
    )
    .unwrap();
    assert_eq!(outcome.report.status, "passthrough");
    assert!(outcome.report.forwarded_passthrough);
    assert!(outcome.report.units.is_empty());
    assert_eq!(runner.calls.len(), 1);
    assert!(runner.calls[0].inherit_io);
    assert!(!runner.calls[0].bootstrap);
}
