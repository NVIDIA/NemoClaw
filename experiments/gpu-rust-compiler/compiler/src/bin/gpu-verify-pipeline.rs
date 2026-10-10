// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

const EXPECTED: &str = "rust-gpu-fixture: arithmetic=verified caught=true drops=1\n";
const HELP: &str =
    "Usage: gpu-verify-pipeline --gpu-cargo FILE --bitcode-wrapper FILE --controller FILE
  --tpde-bridge FILE --llvm-llc FILE --gpu-emitter FILE --gpu-library FILE
  --backend metal|cuda [--shader FILE] --target-root DIRECTORY --report FILE
  [--fixture-manifest FILE]
  [--reference-artifact FILE] [--max-size-ratio 1.5] [--size-basis unmodified|strip-debug]

Creates an owned verification run, builds the full Rust fixture with required
physical GPU objects plus attributed CPU fallback, executes it, and checks an
identical cache-only build. This proves execution and cache behavior, not speedup.";

struct Options {
    fixture: Option<PathBuf>,
    cargo: PathBuf,
    wrapper: PathBuf,
    controller: PathBuf,
    bridge: PathBuf,
    llc: PathBuf,
    emitter: PathBuf,
    library: PathBuf,
    shader: Option<PathBuf>,
    backend: String,
    target_root: PathBuf,
    report: PathBuf,
    reference: Option<PathBuf>,
    ratio: String,
    basis: String,
}

fn options() -> Result<Option<Options>, String> {
    let mut args = env::args().skip(1);
    let mut values = std::collections::BTreeMap::new();
    while let Some(arg) = args.next() {
        if matches!(arg.as_str(), "--help" | "-h") {
            println!("{HELP}");
            return Ok(None);
        }
        let arg = match arg.as_str() {
            "--wrapper" => "--bitcode-wrapper".into(),
            "--bridge" => "--tpde-bridge".into(),
            "--llc" => "--llvm-llc".into(),
            _ => arg,
        };
        if !matches!(
            arg.as_str(),
            "--gpu-cargo"
                | "--bitcode-wrapper"
                | "--controller"
                | "--tpde-bridge"
                | "--llvm-llc"
                | "--gpu-emitter"
                | "--gpu-library"
                | "--shader"
                | "--backend"
                | "--target-root"
                | "--report"
                | "--fixture-manifest"
                | "--reference-artifact"
                | "--max-size-ratio"
                | "--size-basis"
        ) {
            return Err(format!("Unknown option {arg}"));
        }
        let value = args
            .next()
            .ok_or_else(|| format!("Missing value for {arg}"))?;
        if values.insert(arg.clone(), value).is_some() {
            return Err(format!("Repeated option {arg}"));
        }
    }
    let path = |name: &str| -> Result<PathBuf, String> {
        values
            .get(name)
            .map(PathBuf::from)
            .ok_or_else(|| format!("Missing {name}\n{HELP}"))
    };
    let backend = values.get("--backend").ok_or("Missing --backend")?.clone();
    if !matches!(backend.as_str(), "metal" | "cuda") {
        return Err("Backend must be metal or cuda".into());
    }
    let shader = values.get("--shader").map(PathBuf::from);
    if backend == "metal" && shader.is_none() {
        return Err("Metal verification requires --shader".into());
    }
    let reference = values.get("--reference-artifact").map(PathBuf::from);
    if values.contains_key("--max-size-ratio") && reference.is_none() {
        return Err("--max-size-ratio requires --reference-artifact".into());
    }
    let basis = values
        .get("--size-basis")
        .cloned()
        .unwrap_or_else(|| "unmodified".into());
    if !matches!(basis.as_str(), "unmodified" | "strip-debug") {
        return Err("Size basis must be unmodified or strip-debug".into());
    }
    Ok(Some(Options {
        fixture: values.get("--fixture-manifest").map(PathBuf::from),
        cargo: path("--gpu-cargo")?,
        wrapper: path("--bitcode-wrapper")?,
        controller: path("--controller")?,
        bridge: path("--tpde-bridge")?,
        llc: path("--llvm-llc")?,
        emitter: path("--gpu-emitter")?,
        library: path("--gpu-library")?,
        shader,
        backend,
        target_root: path("--target-root")?,
        report: path("--report")?,
        reference,
        ratio: values
            .get("--max-size-ratio")
            .cloned()
            .unwrap_or_else(|| "1.5".into()),
        basis,
    }))
}

