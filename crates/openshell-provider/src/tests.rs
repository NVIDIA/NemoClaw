// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
fn policy() -> proto::SandboxPolicy {
    let manifest: serde_json::Value =
        serde_json::from_str(include_str!("../../../image/fabric/runtime.json")).unwrap();
    let policy: nemoclaw_openshell::policy::ExplicitPolicy =
        serde_json::from_value(manifest["policy"].clone()).unwrap();
    policy.to_proto().unwrap()
}
fn policy_matches(actual: &proto::SandboxPolicy) -> bool {
    policy_json(actual).ok() == policy_json(&policy()).ok()
}

fn metadata() -> proto::ObjectMeta {
    proto::ObjectMeta {
        id: "physical".into(),
        name: "workspace".into(),
        labels: [
            (OWNER.into(), "deployment".into()),
            (GENERATION.into(), "generation".into()),
        ]
        .into(),
        ..Default::default()
    }
}
#[test]
fn only_object_not_found_establishes_absence() {
    assert!(
        authoritative::<proto::GetWorkspaceResponse>(Err(tonic::Status::not_found("gone")))
            .unwrap()
            .is_none()
    );
    for status in [
        tonic::Status::unauthenticated("secret"),
        tonic::Status::permission_denied("secret"),
        tonic::Status::unavailable("secret"),
        tonic::Status::internal("secret"),
    ] {
        let error = authoritative::<proto::GetWorkspaceResponse>(Err(status)).unwrap_err();
        assert!(!error.to_string().contains("secret"));
    }
    assert!(workspace_row(proto::GetWorkspaceResponse::default(), "workspace", false).is_err());
}

#[test]
fn lazy_channel_connection_failures_are_retryable_transport_errors() {
    assert_eq!(
        remote_error(&tonic::Status::unknown("transport error")),
        ObservationError::Transport
    );
    assert_eq!(
        remote_error(&tonic::Status::unknown("server rejected query")),
        ObservationError::Query
    );
}
#[test]
fn workspace_reader_requires_complete_matching_active_identity() {
    let response = proto::GetWorkspaceResponse {
        workspace: Some(proto::Workspace {
            metadata: Some(metadata()),
            status: Some(proto::WorkspaceStatus { phase: 1 }),
        }),
    };
    assert_eq!(
        workspace_row(response.clone(), "workspace", false).unwrap()["id"],
        "physical"
    );
    assert!(workspace_row(response.clone(), "different", false).is_err());
    let mut partial = response.clone();
    partial
        .workspace
        .as_mut()
        .unwrap()
        .metadata
        .as_mut()
        .unwrap()
        .labels
        .clear();
    assert!(workspace_row(partial, "workspace", false).is_err());
    let mut terminating = response;
    terminating
        .workspace
        .as_mut()
        .unwrap()
        .status
        .as_mut()
        .unwrap()
        .phase = 2;
    assert!(workspace_row(terminating.clone(), "workspace", false).is_err());
    assert!(workspace_row(terminating, "workspace", true).is_ok());
}
#[test]
fn active_policy_absence_and_drift_never_mean_sandbox_absence() {
    assert!(active_policy(proto::GetSandboxPolicyStatusResponse::default(), "").is_err());
    let mut policy = policy();
    policy
        .filesystem
        .as_mut()
        .unwrap()
        .read_write
        .push("/".into());
    assert!(!policy_matches(&policy));
    let mut reordered = self::policy();
    reordered.filesystem.as_mut().unwrap().read_only.reverse();
    assert!(policy_matches(&reordered));
}

#[test]
fn mutation_identity_checks_reject_foreign_ownership_and_replacements() {
    let row = base(Some(metadata()), "workspace", false).unwrap();
    assert!(verify_identity(&row, &row).is_ok());
    for key in ["owner", "generation", "id"] {
        let mut changed = row.clone();
        changed.insert(key.into(), "foreign".into());
        assert!(verify_identity(&row, &changed).is_err());
    }
    let mut unbound = row.clone();
    unbound.insert("id".into(), String::new());
    assert!(verify_identity(&unbound, &row).is_ok());
}

