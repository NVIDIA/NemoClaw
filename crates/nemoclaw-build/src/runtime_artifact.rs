// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use serde::Deserialize;
use std::collections::BTreeMap;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeArtifact {
    pub platform: String,
    pub name: String,
    pub image: String,
    pub source_date_epoch: u64,
    pub files: Vec<String>,
    pub downloads: BTreeMap<String, Download>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Download {
    pub url: String,
    pub sha256: String,
}
/// Failures while decoding or validating a runtime artifact manifest.
#[derive(Debug, thiserror::Error)]
pub enum RuntimeArtifactError {
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid runtime artifact manifest")]
    InvalidManifest,
    #[error("invalid or duplicate artifact input path")]
    InvalidInputPath,
    #[error("artifact source requires HTTPS and SHA-256")]
    InvalidDownload,
    #[error("runtime images require a native Linux build host matching the artifact platform")]
    IncompatibleHost,
}
impl RuntimeArtifact {
    /// Require a native build so the retained supervisor matches the image architecture.
    pub fn require_native_host(&self, platform: &str) -> Result<(), RuntimeArtifactError> {
        if platform != self.platform {
            return Err(RuntimeArtifactError::IncompatibleHost);
        }
        Ok(())
    }

    /// Decode and validate the build inputs declared by a runtime manifest.
    ///
    /// # Errors
    /// Returns a JSON error for malformed or incompatible input, or a validation
    /// error for invalid identity, image, input paths, or download integrity data.
    pub fn parse(bytes: &[u8]) -> Result<Self, RuntimeArtifactError> {
        let value: Self = serde_json::from_slice(bytes)?;
        let filename = |s: &str| {
            !s.is_empty()
                && s != "."
                && s != ".."
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        };
        let reserved = [
            "nemoclaw-runtime",
            "supervisor-source.tar.gz",
            "supervisor.json",
            "LICENSE",
            "build.json",
        ];
        let mut names = std::collections::BTreeSet::new();
        if !["linux_arm64", "linux_amd64"].contains(&value.platform.as_str())
            || !filename(&value.name)
            || value.source_date_epoch == 0
            || value.image.is_empty()
            || value.image.starts_with('-')
            || !value
                .image
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-/:@".contains(&b))
            || !value.files.iter().any(|f| f == "Dockerfile")
        {
            return Err(RuntimeArtifactError::InvalidManifest);
        }
        for name in value.files.iter().chain(value.downloads.keys()) {
            if !filename(name) || reserved.contains(&name.as_str()) || !names.insert(name) {
                return Err(RuntimeArtifactError::InvalidInputPath);
            }
        }
        for source in value.downloads.values() {
            if !source.url.starts_with("https://")
                || source.sha256.len() != 64
                || !source
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(RuntimeArtifactError::InvalidDownload);
            }
        }
        Ok(value)
    }
}
