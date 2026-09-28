// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{CancellationToken, Deployment, config::Document};

#[tokio::test]
async fn invalid_programmatic_configuration_cannot_create_deployment_state() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let deployment = Deployment::new(&state, &directory.path().join("missing-bundle"));
    let document = Document::default();
    assert!(
        deployment
            .plan(&document, &CancellationToken::new())
            .await
            .is_err()
    );
    assert!(!state.exists());
}

#[tokio::test]
async fn component_requirement_refuses_plan_and_apply_before_state_access() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let deployment = Deployment::new(&state, &directory.path().join("missing-bundle"));
    let mut document =
        Document::parse(include_str!("fixtures/config/spark.yaml").as_bytes()).unwrap();
    document
        .spec
        .gateway
        .as_managed_mut()
        .unwrap()
        .external_component_ref = Some("policy-governance".into());
    for result in [
        deployment.plan(&document, &CancellationToken::new()).await,
        deployment.apply(&document, &CancellationToken::new()).await,
    ] {
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("external component"),
            "component requirement must fail before opening the bundle"
        );
        assert!(!state.exists());
    }
}