#[test]
fn deletion_timestamp_presence_blocks_observation_but_allows_cleanup() {
    let mut meta = metadata();
    // Even a zero deletion timestamp marks the resource for deletion; only an absent timestamp allows normal observation.
    meta.deletion_time = Some(Default::default());
    assert!(base(Some(meta.clone()), "workspace", false).is_err());
    assert!(base(Some(meta), "workspace", true).is_ok());
}

#[test]
fn a_loaded_policy_keeps_the_declared_rules_and_reports_its_hash() {
    // OpenShell adds paths of its own when it loads a policy. NemoClaw accepts
    // them at that moment and records the revision's hash; later observations
    // compare the hash exactly, so it keeps no copy of OpenShell's additions.
    let mut declared = policy();
    let profile = inference_profile(
        "local",
        "http://172.30.122.1:18899/v1",
        nemoclaw_openshell::profile::InferenceProviderKind::Openai,
        false,
    )
    .unwrap();
    declared.network_policies.insert(
        profile.id.clone(),
        proto::NetworkPolicyRule {
            name: profile.id,
            endpoints: profile.endpoints,
            binaries: profile.binaries,
        },
    );
    let expected = policy_json(&declared).unwrap();
    let response = |policy: proto::SandboxPolicy, hash: &str, status: proto::PolicyStatus| {
        proto::GetSandboxPolicyStatusResponse {
            active_version: 2,
            revision: Some(proto::SandboxPolicyRevision {
                version: 2,
                status: status as i32,
                policy_hash: hash.into(),
                policy: Some(policy),
                ..Default::default()
            }),
        }
    };
    let loaded = proto::PolicyStatus::Loaded;
    let mut enriched = declared.clone();
    let fs = enriched.filesystem.as_mut().unwrap();
    fs.read_only
        .extend(["/var/log", "/proc", "/opt/anything"].map(String::from));
    fs.read_write.push("/scratch".into());
    assert_eq!(
        active_policy(response(enriched.clone(), "sha256:a", loaded), &expected).unwrap(),
        "sha256:a"
    );
    assert_eq!(
        active_policy(response(declared.clone(), "sha256:b", loaded), &expected).unwrap(),
        "sha256:b"
    );
    // A missing declared path, a read-only path made writable, or a different
    // network rule means the loaded policy isn't the declared one.
    let first = declared.filesystem.as_ref().unwrap().read_only[0].clone();
    let mut missing = enriched.clone();
    missing
        .filesystem
        .as_mut()
        .unwrap()
        .read_only
        .retain(|path| path != &first);
    assert!(active_policy(response(missing, "sha256:c", loaded), &expected).is_err());
    let mut writable = enriched.clone();
    let fs = writable.filesystem.as_mut().unwrap();
    fs.read_only.retain(|path| path != &first);
    fs.read_write.push(first.clone());
    assert!(active_policy(response(writable, "sha256:d", loaded), &expected).is_err());
    let mut network = enriched.clone();
    network.network_policies.clear();
    assert!(active_policy(response(network, "sha256:e", loaded), &expected).is_err());
    // An unloaded revision, or one without a hash, has nothing to record.
    assert!(
        active_policy(
            response(enriched.clone(), "sha256:f", proto::PolicyStatus::Pending),
            &expected
        )
        .is_err()
    );
    assert!(active_policy(response(enriched, "", loaded), &expected).is_err());
}

#[test]
fn inference_names_the_variable_sandboxes_see_its_key_in() {
    let row = |pairs: &[(&str, &str)]| -> Row {
        pairs
            .iter()
            .map(|(key, value)| ((*key).into(), (*value).into()))
            .collect()
    };
    let hosted = row(&[
        ("name", "hosted-model"),
        ("credential_env", "NVIDIA_API_KEY"),
        ("credential_source", ""),
    ]);
    assert_eq!(
        inference_sandbox_env(&hosted, &[]).as_deref(),
        Some("NEMOCLAW_INFERENCE_HOSTED_MODEL_KEY")
    );
    // An unauthenticated server gives sandboxes no key.
    let local = row(&[
        ("name", "local"),
        ("credential_env", ""),
        ("credential_source", ""),
    ]);
    assert_eq!(inference_sandbox_env(&local, &[]).as_deref(), Some(""));
    // Unknown until the inputs that decide it are known.
    assert_eq!(inference_sandbox_env(&hosted, &["credential_env"]), None);
}
