// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Data-only recipe contract. Executables run only in the managed runtime.
use crate::{
    config::{ConfigError, Service},
    snapshot::Manifest,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InlineRecipe {
    pub api_version: String,
    pub compatibility: Compatibility,
    pub preparation: Tool,
    pub verification: Tool,
    pub resources: Resources,
    pub serving: Settings,
    pub licenses: Vec<String>,
    pub source_notices: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, required)]
    pub snapshot: Option<Manifest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, required)]
    pub reuse: Option<Reuse>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Compatibility {
    pub architecture: String,
    pub gpu: String,
    pub min_driver_major: u64,
    pub min_host_memory_gi_b: u64,
    pub image_labels: BTreeMap<String, String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Tool {
    pub executable: String,
    pub sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resources {
    pub prepared_bytes: u64,
    pub preparation_memory_gi_b: u64,
    pub gpu_memory_bytes: u64,
    pub startup_headroom_gi_b: u64,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub model_name: String,
    #[schemars(default)]
    pub tool_parser: String,
    #[schemars(default)]
    pub reasoning_parser: String,
    #[schemars(default)]
    pub kv_cache_dtype: String,
    #[schemars(default)]
    pub mamba_cache_dtype: String,
    #[schemars(default)]
    pub lazy_loading: bool,
    #[schemars(default)]
    pub chunked_prefill: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(default, required)]
    pub compilation: Option<Compilation>,
    #[schemars(default)]
    pub environment: BTreeMap<String, String>,
    #[schemars(default)]
    pub prepared_environment: BTreeMap<String, String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Compilation {
    pub mode: u8,
    pub cudagraph_mode: String,
    pub capture_sizes: Vec<u32>,
}
/// Explicit cache import, verified by the new recipe before it is accepted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reuse {
    pub snapshot_directory: String,
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
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
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
        if self.api_version != "nemoclaw.nvidia.com/recipe/v1"
            || service.backend != "vllm"
            || !["arm64", "amd64"].contains(&self.compatibility.architecture.as_str())
            || self.compatibility.gpu.is_empty()
            || !(1..=10000).contains(&self.compatibility.min_driver_major)
            || !(1..=4096).contains(&self.compatibility.min_host_memory_gi_b)
            || self
                .compatibility
                .image_labels
                .get("org.nemoclaw.recipe.protocol")
                .map(String::as_str)
                != Some("v1")
            || self
                .compatibility
                .image_labels
                .iter()
                .any(|(k, v)| !k.starts_with("org.nemoclaw.") || v.is_empty() || v.len() > 256)
            || self.resources.prepared_bytes == 0
            || self.resources.prepared_bytes > 1 << 40
            || self.resources.preparation_memory_gi_b == 0
            || self.resources.preparation_memory_gi_b > 4096
            || self.resources.startup_headroom_gi_b > 4096
            || self.resources.gpu_memory_bytes < 4 * crate::hardware::GIB
            || self.resources.gpu_memory_bytes > 1 << 42
            || service.memory.gpu_memory_gib != 0
        {
            return Err(bad());
        }
        for tool in [&self.preparation, &self.verification] {
            if !absolute(&tool.executable) || tool.executable.len() > 4096 || !digest(&tool.sha256)
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
        let token = |s: &str| {
            s.len() <= 256
                && !s.is_empty()
                && !s.starts_with('-')
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-/".contains(&b))
        };
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
                || value.len() > 4096
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
            && (c.mode > 3
                || !["NONE", "FULL_DECODE_ONLY"].contains(&c.cudagraph_mode.as_str())
                || c.capture_sizes.is_empty()
                || c.capture_sizes.len() > 64
                || c.capture_sizes.iter().any(|n| *n == 0 || *n > 65536))
        {
            return Err(bad());
        }
        Ok(())
    }
}
