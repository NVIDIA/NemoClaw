// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Deterministic protocol fixtures shared by SDK and bundle lifecycle tests.
pub mod openshell;
pub mod qualification;

#[cfg(unix)]
#[path = "../../test-support/docker.rs"]
pub mod docker;

/// Explicit, opt-in generation check for an owned live OpenClaw or Hermes deployment.
/// Reads its durable sandbox binding; does not run as part of apply.
pub async fn verify_agent(
    document: &nemoclaw_sdk::config::Document,
    directory: &std::path::Path,
) -> String {
    use nemoclaw_sdk::{
        backend::Row,
        openshell::{EnvironmentSecrets, OpenShell},
    };
    let state = qualification::StateSnapshot::read(&directory.join("terraform.tfstate")).unwrap();
    let binding: Row =
        serde_json::from_value(state.only("nemoclaw_sandbox").unwrap().clone()).unwrap();
    let client = OpenShell::connect(
        &document.spec.gateway,
        std::sync::Arc::new(EnvironmentSecrets),
    )
    .unwrap();
    client.inference_ready(&binding).await.unwrap();
    client.agent_response(&binding).await.unwrap()
}
