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
