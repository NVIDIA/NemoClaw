// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Compatible Cargo policies. This module performs no GPU compilation.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env, fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

pub const TOOLCHAIN: &str = "1.98.1";
const BACKEND: &str = "rustc-llvm-cpu";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObjectBackend {
    Native,
    Tpde,
    LlvmBitcode,
    Gpu,
}

impl ObjectBackend {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "native" => Ok(Self::Native),
            "tpde" => Ok(Self::Tpde),
            "llvm-bitcode" => Ok(Self::LlvmBitcode),
            "gpu" => Ok(Self::Gpu),
            _ => Err("Object backend must be native, tpde, llvm-bitcode, or gpu".into()),
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Tpde => "tpde",
            Self::LlvmBitcode => "llvm-bitcode",
            Self::Gpu => "gpu",
        }
    }
    fn controller_name(self) -> &'static str {
        match self {
            Self::Tpde => "tpde",
            Self::Gpu => "gpu",
            _ => "llvm",
        }
    }
    fn planned(self) -> &'static str {
        match self {
            Self::Native => BACKEND,
            Self::Tpde => "rustc-bitcode-tpde-cpu",
            Self::LlvmBitcode => "rustc-bitcode-llvm-cpu",
            Self::Gpu => "rustc-bitcode-gpu-eligible",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Fast,
    Balanced,
    Release,
}

impl Quality {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "fast" => Ok(Self::Fast),
            "balanced" => Ok(Self::Balanced),
            "release" => Ok(Self::Release),
            _ => Err("Quality must be fast, balanced, or release".into()),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::Balanced => "balanced",
            Self::Release => "release",
        }
    }

    fn config(self) -> Vec<String> {
        let opt_level = match self {
            Self::Fast => 1,
            Self::Balanced => 2,
            Self::Release => return Vec::new(),
        };
        vec![
            format!("profile.release.opt-level={opt_level}"),
            "profile.release.codegen-units=16".into(),
            "profile.release.lto=\"off\"".into(),
        ]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Placement {
    Auto,
    Cpu,
    Metal,
    Cuda,
}

impl Placement {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "auto" => Ok(Self::Auto),
            "cpu" => Ok(Self::Cpu),
            "metal" => Ok(Self::Metal),
            "cuda" => Ok(Self::Cuda),
            _ => Err("Placement must be auto, cpu, metal, or cuda".into()),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SizeBasis {
    Unmodified,
    StripDebug,
}

impl SizeBasis {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "unmodified" => Ok(Self::Unmodified),
            "strip-debug" => Ok(Self::StripDebug),
            _ => Err("Size basis must be unmodified or strip-debug".into()),
        }
    }
}

pub struct Options {
    pub plan: bool,
    pub manifest_path: PathBuf,
    pub package: String,
    pub binary: String,
    pub quality: Quality,
    pub placement: Placement,
    pub target_root: Option<PathBuf>,
    pub offline: bool,
    pub features: Option<String>,
    pub no_default_features: bool,
    pub reference_artifact: Option<PathBuf>,
    pub max_size_ratio: f64,
    pub size_basis: SizeBasis,
    pub object_backend: ObjectBackend,
    pub bitcode_wrapper: Option<PathBuf>,
    pub tpde_controller: Option<PathBuf>,
    pub tpde_bridge: Option<PathBuf>,
    pub llvm_llc: Option<PathBuf>,
    pub allow_backend_fallback: bool,
    pub gpu_emitter: Option<PathBuf>,
    pub gpu_library: Option<PathBuf>,
    pub gpu_shader: Option<PathBuf>,
    pub gpu_backend: Option<Placement>,
    pub gpu_device: u32,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            plan: false,
            manifest_path: "Cargo.toml".into(),
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
        }
    }
}

#[derive(Debug, Serialize)]
pub struct BackendTool {
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Debug, Serialize)]
pub struct BackendToolchain {
    pub provenance_sha256: String,
    pub wrapper: BackendTool,
    pub controller: BackendTool,
    pub bridge: Option<BackendTool>,
    pub llc: Option<BackendTool>,
    pub allow_fallback: bool,
    pub gpu_emitter: Option<BackendTool>,
    pub gpu_library: Option<BackendTool>,
    pub gpu_shader: Option<BackendTool>,
    pub gpu_backend: Option<Placement>,
    pub gpu_device: u32,
    pub rust_llvm_library: BackendTool,
    pub llc_version: Option<String>,
    pub fallback_library_selection_verified: bool,
    pub fallback_library_scope: &'static str,
}

#[derive(Debug, Default, Serialize)]
pub struct BackendEvidence {
    pub directory: PathBuf,
    pub receipt_count: u64,
    pub successful_receipts: u64,
    pub failed_receipts: u64,
    pub failed_passthrough_probes: u64,
    pub failed_semantic_invocations: u64,
    pub forwarded_passthrough: u64,
    pub translated_units: u64,
    pub unit_backend_counts: BTreeMap<String, u64>,
    pub fallback_units: u64,
    pub fallback_stage_counts: BTreeMap<String, u64>,
    pub fallback_reasons: BTreeMap<String, u64>,
    pub physical_gpu_units: u64,
    pub gpu_kernel_dispatches: u64,
    pub gpu_devices: BTreeMap<String, u64>,
    pub frontend_ms: f64,
    pub materialize_ms: f64,
    pub emit_ms: f64,
    pub link_ms: f64,
    pub wrapper_total_ms: f64,
    pub timing_scope: &'static str,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CachedGpuLineage {
    schema: String,
    version: u32,
    pub artifact_path: PathBuf,
    pub artifact_sha256: String,
    pub backend_provenance_sha256: String,
    pub rustc_version_verbose: String,
    pub quality: Quality,
    pub manifest_sha256: String,
    pub lockfile_sha256: String,
    pub rustflags_sha256: Option<String>,
    pub encoded_rustflags_sha256: Option<String>,
    pub qualified_receipts_directory: PathBuf,
    pub qualified_receipt_hashes: BTreeMap<String, String>,
    pub physical_gpu_units: u64,
    pub gpu_devices: BTreeMap<String, u64>,
    pub origin_backend: String,
}

