// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Select explicitly supported releases and verify saved public scan inputs.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SupportedRelease {
    pub tag: String,
    pub inventory_sha256: String,
    pub sboms_sha256: String,
    pub policy_sha256: String,
    pub support_until: String,
}

#[derive(Debug, thiserror::Error)]
#[error("supported release monitoring: {reason}")]
pub struct MonitorError {
    reason: String,
}

fn invalid(reason: &str) -> MonitorError {
    MonitorError {
        reason: reason.into(),
    }
}

fn sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}

fn tag(value: &str) -> bool {
    let Some(value) = value.strip_prefix("v0.1.") else {
        return false;
    };
    let (patch, suffix) = value.split_once('-').unwrap_or((value, ""));
    !patch.is_empty()
        && patch.bytes().all(|v| v.is_ascii_digit())
        && (!value.contains('-') || !suffix.is_empty())
        && suffix
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || matches!(v, b'.' | b'-'))
}

fn document(bytes: &[u8], limit: usize) -> Result<Value, MonitorError> {
    if bytes.is_empty() || bytes.len() > limit {
        return Err(invalid("saved document is empty or exceeds its size limit"));
    }
    serde_json::from_slice(bytes).map_err(|_| invalid("saved document is not valid JSON"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema_version: u8,
    releases: Vec<SupportedRelease>,
}

/// Planning does not authenticate a release or authorize disclosure.
pub fn plan(
    manifest_bytes: &[u8],
    now: OffsetDateTime,
) -> Result<Vec<SupportedRelease>, MonitorError> {
    if manifest_bytes.is_empty() || manifest_bytes.len() > 1 << 20 {
        return Err(invalid(
            "supported-release manifest is empty or exceeds its size limit",
        ));
    }
    let manifest: Manifest = serde_json::from_slice(manifest_bytes)
        .map_err(|_| invalid("expected unambiguous versioned supported-release manifest"))?;
    if manifest.schema_version != 1 || manifest.releases.len() > 64 {
        return Err(invalid("unsupported manifest version or too many releases"));
    }
    let mut seen = BTreeSet::new();
    let mut active = Vec::new();
    for release in manifest.releases {
        if release.tag.len() > 128
            || !tag(&release.tag)
            || !seen.insert(release.tag.clone())
            || !sha256(&release.inventory_sha256)
            || !sha256(&release.sboms_sha256)
            || !sha256(&release.policy_sha256)
        {
            return Err(invalid(
                "supported release has an invalid or duplicate immutable identity",
            ));
        }
        let end = OffsetDateTime::parse(&release.support_until, &Rfc3339)
            .map_err(|_| invalid("support_until must be an RFC 3339 timestamp"))?;
        if now < end {
            active.push(release);
        }
    }
    active.sort_by(|left, right| left.tag.cmp(&right.tag));
    Ok(active)
}

pub fn verify_public_release(
    release: &SupportedRelease,
    metadata_bytes: &[u8],
    inventory_bytes: &[u8],
    mapping_bytes: &[u8],
) -> Result<(), MonitorError> {
    if !tag(&release.tag)
        || crate::hex(&Sha256::digest(inventory_bytes)) != release.inventory_sha256
        || crate::hex(&Sha256::digest(mapping_bytes)) != release.sboms_sha256
    {
        return Err(invalid(
            "release inputs differ from the supported release's approved checksums",
        ));
    }
    let metadata = document(metadata_bytes, 1 << 20)?;
    let id = metadata["id"]
        .as_u64()
        .filter(|id| *id > 0)
        .ok_or_else(|| invalid("release metadata has no valid identity"))?;
    if metadata["draft"] != false
        || metadata["tag_name"] != release.tag
        || metadata["published_at"]
            .as_str()
            .is_none_or(|value| OffsetDateTime::parse(value, &Rfc3339).is_err())
        || metadata["url"] != format!("https://api.github.com/repos/NVIDIA/NemoClaw/releases/{id}")
        || metadata["html_url"]
            != format!(
                "https://github.com/NVIDIA/NemoClaw/releases/tag/{}",
                release.tag
            )
    {
        return Err(invalid(
            "monitoring requires the exact published NVIDIA/NemoClaw release",
        ));
    }
    let inventory = document(inventory_bytes, 16_000_000)?;
    let mut repositories = BTreeSet::new();
    for image in inventory
        .as_array()
        .filter(|images| !images.is_empty())
        .ok_or_else(|| invalid("release inventory must contain images"))?
    {
        let name = image["name"]
            .as_str()
            .ok_or_else(|| invalid("release image has no name"))?;
        let repository = image["repository"]
            .as_str()
            .ok_or_else(|| invalid("release image has no repository"))?;
        if name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .all(|v| v.is_ascii_lowercase() || v.is_ascii_digit() || v == b'-')
            || repository != format!("ghcr.io/nvidia/nemoclaw/v1/{name}")
            || !image["index_digest"]
                .as_str()
                .and_then(|v| v.strip_prefix("sha256:"))
                .is_some_and(sha256)
            || !repositories.insert(repository)
        {
            return Err(invalid("release image repository is invalid or duplicated"));
        }
    }
    let mapping = document(mapping_bytes, 16_000_000)?;
    let mut assets = BTreeSet::new();
    for entry in mapping
        .as_array()
        .filter(|entries| !entries.is_empty())
        .ok_or_else(|| invalid("release must contain saved SPDX mappings"))?
    {
        let Some((repository, digest)) = entry["reference"]
            .as_str()
            .and_then(|reference| reference.split_once('@'))
        else {
            return Err(invalid("SPDX mapping has no immutable image reference"));
        };
        let Some(asset) = entry["asset"].as_str() else {
            return Err(invalid("SPDX mapping has no asset name"));
        };
        if !repositories.contains(repository)
            || !digest.strip_prefix("sha256:").is_some_and(sha256)
            || !matches!(
                entry["platform"].as_str(),
                Some("linux/amd64" | "linux/arm64")
            )
            || !entry["sha256"].as_str().is_some_and(sha256)
            || !asset.ends_with(".spdx.json")
            || asset.len() > 255
            || !asset
                .bytes()
                .all(|v| v.is_ascii_alphanumeric() || matches!(v, b'.' | b'_' | b'-'))
            || !assets.insert(asset)
        {
            return Err(invalid(
                "SPDX mapping has an invalid subject or unsafe asset name",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_explicitly_supported_unexpired_releases_are_selected() {
        let bytes = serde_json::to_vec(&json!({"schema_version":1,"releases":[{
            "tag":"v0.1.0-rc1", "inventory_sha256":"a".repeat(64),
            "sboms_sha256":"b".repeat(64), "policy_sha256":"c".repeat(64),
            "support_until":"2026-10-22T00:00:00Z"
        }]}))
        .unwrap();
        let releases = plan(
            &bytes,
            OffsetDateTime::parse(
                "2026-10-21T12:00:00Z",
                &time::format_description::well_known::Rfc3339,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].tag, "v0.1.0-rc1");
        assert!(
            plan(
                &bytes,
                OffsetDateTime::parse(
                    "2026-10-22T00:00:00Z",
                    &time::format_description::well_known::Rfc3339
                )
                .unwrap()
            )
            .unwrap()
            .is_empty()
        );
    }

    fn saved_release() -> (SupportedRelease, Value, Vec<u8>, Vec<u8>) {
        let repository = "ghcr.io/nvidia/nemoclaw/v1/hermes";
        let digest = format!("sha256:{}", "d".repeat(64));
        let inventory = serde_json::to_vec(&json!([{"name":"hermes","repository":repository,"index_digest":format!("sha256:{}","e".repeat(64)),"manifests":{"manifests":[]}}])).unwrap();
        let mapping = serde_json::to_vec(&json!([{"reference":format!("{repository}@{digest}"),"platform":"linux/amd64","asset":"hermes-amd64.spdx.json","sha256":"f".repeat(64)}])).unwrap();
        let release = SupportedRelease {
            tag: "v0.1.0".into(),
            inventory_sha256: crate::hex(&Sha256::digest(&inventory)),
            sboms_sha256: crate::hex(&Sha256::digest(&mapping)),
            policy_sha256: "a".repeat(64),
            support_until: "2026-10-22T00:00:00Z".into(),
        };
        let metadata = json!({"id":123,"tag_name":"v0.1.0","draft":false,"published_at":"2026-10-20T00:00:00Z","html_url":"https://github.com/NVIDIA/NemoClaw/releases/tag/v0.1.0","url":"https://api.github.com/repos/NVIDIA/NemoClaw/releases/123"});
        (release, metadata, inventory, mapping)
    }

    #[test]
    fn a_draft_cannot_be_scanned_as_an_authorized_public_release() {
        let (release, mut metadata, inventory, mapping) = saved_release();
        metadata["draft"] = json!(true);
        assert!(
            verify_public_release(
                &release,
                &serde_json::to_vec(&metadata).unwrap(),
                &inventory,
                &mapping
            )
            .is_err()
        );
    }

    #[test]
    fn ambiguous_manifest_fields_are_rejected_before_planning() {
        assert!(
            plan(
                br#"{"schema_version":1,"schema_version":1,"releases":[]}"#,
                OffsetDateTime::UNIX_EPOCH
            )
            .is_err()
        );
    }

    #[test]
    fn unsupported_duplicate_or_unsafe_support_entries_never_form_a_matrix() {
        let (release, _, _, _) = saved_release();
        let base = json!({"schema_version":1,"releases":[release]});
        for case in [
            "version",
            "duplicate",
            "tag",
            "hash",
            "timestamp",
            "unknown",
        ] {
            let mut value = base.clone();
            match case {
                "version" => value["schema_version"] = json!(2),
                "duplicate" => {
                    let duplicate = value["releases"][0].clone();
                    value["releases"].as_array_mut().unwrap().push(duplicate);
                }
                "tag" => value["releases"][0]["tag"] = json!("v0.1.0$(touch injected)"),
                "hash" => value["releases"][0]["inventory_sha256"] = json!("A".repeat(64)),
                "timestamp" => value["releases"][0]["support_until"] = json!("later"),
                "unknown" => value["releases"][0]["allow_private"] = json!(true),
                _ => unreachable!(),
            }
            assert!(
                plan(
                    &serde_json::to_vec(&value).unwrap(),
                    OffsetDateTime::UNIX_EPOCH
                )
                .is_err(),
                "{case}"
            );
        }
    }

    #[test]
    fn only_exact_published_release_bytes_reach_public_scanning() {
        let (release, metadata, inventory, mapping) = saved_release();
        let bytes = serde_json::to_vec(&metadata).unwrap();
        assert!(verify_public_release(&release, &bytes, &inventory, &mapping).is_ok());
        assert!(verify_public_release(&release, &bytes, b"[]", &mapping).is_err());
        assert!(verify_public_release(&release, &bytes, &inventory, b"[]").is_err());
        for (field, replacement) in [
            ("tag_name", json!("v0.1.1")),
            ("published_at", Value::Null),
            (
                "html_url",
                json!("https://github.com/other/NemoClaw/releases/tag/v0.1.0"),
            ),
            (
                "url",
                json!("https://api.github.com/repos/other/NemoClaw/releases/123"),
            ),
        ] {
            let mut metadata = metadata.clone();
            metadata[field] = replacement;
            assert!(
                verify_public_release(
                    &release,
                    &serde_json::to_vec(&metadata).unwrap(),
                    &inventory,
                    &mapping
                )
                .is_err(),
                "{field}"
            );
        }
    }

    #[test]
    fn unsafe_asset_names_cannot_be_used_as_download_patterns() {
        let (mut release, metadata, inventory, mapping) = saved_release();
        let mut mapping: Value = serde_json::from_slice(&mapping).unwrap();
        mapping[0]["asset"] = json!("../private.spdx.json");
        let mapping = serde_json::to_vec(&mapping).unwrap();
        release.sboms_sha256 = crate::hex(&Sha256::digest(&mapping));
        assert!(
            verify_public_release(
                &release,
                &serde_json::to_vec(&metadata).unwrap(),
                &inventory,
                &mapping
            )
            .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn workflow_denies_private_unknown_and_substituted_package_visibility() {
        use std::{fs, os::unix::fs::PermissionsExt, process::Command};
        let workflow: Value = serde_saphyr::from_str(include_str!(
            "../../../../.github/workflows/v1-vulnerability-monitor.yml"
        ))
        .unwrap();
        let script = workflow["jobs"]["scan"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|step| step["name"] == "Verify each image package is public")
            .unwrap()["run"]
            .as_str()
            .unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("sboms")).unwrap();
        let (_, _, inventory, _) = saved_release();
        fs::write(root.path().join("sboms/inventory.json"), inventory).unwrap();
        let gh = root.path().join("gh");
        fs::write(&gh, "#!/bin/sh\nset -eu\ncat \"$PACKAGE_METADATA\"\n").unwrap();
        fs::set_permissions(&gh, fs::Permissions::from_mode(0o700)).unwrap();
        for (value, expected) in [
            (
                json!({"visibility":"public","package_type":"container","name":"nemoclaw/v1/hermes"}),
                true,
            ),
            (
                json!({"visibility":"internal","package_type":"container","name":"nemoclaw/v1/hermes"}),
                false,
            ),
            (
                json!({"visibility":"private","package_type":"container","name":"nemoclaw/v1/hermes"}),
                false,
            ),
            (
                json!({"visibility":"public","package_type":"container","name":"other/hermes"}),
                false,
            ),
            (json!({}), false),
        ] {
            let path = root.path().join("package-metadata.json");
            fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            let output = Command::new("bash")
                .args([
                    "--noprofile",
                    "--norc",
                    "-e",
                    "-o",
                    "pipefail",
                    "-c",
                    script,
                ])
                .env_clear()
                .env(
                    "PATH",
                    format!(
                        "{}:{}",
                        root.path().display(),
                        std::env::var("PATH").unwrap()
                    ),
                )
                .env("RUNNER_TEMP", root.path())
                .env("PACKAGE_METADATA", path)
                .output()
                .unwrap();
            assert_eq!(
                output.status.success(),
                expected,
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
}
