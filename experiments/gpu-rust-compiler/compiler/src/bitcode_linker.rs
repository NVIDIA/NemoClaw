// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Experimental RUSTC_WRAPPER: Rust emits bitcode objects, the selected adapter
//! emits native objects, and Rust links/packages its own saved metadata. Native
//! Rust object emission does not run before the adapter. This serial prototype
//! has no object cache, Cargo-wide service, or extra jobserver credit acquisition.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    env,
    ffi::OsString,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
};

const RUST_VERSION: &str = "1.98.1";
static NEXT: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
pub struct CompilePlan {
    pub llvm_codegen_opt_level: u32,
    pub source: PathBuf,
    pub source_argument: usize,
    pub output_directory: PathBuf,
    out_dir: Option<(usize, bool)>,
    output: Option<(usize, bool, OsString)>,
}
#[derive(Clone, Debug)]
pub enum InvocationKind {
    Compile(CompilePlan),
    PassThrough(String),
}

pub fn classify(arguments: &[OsString]) -> Result<InvocationKind, String> {
    let pass = |reason: &str| Ok(InvocationKind::PassThrough(reason.into()));
    let Some(text): Option<Vec<_>> = arguments.iter().map(|s| s.to_str()).collect() else {
        return pass("non-UTF-8 arguments use original rustc");
    };
    if text.iter().any(|s| {
        s.starts_with('@')
            || *s == "-"
            || s.starts_with("--print")
            || *s == "--version"
            || *s == "-vV"
            || *s == "--help"
            || *s == "-h"
    }) {
        return pass("query, response file, or stdin uses original rustc");
    }
    if text
        .iter()
        .any(|s| s.contains("no-link") || s.contains("link-only") || s.contains("save-temps"))
    {
        return pass("existing split-link or saved-temporary invocation uses original rustc");
    }
    let mut source = None;
    let mut out_dir = None;
    let mut output = None;
    let mut has_link = true;
    let mut llvm_codegen_opt_level = 0;
    let mut index = 0;
    while index < text.len() {
        let value = text[index];
        let optimization = if value == "-O" {
            Some("2")
        } else if value == "-C" {
            text.get(index + 1)
                .and_then(|s| s.strip_prefix("opt-level="))
        } else {
            value.strip_prefix("-Copt-level=")
        };
        if let Some(level) = optimization {
            // Match pinned rustc's target-machine level mapping. Size modes
            // carry their size attributes in IR and use CodeGenOpt::Default.
            llvm_codegen_opt_level = match level {
                "0" => 0,
                "1" => 1,
                "2" | "s" | "z" => 2,
                "3" => 3,
                _ => return pass("unsupported optimization level uses original rustc"),
            };
        }
        let paired = matches!(
            value,
            "--emit"
                | "--crate-type"
                | "--crate-name"
                | "--out-dir"
                | "-o"
                | "--edition"
                | "--target"
                | "--error-format"
                | "--json"
                | "--extern"
                | "--cfg"
                | "--check-cfg"
                | "--cap-lints"
                | "--remap-path-prefix"
                | "--sysroot"
                | "--color"
                | "--diagnostic-width"
                | "-C"
                | "-Z"
                | "-L"
                | "-A"
                | "-W"
                | "-D"
                | "-F"
        );
        let mut emit = value.strip_prefix("--emit=");
        if value == "--emit" {
            emit = text.get(index + 1).copied();
        }
        if let Some(emit) = emit {
            if emit.contains('=')
                || emit
                    .split(',')
                    .any(|kind| !matches!(kind, "dep-info" | "metadata" | "link"))
            {
                return pass("explicit or additional emit destinations use original rustc");
            }
            has_link = emit.split(',').any(|kind| kind == "link");
        }
        if value == "--out-dir" {
            let next = arguments.get(index + 1).ok_or("--out-dir has no value")?;
            if out_dir.is_some() {
                return pass("multiple output directories use original rustc");
            }
            out_dir = Some((index + 1, false, PathBuf::from(next)));
        } else if let Some(path) = value.strip_prefix("--out-dir=") {
            if out_dir.is_some() {
                return pass("multiple output directories use original rustc");
            }
            out_dir = Some((index, true, PathBuf::from(path)));
        } else if value == "-o" {
            let next = arguments.get(index + 1).ok_or("-o has no value")?;
            if output.is_some() {
                return pass("multiple output files use original rustc");
            }
            output = Some((index + 1, false, PathBuf::from(next)));
        } else if let Some(path) = value.strip_prefix("-o=") {
            if output.is_some() {
                return pass("multiple output files use original rustc");
            }
            output = Some((index, true, PathBuf::from(path)));
        } else if !value.starts_with('-') {
            if !value.ends_with(".rs") || source.is_some() {
                return pass("unrecognized source invocation uses original rustc");
            }
            source = Some((index, PathBuf::from(value)));
        }
        // Split debug artifacts need a separately qualified publication path.
        if value.starts_with("-Cdebuginfo=") && value != "-Cdebuginfo=0" {
            return pass("debug artifacts use original rustc until qualified");
        }
        if value == "-C"
            && text
                .get(index + 1)
                .is_some_and(|s| s.starts_with("debuginfo=") && *s != "debuginfo=0")
        {
            return pass("debug artifacts use original rustc until qualified");
        }
        index += if paired { 2 } else { 1 };
    }
    if !has_link {
        return pass("metadata-only invocation performs no object emission");
    }
    let Some((source_argument, source)) = source else {
        return pass("no supported source file");
    };
    let output_directory = if let Some((_, _, path)) = &output {
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."))
            .to_owned()
    } else if let Some((_, _, path)) = &out_dir {
        path.clone()
    } else {
        return pass("an explicit output directory or file is required");
    };
    // These paths become Make dep-info targets; complex escaping is passed
    // through rather than rewriting a dependency contract incorrectly.
    if output_directory
        .to_string_lossy()
        .chars()
        .any(|c| matches!(c, ' ' | '\n' | '\r' | '#' | '$' | '\\'))
    {
        return pass("output path needs unsupported dep-info escaping");
    }
    let output = output
        .map(|(index, inline, path)| -> Result<_, String> {
            let name = path
                .file_name()
                .ok_or("output file has no basename")?
                .to_owned();
            Ok((index, inline, name))
        })
        .transpose()?;
    Ok(InvocationKind::Compile(CompilePlan {
        llvm_codegen_opt_level,
        source,
        source_argument,
        output_directory,
        out_dir: out_dir.map(|(i, inline, _)| (i, inline)),
        output,
    }))
}

