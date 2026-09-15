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
