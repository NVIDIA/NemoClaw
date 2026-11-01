// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Verify saved release subjects and snapshot their SBOM bytes before scanning.
use super::{AssessmentError, Subject};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::Path,
};

// Each vLLM platform's SPDX document is about 65 MB.
const FILE_LIMIT: u64 = 256 << 20;
const TOTAL_SBOM_LIMIT: usize = 1 << 30;

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    value[name]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("missing or empty {name}"))
}

fn hex_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn image_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(hex_hash)
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "assessment input is unavailable")?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > FILE_LIMIT {
        return Err(
            "assessment input must be a nonempty regular file within the size limit".into(),
        );
    }
    let file = fs::File::open(path).map_err(|_| "assessment input could not be opened")?;
    let opened = file
        .metadata()
        .map_err(|_| "assessment input could not be inspected")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.dev() != opened.dev() || metadata.ino() != opened.ino() {
            return Err("assessment input changed while opening it".into());
        }
    }
    if !opened.is_file()
        || fs::symlink_metadata(path)
            .map_err(|_| "assessment input disappeared")?
            .file_type()
            .is_symlink()
    {
        return Err("assessment input changed or is a symlink".into());
    }
    let mut bytes = Vec::new();
    file.take(FILE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "assessment input could not be read")?;
    if bytes.is_empty() || bytes.len() as u64 > FILE_LIMIT {
        return Err("assessment input is empty or exceeds its size limit".into());
    }
    Ok(bytes)
}

fn json(path: &Path) -> Result<Value, String> {
    serde_json::from_slice(&read(path)?).map_err(|_| "assessment input is not valid JSON".into())
}

fn asset_name(value: &str) -> bool {
    value != "."
        && value != ".."
        && value.ends_with(".spdx.json")
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

fn meaningful(value: &str) -> bool {
    !value.trim().is_empty()
        && !matches!(value, "NOASSERTION" | "NONE" | "*" | "-")
        && !value.chars().any(char::is_control)
}

fn decode_component(value: &str) -> Option<String> {
    let mut bytes = value.bytes();
    let mut decoded = Vec::new();
    while let Some(byte) = bytes.next() {
        decoded.push(if byte == b'%' {
            let high = char::from(bytes.next()?).to_digit(16)?;
            let low = char::from(bytes.next()?).to_digit(16)?;
            u8::try_from(high * 16 + low).ok()?
        } else {
            byte
        });
    }
    String::from_utf8(decoded).ok()
}

fn package_url(locator: &str, version: &str) -> bool {
    let Some((kind, path)) = locator.strip_prefix("pkg:").and_then(|v| v.split_once('/')) else {
        return false;
    };
    let Some((name, encoded_version)) = path
        .split(['?', '#'])
        .next()
        .and_then(|v| v.rsplit_once('@'))
    else {
        return false;
    };
    !kind.is_empty()
        && kind.bytes().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'+' | b'-')
        })
        && name
            .split('/')
            .all(|v| decode_component(v).is_some_and(|v| meaningful(&v) && v != "." && v != ".."))
        && decode_component(encoded_version).is_some_and(|v| v == version)
}

fn cpe(locator: &str, version: &str) -> bool {
    let components: Vec<_> = locator.split(':').collect();
    let offset = if locator.starts_with("cpe:2.3:") && components.len() == 13 {
        2
    } else if locator.starts_with("cpe:/") && components.len() >= 5 {
        1
    } else {
        return false;
    };
    let part = components[offset].trim_start_matches('/');
    matches!(part, "a" | "o" | "h")
        && meaningful(components[offset + 1])
        && meaningful(components[offset + 2])
        && components[offset + 3].replace('\\', "") == version
}