#[derive(Clone, Debug)]
pub struct WrapperOptions {
    pub controller: PathBuf,
    pub bridge: PathBuf,
    pub llc: PathBuf,
    pub backend: String,
    pub allow_fallback: bool,
    pub receipt_directory: PathBuf,
    pub quality: String,
    pub gpu: Option<GpuOptions>,
}
#[derive(Clone, Debug)]
pub struct GpuOptions {
    pub emitter: PathBuf,
    pub backend: String,
    pub library: PathBuf,
    pub shader: Option<PathBuf>,
    pub device: u32,
}
impl WrapperOptions {
    pub fn from_env() -> Result<Self, String> {
        let path = |name: &str| {
            env::var_os(name)
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .ok_or_else(|| format!("{name} must name an executable or receipt directory"))
        };
        let backend = env::var("GPU_LINK_BACKEND").unwrap_or_else(|_| "tpde".into());
        if !matches!(backend.as_str(), "tpde" | "llvm" | "gpu") {
            return Err("GPU_LINK_BACKEND must be tpde, llvm, or gpu".into());
        }
        let allow_fallback = match env::var("GPU_LINK_ALLOW_FALLBACK")
            .as_deref()
            .unwrap_or("0")
        {
            "0" => false,
            "1" => true,
            _ => return Err("GPU_LINK_ALLOW_FALLBACK must be 0 or 1".into()),
        };
        let gpu = if backend == "gpu" {
            let gpu_backend = env::var("GPU_LINK_GPU_BACKEND")
                .map_err(|_| "GPU_LINK_GPU_BACKEND must be metal or cuda")?;
            if !matches!(gpu_backend.as_str(), "metal" | "cuda") {
                return Err("GPU_LINK_GPU_BACKEND must be metal or cuda".into());
            }
            Some(GpuOptions {
                emitter: path("GPU_LINK_GPU_EMITTER")?,
                backend: gpu_backend,
                library: path("GPU_LINK_GPU_LIBRARY")?,
                shader: env::var_os("GPU_LINK_GPU_SHADER")
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from),
                device: env::var("GPU_LINK_GPU_DEVICE")
                    .unwrap_or_else(|_| "0".into())
                    .parse()
                    .map_err(|_| "GPU_LINK_GPU_DEVICE must be a u32 device ordinal")?,
            })
        } else {
            None
        };
        Ok(Self {
            controller: path("GPU_LINK_CONTROLLER")?,
            bridge: path("GPU_LINK_BRIDGE")?,
            llc: path("GPU_LINK_LLC")?,
            backend,
            allow_fallback,
            receipt_directory: path("GPU_LINK_RECEIPTS")?,
            quality: env::var("GPU_LINK_QUALITY").unwrap_or_else(|_| "unspecified".into()),
            gpu,
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UnitReport {
    pub input_kind: String,
    pub input_sha256: String,
    pub object_sha256: String,
    pub backend: String,
    pub target: String,
    pub fallback_reason: Option<String>,
    pub controller_elapsed_ms: f64,
    pub controller_receipt: Value,
    pub physical_gpu: bool,
    pub device_id: Option<String>,
    pub kernel_dispatches: u64,
    pub kernel_output_used: bool,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct InvocationReport {
    pub schema: String,
    pub version: u32,
    pub status: String,
    pub rustc_version_verbose: String,
    pub requested_backend: String,
    pub quality: String,
    pub gpu_executed: bool,
    pub performance_speedup_demonstrated: bool,
    pub frontend_bitcode_verified: bool,
    pub native_object_before_selected_emitter: Option<bool>,
    pub saved_link_without_recompilation: bool,
    pub forwarded_passthrough: bool,
    pub passthrough_reason: Option<String>,
    pub input_arguments_sha256: String,
    pub source: Option<PathBuf>,
    pub staging_directory: Option<PathBuf>,
    pub frontend_ms: f64,
    pub materialize_ms: f64,
    pub emit_ms: f64,
    pub link_ms: f64,
    pub total_ms: f64,
    pub units: Vec<UnitReport>,
    pub exit_code: i32,
    pub error: Option<String>,
}
pub struct WrapperOutcome {
    pub report: InvocationReport,
    pub exit_code: i32,
}

#[derive(Clone, Debug)]
pub struct DiagnosticRelay {
    stage: PathBuf,
    destination: PathBuf,
}
impl DiagnosticRelay {
    fn publish(&self, path: &Path) -> Result<(), String> {
        let relative = path
            .strip_prefix(&self.stage)
            .map_err(|_| "compiler artifact is outside owned staging")?;
        if relative.components().count() != 1 {
            return Err("nested compiler artifact is not qualified".into());
        }
        let name = relative.to_str().ok_or("artifact path must be UTF-8")?;
        let publish = self.stage.join(".publish");
        fs::create_dir_all(&publish).map_err(|e| e.to_string())?;
        let candidate = publish.join(name);
        if candidate.exists() {
            fs::remove_file(&candidate).map_err(|e| e.to_string())?;
        }
        if name.ends_with(".d") {
            let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
            fs::write(
                &candidate,
                content.replace(
                    self.stage.to_str().ok_or("staging path must be UTF-8")?,
                    self.destination
                        .to_str()
                        .ok_or("output path must be UTF-8")?,
                ),
            )
            .map_err(|e| e.to_string())?;
        } else {
            fs::hard_link(path, &candidate).map_err(|e| e.to_string())?;
        }
        fs::rename(candidate, self.destination.join(relative))
            .map_err(|e| format!("publish compiler artifact: {e}"))
    }
    fn forward(&self, bytes: &[u8]) -> Result<(), String> {
        let mut transformed = None;
        if let Ok(mut message) = serde_json::from_slice::<Value>(bytes) {
            if message.get("$message_type").and_then(Value::as_str) == Some("artifact") {
                if let Some(name) = message.get("artifact").and_then(Value::as_str) {
                    let path = PathBuf::from(name);
                    if path.starts_with(&self.stage) {
                        // Cargo can start dependent compilation as soon as this
                        // metadata event is forwarded; publish that file first.
                        if path.extension().is_some_and(|e| e == "rmeta") {
                            self.publish(&path)?;
                        }
                        let relative = path.strip_prefix(&self.stage).unwrap();
                        message["artifact"] = Value::String(
                            self.destination
                                .join(relative)
                                .to_string_lossy()
                                .into_owned(),
                        );
                        let mut output = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
                        output.push(b'\n');
                        transformed = Some(output);
                    }
                }
            }
        }
        std::io::stderr()
            .lock()
            .write_all(transformed.as_deref().unwrap_or(bytes))
            .map_err(|e| e.to_string())
    }
}

#[derive(Clone, Debug)]
pub struct ToolCall {
    pub program: PathBuf,
    pub arguments: Vec<OsString>,
    pub bootstrap: bool,
    pub inherit_io: bool,
    pub relay: Option<DiagnosticRelay>,
}
pub struct ToolOutput {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
pub trait ToolRunner {
    fn run(&mut self, call: &ToolCall) -> Result<ToolOutput, String>;
}
pub struct ProcessRunner;
fn exit_code(status: std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(1))
    }
    #[cfg(not(unix))]
    {
        status.code().unwrap_or(1)
    }
}
impl ToolRunner for ProcessRunner {
    fn run(&mut self, call: &ToolCall) -> Result<ToolOutput, String> {
        let mut command = Command::new(&call.program);
        command.args(&call.arguments);
        if call.bootstrap {
            command.env("RUSTC_BOOTSTRAP", "1");
        }
        if call.inherit_io {
            let status = command.status().map_err(|e| e.to_string())?;
            return Ok(ToolOutput {
                exit_code: exit_code(status),
                stdout: vec![],
                stderr: vec![],
            });
        }
        if let Some(relay) = &call.relay {
            let mut child = command
                .stdout(Stdio::inherit())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?;
            let stderr = child.stderr.take().unwrap();
            let mut reader = BufReader::new(stderr);
            let mut line = Vec::new();
            let mut failure = None;
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        if let Err(error) = relay.forward(&line) {
                            failure.get_or_insert(error);
                        }
                    }
                    Err(error) => {
                        failure = Some(error.to_string());
                        break;
                    }
                }
            }
            let status = child.wait().map_err(|e| e.to_string())?;
            if let Some(error) = failure {
                return Err(format!("compiler diagnostic relay: {error}"));
            }
            return Ok(ToolOutput {
                exit_code: exit_code(status),
                stdout: vec![],
                stderr: vec![],
            });
        }
        let output = command.output().map_err(|e| e.to_string())?;
        Ok(ToolOutput {
            exit_code: exit_code(output.status),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn argument_digest(arguments: &[OsString]) -> String {
    let mut bytes = Vec::new();
    for argument in arguments {
        let text = argument.to_string_lossy();
        bytes.extend_from_slice(&(text.len() as u64).to_le_bytes());
        bytes.extend_from_slice(text.as_bytes());
    }
    digest(&bytes)
}
fn call(program: &Path, arguments: Vec<OsString>) -> ToolCall {
    ToolCall {
        program: program.to_owned(),
        arguments,
        bootstrap: false,
        inherit_io: false,
        relay: None,
    }
}
fn elapsed(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}
fn absolute(path: &Path) -> Result<PathBuf, String> {
    if path.is_absolute() {
        Ok(path.to_owned())
    } else {
        Ok(env::current_dir().map_err(|e| e.to_string())?.join(path))
    }
}

fn emit_object(
    options: &WrapperOptions,
    llvm_codegen_opt_level: u32,
    input: &Path,
    output: &Path,
    receipt: &Path,
    runner: &mut impl ToolRunner,
) -> Result<(Value, Option<String>, bool), String> {
    let mut gpu_fallback = None;
    if let Some(gpu) = &options.gpu {
        let packet = output.with_extension("gem1");
        let attempt = (|| -> Result<Value, String> {
            let export = runner.run(&call(
                &options.bridge,
                vec![
                    "--export-leaf".into(),
                    input.as_os_str().to_owned(),
                    packet.clone().into_os_string(),
                ],
            ))?;
            if export.exit_code != 0 {
                return Err(format!(
                    "GPU scalar eligibility/export rejected module: {}",
                    String::from_utf8_lossy(&export.stderr).trim()
                ));
            }
            let mut arguments = vec![
                "--input".into(),
                packet.into_os_string(),
                "--output".into(),
                output.as_os_str().to_owned(),
                "--backend".into(),
                gpu.backend.clone().into(),
                "--library".into(),
                gpu.library.clone().into_os_string(),
                "--device".into(),
                gpu.device.to_string().into(),
                "--report".into(),
                receipt.as_os_str().to_owned(),
            ];
            if let Some(shader) = &gpu.shader {
                arguments.extend(["--shader".into(), shader.clone().into_os_string()]);
            }
            let emission = runner.run(&call(&gpu.emitter, arguments))?;
            if !emission.stderr.is_empty() {
                std::io::stderr()
                    .lock()
                    .write_all(&emission.stderr)
                    .map_err(|e| e.to_string())?;
            }
            if emission.exit_code != 0 {
                return Err(format!(
                    "physical GPU emission failed with exit code {}",
                    emission.exit_code
                ));
            }
            let value: Value =
                serde_json::from_slice(&fs::read(receipt).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if value.get("backend").and_then(Value::as_str) != Some(&gpu.backend)
                || value.get("physical_gpu").and_then(Value::as_bool) != Some(true)
                || value.get("gpu_executed").and_then(Value::as_bool) != Some(true)
                || value
                    .get("device_id")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
                || value
                    .get("kernel_dispatches")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    == 0
                || value.get("kernel_output_used").and_then(Value::as_bool) != Some(true)
            {
                return Err("GPU emitter did not provide matching physical-device and used-kernel-output evidence".into());
            }
            Ok(value)
        })();
        match attempt {
            Ok(value) => return Ok((value, None, true)),
            Err(error) if options.allow_fallback => {
                // Failed candidates are never linked. The immutable bitcode is
                // replayed by an explicitly permitted CPU adapter, with cost.
                if output.exists() {
                    fs::remove_file(output).map_err(|e| e.to_string())?;
                }
                if receipt.exists() {
                    fs::remove_file(receipt).map_err(|e| e.to_string())?;
                }
                gpu_fallback = Some(error);
            }
            Err(error) => return Err(error),
        }
    }
    let backend = if options.backend == "gpu" {
        "tpde"
    } else {
        &options.backend
    };
    let mut args = vec![
        "compile".into(),
        "--input".into(),
        input.as_os_str().to_owned(),
        "--output".into(),
        output.as_os_str().to_owned(),
        "--bridge".into(),
        options.bridge.clone().into_os_string(),
        "--llc".into(),
        options.llc.clone().into_os_string(),
        "--backend".into(),
        backend.into(),
        "--llvm-codegen-opt-level".into(),
        llvm_codegen_opt_level.to_string().into(),
        "--report".into(),
        receipt.as_os_str().to_owned(),
    ];
    if options.allow_fallback {
        args.push("--allow-fallback".into());
    }
    let result = runner.run(&call(&options.controller, args))?;
    if !result.stderr.is_empty() {
        std::io::stderr()
            .lock()
            .write_all(&result.stderr)
            .map_err(|e| e.to_string())?;
    }
    if result.exit_code != 0 {
        return Err(format!(
            "object adapter failed with exit code {}",
            result.exit_code
        ));
    }
    let value: Value = serde_json::from_slice(&fs::read(receipt).map_err(|e| e.to_string())?)
        .map_err(|e| format!("invalid object-controller receipt: {e}"))?;
    if !matches!(
        value.get("backend").and_then(Value::as_str),
        Some("tpde" | "llvm")
    ) || value.get("gpu_accelerated").and_then(Value::as_bool) != Some(false)
    {
        return Err("CPU object controller cannot report GPU execution".into());
    }
    Ok((value, gpu_fallback, false))
}

pub fn run_with(
    rustc: &Path,
    arguments: &[OsString],
    options: &WrapperOptions,
    runner: &mut impl ToolRunner,
) -> Result<WrapperOutcome, String> {
    let start = Instant::now();
    let number = NEXT.fetch_add(1, Ordering::Relaxed);
    let identifier = format!("gpu-object-bridge-{}-{number}", std::process::id());
    let mut report = InvocationReport {
        schema: "gpu-rust-object-bridge".into(),
        version: 1,
        status: "failed".into(),
        rustc_version_verbose: String::new(),
        requested_backend: options.backend.clone(),
        quality: options.quality.clone(),
        gpu_executed: false,
        performance_speedup_demonstrated: false,
        frontend_bitcode_verified: false,
        native_object_before_selected_emitter: None,
        saved_link_without_recompilation: false,
        forwarded_passthrough: false,
        passthrough_reason: None,
        input_arguments_sha256: argument_digest(arguments),
        source: None,
        staging_directory: None,
        frontend_ms: 0.0,
        materialize_ms: 0.0,
        emit_ms: 0.0,
        link_ms: 0.0,
        total_ms: 0.0,
        units: vec![],
        exit_code: 1,
        error: None,
    };
    let operation = (|| -> Result<i32, String> {
        let plan = match classify(arguments)? {
            InvocationKind::PassThrough(reason) => {
                report.forwarded_passthrough = true;
                report.passthrough_reason = Some(reason);
                let mut invocation = call(rustc, arguments.to_vec());
                invocation.inherit_io = true;
                return runner.run(&invocation).map(|output| output.exit_code);
            }
            InvocationKind::Compile(plan) => plan,
        };
        report.source = Some(absolute(&plan.source)?);
        if options.backend == "gpu" && options.gpu.is_none() {
            return Err("GPU object mode requires explicit device/emitter configuration".into());
        }
        let materialize = Instant::now();
        let version = runner.run(&call(rustc, vec!["-vV".into()]))?;
        report.rustc_version_verbose =
            String::from_utf8(version.stdout).map_err(|_| "rustc version is not UTF-8")?;
        if version.exit_code != 0
            || !report
                .rustc_version_verbose
                .lines()
                .any(|line| line == format!("release: {RUST_VERSION}"))
        {
            return Err(format!("object bridge requires exact rustc {RUST_VERSION}"));
        }
        let destination = absolute(&plan.output_directory)?;
        fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
        let stage = destination.join(format!(".{identifier}"));
        fs::create_dir(&stage)
            .map_err(|e| format!("create exclusively owned compiler staging: {e}"))?;
        report.staging_directory = Some(stage.clone());
        let relay = DiagnosticRelay {
            stage: stage.clone(),
            destination,
        };
        let mut frontend = arguments.to_vec();
        if let Some((index, inline)) = plan.out_dir {
            frontend[index] = if inline {
                format!("--out-dir={}", stage.display()).into()
            } else {
                stage.clone().into_os_string()
            };
        }
        if let Some((index, inline, name)) = &plan.output {
            let path = stage.join(name);
            frontend[*index] = if *inline {
                format!("-o={}", path.display()).into()
            } else {
                path.into_os_string()
            };
        }
        frontend.extend([
            "-Clinker-plugin-lto=yes".into(),
            "-Clto=off".into(),
            "-Zno-link".into(),
            "-Zallow-features=".into(),
        ]);
        report.materialize_ms += elapsed(materialize);
        let mut invocation = call(rustc, frontend);
        invocation.bootstrap = true;
        invocation.relay = Some(relay.clone());
        let time = Instant::now();
        let compiled = runner.run(&invocation)?;
        report.frontend_ms = elapsed(time);
        if compiled.exit_code != 0 {
            return Ok(compiled.exit_code);
        }
        let time = Instant::now();
        let mut objects = vec![];
        let mut rlinks = vec![];
        for entry in fs::read_dir(&stage).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
                continue;
            }
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.ends_with(".rcgu.o") {
                objects.push(path);
            } else if name.ends_with(".rlink") {
                rlinks.push(path);
            }
        }
        objects.sort();
        if objects.is_empty() || rlinks.len() != 1 {
            return Err(
                "owned Rust staging must contain bitcode objects and exactly one saved-link record"
                    .into(),
            );
        }
        let backend_stage = stage.join(".backend");
        fs::create_dir(&backend_stage).map_err(|e| e.to_string())?;
        report.materialize_ms += elapsed(time);
        for (index, object) in objects.iter().enumerate() {
            let time = Instant::now();
            let bytes = fs::read(object).map_err(|e| e.to_string())?;
            if !bytes.starts_with(b"BC\xc0\xde") && !bytes.starts_with(b"\xde\xc0\x17\x0b") {
                report.native_object_before_selected_emitter =
                    object::File::parse(bytes.as_slice()).ok().map(|_| true);
                return Err(
                    "rustc produced a native object before the selected object adapter".into(),
                );
            }
            let input_sha256 = digest(&bytes);
            let converted = backend_stage.join(format!("{index}.o"));
            let receipt = backend_stage.join(format!("{index}.json"));
            report.materialize_ms += elapsed(time);
            let time = Instant::now();
            let emission = emit_object(
                options,
                plan.llvm_codegen_opt_level,
                object,
                &converted,
                &receipt,
                runner,
            );
            let controller_elapsed_ms = elapsed(time);
            report.emit_ms += controller_elapsed_ms;
            let (value, gpu_fallback, physical_gpu) = emission?;
            let time = Instant::now();
            let backend = value
                .get("backend")
                .and_then(Value::as_str)
                .filter(|b| matches!(*b, "tpde" | "llvm" | "metal" | "cuda"))
                .ok_or("controller receipt has no qualified backend")?
                .to_owned();
            let target = value
                .get("target")
                .and_then(Value::as_str)
                .ok_or("controller receipt has no target")?
                .to_owned();
            if physical_gpu != matches!(backend.as_str(), "metal" | "cuda") {
                return Err("object backend contradicts physical execution attribution".into());
            }
            if !physical_gpu && value.get("gpu_accelerated").and_then(Value::as_bool) != Some(false)
            {
                return Err("CPU object controller cannot report GPU execution".into());
            }
            if options.backend == "llvm" && backend != "llvm" {
                return Err("LLVM request used a different object backend".into());
            }
            let converted_bytes = fs::read(&converted).map_err(|e| e.to_string())?;
            object::File::parse(converted_bytes.as_slice())
                .map_err(|e| format!("converted object is invalid: {e}"))?;
            if value.get("object_bytes").and_then(Value::as_u64)
                != Some(converted_bytes.len() as u64)
            {
                return Err("controller object byte count differs from emitted object".into());
            }
            let cpu_fallback_reason = value
                .get("fallback_reason")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let fallback_reason = match (gpu_fallback, cpu_fallback_reason) {
                (Some(gpu), Some(cpu)) => Some(format!("{gpu}; {cpu}")),
                (Some(reason), None) | (None, Some(reason)) => Some(reason),
                (None, None) => None,
            };
            if options.backend == "tpde"
                && backend != "tpde"
                && (!options.allow_fallback || fallback_reason.is_none())
            {
                return Err("controller used unqualified implicit LLVM fallback".into());
            }
            report.units.push(UnitReport {
                input_kind: "llvm-bitcode".into(),
                input_sha256,
                object_sha256: digest(&converted_bytes),
                backend,
                target,
                fallback_reason,
                controller_elapsed_ms,
                physical_gpu,
                device_id: value
                    .get("device_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                kernel_dispatches: value
                    .get("kernel_dispatches")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                kernel_output_used: value
                    .get("kernel_output_used")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                controller_receipt: value,
            });
            report.gpu_executed |= physical_gpu;
            // Replace only an object in this invocation's private directory.
            fs::rename(converted, object).map_err(|e| e.to_string())?;
            report.materialize_ms += elapsed(time);
        }
        report.frontend_bitcode_verified = true;
        report.native_object_before_selected_emitter = Some(false);
        let mut link = arguments.to_vec();
        link[plan.source_argument] = rlinks[0].clone().into_os_string();
        if let Some((index, inline)) = plan.out_dir {
            link[index] = if inline {
                format!("--out-dir={}", stage.display()).into()
            } else {
                stage.clone().into_os_string()
            };
        }
        if let Some((index, inline, name)) = &plan.output {
            let path = stage.join(name);
            link[*index] = if *inline {
                format!("-o={}", path.display()).into()
            } else {
                path.into_os_string()
            };
        }
        link.push("-Zlink-only".into());
        let mut invocation = call(rustc, link);
        invocation.bootstrap = true;
        invocation.relay = Some(relay.clone());
        let time = Instant::now();
        let linked = runner.run(&invocation)?;
        report.link_ms = elapsed(time);
        if linked.exit_code != 0 {
            return Ok(linked.exit_code);
        }
        report.saved_link_without_recompilation = true;
        let time = Instant::now();
        for entry in fs::read_dir(&stage).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.ends_with(".rlink") || name.ends_with(".rcgu.o") {
                continue;
            }
            relay.publish(&entry.path())?;
        }
        fs::remove_dir_all(&stage).map_err(|e| format!("clean owned staging: {e}"))?;
        report.materialize_ms += elapsed(time);
        Ok(0)
    })();
    report.exit_code = match operation {
        Ok(code) => code,
        Err(error) => {
            report.error = Some(error);
            1
        }
    };
    report.status = if report.exit_code != 0 {
        "failed"
    } else if report.forwarded_passthrough {
        "passthrough"
    } else {
        "success"
    }
    .into();
    report.total_ms = elapsed(start);
    fs::create_dir_all(&options.receipt_directory).map_err(|e| e.to_string())?;
    let path = options.receipt_directory.join(format!("{identifier}.json"));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("create invocation receipt: {e}"))?;
    serde_json::to_writer(&mut file, &report).map_err(|e| e.to_string())?;
    Ok(WrapperOutcome {
        exit_code: report.exit_code,
        report,
    })
}
