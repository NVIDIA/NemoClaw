// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use gpu_rust_compiler::cargo_policy::{
    self, ObjectBackend, Options, Placement, Quality, SizeBasis,
};
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    time::Instant,
};

const HELP: &str = "Usage: gpu-cargo plan|build --manifest-path Cargo.toml --package PACKAGE --bin BINARY [OPTIONS]
  --quality fast|balanced|release       Default: fast
  --placement auto|cpu|metal|cuda       Required GPUs need the GPU object adapter
  --object-backend native|tpde|llvm-bitcode|gpu   Default: native
  --bitcode-wrapper FILE               Explicit two-phase rustc wrapper
  --tpde-controller FILE               Object-emission controller
  --tpde-bridge FILE                   Pinned LLVM/TPDE shared bridge
  --llvm-llc FILE                      LLVM object emitter
  --allow-backend-fallback             Permit attributed CPU object fallback
  --gpu-backend metal|cuda             Device API for GPU object adapter
  --gpu-emitter FILE                   Qualified module-to-GPU emitter
  --gpu-library FILE                   Native GPU code-emission library
  --gpu-shader FILE                    Required Metal code-emission shader
  --gpu-device INDEX                   Default: physical device index 0
  --target-root DIRECTORY              Owned quality directories below DIRECTORY
  --offline                            Build only from cached dependencies
  --features FEATURES                  Cargo feature selection
  --no-default-features                Cargo feature selection
  --reference-artifact EXECUTABLE      Declared generated-size baseline
  --max-size-ratio RATIO               Default: 1.5; requires a reference when specified
  --size-basis unmodified|strip-debug   Same complete-file basis for candidate and reference
  --report FILE                        Save the same JSON emitted to stdout
  --dry-run                            Plan without building or creating target directories

Uses pinned rustc 1.98.1. Alternate object adapters support fast/balanced;
release preserves the native Cargo LTO contract. Actual GPU work requires
physical module-emission receipts, not a requested device label.";

fn value(arguments: &mut impl Iterator<Item = String>, name: &str) -> Result<String, String> {
    arguments
        .next()
        .ok_or_else(|| format!("Missing value for {name}"))
}

fn parse() -> Result<Option<(Options, Option<PathBuf>)>, String> {
    let mut arguments = env::args().skip(1);
    let action = arguments.next().ok_or(HELP)?;
    if matches!(action.as_str(), "--help" | "-h") {
        println!("{HELP}");
        return Ok(None);
    }
    let plan = match action.as_str() {
        "plan" => true,
        "build" => false,
        _ => return Err(HELP.into()),
    };
    let mut options = Options {
        plan,
        manifest_path: PathBuf::from("Cargo.toml"),
        package: String::new(),
        binary: String::new(),
        quality: Quality::Fast,
        placement: Placement::Auto,
        target_root: None,
        offline: false,
        features: None,
        no_default_features: false,
        reference_artifact: None,
        max_size_ratio: 1.5,
        size_basis: SizeBasis::Unmodified,
        object_backend: ObjectBackend::Native,
        bitcode_wrapper: None,
        tpde_controller: None,
        tpde_bridge: None,
        llvm_llc: None,
        allow_backend_fallback: false,
        gpu_emitter: None,
        gpu_library: None,
        gpu_shader: None,
        gpu_backend: None,
        gpu_device: 0,
    };
    let mut report = None;
    let mut ratio_supplied = false;
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--help" | "-h" => {
                println!("{HELP}");
                return Ok(None);
            }
            "--manifest-path" => options.manifest_path = value(&mut arguments, &argument)?.into(),
            "--package" | "-p" => options.package = value(&mut arguments, &argument)?,
            "--bin" => options.binary = value(&mut arguments, &argument)?,
            "--quality" => options.quality = Quality::parse(&value(&mut arguments, &argument)?)?,
            "--placement" => {
                options.placement = Placement::parse(&value(&mut arguments, &argument)?)?
            }
            "--object-backend" => {
                options.object_backend = ObjectBackend::parse(&value(&mut arguments, &argument)?)?
            }
            "--bitcode-wrapper" => {
                options.bitcode_wrapper = Some(value(&mut arguments, &argument)?.into())
            }
            "--tpde-controller" => {
                options.tpde_controller = Some(value(&mut arguments, &argument)?.into())
            }
            "--tpde-bridge" => options.tpde_bridge = Some(value(&mut arguments, &argument)?.into()),
            "--llvm-llc" => options.llvm_llc = Some(value(&mut arguments, &argument)?.into()),
            "--allow-backend-fallback" => options.allow_backend_fallback = true,
            "--gpu-emitter" => options.gpu_emitter = Some(value(&mut arguments, &argument)?.into()),
            "--gpu-library" => options.gpu_library = Some(value(&mut arguments, &argument)?.into()),
            "--gpu-shader" => options.gpu_shader = Some(value(&mut arguments, &argument)?.into()),
            "--gpu-backend" => {
                options.gpu_backend = Some(Placement::parse(&value(&mut arguments, &argument)?)?)
            }
            "--gpu-device" => {
                options.gpu_device = value(&mut arguments, &argument)?
                    .parse()
                    .map_err(|_| "Invalid GPU device index")?
            }
            "--target-root" => options.target_root = Some(value(&mut arguments, &argument)?.into()),
            "--offline" => options.offline = true,
            "--features" => options.features = Some(value(&mut arguments, &argument)?),
            "--no-default-features" => options.no_default_features = true,
            "--reference-artifact" => {
                options.reference_artifact = Some(value(&mut arguments, &argument)?.into())
            }
            "--max-size-ratio" => {
                ratio_supplied = true;
                options.max_size_ratio = value(&mut arguments, &argument)?
                    .parse()
                    .map_err(|_| "Invalid size ratio")?;
            }
            "--size-basis" => {
                options.size_basis = SizeBasis::parse(&value(&mut arguments, &argument)?)?
            }
            "--report" => report = Some(PathBuf::from(value(&mut arguments, &argument)?)),
            "--dry-run" => options.plan = true,
            _ => return Err(format!("Unknown option {argument}")),
        }
    }
    if ratio_supplied && options.reference_artifact.is_none() {
        return Err("--max-size-ratio requires --reference-artifact".into());
    }
    if let Some(path) = &report {
        validate_report_path(path)?;
        for protected in [
            &options.manifest_path,
            &options.manifest_path.with_file_name("Cargo.lock"),
        ] {
            if same_path(path, protected) {
                return Err("Report path would overwrite a Cargo input".into());
            }
        }
        if options
            .reference_artifact
            .as_ref()
            .is_some_and(|reference| same_path(path, reference))
        {
            return Err("Report path would overwrite the reference artifact".into());
        }
    }
    Ok(Some((options, report)))
}

