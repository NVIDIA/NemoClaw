// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "linux")]

use crate::service_images::support::{
    Scenario, assert_apply_unchanged, with_upstream_model_digest,
};
use nemoclaw_sdk::{CancellationToken, Deployment};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires explicit bundle, agent image/profile and proxy image; creates owned Docker resources"]
// E04-S01
async fn existing_ollama_is_verified_reused_and_retained() {
    let scenario = Scenario::start().await;
    let document = scenario.proxy_document(1).await;
    let deployment = Deployment::new(scenario.state.path(), &scenario.bundle);
    let cancel = CancellationToken::new();

    // A pre-existing model is identified by its digest, not just its name.
    let wrong = with_upstream_model_digest(&document, &"b".repeat(64));
    let error = deployment.apply(&wrong, &cancel).await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("external Ollama model digest changed"),
        "{error}"
    );
    scenario.assert_no_resources();
    scenario.assert_external_server_alive().await;

    deployment.apply(&document, &cancel).await.unwrap();
    scenario.assert_agent_service_access("assistant-0");
    scenario.assert_agent_responds("assistant-0");
    let agent = scenario.agent_identity("assistant-0");
    let service = scenario.service_identity(&document);
    let exported = scenario.export();
    assert_eq!(exported, document);
    let reopened = Deployment::new(scenario.state.path(), &scenario.bundle);
    assert_apply_unchanged(&reopened, &exported, &cancel).await;
    assert_eq!(scenario.agent_identity("assistant-0"), agent);
    assert_eq!(scenario.service_identity(&document), service);
    scenario.assert_agent_service_access("assistant-0");
    scenario.assert_agent_responds("assistant-0");

    scenario.destroy();
    scenario.assert_agent_absent("assistant-0");
    scenario.assert_service_destroyed_with_credentials_retained(&document);
    scenario.assert_external_server_alive().await;
}
