// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "gpu-cargo-{}-{nonce}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("Cargo.toml"),
            concat!(
                "[package]\nname='cargo-policy-fixture'\nversion='0.1.0'\nedition='2021'\n",
                "[workspace]\n[profile.release]\noverflow-checks=true\npanic='unwind'\n",
            ),
        )
        .unwrap();
        fs::write(root.join("src/main.rs"), concat!(
            "use std::sync::atomic::{AtomicUsize, Ordering};\n",
            "static DROPS: AtomicUsize = AtomicUsize::new(0);\n",
            "struct Guard; impl Drop for Guard { fn drop(&mut self) { DROPS.fetch_add(1, Ordering::Relaxed); } }\n",
            "fn generic<T: Into<u64>>(value: T) -> u64 { value.into() + 1 }\n",
            "fn main() { std::panic::set_hook(Box::new(|_| {}));\n",
            "let caught=std::panic::catch_unwind(|| { let _guard=Guard; let v=std::hint::black_box(u8::MAX); let _=v+1; });\n",
            "assert!(caught.is_err()); assert_eq!(DROPS.load(Ordering::Relaxed),1);\n",
            "let value=std::thread::spawn(|| generic(41u32)).join().unwrap(); println!(\"value={value} drops=1\"); }\n",
        )).unwrap();
        fs::write(
            root.join("Cargo.lock"),
            "version = 4\n\n[[package]]\nname = \"cargo-policy-fixture\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
        Self(root)
    }

    fn driver(&self, action: &str, quality: &str) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_gpu-cargo"));
        command
            .args([action, "--manifest-path"])
            .arg(self.0.join("Cargo.toml"));
        command.args([
            "--package",
            "cargo-policy-fixture",
            "--bin",
            "cargo-policy-fixture",
            "--quality",
            quality,
            "--target-root",
        ]);
        command.arg(self.0.join("owned-targets")).arg("--offline");
        command
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn plan_selects_explicit_quality_and_does_not_build_or_create_target_directories() {
    let fixture = Fixture::new();
    let output = fixture.driver("plan", "fast").output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["quality"], "fast");
    let arguments = report["cargo_arguments"].as_array().unwrap();
    for config in [
        "profile.release.opt-level=1",
        "profile.release.codegen-units=16",
        "profile.release.lto=\"off\"",
    ] {
        assert!(arguments.iter().any(|value| value == config), "{report}");
    }
    assert!(report["actual_backend"].is_null());
    assert_eq!(report["gpu_compilation_jobs"], 0);
    assert!(!fixture.0.join("owned-targets").exists());
}

fn json(output: &std::process::Output) -> serde_json::Value {
    serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&output.stdout)))
}

#[test]
fn quality_modes_build_complete_rust_programs_and_preserve_panic_and_overflow_settings() {
    let fixture = Fixture::new();
    for quality in ["fast", "balanced", "release"] {
        let report_path = fixture.0.join(format!("{quality}-report.json"));
        let output = fixture
            .driver("build", quality)
            .arg("--report")
            .arg(&report_path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report = json(&output);
        assert_eq!(report["status"], "ok");
        assert_eq!(report["quality"], quality);
        assert_eq!(report["toolchain"], "1.98.1");
        assert_eq!(report["actual_backend"], "rustc-llvm-cpu");
        assert_eq!(report["gpu_compilation_jobs"], 0);
        assert!(report["cargo_elapsed_ms"].as_f64().unwrap() > 0.0);
        let path = PathBuf::from(report["artifact"]["path"].as_str().unwrap());
        assert_eq!(
            report["artifact"]["raw_bytes"].as_u64().unwrap(),
            fs::metadata(&path).unwrap().len()
        );
        assert_eq!(
            report["artifact"]["raw_bytes"],
            report["artifact"]["measured_bytes"]
        );
        let execution = Command::new(&path).output().unwrap();
        assert!(
            execution.status.success(),
            "{}",
            String::from_utf8_lossy(&execution.stderr)
        );
        assert_eq!(execution.stdout, b"value=42 drops=1\n");
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(&report_path).unwrap()).unwrap();
        assert_eq!(saved, report);
        assert!(fixture
            .0
            .join("owned-targets")
            .join(quality)
            .join("native")
            .join(".gpu-cargo-owner.json")
            .exists());
    }
}

#[test]
fn required_gpu_placement_fails_before_cargo_or_target_creation() {
    let fixture = Fixture::new();
    for placement in ["metal", "cuda"] {
        let output = fixture
            .driver("build", "fast")
            .args(["--placement", placement])
            .output()
            .unwrap();
        assert!(!output.status.success());
        let report = json(&output);
        assert_eq!(report["status"], "error");
        assert!(report["error"]
            .as_str()
            .unwrap()
            .contains("GPU placement is unavailable"));
    }
    assert!(!fixture.0.join("owned-targets").exists());
}