fn validate_fresh_report(report: &Value) -> Result<(), String> {
    if report["schema"] != "gpu-cargo-report"
        || report["version"] != 1
        || report["status"] != "ok"
        || report["object_backend"] != "gpu"
        || report["quality"] != "fast"
        || report["toolchain"] != "1.98.1"
    {
        return Err("Fresh build lacks a successful pinned GPU Cargo report".into());
    }
    if report["gpu_executed"] != true
        || report["current_run_gpu_qualified"] != true
        || report["cache_only"] != false
        || report["artifact"]["cargo_fresh"] != false
        || report["performance_speedup_demonstrated"] != false
    {
        return Err(
            "A cached, simulated, or unqualified build cannot establish fresh GPU execution".into(),
        );
    }
    let jobs = report["gpu_compilation_jobs"]
        .as_u64()
        .filter(|jobs| *jobs > 0)
        .ok_or("No physical GPU module was compiled")?;
    let evidence = &report["object_backend_receipts"];
    if evidence["physical_gpu_units"].as_u64() != Some(jobs)
        || evidence["gpu_kernel_dispatches"].as_u64().unwrap_or(0) == 0
        || evidence["fallback_units"].as_u64().unwrap_or(0) == 0
        || evidence["gpu_devices"]
            .as_object()
            .is_none_or(|devices| devices.is_empty())
    {
        return Err("Fresh GPU modules or attributed CPU fallback are missing".into());
    }
    Ok(())
}

fn validate_cached_report(report: &Value, fresh: &Value) -> Result<(), String> {
    if report["status"] != "ok"
        || report["object_backend"] != "gpu"
        || report["artifact"]["cargo_fresh"] != true
        || report["cache_only"] != true
        || report["gpu_executed"] != false
        || report["current_run_gpu_qualified"] != false
        || report["gpu_compilation_jobs"] != 0
        || report["performance_speedup_demonstrated"] != false
    {
        return Err(
            "Unchanged build did not report qualified cache reuse without new GPU execution".into(),
        );
    }
    let evidence = &report["object_backend_receipts"];
    if evidence["physical_gpu_units"] != 0
        || evidence["translated_units"] != 0
        || evidence["gpu_kernel_dispatches"] != 0
    {
        return Err("Cache-only build contains new object-emission work".into());
    }
    let lineage = &report["cached_gpu_lineage"];
    if report["artifact"]["sha256"] != fresh["artifact"]["sha256"]
        || report["artifact"]["path"] != fresh["artifact"]["path"]
        || lineage["artifact_sha256"] != fresh["artifact"]["sha256"]
        || lineage["physical_gpu_units"] != fresh["gpu_compilation_jobs"]
        || lineage["qualified_receipts_directory"] != fresh["object_backend_receipts"]["directory"]
        || lineage["qualified_receipt_hashes"]
            .as_object()
            .is_none_or(|hashes| hashes.is_empty())
    {
        return Err(
            "Cached artifact does not retain the fresh run's qualified receipt lineage".into(),
        );
    }
    Ok(())
}

fn verify_raw_receipts(report: &Value, backend: &str) -> Result<(u64, u64), String> {
    let directory = Path::new(
        report["object_backend_receipts"]["directory"]
            .as_str()
            .ok_or("No raw receipt directory")?,
    );
    let mut gpu = 0u64;
    let mut cpu = 0u64;
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let receipt: Value = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        if receipt["forwarded_passthrough"] == true {
            continue;
        }
        if receipt["status"] != "success"
            || receipt["frontend_bitcode_verified"] != true
            || receipt["native_object_before_selected_emitter"] != false
            || receipt["saved_link_without_recompilation"] != true
        {
            return Err(format!(
                "Receipt does not prove bitcode-only frontend and saved linking: {}",
                path.display()
            ));
        }
        for unit in receipt["units"]
            .as_array()
            .ok_or("Receipt omitted object units")?
        {
            if unit["input_kind"] != "llvm-bitcode"
                || unit["input_sha256"]
                    .as_str()
                    .is_none_or(|hash| hash.len() != 64)
                || unit["object_sha256"]
                    .as_str()
                    .is_none_or(|hash| hash.len() != 64)
            {
                return Err("Object unit omitted immutable bitcode/native-object evidence".into());
            }
            if unit["backend"] == backend {
                if unit["physical_gpu"] != true
                    || unit["kernel_output_used"] != true
                    || unit["kernel_dispatches"].as_u64().unwrap_or(0) == 0
                    || unit["device_id"].as_str().is_none_or(|id| id.is_empty())
                {
                    return Err("GPU object unit lacks physical execution evidence".into());
                }
                gpu += 1;
            } else {
                if !matches!(unit["backend"].as_str(), Some("llvm" | "tpde"))
                    || unit["physical_gpu"] != false
                    || unit["kernel_output_used"] != false
                    || unit["fallback_reason"]
                        .as_str()
                        .is_none_or(|reason| reason.is_empty())
                {
                    return Err("CPU object fallback is missing its actual backend/reason".into());
                }
                cpu += 1;
            }
        }
    }
    if gpu == 0 || cpu == 0 || report["gpu_compilation_jobs"].as_u64() != Some(gpu) {
        return Err("Raw receipt GPU/CPU counts do not match the compiled fixture".into());
    }
    Ok((gpu, cpu))
}

