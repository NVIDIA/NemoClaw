// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use serde::Deserialize;
use std::collections::BTreeMap;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeArtifact {
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
impl RuntimeArtifact {
    pub fn parse(bytes: &[u8]) -> Result<Self, Box<dyn std::error::Error>> {
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
        if !filename(&value.name)
            || value.source_date_epoch == 0
            || value.image.is_empty()
            || value.image.starts_with('-')
            || !value
                .image
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-/:@".contains(&b))
            || !value.files.iter().any(|f| f == "Dockerfile")
        {
            return Err("invalid runtime artifact manifest".into());
        }
        for name in value.files.iter().chain(value.downloads.keys()) {
            if !filename(name) || reserved.contains(&name.as_str()) || !names.insert(name) {
                return Err("invalid or duplicate artifact input path".into());
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
                return Err("artifact source requires HTTPS and SHA-256".into());
            }
        }
        Ok(value)
    }
}
