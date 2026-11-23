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

/// Whether a loaded policy keeps every declared rule. OpenShell adds paths of
/// its own when it loads a policy; they're accepted here, and the loaded
/// revision's recorded hash pins them, so NemoClaw keeps no copy of them.
pub(super) fn loaded_policy_contains(
    loaded: &proto::SandboxPolicy,
    expected: &str,
) -> Result<bool, ObservationError> {
    // Exactly as declared, with nothing added.
    if policy_json(loaded)? == expected {
        return Ok(true);
    }
    let input: ExplicitPolicy =
        serde_json::from_str(expected).map_err(|_| ObservationError::Query)?;
    let declared = input.to_proto().map_err(|_| ObservationError::Query)?;
    let Some(observed) = &loaded.filesystem else {
        return Ok(false);
    };
    let filesystem = declared
        .filesystem
        .clone()
        .unwrap_or(proto::FilesystemPolicy {
            include_workdir: true,
            ..Default::default()
        });
    // Each declared path stays in its own list, so a read-only path made
    // writable is a difference.
    if observed.include_workdir != filesystem.include_workdir
        || !filesystem
            .read_only
            .iter()
            .all(|path| observed.read_only.contains(path))
        || !filesystem
            .read_write
            .iter()
            .all(|path| observed.read_write.contains(path))
    {
        return Ok(false);
    }
    // Everything else must be exactly as declared.
    let mut comparable = loaded.clone();
    comparable.filesystem.clone_from(&declared.filesystem);
    Ok(policy_json(&comparable)? == policy_json(&declared)?)
}

/// The settings a sandbox starts with, which OpenShell never changes on a
/// running one: everything in its policy but its network rules and
/// middleware bindings.
pub(super) fn startup_settings(policy: &proto::SandboxPolicy) -> Result<String, ObservationError> {
    policy_json(&proto::SandboxPolicy {
        network_policies: Default::default(),
        network_middlewares: Default::default(),
        ..policy.clone()
    })
}

/// Whether a change to `field` replaces the sandbox. OpenShell changes a
/// running sandbox's network rules and middleware bindings in place, as
/// `openshell policy set` does, but applies the rest of its policy only when
/// it starts. So a policy change replaces the sandbox when it changes its
/// startup settings, when APF governs its policy, or when either policy isn't
/// known yet.
pub(super) fn policy_changes(
    field: &str,
    prior: &nemoclaw_tofu::State,
    proposed: &nemoclaw_tofu::State,
) -> bool {
    use tf_provider::value::Value;
    let startup = |state: &nemoclaw_tofu::State| -> Option<String> {
        let value = |field: &str| match state.get(field) {
            Some(Value::Value(value)) => Some(value.as_str()),
            Some(Value::Null) | None => Some(""),
            Some(Value::Unknown) => None,
        };
        if !value(crate::POLICY_AUTHORITY)?.is_empty() {
            return None;
        }
        let launch = nemoclaw_openshell::runtime::Launch::from_json(value("launch_json")?).ok()?;
        let input = serde_json::from_str(value("policy_json")?).ok()?;
        startup_settings(&launch.policy(&input).ok()?).ok()
    };
    field == "policy_json"
        && match (startup(prior), startup(proposed)) {
            (Some(prior), Some(proposed)) => prior != proposed,
            _ => true,
        }
}

/// The policy that changes a running sandbox's network rules to `declared`'s:
/// `declared` with the filesystem paths of `loaded`, the policy the sandbox
/// holds now, so the new revision keeps the paths OpenShell added when the
/// sandbox started, as OpenShell's guide to `openshell policy set` asks. The
/// sandbox must hold `declared`'s other settings.
pub(super) fn updated_policy(
    loaded: &proto::SandboxPolicy,
    mut declared: proto::SandboxPolicy,
) -> Result<proto::SandboxPolicy, ObservationError> {
    let mut started = loaded.clone();
    started
        .network_policies
        .clone_from(&declared.network_policies);
    started
        .network_middlewares
        .clone_from(&declared.network_middlewares);
    if !loaded_policy_contains(&started, &policy_json(&declared)?)? {
        return Err(ObservationError::BindingMismatch);
    }
    declared.filesystem.clone_from(&loaded.filesystem);
    Ok(declared)
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
