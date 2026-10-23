// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Compare independent package observations with verified, saved release inventories.
use crate::release_assessment::{input, release};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs, io::Read, path::Path};

#[derive(Debug, Serialize, thiserror::Error)]
#[serde(tag = "category", rename_all = "snake_case")]
pub enum QualificationError {
    #[error("qualification input: {reason}")]
    Input { reason: String },
    #[error("representative package coverage: {reason}")]
    Coverage { reason: String },
    #[error("qualification output: {reason}")]
    Output { reason: String },
}

impl From<String> for QualificationError {
    fn from(reason: String) -> Self {
        Self::Input { reason }
    }
}

impl From<&str> for QualificationError {
    fn from(reason: &str) -> Self {
        Self::Input {
            reason: reason.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Family {
    Os,
    FabricPython,
    Node,
    SupervisorRust,
    ProxyRust,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Package {
    pub family: Family,
    pub name: String,
    pub version: String,
    pub purl: String,
    pub source_path: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SubjectExpectation {
    pub image: String,
    pub platform: String,
    pub packages: Vec<Package>,
}

#[derive(Serialize)]
pub struct CoverageReceipt {
    pub schema_version: u8,
    pub representative_coverage_verified: bool,
    pub package_completeness_verified: bool,
    pub image_source_authenticated: bool,
    pub publication_authorized: bool,
    pub inventory_sha256: String,
    pub sboms_sha256: String,
    pub expectations_sha256: String,
    pub subjects: Vec<CheckedSubject>,
}

#[derive(Serialize)]
pub struct CheckedSubject {
    pub image: String,
    pub reference: String,
    pub platform: String,
    pub sbom_asset: String,
    pub sbom_sha256: String,
    pub checked_packages: Vec<Package>,
}

fn hash(bytes: &[u8]) -> String {
    crate::hex(&Sha256::digest(bytes))
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|_| "qualification input is unavailable")?;
    if !file
        .metadata()
        .map_err(|_| "cannot inspect qualification input")?
        .is_file()
    {
        return Err("qualification input must be a regular file".into());
    }
    let mut bytes = Vec::new();
    file.take(16_000_001)
        .read_to_end(&mut bytes)
        .map_err(|_| "cannot read qualification input")?;
    if bytes.is_empty() || bytes.len() > 16_000_000 {
        return Err("qualification input is empty or oversized".into());
    }
    Ok(bytes)
}

/// Expectations are caller-supplied observations; a match does not authenticate
/// that observation or establish that the scanner discovered every component.
pub fn package_matches(package: &Value, expected: &Package) -> bool {
    let family = match expected.family {
        Family::Os => ["pkg:deb/", "pkg:apk/", "pkg:rpm/"]
            .iter()
            .any(|p| expected.purl.starts_with(p)),
        Family::FabricPython => {
            expected.purl.starts_with("pkg:pypi/")
                && expected.source_path.starts_with("/opt/fabric/")
        }
        Family::Node => {
            expected.purl.starts_with("pkg:npm/") && expected.source_path.contains("/node_modules/")
        }
        Family::SupervisorRust => {
            expected.purl.starts_with("pkg:cargo/")
                && expected.source_path == "/opt/nemoclaw/source/supervisor/Cargo.lock"
        }
        Family::ProxyRust => {
            expected.purl.starts_with("pkg:cargo/")
                && expected.source_path == "/usr/share/doc/nemoclaw-ollama-proxy/Cargo.lock"
        }
    };
    family
        && !expected.name.is_empty()
        && !expected.version.is_empty()
        && expected.source_path.starts_with('/')
        && !expected.source_path.chars().any(char::is_control)
        && !expected
            .source_path
            .split('/')
            .skip(1)
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
        && package["name"] == expected.name
        && package["versionInfo"] == expected.version
        && package["externalRefs"]
            .as_array()
            .is_some_and(|references| {
                references
                    .iter()
                    .any(|r| r["referenceType"] == "purl" && r["referenceLocator"] == expected.purl)
            })
        && package["sourceInfo"]
            .as_str()
            .and_then(|source| source.split_once(": "))
            .is_some_and(|(_, paths)| paths.split(", ").any(|path| path == expected.source_path))
}

/// Reuse the assessor's immutable SBOM snapshots and input checks. No scanner,
/// registry operation, saved passing assessment, or publication authority is used.
pub fn verify(
    inventory_path: &Path,
    mapping_path: &Path,
    sbom_directory: &Path,
    expectations_path: &Path,
    output: &Path,
) -> Result<CoverageReceipt, QualificationError> {
    if [
        inventory_path,
        mapping_path,
        sbom_directory,
        expectations_path,
        output,
    ]
    .iter()
    .any(|path| !path.is_absolute())
    {
        return Err("qualification paths must be absolute".into());
    }
    if output.try_exists().unwrap_or(true) {
        return Err(QualificationError::Output {
            reason: "coverage receipt output must be fresh".into(),
        });
    }
    let inventory = read(inventory_path)?;
    let mapping = read(mapping_path)?;
    let observations = read(expectations_path)?;
    // Validate index and executable-platform descriptors with the release gate's
    // existing contract, without claiming that these are registry observations.
    release::verify_promoted(&inventory, &inventory).map_err(|error| error.to_string())?;
    let images: Value = serde_json::from_slice(&inventory).map_err(|_| "invalid inventory JSON")?;
    for image in images.as_array().ok_or("inventory must list images")? {
        let name = image["name"].as_str().ok_or("image name is missing")?;
        if image["repository"] != format!("ghcr.io/nvidia/nemoclaw/v1/{name}") {
            return Err("qualification requires the intended v1 release repository".into());
        }
    }
    // Load the same inventory/mapping bytes whose checksums the receipt records.
    // The established loader snapshots each verified SPDX asset itself.
    let snapshot = tempfile::tempdir().map_err(|_| "cannot snapshot qualification inputs")?;
    let saved_inventory = snapshot.path().join("inventory.json");
    let saved_mapping = snapshot.path().join("sboms.json");
    fs::write(&saved_inventory, &inventory).map_err(|_| "cannot save qualification inventory")?;
    fs::write(&saved_mapping, &mapping).map_err(|_| "cannot save qualification mapping")?;
    let subjects = input::load(&saved_inventory, &saved_mapping, sbom_directory)
        .map_err(|error| error.to_string())?;
    let expectations: Vec<SubjectExpectation> =
        serde_json::from_slice(&observations).map_err(|_| "invalid package expectations JSON")?;
    let expected_subjects: BTreeSet<_> = subjects
        .iter()
        .map(|subject| (subject.name(), subject.platform()))
        .collect();
    let mut seen = BTreeSet::new();
    let mut families = BTreeSet::new();
    for expected in &expectations {
        if !seen.insert((expected.image.as_str(), expected.platform.as_str()))
            || expected.packages.is_empty()
        {
            return Err(QualificationError::Coverage {
                reason: "each selected subject needs unique nonempty package expectations".into(),
            });
        }
        let mut packages = BTreeSet::new();
        for package in &expected.packages {
            if !packages.insert((&package.purl, &package.source_path)) {
                return Err(QualificationError::Coverage {
                    reason: "package expectations duplicate an identity and source".into(),
                });
            }
            families.insert((expected.platform.as_str(), package.family));
        }
        if expected.image == "ollama-proxy"
            && !expected
                .packages
                .iter()
                .any(|package| package.family == Family::ProxyRust)
        {
            return Err(QualificationError::Coverage {
                reason: "the proxy subject requires its retained Rust inventory".into(),
            });
        }
        if matches!(expected.image.as_str(), "vllm" | "ollama")
            && !expected
                .packages
                .iter()
                .any(|package| package.family == Family::SupervisorRust)
        {
            return Err(QualificationError::Coverage {
                reason: "each runtime subject requires its retained supervisor Rust inventory"
                    .into(),
            });
        }
    }
    if seen != expected_subjects {
        return Err(QualificationError::Coverage {
            reason: "package expectations must describe every selected image/platform exactly"
                .into(),
        });
    }
    for platform in ["linux/amd64", "linux/arm64"] {
        if ![
            Family::Os,
            Family::FabricPython,
            Family::Node,
            Family::SupervisorRust,
        ]
        .into_iter()
        .all(|family| families.contains(&(platform, family)))
        {
            return Err(QualificationError::Coverage { reason: "qualification requires OS, Fabric Python, Node and supervisor Rust observations on both platforms".into() });
        }
    }
    let mut checked = Vec::new();
    for expected in expectations {
        let subject = subjects
            .iter()
            .find(|subject| {
                subject.name() == expected.image && subject.platform() == expected.platform
            })
            .ok_or("expected subject is absent")?;
        let document: Value = serde_json::from_slice(subject.sbom())
            .map_err(|_| "verified SPDX cannot be decoded")?;
        let packages = document["packages"]
            .as_array()
            .ok_or("verified SPDX has no packages")?;
        for expected_package in &expected.packages {
            if !packages
                .iter()
                .any(|package| package_matches(package, expected_package))
            {
                return Err(QualificationError::Coverage {
                    reason: format!(
                        "independent package observation is missing for {} {}",
                        expected.image, expected.platform
                    ),
                });
            }
        }
        checked.push(CheckedSubject {
            image: subject.name().into(),
            reference: subject.reference().into(),
            platform: subject.platform().into(),
            sbom_asset: subject.asset().into(),
            sbom_sha256: subject.sha256().into(),
            checked_packages: expected.packages,
        });
    }
    checked
        .sort_by(|left, right| (&left.image, &left.platform).cmp(&(&right.image, &right.platform)));
    let receipt = CoverageReceipt {
        schema_version: 1,
        representative_coverage_verified: true,
        package_completeness_verified: false,
        image_source_authenticated: false,
        publication_authorized: false,
        inventory_sha256: hash(&inventory),
        sboms_sha256: hash(&mapping),
        expectations_sha256: hash(&observations),
        subjects: checked,
    };
    let parent = output
        .parent()
        .ok_or("qualification output needs a parent directory")?;
    let temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| QualificationError::Output {
            reason: "cannot create private coverage receipt".into(),
        })?;
    serde_json::to_writer(temporary.as_file(), &receipt).map_err(|_| {
        QualificationError::Output {
            reason: "cannot write coverage receipt".into(),
        }
    })?;
    temporary
        .persist_noclobber(output)
        .map_err(|_| QualificationError::Output {
            reason: "cannot expose fresh coverage receipt".into(),
        })?;
    Ok(receipt)
}