#[test]
fn driver_refuses_to_adopt_unowned_target_contents() {
    let fixture = Fixture::new();
    let target = fixture.0.join("owned-targets/fast/native");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("other-work"), "preserve me").unwrap();
    let output = fixture.driver("build", "fast").output().unwrap();
    assert!(!output.status.success());
    assert!(json(&output)["error"]
        .as_str()
        .unwrap()
        .contains("Refusing to adopt"));
    assert_eq!(
        fs::read_to_string(target.join("other-work")).unwrap(),
        "preserve me"
    );
    assert!(!target.join(".gpu-cargo-owner.json").exists());
}

#[test]
fn size_limit_compares_complete_files_and_fails_without_claiming_success() {
    let fixture = Fixture::new();
    let first = fixture.driver("build", "fast").output().unwrap();
    assert!(first.status.success());
    let report = json(&first);
    let artifact = PathBuf::from(report["artifact"]["path"].as_str().unwrap());
    let baseline = fixture.0.join("reference");
    fs::copy(&artifact, &baseline).unwrap();
    let second = fixture
        .driver("build", "fast")
        .arg("--reference-artifact")
        .arg(&baseline)
        .args(["--max-size-ratio", "1.0"])
        .output()
        .unwrap();
    assert!(
        second.status.success(),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    let second = json(&second);
    assert_eq!(second["artifact"]["reference"]["observed_ratio"], 1.0);
    assert_eq!(second["artifact"]["reference"]["within_limit"], true);
    assert_eq!(second["artifact"]["cargo_fresh"], true);
    fs::write(&baseline, b"declared reference").unwrap();
    let failed = fixture
        .driver("build", "fast")
        .arg("--reference-artifact")
        .arg(&baseline)
        .output()
        .unwrap();
    assert!(!failed.status.success());
    let failed = json(&failed);
    assert_eq!(failed["status"], "size-limit-exceeded");
    assert_eq!(failed["artifact"]["reference"]["measured_bytes"], 18);
    assert_eq!(failed["artifact"]["reference"]["within_limit"], false);
    assert!(artifact.exists());
}

#[test]
fn same_strip_basis_measures_copies_and_preserves_original_artifacts() {
    if !cfg!(any(target_os = "macos", target_os = "linux")) {
        return;
    }
    let fixture = Fixture::new();
    let first = fixture.driver("build", "fast").output().unwrap();
    assert!(first.status.success());
    let first = json(&first);
    let artifact = PathBuf::from(first["artifact"]["path"].as_str().unwrap());
    let original = fs::read(&artifact).unwrap();
    let baseline = fixture.0.join("reference");
    fs::write(&baseline, &original).unwrap();
    let output = fixture
        .driver("build", "fast")
        .arg("--reference-artifact")
        .arg(&baseline)
        .args(["--size-basis", "strip-debug", "--max-size-ratio", "1.0"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report = json(&output);
    assert_eq!(report["artifact"]["size_basis"], "strip-debug");
    assert_eq!(report["artifact"]["reference"]["observed_ratio"], 1.0);
    assert_eq!(fs::read(&artifact).unwrap(), original);
    assert_eq!(fs::read(&baseline).unwrap(), original);
}

#[test]
fn cargo_failure_reports_no_usable_artifact() {
    let fixture = Fixture::new();
    fs::write(
        fixture.0.join("src/main.rs"),
        "compile_error!(\"intentional fixture failure\"); fn main() {}\n",
    )
    .unwrap();
    let output = fixture.driver("build", "fast").output().unwrap();
    assert!(!output.status.success());
    let report = json(&output);
    assert_eq!(report["status"], "build-failed");
    assert!(report["artifact"].is_null());
    assert!(report["error"].as_str().unwrap().contains("Cargo exited"));
}

#[test]
fn report_cannot_replace_source_or_an_unrelated_existing_json_file() {
    let fixture = Fixture::new();
    for path in [
        fixture.0.join("src/main.rs"),
        fixture.0.join("important.json"),
    ] {
        if !path.exists() {
            fs::write(&path, "{\"important\":true}\n").unwrap();
        }
        let original = fs::read(&path).unwrap();
        let output = fixture
            .driver("plan", "fast")
            .arg("--report")
            .arg(&path)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert_eq!(fs::read(&path).unwrap(), original);
    }
    assert!(!fixture.0.join("owned-targets").exists());
}

fn backend_tools(fixture: &Fixture) -> [PathBuf; 4] {
    ["wrapper", "controller", "bridge", "llc"].map(|name| {
        let path = fixture.0.join(name);
        fs::write(&path, format!("declared {name} revision one")).unwrap();
        path
    })
}

fn bitcode_plan(fixture: &Fixture, backend: &str, tools: &[PathBuf; 4]) -> Command {
    let mut command = fixture.driver("plan", "fast");
    command
        .args(["--object-backend", backend, "--bitcode-wrapper"])
        .arg(&tools[0]);
    command.arg("--tpde-controller").arg(&tools[1]);
    command.arg("--tpde-bridge").arg(&tools[2]);
    command.arg("--llvm-llc").arg(&tools[3]);
    command
}

#[test]
fn bitcode_backend_plans_select_the_wrapper_and_isolate_its_content_provenance() {
    let fixture = Fixture::new();
    let tools = backend_tools(&fixture);
    let native = fixture.driver("plan", "fast").output().unwrap();
    assert!(native.status.success());
    let native = json(&native);
    let tpde = bitcode_plan(&fixture, "tpde", &tools)
        .arg("--allow-backend-fallback")
        .output()
        .unwrap();
    assert!(
        tpde.status.success(),
        "{}",
        String::from_utf8_lossy(&tpde.stderr)
    );
    let tpde = json(&tpde);
    assert_eq!(tpde["object_backend"], "tpde");
    assert_eq!(tpde["backend_environment"]["GPU_LINK_BACKEND"], "tpde");
    assert_eq!(tpde["backend_environment"]["GPU_LINK_ALLOW_FALLBACK"], "1");
    let llvm_library = &tpde["backend_toolchain"]["rust_llvm_library"];
    assert_eq!(llvm_library["sha256"].as_str().unwrap().len(), 64);
    assert_eq!(
        tpde["backend_environment"]["RUST_LLVM_LIBRARY"],
        llvm_library["path"]
    );
    assert_eq!(
        tpde["backend_toolchain"]["fallback_library_selection_verified"],
        false
    );
    assert!(tpde["actual_backend"].is_null());
    assert_ne!(native["target_dir"], tpde["target_dir"]);
    fs::write(&tools[0], "declared wrapper revision two").unwrap();
    let changed = bitcode_plan(&fixture, "tpde", &tools)
        .arg("--allow-backend-fallback")
        .output()
        .unwrap();
    assert!(changed.status.success());
    assert_ne!(tpde["target_dir"], json(&changed)["target_dir"]);
    let llvm = bitcode_plan(&fixture, "llvm-bitcode", &tools)
        .output()
        .unwrap();
    assert!(llvm.status.success());
    assert_eq!(
        json(&llvm)["backend_environment"]["GPU_LINK_BACKEND"],
        "llvm"
    );
    assert!(!fixture.0.join("owned-targets").exists());
}

#[test]
fn alternate_object_backends_reject_release_policy_without_building() {
    let fixture = Fixture::new();
    let tools = backend_tools(&fixture);
    let output = bitcode_plan(&fixture, "tpde", &tools)
        .args(["--quality", "release"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(json(&output)["error"]
        .as_str()
        .unwrap()
        .contains("fast or balanced"));
    assert!(!fixture.0.join("owned-targets").exists());
}

#[test]
fn required_gpu_plan_records_tools_without_claiming_hardware_execution() {
    let fixture = Fixture::new();
    let tools = backend_tools(&fixture);
    let output = bitcode_plan(&fixture, "gpu", &tools)
        .args(["--placement", "metal", "--gpu-emitter"])
        .arg(&tools[1])
        .arg("--gpu-library")
        .arg(&tools[2])
        .arg("--gpu-shader")
        .arg(&tools[3])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report = json(&output);
    assert_eq!(report["object_backend"], "gpu");
    assert_eq!(
        report["backend_environment"]["GPU_LINK_GPU_BACKEND"],
        "metal"
    );
    assert_eq!(report["backend_environment"]["GPU_LINK_GPU_DEVICE"], "0");
    assert!(report["actual_backend"].is_null());
    assert_eq!(report["gpu_compilation_jobs"], 0);
    assert_eq!(report["gpu_executed"], false);
    assert_eq!(report["current_run_gpu_qualified"], false);
    assert_eq!(report["performance_speedup_demonstrated"], false);
    assert!(!fixture.0.join("owned-targets").exists());
}

#[test]
fn inherited_llvm_library_override_cannot_silently_reuse_backend_provenance() {
    let fixture = Fixture::new();
    let tools = backend_tools(&fixture);
    let output = bitcode_plan(&fixture, "llvm-bitcode", &tools)
        .env("RUST_LLVM_LIBRARY", &tools[2])
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "Library override was accepted: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(json(&output)["error"]
        .as_str()
        .unwrap()
        .contains("RUST_LLVM_LIBRARY"));
    assert!(!fixture.0.join("owned-targets").exists());
}