/// Returns how many packages lack a versioned PURL or CPE. Syft records some,
/// such as npm subpath exports and unversioned binaries, in every release;
/// Grype can't match them, so the report counts them instead of failing.
fn validate_spdx(bytes: &[u8]) -> Result<usize, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "SBOM is not valid JSON")?;
    if value["spdxVersion"] != "SPDX-2.3"
        || value["SPDXID"] != "SPDXRef-DOCUMENT"
        || value["dataLicense"] != "CC0-1.0"
        || field(&value, "documentNamespace").is_err()
        || value["creationInfo"].as_object().is_none()
        || value["packages"]
            .as_array()
            .is_none_or(|p| p.is_empty() || p.iter().any(|v| field(v, "name").is_err()))
    {
        return Err("SBOM is not a populated SPDX 2.3 document".into());
    }
    let creation = &value["creationInfo"];
    if creation["creators"]
        .as_array()
        .is_none_or(|v| v.is_empty() || v.iter().any(|v| v.as_str().is_none_or(|v| !meaningful(v))))
        || time::OffsetDateTime::parse(
            field(creation, "created")?,
            &time::format_description::well_known::Rfc3339,
        )
        .is_err()
    {
        return Err("SBOM requires creators and a valid creation timestamp".into());
    }
    let described: BTreeSet<_> = value["relationships"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| {
            v["relationshipType"] == "DESCRIBES" && v["spdxElementId"] == "SPDXRef-DOCUMENT"
        })
        .filter_map(|v| v["relatedSpdxElement"].as_str())
        .collect();
    let mut ids = BTreeSet::new();
    let mut libraries = 0;
    let mut unidentified = 0;
    for package in value["packages"]
        .as_array()
        .ok_or("missing SBOM packages")?
    {
        let id = field(package, "SPDXID")?;
        if !id.strip_prefix("SPDXRef-").is_some_and(|v| {
            !v.is_empty()
                && v.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-'))
        }) || !ids.insert(id)
            || !meaningful(field(package, "name")?)
        {
            return Err("SBOM package identities are invalid or duplicated".into());
        }
        // Syft includes the source directory/image as a structural package.
        // It is not evidence of an inventoried software component.
        if package["primaryPackagePurpose"] == "FILE" && described.contains(id) {
            continue;
        }
        let version = package["versionInfo"].as_str().filter(|v| meaningful(v));
        let references = package["externalRefs"].as_array();
        let has_identity = version
            .zip(references)
            .is_some_and(|(version, references)| {
                references.iter().any(|reference| {
                    let Some(locator) = reference["referenceLocator"].as_str() else {
                        return false;
                    };
                    match reference["referenceType"].as_str() {
                        Some("purl") => package_url(locator, version),
                        Some("cpe23Type" | "cpe22Type") => cpe(locator, version),
                        _ => false,
                    }
                })
            });
        let Some(references) = references.filter(|_| has_identity) else {
            unidentified += 1;
            continue;
        };
        if package["primaryPackagePurpose"] != "CONTAINER"
            && !references.iter().any(|v| {
                v["referenceType"] == "purl"
                    && v["referenceLocator"]
                        .as_str()
                        .is_some_and(|v| v.starts_with("pkg:oci/"))
            })
        {
            libraries += 1;
        }
    }
    if libraries == 0 {
        return Err("SBOM contains no identifiable software packages".into());
    }
    Ok(unidentified)
}

pub(super) struct Expected {
    name: String,
}

pub(crate) fn auxiliary_attestation(manifest: &Value) -> bool {
    manifest["annotations"]["vnd.docker.reference.type"] == "attestation-manifest"
        && manifest["platform"]["os"] == "unknown"
        && manifest["platform"]["architecture"] == "unknown"
}

pub(super) fn expected_subjects(
    inventory: &Value,
) -> Result<BTreeMap<(String, String), Expected>, String> {
    let images = inventory
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or("empty image inventory")?;
    let mut names = BTreeSet::new();
    let mut repositories = BTreeSet::new();
    let mut expected = BTreeMap::new();
    for image in images {
        let name = field(image, "name")?;
        let repository = field(image, "repository")?;
        if !name
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            || !names.insert(name)
            || !repositories.insert(repository)
            || repository.contains(['@', '?', '#'])
            || repository.contains("://")
            || repository.chars().any(char::is_whitespace)
            || repository
                .split('/')
                .any(|v| v.is_empty() || matches!(v, "." | ".."))
            || !repository.contains('/')
        {
            return Err("image inventory contains an invalid or duplicate image identity".into());
        }
        let manifests = image["manifests"]["manifests"]
            .as_array()
            .ok_or("missing image manifests")?;
        let mut platforms = BTreeSet::new();
        let mut digests = BTreeSet::new();
        for manifest in manifests {
            let digest = field(manifest, "digest")?;
            if !image_digest(digest) {
                return Err("invalid platform digest".into());
            }
            let platform = &manifest["platform"];
            let os = field(platform, "os")?;
            let arch = field(platform, "architecture")?;
            if auxiliary_attestation(manifest) {
                continue;
            }
            if os != "linux"
                || !matches!(arch, "amd64" | "arm64")
                || !platforms.insert(arch)
                || !digests.insert(digest)
                || manifest["annotations"]["vnd.docker.reference.type"] == "attestation-manifest"
                || manifest.get("mediaType").is_some_and(|v| {
                    !matches!(
                        v.as_str(),
                        Some(
                            "application/vnd.oci.image.manifest.v1+json"
                                | "application/vnd.docker.distribution.manifest.v2+json"
                        )
                    )
                })
            {
                return Err("unsupported, ambiguous or duplicate executable platform".into());
            }
            expected.insert(
                (format!("{repository}@{digest}"), format!("linux/{arch}")),
                Expected { name: name.into() },
            );
        }
        if platforms != BTreeSet::from(["amd64", "arm64"]) {
            return Err("image inventory requires linux/amd64 and linux/arm64".into());
        }
    }
    Ok(expected)
}

