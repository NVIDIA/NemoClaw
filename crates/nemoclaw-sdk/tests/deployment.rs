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
async fn pi_model_mismatch_stops_plan_and_apply_before_creating_state() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let deployment = Deployment::new(&state, &directory.path().join("missing-bundle"));
    let mut document =
        Document::parse(include_str!("fixtures/config/fabric-pi.yaml").as_bytes()).unwrap();
    document.spec.sandboxes[0].agents[0].inference.routes[0]
        .overrides
        .model = "qwen3:4b".into();
    let cancel = CancellationToken::new();
    for result in [
        deployment.plan(&document, &cancel).await,
        deployment.apply(&document, &cancel).await,
    ] {
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("the pinned Pi recipe requires route model gpt-4o")
        );
        assert!(!state.exists());
    }
}
