// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Data-only recipe contract. Executables run only in the managed runtime.
pub(crate) mod limits;
use crate::{
    config::{ConfigError, Service},
    snapshot::Manifest,
};
use limits as l;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::LazyLock};
static TOKEN: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(l::TOKEN).unwrap());
static SHA256: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(l::SHA256).unwrap());

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Data-only contract for executables and capabilities packaged in a pinned runtime image.
pub struct InlineRecipe {
    /// Inline recipe protocol version.
    pub api_version: String,
    /// Required execution host and image capabilities; declaring them does not establish live qualification.
    pub compatibility: Compatibility,
    /// Executable that prepares candidate model data.
    pub preparation: Tool,
    /// Executable that independently verifies prepared data before publication.
    pub verification: Tool,
    /// Preparation capacity, GPU budget, and startup headroom.
    pub resources: Resources,
    /// Recipe-specific vLLM settings.
    pub serving: Settings,
    /// Nonempty list of absolute paths to retained license files inside the image.
    pub licenses: Vec<String>,
    /// Nonempty list of absolute paths to retained source notices inside the image.
    pub source_notices: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Manifest")]
    /// Optional pinned file manifest. When omitted, the SDK resolves the model inventory.
    /// When present, its repository and revision must match service.model.
    pub snapshot: Option<Manifest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Reuse")]
    /// Optional cache import. The new recipe must verify the imported data before accepting it.
    pub reuse: Option<Reuse>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Execution host requirements and labels that must be present on the pinned image.
pub struct Compatibility {
    /// Execution host CPU architecture.
    pub architecture: String,
    /// GPU name that must equal the observed device name.
    pub gpu: String,
    /// Minimum NVIDIA driver major version.
    pub min_driver_major: u64,
    /// Minimum total host memory in GiB.
    pub min_host_memory_gi_b: u64,
    /// Required org.nemoclaw.* labels. org.nemoclaw.recipe.protocol must equal v1.
    pub image_labels: BTreeMap<String, String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// Executable identity inside the runtime image; this is not a shell command.
pub struct Tool {
    /// Absolute path to the executable inside the image. Traversal and empty path components are rejected.
    pub executable: String,
    /// Lowercase SHA-256 of the executable file.
    pub sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Resource declarations checked against host observations and produced data.
pub struct Resources {
    /// Maximum total prepared-data bytes.
    pub prepared_bytes: u64,
    /// Preparation memory requirement in GiB, in addition to the service host reserve.
    pub preparation_memory_gi_b: u64,
    /// Total serving GPU budget in bytes, including model, caches, and other allocations.
    pub gpu_memory_bytes: u64,
    /// Additional available-memory headroom in GiB required at startup.
    pub startup_headroom_gi_b: u64,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
/// Recipe settings select serving behavior without shell hooks or arbitrary argument lists.
pub struct Settings {
    /// Model identifier advertised by vLLM. The primary route model must match it.
    pub model_name: String,
    #[schemars(default)]
    /// Native vLLM tool parser supplied by the runtime image. Empty omits the flag.
    pub tool_parser: String,
    #[schemars(default)]
    /// Native vLLM reasoning parser supplied by the runtime image. Empty omits the flag.
    pub reasoning_parser: String,
    #[schemars(default)]
    /// KV cache dtype understood by the pinned vLLM image. Empty omits the flag.
    pub kv_cache_dtype: String,
    #[schemars(default)]
    /// Mamba SSM cache dtype understood by the pinned vLLM image. Empty omits the flag.
    pub mamba_cache_dtype: String,
    #[schemars(default)]
    /// Enable the lazy safetensors loading strategy.
    pub lazy_loading: bool,
    #[schemars(default)]
    /// Enable chunked prefill.
    pub chunked_prefill: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Compilation")]
    /// Optional typed compilation settings. Omission selects compilation mode 0 for recipe serving.
    pub compilation: Option<Compilation>,
    #[schemars(default)]
    /// Literal VLLM_* environment values for serving. Do not place credentials here.
    pub environment: BTreeMap<String, String>,
    #[schemars(default)]
    /// VLLM_* variables mapped to paths beneath verified prepared data; . selects its root. Names must not also appear in environment.
    pub prepared_environment: BTreeMap<String, String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Typed vLLM compilation settings.
pub struct Compilation {
    /// Compilation mode understood by the pinned vLLM image.
    pub mode: u8,
    /// CUDA graph execution mode.
    pub cudagraph_mode: String,
    /// Nonempty list of CUDA graph capture sizes.
    pub capture_sizes: Vec<u32>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Explicit cache import, verified by the new recipe before acceptance.
pub struct Reuse {
    /// Existing snapshot directory relative to /data. Traversal, backslashes, and empty path components are rejected.
    pub snapshot_directory: String,
    /// SHA-256 preparation key identifying previously prepared data.
    pub preparation_key: String,
}
pub fn relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', '\0'])
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}
fn absolute(path: &str) -> bool {
    path.strip_prefix('/').is_some_and(relative)
}
fn digest(value: &str) -> bool {
    SHA256.is_match(value)
}
impl InlineRecipe {
    pub fn key(&self, service: &Service) -> String {
        let bytes =
            serde_json::to_vec(&(service.model.clone(), self)).expect("recipe serialization");
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
    pub fn validate(&self, service: &Service) -> Result<(), ConfigError> {
        let bad = || ConfigError("invalid inline recipe contract or incompatible service");
        if self.api_version != l::API_VERSION
            || service.backend != crate::config::constraints::BACKEND
            || !l::ARCHITECTURES.contains(&self.compatibility.architecture.as_str())
            || self.compatibility.gpu.is_empty()
            || !(1..=l::DRIVER_MAX).contains(&self.compatibility.min_driver_major)
            || !(1..=l::MEMORY_MAX).contains(&self.compatibility.min_host_memory_gi_b)
            || self
                .compatibility
                .image_labels
                .get(l::PROTOCOL_LABEL)
                .map(String::as_str)
                != Some("v1")
            || self.compatibility.image_labels.iter().any(|(k, v)| {
                !k.starts_with("org.nemoclaw.") || v.is_empty() || v.len() > l::TOKEN_MAX
            })
            || self.resources.prepared_bytes == 0
            || self.resources.prepared_bytes > l::PREPARED_MAX
            || self.resources.preparation_memory_gi_b == 0
            || self.resources.preparation_memory_gi_b > l::MEMORY_MAX
            || self.resources.startup_headroom_gi_b > l::MEMORY_MAX
            || self.resources.gpu_memory_bytes < l::GPU_MIN
            || self.resources.gpu_memory_bytes > l::GPU_MAX
            || service.memory.gpu_memory_gib != 0
        {
            return Err(bad());
        }
        for tool in [&self.preparation, &self.verification] {
            if !absolute(&tool.executable)
                || tool.executable.len() > l::PATH_MAX
                || !digest(&tool.sha256)
            {
                return Err(bad());
            }
        }
        if self.licenses.is_empty()
            || self.source_notices.is_empty()
            || self
                .licenses
                .iter()
                .chain(&self.source_notices)
                .any(|p| !absolute(p))
        {
            return Err(bad());
        }
        if let Some(manifest) = &self.snapshot {
            manifest.validate().map_err(|_| bad())?;
            if manifest.repository != service.model.repository
                || manifest.revision != service.model.revision
            {
                return Err(bad());
            }
        }
        if let Some(reuse) = &self.reuse
            && (!relative(&reuse.snapshot_directory) || !digest(&reuse.preparation_key))
        {
            return Err(bad());
        }
        let settings = &self.serving;
        let token = |s: &str| s.len() <= l::TOKEN_MAX && TOKEN.is_match(s);
        if !token(&settings.model_name)
            || [
                &settings.tool_parser,
                &settings.reasoning_parser,
                &settings.kv_cache_dtype,
                &settings.mamba_cache_dtype,
            ]
            .iter()
            .any(|v| !v.is_empty() && !token(v))
        {
            return Err(bad());
        }
        for (key, value) in &settings.environment {
            if !key.starts_with("VLLM_")
                || !key
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
                || value.len() > l::PATH_MAX
                || value.contains('\0')
            {
                return Err(bad());
            }
        }
        for (key, value) in &settings.prepared_environment {
            if !key.starts_with("VLLM_")
                || !key
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
                || settings.environment.contains_key(key)
                || (value != "." && !relative(value))
            {
                return Err(bad());
            }
        }
        if let Some(c) = &settings.compilation
            && (c.mode > l::COMPILATION_MODE_MAX
                || !l::CUDAGRAPH_MODES.contains(&c.cudagraph_mode.as_str())
                || c.capture_sizes.is_empty()
                || c.capture_sizes.len() > l::CAPTURE_COUNT_MAX
                || c.capture_sizes
                    .iter()
                    .any(|n| *n == 0 || *n > l::CAPTURE_SIZE_MAX))
        {
            return Err(bad());
        }
        Ok(())
    }
}