pub fn load(
    inventory: &Path,
    mapping: &Path,
    sbom_directory: &Path,
) -> Result<Vec<Subject>, AssessmentError> {
    load_checked(inventory, mapping, sbom_directory)
        .map_err(|reason| AssessmentError::Input { reason })
}

fn load_checked(
    inventory: &Path,
    mapping: &Path,
    sbom_directory: &Path,
) -> Result<Vec<Subject>, String> {
    let expected = expected_subjects(&json(inventory)?)?;
    let mapping = json(mapping)?;
    let entries = mapping
        .as_array()
        .filter(|v| v.len() == expected.len())
        .ok_or("SBOM coverage does not match the expected inventory")?;
    let mut seen = BTreeSet::new();
    let mut assets = BTreeSet::new();
    let mut total = 0usize;
    let mut subjects = Vec::new();
    for entry in entries {
        let reference = field(entry, "reference")?;
        let platform = field(entry, "platform")?;
        let key = (reference.to_owned(), platform.to_owned());
        let subject = expected
            .get(&key)
            .ok_or("SBOM names an unexpected subject")?;
        if !seen.insert(key) {
            return Err("SBOM mapping duplicates or substitutes an expected subject".into());
        }
        let asset = field(entry, "asset")?;
        let sha256 = field(entry, "sha256")?;
        if !asset_name(asset) || !assets.insert(asset) || !hex_hash(sha256) {
            return Err("invalid or duplicate SBOM asset or checksum".into());
        }
        let sbom = read(&sbom_directory.join(asset))?;
        total = total
            .checked_add(sbom.len())
            .ok_or("SBOM input exceeds its size limit")?;
        if total > TOTAL_SBOM_LIMIT {
            return Err("combined SBOM input exceeds its size limit".into());
        }
        if crate::hex(&Sha256::digest(&sbom)) != sha256 {
            return Err("SBOM checksum differs from its mapping".into());
        }
        let unidentified_packages = validate_spdx(&sbom)?;
        subjects.push(Subject {
            name: subject.name.clone(),
            reference: reference.into(),
            platform: platform.into(),
            sha256: sha256.into(),
            asset: asset.into(),
            sbom,
            unidentified_packages,
        });
    }
    Ok(subjects)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};
    use std::fs;

    fn fixture() -> (tempfile::TempDir, Value, Value) {
        let dir = tempfile::tempdir().unwrap();
        let sbom = serde_json::to_vec(&json!({
            "spdxVersion": "SPDX-2.3", "SPDXID": "SPDXRef-DOCUMENT",
            "dataLicense": "CC0-1.0", "documentNamespace": "https://example.test/sbom",
            "creationInfo": {"creators": ["Tool: syft"], "created": "2026-10-21T00:00:00Z"},
            "packages": [{"SPDXID": "SPDXRef-package", "name": "example", "versionInfo": "1",
                "externalRefs": [{"referenceCategory": "PACKAGE-MANAGER", "referenceType": "purl", "referenceLocator": "pkg:cargo/example@1"}]}]
        }))
        .unwrap();
        let hash = crate::hex(&Sha256::digest(&sbom));
        let repository = "ghcr.io/nvidia/nemoclaw/candidates/hermes";
        let mut manifests = Vec::new();
        let mut mapping = Vec::new();
        for (arch, byte) in [("amd64", 'a'), ("arm64", 'b')] {
            let digest = format!("sha256:{}", byte.to_string().repeat(64));
            let asset = format!("hermes-{arch}.spdx.json");
            fs::write(dir.path().join(&asset), &sbom).unwrap();
            manifests
                .push(json!({"digest": digest, "platform": {"os": "linux", "architecture": arch}}));
            mapping.push(json!({"reference": format!("{repository}@{digest}"),
                "platform": format!("linux/{arch}"), "asset": asset, "sha256": hash}));
        }
        let inventory = json!([{"name": "hermes", "repository": repository, "manifests": {"manifests": manifests}}]);
        (dir, inventory, json!(mapping))
    }

    fn run(
        dir: &Path,
        inventory: &Value,
        mapping: &Value,
    ) -> Result<Vec<Subject>, AssessmentError> {
        fs::write(
            dir.join("inventory.json"),
            serde_json::to_vec(inventory).unwrap(),
        )
        .unwrap();
        fs::write(dir.join("sboms.json"), serde_json::to_vec(mapping).unwrap()).unwrap();
        load(&dir.join("inventory.json"), &dir.join("sboms.json"), dir)
    }

    #[test]
    fn staged_mapping_binds_subjects_through_immutable_references() {
        let (dir, inventory, mapping) = fixture();
        let subjects = run(dir.path(), &inventory, &mapping).unwrap();
        assert_eq!(subjects.len(), 2);
        for subject in subjects {
            assert!(mapping.as_array().unwrap().iter().any(|entry| {
                entry["reference"] == subject.reference
                    && entry["platform"] == subject.platform
                    && entry["sha256"] == subject.sha256
            }));
        }
    }

    #[test]
    fn snapshots_every_expected_platform_without_pinning_the_storage_namespace() {
        let (dir, inventory, mapping) = fixture();
        let subjects = run(dir.path(), &inventory, &mapping).unwrap();
        assert_eq!(subjects.len(), 2);
        assert_eq!(subjects[0].name, "hermes");
        assert_eq!(subjects[0].platform, "linux/amd64");
        fs::write(
            dir.path().join("hermes-amd64.spdx.json"),
            b"replaced after validation",
        )
        .unwrap();
        assert!(serde_json::from_slice::<Value>(&subjects[0].sbom).is_ok());
    }

    #[test]
    fn packages_without_matching_identity_cannot_look_like_a_clean_inventory() {
        let mut accepted = Vec::new();
        for case in [
            "name_only",
            "version",
            "identity",
            "malformed_purl",
            "purl_version",
            "duplicate_id",
            "created",
            "creators",
            "container_only",
        ] {
            let (dir, inventory, mut mapping) = fixture();
            let path = dir.path().join("hermes-amd64.spdx.json");
            let mut sbom: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            match case {
                "name_only" => sbom["packages"] = json!([{"name": "example"}]),
                "version" => {
                    sbom["packages"][0]
                        .as_object_mut()
                        .unwrap()
                        .remove("versionInfo");
                }
                "identity" => {
                    sbom["packages"][0]
                        .as_object_mut()
                        .unwrap()
                        .remove("externalRefs");
                }
                "malformed_purl" => {
                    sbom["packages"][0]["externalRefs"][0]["referenceLocator"] = json!("pkg:cargo/")
                }
                "purl_version" => {
                    sbom["packages"][0]["externalRefs"][0]["referenceLocator"] =
                        json!("pkg:cargo/example@2")
                }
                "duplicate_id" => {
                    let package = sbom["packages"][0].clone();
                    sbom["packages"].as_array_mut().unwrap().push(package);
                }
                "created" => sbom["creationInfo"]["created"] = json!("yesterday"),
                "creators" => sbom["creationInfo"]["creators"] = json!([]),
                "container_only" => {
                    sbom["packages"][0]["primaryPackagePurpose"] = json!("CONTAINER");
                    sbom["packages"][0]["externalRefs"][0]["referenceLocator"] =
                        json!(format!("pkg:oci/image@sha256%3A{}", "a".repeat(64)));
                }
                _ => unreachable!(),
            }
            let bytes = serde_json::to_vec(&sbom).unwrap();
            fs::write(&path, &bytes).unwrap();
            mapping[0]["sha256"] = json!(crate::hex(&Sha256::digest(&bytes)));
            if run(dir.path(), &inventory, &mapping).is_ok() {
                accepted.push(case);
            }
        }
        assert!(
            accepted.is_empty(),
            "accepted unusable inventory: {accepted:?}"
        );
    }

    fn rewrite(dir: &Path, mapping: &mut Value, change: impl FnOnce(&mut Value)) {
        let path = dir.join("hermes-amd64.spdx.json");
        let mut sbom: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        change(&mut sbom);
        replace(dir, mapping, &serde_json::to_vec(&sbom).unwrap());
    }

    /// Replace the first SBOM with `bytes`, keeping its mapping's digest.
    fn replace(dir: &Path, mapping: &mut Value, bytes: &[u8]) {
        fs::write(dir.join("hermes-amd64.spdx.json"), bytes).unwrap();
        mapping[0]["sha256"] = json!(crate::hex(&Sha256::digest(bytes)));
    }

    #[test]
    fn packages_without_a_versioned_identity_are_counted_not_rejected() {
        let (dir, inventory, mut mapping) = fixture();
        // Shapes Syft 1.55 records in the staged release images.
        rewrite(dir.path(), &mut mapping, |sbom| {
            sbom["packages"].as_array_mut().unwrap().extend([
                json!({"SPDXID": "SPDXRef-subpath", "name": "@google/genai/node", "versionInfo": "UNKNOWN",
                    "externalRefs": [{"referenceCategory": "PACKAGE-MANAGER", "referenceType": "purl", "referenceLocator": "pkg:npm/%40google/genai%2Fnode"}]}),
                json!({"SPDXID": "SPDXRef-stdlib", "name": "stdlib", "versionInfo": "go1.26.0",
                    "externalRefs": [{"referenceCategory": "PACKAGE-MANAGER", "referenceType": "purl", "referenceLocator": "pkg:golang/stdlib@1.26.0"}]}),
                json!({"SPDXID": "SPDXRef-model", "name": "utils", "versionInfo": "UNKNOWN"}),
                json!({"SPDXID": "SPDXRef-binary", "name": "cli"}),
            ]);
        });
        let subjects = run(dir.path(), &inventory, &mapping).unwrap();
        let counts: Vec<_> = subjects.iter().map(|s| s.unidentified_packages).collect();
        assert_eq!(counts, [4, 0]);
    }

    #[test]
    fn release_sized_sboms_are_admissible() {
        // Each vLLM platform's SPDX document is about 65 MB.
        let (dir, inventory, mut mapping) = fixture();
        // Write the large comment into the document's text: serializing it
        // takes longer than the assessment it feeds.
        let sbom = fs::read(dir.path().join("hermes-amd64.spdx.json")).unwrap();
        let fields = sbom.strip_prefix(b"{").unwrap();
        let mut bytes = br#"{"comment":""#.to_vec();
        bytes.resize(bytes.len() + 70_000_000, b'x');
        bytes.extend_from_slice(b"\",");
        bytes.extend_from_slice(fields);
        replace(dir.path(), &mut mapping, &bytes);
        assert!(run(dir.path(), &inventory, &mapping).is_ok());
    }

    #[test]
    fn cpe_only_libraries_and_described_file_roots_remain_admissible() {
        let (dir, _, _) = fixture();
        let mut sbom: Value =
            serde_json::from_slice(&fs::read(dir.path().join("hermes-amd64.spdx.json")).unwrap())
                .unwrap();
        sbom["packages"][0]["externalRefs"] = json!([{"referenceCategory": "SECURITY", "referenceType": "cpe23Type",
            "referenceLocator": "cpe:2.3:a:vendor:example:1:*:*:*:*:*:*:*"}]);
        sbom["packages"].as_array_mut().unwrap().push(
            json!({"SPDXID": "SPDXRef-source", "name": "source", "primaryPackagePurpose": "FILE"}),
        );
        sbom["relationships"] = json!([{"spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": "SPDXRef-source"}]);
        assert!(validate_spdx(&serde_json::to_vec(&sbom).unwrap()).is_ok());
        sbom["packages"][0]["externalRefs"][0] = json!({"referenceCategory": "SECURITY", "referenceType": "cpe22Type", "referenceLocator": "cpe:/a:vendor:example:1"});
        assert!(validate_spdx(&serde_json::to_vec(&sbom).unwrap()).is_ok());
    }

    #[test]
    fn missing_duplicate_and_substituted_subjects_are_not_complete_coverage() {
        let mut accepted = Vec::new();
        for case in [
            "missing",
            "duplicate",
            "digest",
            "platform",
            "reference",
            "empty",
        ] {
            let (dir, inventory, mut mapping) = fixture();
            match case {
                "missing" => {
                    mapping.as_array_mut().unwrap().pop();
                }
                "duplicate" => {
                    mapping[1] = mapping[0].clone();
                }
                "digest" => {
                    mapping[0]["reference"] = json!(format!(
                        "ghcr.io/nvidia/nemoclaw/candidates/hermes@sha256:{}",
                        "c".repeat(64)
                    ))
                }
                "platform" => mapping[0]["platform"] = json!("linux/s390x"),
                "reference" => mapping[0]["reference"] = json!("ghcr.io/other/image:latest"),
                "empty" => mapping = json!([]),
                _ => unreachable!(),
            }
            if run(dir.path(), &inventory, &mapping).is_ok() {
                accepted.push(case);
            }
        }
        assert!(
            accepted.is_empty(),
            "accepted invalid coverage: {accepted:?}"
        );
    }

    #[test]
    fn auxiliary_attestations_are_not_executable_platforms() {
        let (dir, mut inventory, mapping) = fixture();
        let descriptor = json!({"digest": format!("sha256:{}", "c".repeat(64)),
            "platform": {"os": "unknown", "architecture": "unknown"},
            "annotations": {"vnd.docker.reference.type": "attestation-manifest"}});
        inventory[0]["manifests"]["manifests"]
            .as_array_mut()
            .unwrap()
            .push(descriptor);
        assert_eq!(run(dir.path(), &inventory, &mapping).unwrap().len(), 2);
        inventory[0]["manifests"]["manifests"][2]
            .as_object_mut()
            .unwrap()
            .remove("annotations");
        assert!(run(dir.path(), &inventory, &mapping).is_err());
    }

    #[test]
    fn unsupported_and_duplicate_inventory_platforms_are_rejected() {
        for case in ["empty", "missing", "duplicate", "unsupported", "bad_digest"] {
            let (dir, mut inventory, mapping) = fixture();
            match case {
                "empty" => inventory = json!([]),
                "missing" => {
                    inventory[0]["manifests"]["manifests"]
                        .as_array_mut()
                        .unwrap()
                        .pop();
                }
                "duplicate" => {
                    inventory[0]["manifests"]["manifests"][1] =
                        inventory[0]["manifests"]["manifests"][0].clone()
                }
                "unsupported" => {
                    inventory[0]["manifests"]["manifests"][0]["platform"]["architecture"] =
                        json!("s390x")
                }
                "bad_digest" => {
                    inventory[0]["manifests"]["manifests"][0]["digest"] = json!("sha256:invalid")
                }
                _ => unreachable!(),
            }
            assert!(run(dir.path(), &inventory, &mapping).is_err(), "{case}");
        }
    }

    #[test]
    fn substituted_bytes_and_invalid_spdx_are_rejected_before_scanning() {
        let mut accepted = Vec::new();
        for case in ["checksum", "spdx"] {
            let (dir, inventory, mut mapping) = fixture();
            if case == "checksum" {
                mapping[0]["sha256"] = json!("c".repeat(64));
            } else {
                fs::write(dir.path().join("hermes-amd64.spdx.json"), b"{}").unwrap();
                mapping[0]["sha256"] = json!(crate::hex(&Sha256::digest(b"{}")));
            }
            if run(dir.path(), &inventory, &mapping).is_ok() {
                accepted.push(case);
            }
        }
        assert!(accepted.is_empty(), "accepted invalid bytes: {accepted:?}");
    }

    #[test]
    fn absolute_asset_paths_cannot_escape_the_sbom_directory() {
        let (dir, inventory, mut mapping) = fixture();
        mapping[0]["asset"] = json!(dir.path().join("hermes-amd64.spdx.json"));
        assert!(run(dir.path(), &inventory, &mapping).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_assets_are_rejected() {
        let (dir, inventory, mut mapping) = fixture();
        std::os::unix::fs::symlink("hermes-amd64.spdx.json", dir.path().join("link.spdx.json"))
            .unwrap();
        mapping[0]["asset"] = json!("link.spdx.json");
        assert!(run(dir.path(), &inventory, &mapping).is_err());
    }
}