#[derive(Debug, Serialize)]
pub struct Source {
    pub manifest_path: PathBuf,
    pub workspace_root: PathBuf,
    pub manifest_sha256: String,
    pub lockfile_sha256: String,
    pub git_head: Option<String>,
    pub git_worktree_dirty: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct Artifact {
    pub path: PathBuf,
    pub cargo_fresh: bool,
    pub raw_bytes: u64,
    pub measured_bytes: u64,
    pub size_basis: SizeBasis,
    pub measurement_command: Vec<String>,
    pub sha256: String,
    pub reference: Option<Reference>,
}

#[derive(Debug, Serialize)]
pub struct Reference {
    pub path: PathBuf,
    pub raw_bytes: u64,
    pub measured_bytes: u64,
    pub sha256: String,
    pub max_ratio: f64,
    pub observed_ratio: f64,
    pub within_limit: bool,
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub schema: &'static str,
    pub version: u32,
    pub status: &'static str,
    pub quality: Quality,
    pub requested_placement: Placement,
    pub object_backend: ObjectBackend,
    pub backend_toolchain: Option<BackendToolchain>,
    pub backend_environment: BTreeMap<String, String>,
    pub object_backend_receipts: Option<BackendEvidence>,
    pub planned_backend: &'static str,
    pub actual_backend: Option<&'static str>,
    pub gpu_compilation_jobs: u64,
    pub gpu_executed: bool,
    pub current_run_gpu_qualified: bool,
    pub cache_only: bool,
    pub cached_gpu_lineage: Option<CachedGpuLineage>,
    pub performance_speedup_demonstrated: bool,
    pub placement_reason: &'static str,
    pub toolchain: &'static str,
    pub rustc_version_verbose: String,
    pub rustc_path: PathBuf,
    pub source: Source,
    pub cargo_program: &'static str,
    pub cargo_arguments: Vec<String>,
    pub target_dir: PathBuf,
    pub invocation_directory: PathBuf,
    pub jobserver_inherited: bool,
    pub rustflags_sha256: Option<String>,
    pub encoded_rustflags_sha256: Option<String>,
    pub semantic_policy: &'static str,
    pub policy_scope: &'static str,
    pub cargo_elapsed_ms: Option<f64>,
    pub total_elapsed_ms: f64,
    pub artifact: Option<Artifact>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Owner {
    version: u32,
    manifest_path: PathBuf,
    quality: Quality,
    toolchain: String,
    object_backend: ObjectBackend,
    backend_provenance: String,
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn file_digest(path: &Path) -> Result<String, String> {
    fs::read(path)
        .map(|bytes| digest(&bytes))
        .map_err(|error| format!("{}: {error}", path.display()))
}

fn backend_tool(path: &Option<PathBuf>, name: &str) -> Result<BackendTool, String> {
    let path = path
        .as_ref()
        .ok_or_else(|| format!("Alternate object backend requires {name}"))?;
    let path = fs::canonicalize(path).map_err(|error| format!("{name}: {error}"))?;
    if !path.is_file() {
        return Err(format!("{name} must identify a regular tool file"));
    }
    Ok(BackendTool {
        sha256: file_digest(&path)?,
        path,
    })
}

fn pinned_llvm_library(sysroot: &Path) -> Result<BackendTool, String> {
    let directory = sysroot.join("lib");
    let mut paths = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == "libLLVM.dylib"
            || name == "libLLVM.so"
            || (name.starts_with("libLLVM") && (name.ends_with(".so") || name.contains(".so.")))
        {
            let path = fs::canonicalize(entry.path()).map_err(|e| e.to_string())?;
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    if paths.len() != 1 {
        return Err("Pinned sysroot must identify exactly one Rust LLVM shared library".into());
    }
    backend_tool(&Some(paths.remove(0)), "pinned Rust LLVM shared library")
}

fn backend_toolchain(
    options: &Options,
    sysroot: &Path,
) -> Result<Option<BackendToolchain>, String> {
    if options.object_backend == ObjectBackend::Native {
        if options.bitcode_wrapper.is_some()
            || options.tpde_controller.is_some()
            || options.tpde_bridge.is_some()
            || options.llvm_llc.is_some()
            || options.allow_backend_fallback
            || options.gpu_emitter.is_some()
            || options.gpu_library.is_some()
            || options.gpu_shader.is_some()
            || options.gpu_backend.is_some()
            || options.gpu_device != 0
        {
            return Err(
                "Backend tool/fallback options require an alternate --object-backend".into(),
            );
        }
        return Ok(None);
    }
    if options.quality == Quality::Release {
        return Err("Alternate object backends support fast or balanced only; release preserves the native Cargo LTO contract".into());
    }
    let wrapper = backend_tool(&options.bitcode_wrapper, "--bitcode-wrapper")?;
    let controller = backend_tool(&options.tpde_controller, "--tpde-controller")?;
    let bridge = backend_tool(&options.tpde_bridge, "--tpde-bridge")?;
    let llc = backend_tool(&options.llvm_llc, "--llvm-llc")?;
    let rust_llvm_library = pinned_llvm_library(sysroot)?;
    let llc_version = Command::new(&llc.path)
        .arg("--version")
        .env("RUST_LLVM_LIBRARY", &rust_llvm_library.path)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok());
    let fallback_library_selection_verified = llc_version.as_ref().is_some_and(|version| {
        version.starts_with("Rust LLVM C-API object emitter\n")
            && version
                .lines()
                .find_map(|line| line.strip_prefix("Existing Rust LLVM library: "))
                .and_then(|path| fs::canonicalize(path).ok())
                .is_some_and(|path| path == rust_llvm_library.path)
            && version.lines().any(|line| line == "LLVM version 22.1.8")
    });
    let fallback_library_scope = if fallback_library_selection_verified {
        "Pinned Rust LLVM C-API library selected and hashed"
    } else {
        "External llc executable hashed; additional dynamic dependencies are unqualified, so GPU cache lineage is unavailable"
    };
    let (gpu_emitter, gpu_library, gpu_shader, gpu_backend) =
        if options.object_backend == ObjectBackend::Gpu {
            let backend = options.gpu_backend.unwrap_or({
                if matches!(options.placement, Placement::Metal | Placement::Cuda) {
                    options.placement
                } else if cfg!(target_os = "macos") {
                    Placement::Metal
                } else {
                    Placement::Cuda
                }
            });
            if !matches!(backend, Placement::Metal | Placement::Cuda)
                || options.placement == Placement::Cpu
                || (matches!(options.placement, Placement::Metal | Placement::Cuda)
                    && options.placement != backend)
            {
                return Err(
                    "GPU object backend requires matching Metal or CUDA placement/backend".into(),
                );
            }
            (
                Some(backend_tool(&options.gpu_emitter, "--gpu-emitter")?),
                Some(backend_tool(&options.gpu_library, "--gpu-library")?),
                if backend == Placement::Metal {
                    Some(backend_tool(&options.gpu_shader, "--gpu-shader")?)
                } else {
                    options
                        .gpu_shader
                        .as_ref()
                        .map(|_| backend_tool(&options.gpu_shader, "--gpu-shader"))
                        .transpose()?
                },
                Some(backend),
            )
        } else {
            if options.gpu_emitter.is_some()
                || options.gpu_library.is_some()
                || options.gpu_shader.is_some()
                || options.gpu_backend.is_some()
                || options.gpu_device != 0
            {
                return Err("GPU tool options require --object-backend gpu".into());
            }
            (None, None, None, None)
        };
    let provenance = serde_json::to_vec(&(
        options.object_backend,
        &wrapper,
        &controller,
        &bridge,
        &llc,
        options.allow_backend_fallback,
        &gpu_emitter,
        &gpu_library,
        &gpu_shader,
        gpu_backend,
        options.gpu_device,
        &rust_llvm_library,
        &llc_version,
        fallback_library_selection_verified,
    ))
    .map_err(|error| error.to_string())?;
    Ok(Some(BackendToolchain {
        provenance_sha256: digest(&provenance),
        wrapper,
        controller,
        bridge: Some(bridge),
        llc: Some(llc),
        allow_fallback: options.allow_backend_fallback,
        gpu_emitter,
        gpu_library,
        gpu_shader,
        gpu_backend,
        gpu_device: options.gpu_device,
        rust_llvm_library,
        llc_version,
        fallback_library_selection_verified,
        fallback_library_scope,
    }))
}

fn aggregate_receipts(directory: &Path, options: &Options) -> Result<BackendEvidence, String> {
    let mut evidence = BackendEvidence {directory:directory.to_owned(), timing_scope:"Sum of wrapper invocation stages; Cargo processes can overlap, so these are not whole-build wall-time shares", ..Default::default()};
    let mut files = fs::read_dir(directory)
        .map_err(|e| e.to_string())?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    files.sort();
    for file in files {
        if file.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let receipt: serde_json::Value =
            serde_json::from_slice(&fs::read(&file).map_err(|e| e.to_string())?)
                .map_err(|error| format!("Invalid backend receipt {}: {error}", file.display()))?;
        if receipt["schema"] != "gpu-rust-object-bridge"
            || receipt["version"] != 1
            || receipt["requested_backend"] != options.object_backend.controller_name()
            || receipt["quality"] != options.quality.name()
        {
            return Err(format!(
                "Backend receipt schema, quality, placement, or request provenance mismatch: {}",
                file.display()
            ));
        }
        match receipt["status"].as_str() {
            Some("success" | "passthrough") => evidence.successful_receipts += 1,
            Some("failed") => evidence.failed_receipts += 1,
            _ => return Err("Backend receipt has an unknown status".into()),
        }
        evidence.receipt_count += 1;
        let executed = receipt["gpu_executed"]
            .as_bool()
            .ok_or("Backend receipt omitted GPU execution state")?;
        if receipt["performance_speedup_demonstrated"] != false {
            return Err(
                "Object receipt cannot infer a performance speedup from device execution".into(),
            );
        }
        let mut receipt_gpu_units = 0;
        let forwarded = receipt["forwarded_passthrough"]
            .as_bool()
            .ok_or("Backend receipt omitted passthrough state")?;
        let units = receipt["units"]
            .as_array()
            .ok_or("Backend receipt omitted units")?;
        if forwarded {
            evidence.forwarded_passthrough += 1;
        }
        if receipt["status"] == "failed" {
            if forwarded && units.is_empty() {
                evidence.failed_passthrough_probes += 1;
            } else {
                evidence.failed_semantic_invocations += 1;
            }
        }
        for (key, total) in [
            ("frontend_ms", &mut evidence.frontend_ms),
            ("materialize_ms", &mut evidence.materialize_ms),
            ("emit_ms", &mut evidence.emit_ms),
            ("link_ms", &mut evidence.link_ms),
            ("total_ms", &mut evidence.wrapper_total_ms),
        ] {
            let value = receipt[key]
                .as_f64()
                .ok_or_else(|| format!("Backend receipt omitted stage {key}"))?;
            if !value.is_finite() || value < 0.0 {
                return Err(format!("Backend receipt has invalid stage {key}"));
            }
            *total += value;
        }
        for unit in units {
            let backend = unit["backend"]
                .as_str()
                .ok_or("Backend unit omitted actual backend")?;
            if !matches!(backend, "tpde" | "llvm" | "metal" | "cuda") {
                return Err("Backend unit reports an unknown object emitter".into());
            }
            *evidence
                .unit_backend_counts
                .entry(backend.into())
                .or_default() += 1;
            evidence.translated_units += 1;
            if matches!(backend, "metal" | "cuda") {
                let selected = options.gpu_backend.unwrap_or({
                    if matches!(options.placement, Placement::Metal | Placement::Cuda) {
                        options.placement
                    } else if cfg!(target_os = "macos") {
                        Placement::Metal
                    } else {
                        Placement::Cuda
                    }
                });
                let expected = if selected == Placement::Metal {
                    "metal"
                } else {
                    "cuda"
                };
                let dispatches = unit["kernel_dispatches"]
                    .as_u64()
                    .ok_or("GPU unit omitted dispatch evidence")?;
                let device = unit["device_id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or("GPU unit omitted physical device identity")?;
                if options.object_backend != ObjectBackend::Gpu
                    || backend != expected
                    || unit["physical_gpu"] != true
                    || unit["kernel_output_used"] != true
                    || dispatches == 0
                {
                    return Err(
                        "GPU object unit lacks matching physical execution and used kernel output"
                            .into(),
                    );
                }
                evidence.physical_gpu_units += 1;
                receipt_gpu_units += 1;
                evidence.gpu_kernel_dispatches = evidence
                    .gpu_kernel_dispatches
                    .checked_add(dispatches)
                    .ok_or("GPU dispatch total overflow")?;
                *evidence.gpu_devices.entry(device.into()).or_default() += 1;
            } else if unit["physical_gpu"] == true
                || unit["kernel_output_used"] == true
                || unit["kernel_dispatches"]
                    .as_u64()
                    .is_some_and(|value| value > 0)
            {
                return Err("CPU object unit reports contradictory GPU execution evidence".into());
            }
            if let Some(reason) = unit["fallback_reason"]
                .as_str()
                .filter(|reason| !reason.is_empty())
            {
                if !matches!(
                    options.object_backend,
                    ObjectBackend::Tpde | ObjectBackend::Gpu
                ) || !matches!(backend, "llvm" | "tpde")
                    || !options.allow_backend_fallback
                {
                    return Err("Backend receipt records an unauthorized fallback".into());
                }
                evidence.fallback_units += 1;
                *evidence
                    .fallback_stage_counts
                    .entry("object-emission".into())
                    .or_default() += 1;
                *evidence.fallback_reasons.entry(reason.into()).or_default() += 1;
            } else if (options.object_backend == ObjectBackend::Tpde && backend == "llvm")
                || (options.object_backend == ObjectBackend::Gpu
                    && matches!(backend, "llvm" | "tpde"))
            {
                return Err("CPU fallback unit omitted its explicit reason".into());
            }
        }
        if executed != (receipt_gpu_units > 0) {
            return Err(
                "Backend receipt GPU claim disagrees with verified object-unit evidence".into(),
            );
        }
    }
    Ok(evidence)
}

fn observed_backend(evidence: &BackendEvidence, fresh: bool) -> Option<&'static str> {
    if fresh && evidence.translated_units == 0 {
        return Some("cached-artifact");
    }
    let tpde = evidence
        .unit_backend_counts
        .get("tpde")
        .copied()
        .unwrap_or(0)
        > 0;
    let llvm = evidence
        .unit_backend_counts
        .get("llvm")
        .copied()
        .unwrap_or(0)
        > 0;
    if evidence.physical_gpu_units > 0 {
        return Some(if tpde || llvm || evidence.forwarded_passthrough > 0 {
            "rustc-bitcode-gpu-and-cpu"
        } else if evidence.unit_backend_counts.contains_key("metal") {
            "rustc-bitcode-metal"
        } else {
            "rustc-bitcode-cuda"
        });
    }
    match (tpde, llvm, evidence.forwarded_passthrough > 0) {
        (true, false, false) => Some("rustc-bitcode-tpde-cpu"),
        (true, _, _) => Some("rustc-bitcode-mixed-cpu"),
        (false, true, _) => Some("rustc-bitcode-llvm-cpu"),
        (false, false, true) => Some("rustc-llvm-cpu-passthrough"),
        _ if fresh => Some("cached-artifact"),
        _ => None,
    }
}

fn receipt_hashes(directory: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut hashes = BTreeMap::new();
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry
            .path()
            .extension()
            .is_none_or(|extension| extension != "json")
        {
            continue;
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Receipt filename is not UTF-8")?;
        hashes.insert(name, file_digest(&entry.path())?);
    }
    Ok(hashes)
}

fn lineage_path(target: &Path) -> PathBuf {
    target.join(".gpu-cargo-qualified-gpu-artifact.json")
}

fn qualified_lineage(report: &Report) -> Result<CachedGpuLineage, String> {
    let artifact = report
        .artifact
        .as_ref()
        .ok_or("GPU lineage has no artifact")?;
    let tools = report
        .backend_toolchain
        .as_ref()
        .ok_or("GPU lineage has no tool provenance")?;
    let evidence = report
        .object_backend_receipts
        .as_ref()
        .ok_or("GPU lineage has no receipts")?;
    if !report.current_run_gpu_qualified || evidence.physical_gpu_units == 0 {
        return Err("Current run has no qualified GPU lineage".into());
    }
    if evidence.failed_semantic_invocations > 0 {
        return Err(
            "Failed semantic backend invocations cannot qualify GPU artifact lineage".into(),
        );
    }
    if !tools.fallback_library_selection_verified {
        return Err("GPU cache lineage requires a qualified selected fallback LLVM library".into());
    }
    Ok(CachedGpuLineage {
        schema: "gpu-cargo-qualified-gpu-artifact".into(),
        version: 1,
        artifact_path: artifact.path.clone(),
        artifact_sha256: artifact.sha256.clone(),
        backend_provenance_sha256: tools.provenance_sha256.clone(),
        rustc_version_verbose: report.rustc_version_verbose.clone(),
        quality: report.quality,
        manifest_sha256: report.source.manifest_sha256.clone(),
        lockfile_sha256: report.source.lockfile_sha256.clone(),
        rustflags_sha256: report.rustflags_sha256.clone(),
        encoded_rustflags_sha256: report.encoded_rustflags_sha256.clone(),
        qualified_receipts_directory: evidence.directory.clone(),
        qualified_receipt_hashes: receipt_hashes(&evidence.directory)?,
        physical_gpu_units: evidence.physical_gpu_units,
        gpu_devices: evidence.gpu_devices.clone(),
        origin_backend: report
            .actual_backend
            .ok_or("GPU lineage omitted actual backend")?
            .into(),
    })
}

fn save_lineage(report: &Report) -> Result<(), String> {
    let lineage = qualified_lineage(report)?;
    let path = lineage_path(&report.target_dir);
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    let result = file
        .write_all(&serde_json::to_vec(&lineage).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string());
    drop(file);
    let result = result.and_then(|_| fs::rename(&temporary, path).map_err(|e| e.to_string()));
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn cached_lineage(report: &Report, options: &Options) -> Result<CachedGpuLineage, String> {
    let lineage: CachedGpuLineage = serde_json::from_slice(
        &fs::read(lineage_path(&report.target_dir))
            .map_err(|e| format!("No qualified cached GPU lineage: {e}"))?,
    )
    .map_err(|e| format!("Invalid cached GPU lineage: {e}"))?;
    let artifact = report
        .artifact
        .as_ref()
        .ok_or("Cached GPU lineage has no artifact")?;
    let tools = report
        .backend_toolchain
        .as_ref()
        .ok_or("Cached GPU lineage has no tools")?;
    if lineage.schema != "gpu-cargo-qualified-gpu-artifact"
        || lineage.version != 1
        || lineage.physical_gpu_units == 0
        || lineage.artifact_path != artifact.path
        || lineage.artifact_sha256 != artifact.sha256
        || lineage.backend_provenance_sha256 != tools.provenance_sha256
        || lineage.rustc_version_verbose != report.rustc_version_verbose
        || lineage.quality != report.quality
        || lineage.manifest_sha256 != report.source.manifest_sha256
        || lineage.lockfile_sha256 != report.source.lockfile_sha256
        || lineage.rustflags_sha256 != report.rustflags_sha256
        || lineage.encoded_rustflags_sha256 != report.encoded_rustflags_sha256
        || !tools.fallback_library_selection_verified
        || !lineage
            .qualified_receipts_directory
            .starts_with(report.target_dir.join(".gpu-link-receipts"))
    {
        return Err("Cached GPU artifact/input/tool provenance does not match".into());
    }
    if lineage.qualified_receipt_hashes.is_empty()
        || receipt_hashes(&lineage.qualified_receipts_directory)?
            != lineage.qualified_receipt_hashes
    {
        return Err("Cached GPU receipt lineage changed or is incomplete".into());
    }
    let evidence = aggregate_receipts(&lineage.qualified_receipts_directory, options)?;
    if evidence.physical_gpu_units != lineage.physical_gpu_units
        || evidence.gpu_devices != lineage.gpu_devices
        || evidence.failed_semantic_invocations > 0
    {
        return Err("Cached GPU execution evidence does not qualify its lineage".into());
    }
    Ok(lineage)
}

fn text_path(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("Path must be UTF-8: {}", path.display()))
}

fn rustup_command(program: &str) -> Command {
    let mut command = Command::new("rustup");
    command.args(["run", TOOLCHAIN, program]);
    command
}

fn output_text(mut command: Command, label: &str) -> Result<String, String> {
    let result = command
        .output()
        .map_err(|error| format!("Could not run {label}: {error}"))?;
    if !result.status.success() {
        return Err(format!(
            "{label} failed: {}",
            String::from_utf8_lossy(&result.stderr)
        ));
    }
    String::from_utf8(result.stdout).map_err(|_| format!("{label} emitted non-UTF-8 output"))
}

fn git_output(root: &Path, arguments: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(arguments)
        .output()
        .ok()?;
    output.status.success().then(|| {
        String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_owned()
    })
}

fn absolute(path: &Path) -> Result<PathBuf, String> {
    if path.is_absolute() {
        Ok(path.to_owned())
    } else {
        env::current_dir()
            .map(|current| current.join(path))
            .map_err(|error| error.to_string())
    }
}

fn claim_target(path: &Path, owner: &Owner) -> Result<(), String> {
    let marker = path.join(".gpu-cargo-owner.json");
    if marker.exists() {
        let existing: Owner =
            serde_json::from_slice(&fs::read(&marker).map_err(|e| e.to_string())?)
                .map_err(|e| format!("Invalid target owner marker: {e}"))?;
        if existing != *owner {
            return Err(format!(
                "Target directory belongs to a different policy: {}",
                path.display()
            ));
        }
        return Ok(());
    }
    if path.exists()
        && fs::read_dir(path)
            .map_err(|error| error.to_string())?
            .next()
            .is_some()
    {
        return Err(format!(
            "Refusing to adopt a nonempty target directory without an owner marker: {}",
            path.display()
        ));
    }
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    let mut marker_file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&marker)
        .map_err(|error| format!("Could not create target owner marker: {error}"))?;
    marker_file
        .write_all(&serde_json::to_vec(owner).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

fn strip_arguments() -> Result<Vec<String>, String> {
    if cfg!(target_os = "macos") {
        Ok(vec!["-S".into(), "-x".into()])
    } else if cfg!(target_os = "linux") {
        Ok(vec!["--strip-debug".into(), "--discard-all".into()])
    } else {
        Err("strip-debug measurement supports macOS and Linux only".into())
    }
}

fn measure(path: &Path, basis: SizeBasis, directory: &Path, name: &str) -> Result<u64, String> {
    if matches!(basis, SizeBasis::Unmodified) {
        return fs::metadata(path)
            .map(|meta| meta.len())
            .map_err(|e| e.to_string());
    }
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let copy = directory.join(format!("{}-{name}", std::process::id()));
    fs::copy(path, &copy).map_err(|e| e.to_string())?;
    let result = Command::new("strip")
        .args(strip_arguments()?)
        .arg(&copy)
        .output();
    let measured = match result {
        Ok(result) if result.status.success() => fs::metadata(&copy)
            .map(|m| m.len())
            .map_err(|e| e.to_string()),
        Ok(result) => Err(format!(
            "strip measurement failed: {}",
            String::from_utf8_lossy(&result.stderr)
        )),
        Err(error) => Err(format!("Could not run strip: {error}")),
    };
    let _ = fs::remove_file(copy);
    measured
}

/// Build with the stock pinned compiler or produce an equivalent command plan.
/// Environment and inherited descriptors are retained for Cargo's jobserver.
pub fn execute(options: &Options) -> Result<Report, String> {
    let start = Instant::now();
    if matches!(options.placement, Placement::Metal | Placement::Cuda)
        && options.object_backend != ObjectBackend::Gpu
    {
        return Err("Required GPU placement is unavailable for this object backend; select a qualified GPU object adapter explicitly".into());
    }
    if !options.max_size_ratio.is_finite() || options.max_size_ratio < 1.0 {
        return Err("Maximum size ratio must be finite and at least 1.0".into());
    }
    for value in [&options.package, &options.binary] {
        if value.is_empty() || value.starts_with('-') {
            return Err(
                "Package and binary names must be nonempty and cannot start with '-'".into(),
            );
        }
    }
    for key in ["RUSTC", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"] {
        if env::var_os(key).is_some_and(|value| !value.is_empty()) {
            return Err(format!(
                "{key} overrides the pinned compiler; unset it for this experiment"
            ));
        }
    }
    for key in ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS"] {
        if env::var(key).is_ok_and(|value| value.contains("codegen-backend")) {
            return Err(format!(
                "{key} requests a different backend; the report requires stock LLVM"
            ));
        }
        if options.object_backend != ObjectBackend::Native
            && env::var(key).is_ok_and(|value| {
                value.contains("lto=")
                    || value.contains("linker-plugin-lto")
                    || value.contains("embed-bitcode")
            })
        {
            return Err(format!(
                "{key} overrides the bitcode adapter's required LTO/embedding policy"
            ));
        }
    }
    if options.object_backend != ObjectBackend::Native && env::var_os("RUST_LLVM_LIBRARY").is_some()
    {
        return Err(
            "RUST_LLVM_LIBRARY overrides the pinned fallback library; unset it for this experiment"
                .into(),
        );
    }
    let manifest =
        fs::canonicalize(&options.manifest_path).map_err(|error| format!("Manifest: {error}"))?;
    let mut metadata = rustup_command("cargo");
    metadata
        .args([
            "metadata",
            "--locked",
            "--no-deps",
            "--format-version",
            "1",
            "--manifest-path",
        ])
        .arg(&manifest);
    if options.offline {
        metadata.arg("--offline");
    }
    let metadata: serde_json::Value =
        serde_json::from_str(&output_text(metadata, "Cargo metadata")?)
            .map_err(|error| format!("Invalid Cargo metadata: {error}"))?;
    let workspace = PathBuf::from(
        metadata["workspace_root"]
            .as_str()
            .ok_or("Cargo omitted workspace root")?,
    );
    let mut version_command = rustup_command("rustc");
    version_command.arg("-vV");
    let version = output_text(version_command, "rustc version")?;
    if !version.starts_with(&format!("rustc {TOOLCHAIN} ")) {
        return Err(format!("Expected rustc {TOOLCHAIN}"));
    }
    let mut sysroot_command = rustup_command("rustc");
    sysroot_command.args(["--print", "sysroot"]);
    let sysroot = output_text(sysroot_command, "rustc sysroot")?;
    let backend_tools = backend_toolchain(options, Path::new(sysroot.trim()))?;
    let rustc_path =
        fs::canonicalize(Path::new(sysroot.trim()).join("bin/rustc")).map_err(|e| e.to_string())?;
    let target_root = absolute(
        &options
            .target_root
            .clone()
            .unwrap_or_else(|| workspace.join("target/gpu-cargo")),
    )?;
    let backend_component = backend_tools
        .as_ref()
        .map(|tools| {
            format!(
                "{}-{}",
                options.object_backend.name(),
                &tools.provenance_sha256[..16]
            )
        })
        .unwrap_or_else(|| "native".into());
    let target_dir = target_root
        .join(options.quality.name())
        .join(backend_component);
    let mut backend_environment = BTreeMap::new();
    let receipts_directory = if let Some(tools) = &backend_tools {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let directory = target_dir
            .join(".gpu-link-receipts")
            .join(format!("run-{}-{nonce}", std::process::id()));
        backend_environment.insert(
            "RUST_LLVM_LIBRARY".into(),
            text_path(&tools.rust_llvm_library.path)?,
        );
        backend_environment.insert(
            "GPU_LINK_CONTROLLER".into(),
            text_path(&tools.controller.path)?,
        );
        backend_environment.insert(
            "GPU_LINK_BRIDGE".into(),
            text_path(&tools.bridge.as_ref().ok_or("Bridge omitted")?.path)?,
        );
        backend_environment.insert(
            "GPU_LINK_LLC".into(),
            text_path(&tools.llc.as_ref().ok_or("LLVM llc omitted")?.path)?,
        );
        backend_environment.insert(
            "GPU_LINK_BACKEND".into(),
            options.object_backend.controller_name().into(),
        );
        backend_environment.insert(
            "GPU_LINK_ALLOW_FALLBACK".into(),
            if tools.allow_fallback { "1" } else { "0" }.into(),
        );
        backend_environment.insert("GPU_LINK_QUALITY".into(), options.quality.name().into());
        backend_environment.insert("GPU_LINK_RECEIPTS".into(), text_path(&directory)?);
        if let Some(emitter) = &tools.gpu_emitter {
            backend_environment.insert("GPU_LINK_GPU_EMITTER".into(), text_path(&emitter.path)?);
            backend_environment.insert(
                "GPU_LINK_GPU_LIBRARY".into(),
                text_path(
                    &tools
                        .gpu_library
                        .as_ref()
                        .ok_or("GPU library omitted")?
                        .path,
                )?,
            );
            backend_environment.insert(
                "GPU_LINK_GPU_BACKEND".into(),
                match tools.gpu_backend {
                    Some(Placement::Metal) => "metal",
                    Some(Placement::Cuda) => "cuda",
                    _ => return Err("GPU backend omitted".into()),
                }
                .into(),
            );
            backend_environment.insert(
                "GPU_LINK_GPU_SHADER".into(),
                tools
                    .gpu_shader
                    .as_ref()
                    .map(|shader| text_path(&shader.path))
                    .transpose()?
                    .unwrap_or_default(),
            );
            backend_environment.insert("GPU_LINK_GPU_DEVICE".into(), tools.gpu_device.to_string());
        }
        Some(directory)
    } else {
        None
    };
    let source = Source {
        manifest_path: manifest.clone(),
        workspace_root: workspace.clone(),
        manifest_sha256: file_digest(&manifest)?,
        lockfile_sha256: file_digest(&workspace.join("Cargo.lock"))?,
        git_head: git_output(&workspace, &["rev-parse", "HEAD"]),
        git_worktree_dirty: git_output(
            &workspace,
            &["status", "--porcelain", "--untracked-files=normal"],
        )
        .map(|s| !s.is_empty()),
    };
    let mut arguments = vec![
        "run".into(),
        TOOLCHAIN.into(),
        "cargo".into(),
        "build".into(),
        "--locked".into(),
        "--release".into(),
        "--manifest-path".into(),
        text_path(&manifest)?,
        "--package".into(),
        options.package.clone(),
        "--bin".into(),
        options.binary.clone(),
        "--target-dir".into(),
        text_path(&target_dir)?,
        "--message-format=json-render-diagnostics".into(),
    ];
    // A project can configure another compiler. Pin the executable used by
    // Cargo rather than only probing rustup's selected toolchain.
    arguments.extend([
        "--config".into(),
        format!(
            "build.rustc={}",
            serde_json::to_string(&text_path(&rustc_path)?).map_err(|e| e.to_string())?
        ),
        "--config".into(),
        format!(
            "build.rustc-wrapper={}",
            serde_json::to_string(
                &backend_tools
                    .as_ref()
                    .map(|tools| text_path(&tools.wrapper.path))
                    .transpose()?
                    .unwrap_or_default()
            )
            .map_err(|e| e.to_string())?
        ),
        "--config".into(),
        "build.rustc-workspace-wrapper=\"\"".into(),
    ]);
    if options.offline {
        arguments.push("--offline".into());
    }
    if options.no_default_features {
        arguments.push("--no-default-features".into());
    }
    if let Some(features) = &options.features {
        arguments.extend(["--features".into(), features.clone()]);
    }
    for config in options.quality.config() {
        arguments.extend(["--config".into(), config]);
    }
    let mut report = Report {
        schema: "gpu-cargo-report", version: 1, status: "planned", quality: options.quality,
        requested_placement: options.placement, planned_backend: options.object_backend.planned(), actual_backend: None,
        object_backend:options.object_backend,backend_toolchain:backend_tools,backend_environment,object_backend_receipts:None,
        gpu_compilation_jobs: 0,
        gpu_executed:false,current_run_gpu_qualified:false,cache_only:false,cached_gpu_lineage:None,
        performance_speedup_demonstrated:false,
        placement_reason: "Actual object emitters and GPU work are verified from wrapper receipts; native policies use pinned stock CPU LLVM",
        toolchain: TOOLCHAIN, rustc_version_verbose: version, rustc_path, source,
        cargo_program: "rustup", cargo_arguments: arguments.clone(), target_dir: target_dir.clone(),
        invocation_directory: env::current_dir().map_err(|e| e.to_string())?,
        jobserver_inherited: env::var_os("CARGO_MAKEFLAGS").is_some() || env::var_os("MAKEFLAGS").is_some(),
        rustflags_sha256: env::var("RUSTFLAGS").ok().map(|v| digest(v.as_bytes())),
        encoded_rustflags_sha256: env::var("CARGO_ENCODED_RUSTFLAGS").ok().map(|v| digest(v.as_bytes())),
        semantic_policy: "Preserve project panic, overflow, debug, features, target, and inherited semantic flags",
        policy_scope: "Root release profile; existing package-specific profile overrides and inherited compiler flags retain Cargo precedence",
        cargo_elapsed_ms: None, total_elapsed_ms: 0.0, artifact: None, error: None,
    };
    let reference = options
        .reference_artifact
        .as_deref()
        .map(fs::canonicalize)
        .transpose()
        .map_err(|e| format!("Reference artifact: {e}"))?;
    if let Some(path) = &reference {
        if !path.is_file() || fs::metadata(path).map_err(|e| e.to_string())?.len() == 0 {
            return Err("Reference artifact must be a nonempty regular file".into());
        }
        let resolved_target = fs::canonicalize(&target_dir).unwrap_or_else(|_| target_dir.clone());
        if path.starts_with(&resolved_target) {
            return Err("Reference artifact must be outside the selected quality's target directory so the build cannot replace its baseline".into());
        }
    }
    if options.plan {
        report.total_elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        return Ok(report);
    }
    claim_target(
        &target_dir,
        &Owner {
            version: 2,
            manifest_path: manifest,
            quality: options.quality,
            toolchain: TOOLCHAIN.into(),
            object_backend: options.object_backend,
            backend_provenance: report
                .backend_toolchain
                .as_ref()
                .map(|tools| tools.provenance_sha256.clone())
                .unwrap_or_else(|| "native".into()),
        },
    )?;
    if let Some(directory) = &receipts_directory {
        fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    }
    let cargo_start = Instant::now();
    let mut cargo = Command::new("rustup");
    cargo.args(&arguments);
    for key in [
        "RUST_LLVM_LIBRARY",
        "GPU_LINK_CONTROLLER",
        "GPU_LINK_BRIDGE",
        "GPU_LINK_LLC",
        "GPU_LINK_BACKEND",
        "GPU_LINK_ALLOW_FALLBACK",
        "GPU_LINK_QUALITY",
        "GPU_LINK_RECEIPTS",
        "GPU_LINK_GPU_EMITTER",
        "GPU_LINK_GPU_LIBRARY",
        "GPU_LINK_GPU_BACKEND",
        "GPU_LINK_GPU_SHADER",
        "GPU_LINK_GPU_DEVICE",
    ] {
        cargo.env_remove(key);
    }
    cargo.envs(&report.backend_environment);
    let mut child = cargo
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Cargo: {e}"))?;
    let mut executable = None;
    let mut fresh = false;
    for line in BufReader::new(child.stdout.take().ok_or("Cargo stdout unavailable")?).lines() {
        let line = line.map_err(|e| e.to_string())?;
        let message: serde_json::Value = match serde_json::from_str(&line) {
            Ok(message) => message,
            Err(_) => {
                eprintln!("{line}");
                continue;
            }
        };
        if message["reason"] == "compiler-message" {
            if let Some(rendered) = message["message"]["rendered"].as_str() {
                eprint!("{rendered}");
            }
        }
        if message["reason"] == "compiler-artifact" && message["target"]["name"] == options.binary {
            if let Some(path) = message["executable"].as_str() {
                executable = Some(PathBuf::from(path));
                fresh = message["fresh"].as_bool().unwrap_or(false);
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    report.cargo_elapsed_ms = Some(cargo_start.elapsed().as_secs_f64() * 1000.0);
    report.actual_backend = if let Some(directory) = &receipts_directory {
        let evidence = aggregate_receipts(directory, options)?;
        let actual = observed_backend(&evidence, fresh);
        report.gpu_compilation_jobs = evidence.physical_gpu_units;
        report.object_backend_receipts = Some(evidence);
        actual
    } else {
        Some(BACKEND)
    };
    report.gpu_executed = report.gpu_compilation_jobs > 0;
    report.current_run_gpu_qualified = status.success()
        && report.gpu_executed
        && report
            .object_backend_receipts
            .as_ref()
            .is_none_or(|evidence| evidence.failed_semantic_invocations == 0);
    report.cache_only = fresh
        && report
            .object_backend_receipts
            .as_ref()
            .is_none_or(|evidence| evidence.translated_units == 0);
    if !status.success() {
        report.status = "build-failed";
        report.error = Some(format!("Cargo exited with {status}"));
        report.total_elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        return Ok(report);
    }
    if report.actual_backend.is_none() {
        report.status = "backend-evidence-missing";
        report.error = Some(
            "Cargo succeeded without object-backend receipts or a qualified cached artifact".into(),
        );
        report.total_elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        return Ok(report);
    }
    let path =
        fs::canonicalize(executable.ok_or("Cargo did not report the requested binary artifact")?)
            .map_err(|e| e.to_string())?;
    let measurement_dir = target_dir.join(".gpu-cargo-measurement");
    let measured_bytes = measure(&path, options.size_basis, &measurement_dir, "candidate")?;
    let reference = reference
        .map(|reference_path| {
            let bytes = measure(
                &reference_path,
                options.size_basis,
                &measurement_dir,
                "reference",
            )?;
            let ratio = measured_bytes as f64 / bytes as f64;
            Ok::<_, String>(Reference {
                raw_bytes: fs::metadata(&reference_path)
                    .map_err(|e| e.to_string())?
                    .len(),
                measured_bytes: bytes,
                sha256: file_digest(&reference_path)?,
                path: reference_path,
                max_ratio: options.max_size_ratio,
                observed_ratio: ratio,
                within_limit: ratio <= options.max_size_ratio,
            })
        })
        .transpose()?;
    let within_limit = reference.as_ref().is_none_or(|r| r.within_limit);
    report.artifact = Some(Artifact {
        raw_bytes: fs::metadata(&path).map_err(|e| e.to_string())?.len(),
        measured_bytes,
        size_basis: options.size_basis,
        measurement_command: match options.size_basis {
            SizeBasis::Unmodified => vec![],
            SizeBasis::StripDebug => {
                let mut args = vec!["strip".into()];
                args.extend(strip_arguments()?);
                args
            }
        },
        sha256: file_digest(&path)?,
        path,
        cargo_fresh: fresh,
        reference,
    });
    report.status = if within_limit {
        "ok"
    } else {
        "size-limit-exceeded"
    };
    if !within_limit {
        report.error = Some("Generated executable exceeds the declared reference size limit; no fallback or size-changing rebuild was performed".into());
    }
    if options.object_backend == ObjectBackend::Gpu {
        if report
            .object_backend_receipts
            .as_ref()
            .is_some_and(|evidence| evidence.failed_semantic_invocations > 0)
        {
            let path = lineage_path(&report.target_dir);
            if path.exists() {
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
            report.status = "backend-receipt-failure";
            report.error=Some("Failed semantic backend invocations prevent GPU qualification; only failed empty passthrough probes may be ignored".into());
        } else if report.current_run_gpu_qualified {
            if report
                .backend_toolchain
                .as_ref()
                .is_some_and(|tools| tools.fallback_library_selection_verified)
            {
                save_lineage(&report)?;
            }
        } else if report.cache_only {
            match cached_lineage(&report, options) {
                Ok(lineage) => {
                    report.cached_gpu_lineage = Some(lineage);
                    report.actual_backend = Some("cached-artifact");
                }
                Err(error) => {
                    report.status = "unqualified-gpu-cache";
                    report.error = Some(error);
                }
            }
        } else {
            let path = lineage_path(&report.target_dir);
            if path.exists() {
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
            report.status = "required-gpu-not-executed";
            report.error=Some("This fresh Cargo build emitted no physical GPU modules; CPU fallback does not qualify the required GPU adapter".into());
        }
    }
    report.total_elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    fn receipt(backend: &str, unit: serde_json::Value, executed: bool) -> serde_json::Value {
        serde_json::json!({"schema":"gpu-rust-object-bridge","version":1,"status":"success","requested_backend":backend,"quality":"fast","gpu_executed":executed,"performance_speedup_demonstrated":false,"forwarded_passthrough":false,"frontend_ms":2.0,"materialize_ms":1.0,"emit_ms":3.0,"link_ms":4.0,"total_ms":10.0,"units":[unit]})
    }

    fn directory() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = env::temp_dir().join(format!(
            "gpu-cargo-receipt-protocol-{}-{nonce}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn pinned_library_discovery_accepts_linux_rust_library_names() {
        let path = directory();
        fs::create_dir(path.join("lib")).unwrap();
        let library = path.join("lib/libLLVM-22-rust-1.98.1-stable.so");
        fs::write(&library, b"protocol library fixture").unwrap();
        let resolved = pinned_llvm_library(&path).unwrap();
        assert_eq!(resolved.path, fs::canonicalize(library).unwrap());
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn cpu_receipt_protocol_attributes_fallback_and_rejects_a_gpu_claim() {
        let path = directory();
        let options = Options {
            object_backend: ObjectBackend::Tpde,
            allow_backend_fallback: true,
            ..Default::default()
        };
        let value = receipt(
            "tpde",
            serde_json::json!({"backend":"llvm","fallback_reason":"Darwin requires LLVM object emission"}),
            false,
        );
        fs::write(
            path.join("invocation.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        let evidence = aggregate_receipts(&path, &options).unwrap();
        assert_eq!(evidence.fallback_units, 1);
        assert_eq!(evidence.fallback_stage_counts["object-emission"], 1);
        assert_eq!(evidence.frontend_ms, 2.0);
        assert_eq!(evidence.wrapper_total_ms, 10.0);
        assert_eq!(
            observed_backend(&evidence, false),
            Some("rustc-bitcode-llvm-cpu")
        );
        let mut forged = value;
        forged["gpu_executed"] = true.into();
        fs::write(
            path.join("invocation.json"),
            serde_json::to_vec(&forged).unwrap(),
        )
        .unwrap();
        assert!(aggregate_receipts(&path, &options).is_err());
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn gpu_receipt_protocol_rejects_simulation_and_unused_kernel_output() {
        let path = directory();
        let options = Options {
            object_backend: ObjectBackend::Gpu,
            gpu_backend: Some(Placement::Metal),
            ..Default::default()
        };
        for (physical, used) in [(false, true), (true, false)] {
            let value = receipt(
                "gpu",
                serde_json::json!({"backend":"metal","physical_gpu":physical,"device_id":"protocol simulation","kernel_dispatches":2,"kernel_output_used":used}),
                true,
            );
            fs::write(
                path.join("invocation.json"),
                serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
            assert!(aggregate_receipts(&path, &options).is_err());
        }
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn cached_receipt_protocol_preserves_no_new_gpu_execution_and_checks_integrity() {
        // Synthetic protocol data checks caching and hash validation. This test
        // cannot establish physical GPU execution or a compiler speedup.
        let root = directory();
        let previous = root.join(".gpu-link-receipts/previous");
        fs::create_dir_all(&previous).unwrap();
        let options = Options {
            object_backend: ObjectBackend::Gpu,
            gpu_backend: Some(Placement::Metal),
            ..Default::default()
        };
        let value = receipt(
            "gpu",
            serde_json::json!({"backend":"metal","physical_gpu":true,"device_id":"protocol fixture only","kernel_dispatches":2,"kernel_output_used":true}),
            true,
        );
        let receipt_file = previous.join("invocation.json");
        fs::write(&receipt_file, serde_json::to_vec(&value).unwrap()).unwrap();
        let mut failed_probe = value.clone();
        failed_probe["status"] = "failed".into();
        failed_probe["forwarded_passthrough"] = true.into();
        failed_probe["units"] = serde_json::json!([]);
        failed_probe["gpu_executed"] = false.into();
        fs::write(
            previous.join("failed-probe.json"),
            serde_json::to_vec(&failed_probe).unwrap(),
        )
        .unwrap();
        let artifact_path = root.join("fixture-artifact");
        fs::write(&artifact_path, b"protocol fixture artifact").unwrap();
        let mut report = Report {
            schema: "gpu-cargo-report",
            version: 1,
            status: "ok",
            quality: Quality::Fast,
            requested_placement: Placement::Metal,
            object_backend: ObjectBackend::Gpu,
            backend_toolchain: Some(BackendToolchain {
                provenance_sha256: "fixture provenance".into(),
                wrapper: BackendTool {
                    path: root.join("wrapper"),
                    sha256: "fixture".into(),
                },
                controller: BackendTool {
                    path: root.join("controller"),
                    sha256: "fixture".into(),
                },
                bridge: None,
                llc: None,
                allow_fallback: false,
                gpu_emitter: None,
                gpu_library: None,
                gpu_shader: None,
                gpu_backend: Some(Placement::Metal),
                gpu_device: 0,
                rust_llvm_library: BackendTool {
                    path: root.join("fixture-LLVM"),
                    sha256: "protocol fixture".into(),
                },
                llc_version: None,
                fallback_library_selection_verified: true,
                fallback_library_scope: "protocol fixture only",
            }),
            backend_environment: BTreeMap::new(),
            object_backend_receipts: Some(aggregate_receipts(&previous, &options).unwrap()),
            planned_backend: "fixture",
            actual_backend: Some("fixture"),
            gpu_compilation_jobs: 1,
            gpu_executed: true,
            current_run_gpu_qualified: true,
            cache_only: false,
            cached_gpu_lineage: None,
            performance_speedup_demonstrated: false,
            placement_reason: "protocol fixture",
            toolchain: TOOLCHAIN,
            rustc_version_verbose: "fixture rustc".into(),
            rustc_path: root.join("rustc"),
            source: Source {
                manifest_path: root.join("Cargo.toml"),
                workspace_root: root.clone(),
                manifest_sha256: "fixture manifest".into(),
                lockfile_sha256: "fixture lock".into(),
                git_head: None,
                git_worktree_dirty: None,
            },
            cargo_program: "fixture",
            cargo_arguments: vec![],
            target_dir: root.clone(),
            invocation_directory: root.clone(),
            jobserver_inherited: false,
            rustflags_sha256: None,
            encoded_rustflags_sha256: None,
            semantic_policy: "fixture",
            policy_scope: "fixture",
            cargo_elapsed_ms: Some(1.0),
            total_elapsed_ms: 1.0,
            artifact: Some(Artifact {
                path: artifact_path.clone(),
                cargo_fresh: true,
                raw_bytes: 25,
                measured_bytes: 25,
                size_basis: SizeBasis::Unmodified,
                measurement_command: vec![],
                sha256: file_digest(&artifact_path).unwrap(),
                reference: None,
            }),
            error: None,
        };
        save_lineage(&report).unwrap();
        assert_eq!(
            report
                .object_backend_receipts
                .as_ref()
                .unwrap()
                .failed_passthrough_probes,
            1
        );
        assert_eq!(
            report
                .object_backend_receipts
                .as_ref()
                .unwrap()
                .failed_semantic_invocations,
            0
        );
        report.gpu_compilation_jobs = 0;
        report.gpu_executed = false;
        report.current_run_gpu_qualified = false;
        report.cache_only = true;
        report.object_backend_receipts = Some(BackendEvidence::default());
        assert_eq!(
            cached_lineage(&report, &options)
                .unwrap()
                .physical_gpu_units,
            1
        );
        let mut failed_translation = failed_probe.clone();
        failed_translation["forwarded_passthrough"] = false.into();
        fs::write(
            previous.join("failed-translation.json"),
            serde_json::to_vec(&failed_translation).unwrap(),
        )
        .unwrap();
        assert_eq!(
            aggregate_receipts(&previous, &options)
                .unwrap()
                .failed_semantic_invocations,
            1
        );
        // Retain an integrity-matching ledger to prove semantic failure alone
        // rejects cached qualification, rather than only a changed file set.
        let mut lineage: CachedGpuLineage =
            serde_json::from_slice(&fs::read(lineage_path(&root)).unwrap()).unwrap();
        lineage.qualified_receipt_hashes = receipt_hashes(&previous).unwrap();
        fs::write(lineage_path(&root), serde_json::to_vec(&lineage).unwrap()).unwrap();
        assert!(cached_lineage(&report, &options).is_err());
        fs::remove_file(previous.join("failed-translation.json")).unwrap();
        lineage.qualified_receipt_hashes = receipt_hashes(&previous).unwrap();
        fs::write(lineage_path(&root), serde_json::to_vec(&lineage).unwrap()).unwrap();
        assert_eq!(report.gpu_compilation_jobs, 0);
        assert!(!report.gpu_executed && !report.current_run_gpu_qualified);
        assert!(report.cache_only);
        fs::write(&receipt_file, b"changed receipt").unwrap();
        assert!(cached_lineage(&report, &options).is_err());
        fs::write(&receipt_file, serde_json::to_vec(&value).unwrap()).unwrap();
        report.artifact.as_mut().unwrap().sha256 = "changed artifact".into();
        assert!(cached_lineage(&report, &options).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
