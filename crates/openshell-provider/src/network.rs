// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use nemoclaw_openshell::policy::ExplicitPolicy;
pub(super) use nemoclaw_openshell::runtime::ClusterGrants;

pub(super) fn policy_input(
    row: &Row,
) -> Result<nemoclaw_openshell::runtime::PolicyInput, ObservationError> {
    serde_json::from_str(row.get("policy_json").ok_or(ObservationError::Incomplete)?)
        .map_err(|_| ObservationError::Query)
}

pub(super) fn granted_row_policy(
    row: &Row,
    grants: &ClusterGrants,
) -> Result<proto::SandboxPolicy, ObservationError> {
    agent::launch(row)?.granted_policy(&policy_input(row)?, grants)
}

pub(super) fn recorded_grants(
    input: &nemoclaw_openshell::runtime::PolicyInput,
    policy: &proto::SandboxPolicy,
) -> Result<ClusterGrants, ObservationError> {
    input
        .cluster_grants
        .iter()
        .map(|name| {
            let rule = policy
                .network_policies
                .get(name)
                .ok_or(ObservationError::BindingMismatch)?;
            if rule.endpoints.len() != 1 {
                return Err(ObservationError::BindingMismatch);
            }
            Ok((name.clone(), rule.endpoints[0].allowed_ips.clone()))
        })
        .collect()
}

// Baseline grants follow NVIDIA/OpenShell crates/openshell-supervisor/src/lib.rs
// at 7e7a8d5610f336f5f7f9f60da0951adbf295475d (Apache-2.0).
// 2026-09-17: compare image-dependent proxy additions without changing authored
// grants, accepting unrelated paths, or upgrading explicit read-only grants.
pub(super) fn loaded_policy_matches(
    loaded: &proto::SandboxPolicy,
    expected: &str,
) -> Result<bool, ObservationError> {
    let actual = policy_json(loaded)?;
    if actual == expected {
        return Ok(true);
    }
    let input: ExplicitPolicy =
        serde_json::from_str(expected).map_err(|_| ObservationError::Query)?;
    let mut baseline = input.to_proto().map_err(|_| ObservationError::Query)?;
    if baseline.network_policies.is_empty() {
        return Ok(false);
    }
    let Some(observed) = &loaded.filesystem else {
        return Ok(false);
    };
    let fs = baseline
        .filesystem
        .get_or_insert_with(|| proto::FilesystemPolicy {
            include_workdir: true,
            ..Default::default()
        });
    // OpenShell adds only paths present in the sandbox image. Host filesystem
    // probes cannot establish that set; accept only observed, known additions.
    for (paths, writable) in [
        (
            &[
                "/usr",
                "/lib",
                "/etc",
                "/app",
                "/var/log",
                "/proc",
                "/dev/urandom",
            ][..],
            false,
        ),
        (&["/tmp", "/dev/null"][..], true),
    ] {
        for path in paths {
            let observed_paths = if writable {
                &observed.read_write
            } else {
                &observed.read_only
            };
            if observed_paths.iter().any(|p| p == path)
                && !fs.read_only.iter().chain(&fs.read_write).any(|p| p == path)
            {
                if writable {
                    &mut fs.read_write
                } else {
                    &mut fs.read_only
                }
                .push((*path).into());
            }
        }
    }
    Ok(policy_json(&baseline)? == actual)
}

pub(super) fn row_policy(row: &Row) -> Result<proto::SandboxPolicy, ObservationError> {
    agent::launch(row)?.policy(&policy_input(row)?)
}

pub(super) fn validate_row_policy(row: &Row) -> Result<(), ObservationError> {
    row_policy(row).map(|_| ())
}

/// Managed grants are named in OpenShell's policy, so their names must be
/// unique; checked when planning, while names are known.
pub(super) fn validate_grant_names(
    known: &Row,
    unknown: &[&str],
) -> Result<(), std::borrow::Cow<'static, str>> {
    let Some(encoded) = known.get("policy_json").filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    if unknown.contains(&"policy_json") {
        return Ok(());
    }
    let input: nemoclaw_openshell::runtime::PolicyInput =
        serde_json::from_str(encoded).map_err(|_| "policy is not a valid sandbox policy")?;
    if input.has_duplicate_grant() {
        return Err("policy grants must have unique names".into());
    }
    Ok(())
}

#[cfg(test)]
mod grant_name_tests {
    use super::validate_grant_names;
    use serde_json::json;

    fn row(managed: serde_json::Value) -> nemoclaw_tofu::Row {
        [(
            "policy_json".to_owned(),
            json!({"explicit": null, "managed": managed}).to_string(),
        )]
        .into()
    }

    fn grant(name: &str) -> serde_json::Value {
        json!({"name": name, "endpoints": [{"host": "api.example.com", "port": 443}], "binaries": []})
    }

    #[test]
    fn grants_need_unique_names() {
        assert!(validate_grant_names(&row(json!([grant("model"), grant("search")])), &[]).is_ok());
        let error =
            validate_grant_names(&row(json!([grant("model"), grant("model")])), &[]).unwrap_err();
        assert_eq!(error, "policy grants must have unique names");
        // Unknown policies are checked once known.
        assert!(
            validate_grant_names(
                &row(json!([grant("model"), grant("model")])),
                &["policy_json"]
            )
            .is_ok()
        );
    }
}
