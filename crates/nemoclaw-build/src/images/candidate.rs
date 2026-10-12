// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Bind the Brev image transfer to its source revision, archive, and OCI digest.
//!
//! Migrated from tools/ci/brev_image.py in NVIDIA/NemoClaw PR #12537,
//! revision 32fd51818415dd10722b0653fa815e3474f0d72c, with validation in Rust.

use super::{Result, docker, output, status};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};

#[derive(Deserialize, Serialize)]
struct Candidate {
    revision: String,
    sha256: String,
    image: String,
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let bytes = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("{}: {error}", path.display()))
}

fn archive_hash(root: &Path) -> Result<String> {
    let mut archive = fs::File::open(root.join("image.tar"))
        .map_err(|error| format!("cannot open candidate archive: {error}"))?;
    let mut digest = Sha256::new();
    let mut chunk = [0; 64 * 1024];
    loop {
        let count = archive
            .read(&mut chunk)
            .map_err(|error| format!("cannot read candidate archive: {error}"))?;
        if count == 0 {
            return Ok(crate::hex(&digest.finalize()));
        }
        digest.update(&chunk[..count]);
    }
}

fn is_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// Record the source revision, archive checksum and final Buildx image digest.
pub fn record(root: &Path, revision: &str) -> Result<()> {
    let metadata: Value = read_json(&root.join("metadata.json"))?;
    let digest = metadata["openclaw"]["containerimage.digest"]
        .as_str()
        .filter(|digest| is_digest(digest))
        .ok_or("build did not produce an immutable image digest")?;
    let manifest = Candidate {
        revision: revision.into(),
        sha256: archive_hash(root)?,
        image: format!("nc-fabric@{digest}"),
    };
    let json = serde_json::to_string(&manifest).map_err(|error| error.to_string())?;
    fs::write(root.join("candidate.json"), format!("{json}\n"))
        .map_err(|error| format!("cannot write candidate record: {error}"))
}

/// Write image-ref only after the loaded candidate passes identity and runtime checks.
pub fn load(root: &Path, revision: &str) -> Result<String> {
    let manifest: Candidate = read_json(&root.join("candidate.json"))?;
    if manifest.revision != revision {
        return Err("candidate source revision mismatch".into());
    }
    if manifest.sha256 != archive_hash(root)? {
        return Err("candidate archive checksum mismatch".into());
    }
    if !manifest
        .image
        .strip_prefix("nc-fabric@")
        .is_some_and(is_digest)
    {
        return Err("candidate image digest is invalid".into());
    }
    status(
        docker()
            .args(["image", "load", "-i"])
            .arg(root.join("image.tar")),
        "load the candidate image",
    )?;
    let inspected = output(
        docker().args(["image", "inspect", "nc-fabric:openclaw"]),
        "inspect the candidate image",
    )?;
    let inspected: Value =
        serde_json::from_slice(&inspected).map_err(|_| "unreadable candidate image inspection")?;
    let image = &inspected[0];
    if image["Os"] != "linux" || image["Architecture"] != "amd64" {
        return Err("candidate image must target linux/amd64".into());
    }
    if !image["RepoDigests"].as_array().is_some_and(|digests| {
        digests
            .iter()
            .any(|digest| digest.as_str() == Some(&manifest.image))
    }) {
        return Err("loaded candidate does not retain the build's repository digest".into());
    }
    let label = image["Config"]["Labels"][super::CATALOG_LABEL]
        .as_str()
        .ok_or("candidate image lacks installed Fabric metadata")?;
    let catalog: Value = serde_json::from_str(label)
        .map_err(|_| "candidate image lacks installed Fabric metadata")?;
    let runtime = &catalog["runtime"];
    for value in [
        &runtime["command"],
        &runtime["binaries"]["nvidia.fabric.openclaw"],
    ] {
        if !value.as_array().is_some_and(|items| {
            !items.is_empty()
                && items
                    .iter()
                    .all(|item| item.as_str().is_some_and(|s| !s.is_empty()))
        }) {
            return Err("candidate image lacks OpenClaw runtime metadata".into());
        }
    }
    fs::write(root.join("image-ref"), format!("{}\n", manifest.image))
        .map_err(|error| format!("cannot write candidate image-ref: {error}"))?;
    Ok(manifest.image)
}