fn same_path(left: &Path, right: &Path) -> bool {
    let normalize = |path: &Path| {
        fs::canonicalize(path).unwrap_or_else(|_| {
            if path.is_absolute() {
                path.to_owned()
            } else {
                env::current_dir().unwrap_or_default().join(path)
            }
        })
    };
    normalize(left) == normalize(right)
}

fn write_report(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temporary = path.with_extension(format!("gpu-cargo-{}.tmp", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    let result = file
        .write_all(format!("{text}\n").as_bytes())
        .map_err(|e| e.to_string());
    drop(file);
    let result = result.and_then(|_| fs::rename(&temporary, path).map_err(|e| e.to_string()));
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn validate_report_path(path: &Path) -> Result<(), String> {
    if path.exists() {
        let existing = fs::read(path).map_err(|e| e.to_string())?;
        let owned = serde_json::from_slice::<serde_json::Value>(&existing)
            .is_ok_and(|value| value["schema"] == "gpu-cargo-report" && value["version"] == 1);
        if !owned {
            return Err(
                "Refusing to replace an existing file that is not a gpu-cargo report".into(),
            );
        }
    }
    Ok(())
}

fn run() -> Result<bool, String> {
    let Some((options, path)) = parse()? else {
        return Ok(true);
    };
    let start = Instant::now();
    let report = match cargo_policy::execute(&options) {
        Ok(report) => report,
        Err(error) => {
            let text = serde_json::to_string(&serde_json::json!({
                "schema":"gpu-cargo-report", "version":1, "status":"error", "error":error,
                "quality":options.quality, "requested_placement":options.placement,
                "object_backend":options.object_backend,
                "toolchain":cargo_policy::TOOLCHAIN, "actual_backend":null,
                "gpu_compilation_jobs":0, "manifest_path":options.manifest_path,
                "total_elapsed_ms":start.elapsed().as_secs_f64()*1000.0,
            }))
            .map_err(|e| e.to_string())?;
            if let Some(path) = path {
                write_report(&path, &text)?;
            }
            println!("{text}");
            eprintln!("gpu-cargo: {error}");
            return Ok(false);
        }
    };
    if let (Some(path), Some(artifact)) = (&path, &report.artifact) {
        if same_path(path, &artifact.path) {
            return Err("Report path would overwrite the compiled artifact".into());
        }
    }
    let text = serde_json::to_string(&report).map_err(|e| e.to_string())?;
    if let Some(path) = path {
        write_report(&path, &text)?;
    }
    println!("{text}");
    Ok(matches!(report.status, "ok" | "planned"))
}

fn main() {
    match run() {
        Ok(true) => {}
        Ok(false) => std::process::exit(1),
        Err(error) => {
            println!(
                "{}",
                serde_json::json!({"schema":"gpu-cargo-report", "version":1, "status":"error", "error":error})
            );
            eprintln!("gpu-cargo: {error}");
            std::process::exit(1);
        }
    }
}
