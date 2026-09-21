// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

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
fn loaded_policy_accepts_only_the_runtime_log_directory_enrichment() {
    let mut declared = policy();
    let profile =
        native_profile::definition("local", "http://172.30.122.1:18899/v1", "openai", false)
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
    let mut loaded = declared.clone();
    loaded
        .filesystem
        .as_mut()
        .unwrap()
        .read_only
        .push("/var/log".into());
    let response = |policy| proto::GetSandboxPolicyStatusResponse {
        active_version: 2,
        revision: Some(proto::SandboxPolicyRevision {
            version: 2,
            status: proto::PolicyStatus::Loaded as i32,
            policy: Some(policy),
            ..Default::default()
        }),
    };
    assert!(active_policy(response(loaded.clone()), &expected).is_ok());
    loaded
        .filesystem
        .as_mut()
        .unwrap()
        .read_only
        .push("/private".into());
    assert!(active_policy(response(loaded), &expected).is_err());
    let mut writable = declared.clone();
    writable
        .filesystem
        .as_mut()
        .unwrap()
        .read_write
        .push("/var/log".into());
    assert!(active_policy(response(writable), &expected).is_err());
    let mut missing = declared.clone();
    missing
        .filesystem
        .as_mut()
        .unwrap()
        .read_only
        .retain(|p| p != "/usr");
    assert!(active_policy(response(missing), &expected).is_err());
    assert!(active_policy(response(declared), &expected).is_ok());
}

#[test]
fn sparse_filesystem_policy_accepts_proxy_baseline_but_rejects_other_drift() {
    let mut declared = policy();
    declared.filesystem = Some(proto::FilesystemPolicy {
        include_workdir: true,
        read_only: vec![
            "/usr".into(),
            "/opt/fabric".into(),
            "/opt/nemoclaw".into(),
            "/app".into(),
        ],
        read_write: vec!["/sandbox".into()],
    });
    let profile =
        native_profile::definition("inference", "https://example.com/v1", "openai", false).unwrap();
    declared.network_policies.insert(
        "inference".into(),
        proto::NetworkPolicyRule {
            name: "inference".into(),
            endpoints: profile.endpoints,
            binaries: profile.binaries,
        },
    );
    let expected = policy_json(&declared).unwrap();
    let mut loaded = declared.clone();
    let fs = loaded.filesystem.as_mut().unwrap();
    fs.read_only
        .extend(["/lib", "/etc", "/var/log", "/proc", "/dev/urandom"].map(String::from));
    fs.read_write
        .extend(["/tmp", "/dev/null"].map(String::from));
    assert!(network::loaded_policy_matches(&loaded, &expected).unwrap());
    let mut drift = loaded.clone();
    drift
        .filesystem
        .as_mut()
        .unwrap()
        .read_write
        .push("/etc".into());
    assert!(!network::loaded_policy_matches(&drift, &expected).unwrap());
    let mut drift = loaded.clone();
    drift
        .filesystem
        .as_mut()
        .unwrap()
        .read_only
        .retain(|p| p != "/opt/fabric");
    assert!(!network::loaded_policy_matches(&drift, &expected).unwrap());
    let mut drift = loaded.clone();
    drift
        .network_policies
        .get_mut("inference")
        .unwrap()
        .endpoints[0]
        .host = "other.example.com".into();
    assert!(!network::loaded_policy_matches(&drift, &expected).unwrap());
    // Existing explicit read-only restrictions must not be promoted to writable.
    declared
        .filesystem
        .as_mut()
        .unwrap()
        .read_only
        .push("/tmp".into());
    assert!(!network::loaded_policy_matches(&loaded, &policy_json(&declared).unwrap()).unwrap());
}