fn save_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(
        path,
        format!(
            "{}\n",
            serde_json::to_string(value).map_err(|e| e.to_string())?
        ),
    )
    .map_err(|e| e.to_string())
}

fn cargo_build(
    options: &Options,
    manifest: &Path,
    target: &Path,
    report_path: &Path,
) -> Result<Value, String> {
    let mut command = Command::new(&options.cargo);
    command
        .args(["build", "--manifest-path"])
        .arg(manifest)
        .args([
            "--package",
            "gpu-rust-full-fixture",
            "--bin",
            "gpu-rust-full-fixture",
            "--quality",
            "fast",
            "--object-backend",
            "gpu",
            "--placement",
            &options.backend,
            "--allow-backend-fallback",
            "--offline",
            "--bitcode-wrapper",
        ])
        .arg(&options.wrapper);
    for (name, path) in [
        ("--tpde-controller", options.controller.as_path()),
        ("--tpde-bridge", options.bridge.as_path()),
        ("--llvm-llc", options.llc.as_path()),
        ("--gpu-emitter", options.emitter.as_path()),
        ("--gpu-library", options.library.as_path()),
        ("--target-root", target),
        ("--report", report_path),
    ] {
        command.arg(name).arg(path);
    }
    command.args([
        "--gpu-backend",
        &options.backend,
        "--size-basis",
        &options.basis,
    ]);
    if let Some(shader) = &options.shader {
        command.arg("--gpu-shader").arg(shader);
    }
    if let Some(reference) = &options.reference {
        command
            .arg("--reference-artifact")
            .arg(reference)
            .args(["--max-size-ratio", &options.ratio]);
    }
    let result = command
        .output()
        .map_err(|e| format!("Cargo policy launch failed: {e}"))?;
    fs::write(report_path.with_extension("stdout.log"), &result.stdout)
        .map_err(|e| e.to_string())?;
    fs::write(report_path.with_extension("stderr.log"), &result.stderr)
        .map_err(|e| e.to_string())?;
    let report: Value = serde_json::from_slice(&result.stdout)
        .map_err(|e| format!("Cargo policy did not emit strict JSON: {e}"))?;
    if !report_path.exists() {
        save_json(report_path, &report)?;
    }
    if !result.status.success() {
        return Err(format!(
            "Cargo policy failed: {}",
            report["error"].as_str().unwrap_or("see raw report")
        ));
    }
    Ok(report)
}

fn fixture_manifest(explicit: Option<&Path>, current: &Path) -> Result<PathBuf, String> {
    // Qualification binaries travel from a hosted build machine to /lab on the
    // GPU runner. Source locations must be resolved from the execution host.
    let selected = if let Some(path) = explicit {
        current.join(path)
    } else {
        let local = current.join("fixtures/full-rust-gpu/Cargo.toml");
        if local.is_file() {
            local
        } else {
            current.join("experiments/gpu-rust-compiler/fixtures/full-rust-gpu/Cargo.toml")
        }
    };
    if !selected.is_file() {
        return Err(
            "Fixture manifest is missing; supply --fixture-manifest from the execution host".into(),
        );
    }
    fs::canonicalize(selected).map_err(|e| e.to_string())
}

