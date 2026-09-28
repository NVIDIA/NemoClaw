// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use serde_json::json;

fn spec() -> Spec {
    serde_json::from_value(json!({
        "layout":1,"kind":"kubernetes_gateway","name":"nc-0123456789abcdef-gateway",
        "owner":"11111111-1111-4111-8111-111111111111","generation":"0123456789abcdef0123456789abcdef",
        "settings":{
            "endpoint":"https://127.0.0.1:17671",
            "kubernetes":{
                "kubeconfig":{"env":"TEST_CLUSTER_CONFIG"},"context":"explicit-context","namespace":"test-owned",
                "prerequisites":{"agentSandbox":{"management":"managed"}},
                "authentication":{"profile":"development"}
            }
        }
    })).unwrap()
}

#[test]
fn raw_provider_cannot_route_an_engine_spec_to_kubernetes() {
    let mut spec = spec();
    assert!(spec.validate().is_ok());
    spec.settings.engine = "unix:///var/run/docker.sock".into();
    assert!(spec.validate().is_err());
    spec.settings.engine.clear();
    spec.kind = "managed_gateway".into();
    assert!(spec.validate().is_err());
}

#[test]
fn fresh_provider_plan_does_not_claim_an_empty_prior_identity() {
    // The provider projects an unknown computed ID as an empty string during
    // fresh planning. Only a real retained ID may cross the helper boundary.
    assert!(bound_id(&Row::new()).is_none());
    assert!(bound_id(&Row::from([("id".into(), String::new())])).is_none());
    let row = Row::from([("id".into(), "retained-id".into())]);
    assert_eq!(bound_id(&row).map(String::as_str), Some("retained-id"));
}

#[test]
fn changed_platform_identity_is_never_a_refresh() {
    let spec = spec();
    let row = Row::from([
        ("spec".into(), spec.encode().unwrap()),
        ("id".into(), "original".into()),
    ]);
    let response = Response {
        id: Some("replacement".into()),
        running: Some(true),
        ..Default::default()
    };
    assert_eq!(
        response.row(&spec, &row),
        Err(ObservationError::BindingMismatch)
    );
}

#[test]
fn readiness_failure_preserves_established_platform_binding() {
    for kind in [STORAGE_KIND, GATEWAY_KIND] {
        let mut spec = spec();
        spec.kind = kind.into();
        let row = Row::from([("spec".into(), spec.encode().unwrap())]);
        let response = Response {
            id: Some("known-uid".into()),
            running: Some(true),
            error: Some("command".into()),
            ..Default::default()
        };
        let mutation = response.mutation(&spec, &row);
        assert_eq!(mutation.state().unwrap()["id"], "known-uid");
        assert_eq!(mutation.state().unwrap()["running"], "false");
        assert!(
            mutation.error().is_none(),
            "postcondition must report failure without taint"
        );
        let unknown = Response {
            error: Some("command".into()),
            ..Default::default()
        };
        assert!(unknown.mutation(&spec, &row).error().is_some());
        assert!(unknown.mutation(&spec, &row).state().is_none());
    }
}

#[test]
fn incomplete_and_secret_bearing_helper_output_never_enters_state_or_diagnostics() {
    let spec = spec();
    let row = Row::from([("spec".into(), spec.encode().unwrap())]);
    let response = Response {
        id: Some("credential\ncontents".into()),
        running: Some(true),
        error: Some("secret-key-sentinel".into()),
        ..Default::default()
    };
    assert_eq!(response.row(&spec, &row), Err(ObservationError::Incomplete));
    assert!(
        !response
            .error()
            .unwrap()
            .to_string()
            .contains("secret-key-sentinel")
    );
    assert!(
        serde_json::from_value::<Response>(json!({"id":"uid","unexpected":"private"})).is_err()
    );
}

#[cfg(unix)]
#[test]
fn backend_rejects_shared_and_symlinked_private_state() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = tempfile::tempdir().unwrap();
    // macOS temporary paths may begin with the system /var symlink.
    let directory = root.path().canonicalize().unwrap();
    let shared = directory.join("shared");
    std::fs::create_dir(&shared).unwrap();
    std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        runner::private_directory(&shared),
        Err(ObservationError::Permission)
    );
    let alias = directory.join("alias");
    symlink(&shared, &alias).unwrap();
    assert_eq!(
        runner::private_directory(&alias),
        Err(ObservationError::BindingMismatch)
    );
    let private = directory.join("private");
    assert!(runner::private_directory(&private).is_ok());
}
