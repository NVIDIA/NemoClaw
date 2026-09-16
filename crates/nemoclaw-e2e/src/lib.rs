// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Deterministic protocol fixtures shared by SDK and bundle lifecycle tests.
pub mod openshell;
pub mod v0_export;

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
    let state: serde_json::Value =
        serde_json::from_slice(&std::fs::read(directory.join("terraform.tfstate")).unwrap())
            .unwrap();
    let sandboxes: Vec<_> = state["resources"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["type"] == "nemoclaw_sandbox")
        .collect();
    assert_eq!(sandboxes.len(), 1);
    let binding: Row =
        serde_json::from_value(sandboxes[0]["instances"][0]["attributes"].clone()).unwrap();
    let client = OpenShell::connect(
        &document.spec.gateway,
        std::sync::Arc::new(EnvironmentSecrets),
    )
    .unwrap();
    client.inference_ready(&binding).await.unwrap();
    client.agent_response(&binding).await.unwrap()
}