fn verify(options: &Options, run: &Path, summary: &mut Value) -> Result<(), String> {
    let manifest = fixture_manifest(
        options.fixture.as_deref(),
        &env::current_dir().map_err(|e| e.to_string())?,
    )?;
    let fresh_path = run.join("fresh-cargo.json");
    let cached_path = run.join("cached-cargo.json");
    summary["fixture_manifest"] = json!(manifest);
    summary["fresh_cargo_report"] = json!(fresh_path);
    summary["cached_cargo_report"] = json!(cached_path);
    summary["owned_target_root"] = json!(run.join("targets"));
    let fresh = cargo_build(options, &manifest, &run.join("targets"), &fresh_path)?;
    validate_fresh_report(&fresh)?;
    let (gpu, cpu) = verify_raw_receipts(&fresh, &options.backend)?;
    summary["fresh_gpu_execution_verified"] = true.into();
    summary["bitcode_only_frontend_verified"] = true.into();
    summary["saved_link_without_recompilation_verified"] = true.into();
    summary["physical_gpu_units"] = gpu.into();
    summary["attributed_cpu_units"] = cpu.into();
    summary["gpu_devices"] = fresh["object_backend_receipts"]["gpu_devices"].clone();
    summary["artifact"] = fresh["artifact"].clone();
    summary["fresh_cargo_ms"] = fresh["cargo_elapsed_ms"].clone();
    let artifact = Path::new(
        fresh["artifact"]["path"]
            .as_str()
            .ok_or("Fresh build omitted executable")?,
    );
    let execution = Command::new(artifact).output().map_err(|e| e.to_string())?;
    fs::write(run.join("fixture-stdout.log"), &execution.stdout).map_err(|e| e.to_string())?;
    fs::write(run.join("fixture-stderr.log"), &execution.stderr).map_err(|e| e.to_string())?;
    if !execution.status.success() || execution.stdout != EXPECTED.as_bytes() {
        return Err(format!(
            "GPU-compiled Rust fixture execution failed or produced unexpected output: {}",
            String::from_utf8_lossy(&execution.stdout)
        ));
    }
    summary["fixture_execution_verified"] = true.into();
    summary["fixture_stdout"] = EXPECTED.into();
    let cached = cargo_build(options, &manifest, &run.join("targets"), &cached_path)?;
    validate_cached_report(&cached, &fresh)?;
    summary["cache_only_verified"] = true.into();
    summary["cached_cargo_ms"] = cached["cargo_elapsed_ms"].clone();
    Ok(())
}

fn run() -> Result<bool, String> {
    let Some(options) = options()? else {
        return Ok(true);
    };
    if options.report.exists() {
        let prior: Value =
            serde_json::from_slice(&fs::read(&options.report).map_err(|e| e.to_string())?)
                .map_err(|_| "Refusing to replace a non-verification report")?;
        if prior["schema"] != "gpu-rust-pipeline-verification" || prior["version"] != 1 {
            return Err("Refusing to replace an unrelated report".into());
        }
    }
    fs::create_dir_all(&options.target_root).map_err(|e| e.to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let run = options
        .target_root
        .join(format!("verify-{}-{nonce}", std::process::id()));
    fs::create_dir(&run).map_err(|e| format!("Could not claim verification directory: {e}"))?;
    let run = fs::canonicalize(run).map_err(|e| e.to_string())?;
    let mut summary = json!({"schema":"gpu-rust-pipeline-verification","version":1,"status":"running","scope":"full-rust-fixture-cargo-object-emission","backend":options.backend,"toolchain":"1.98.1","performance_speedup_demonstrated":false,"compiler_size_limit_qualified":false,"fresh_gpu_execution_verified":false,"cache_only_verified":false,"fixture_execution_verified":false,"bitcode_only_frontend_verified":false,"saved_link_without_recompilation_verified":false,"owned_verification_directory":run});
    let result = verify(&options, &run, &mut summary);
    summary["status"] = if result.is_ok() { "ok" } else { "failed" }.into();
    if let Err(error) = &result {
        summary["error"] = error.clone().into();
    }
    save_json(&options.report, &summary)?;
    println!(
        "{}",
        serde_json::to_string(&summary).map_err(|e| e.to_string())?
    );
    Ok(result.is_ok())
}

fn main() {
    match run() {
        Ok(true) => {}
        Ok(false) => std::process::exit(1),
        Err(error) => {
            eprintln!("gpu-verify-pipeline: {error}");
            println!(
                "{}",
                json!({"schema":"gpu-rust-pipeline-verification","version":1,"status":"failed","error":error})
            );
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn moved_verifier_resolves_the_runtime_fixture_and_explicit_manifest() {
        let root = std::env::temp_dir().join(format!("gpu-runtime-fixture-{}", std::process::id()));
        std::fs::create_dir_all(root.join("fixtures/full-rust-gpu")).unwrap();
        let default = root.join("fixtures/full-rust-gpu/Cargo.toml");
        let explicit = root.join("custom-fixture.toml");
        std::fs::write(&default, "[workspace]\n").unwrap();
        std::fs::write(&explicit, "[workspace]\n").unwrap();
        assert_eq!(
            super::fixture_manifest(None, &root).unwrap(),
            std::fs::canonicalize(&default).unwrap()
        );
        assert_eq!(
            super::fixture_manifest(Some(&explicit), &root).unwrap(),
            std::fs::canonicalize(&explicit).unwrap()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn metadata_only_or_simulated_reports_cannot_qualify_a_gpu_pipeline() {
        let report = serde_json::json!({"status":"ok","gpu_executed":false,"gpu_compilation_jobs":0,"current_run_gpu_qualified":false,"performance_speedup_demonstrated":false,"artifact":{"cargo_fresh":true},"object_backend_receipts":{"physical_gpu_units":0}});
        assert!(super::validate_fresh_report(&report).is_err());
    }
}
