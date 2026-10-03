// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Decisions that depend on the environment are tested by replaying a recorded
//! fact sheet, with no engine or hardware present.
use nemoclaw_authoring::{Capabilities, JourneyDefinition, PartialDocument, environment_needs};
use nemoclaw_sdk::{
    CancellationToken,
    facts::{FactSheet, FixtureFacts, gather},
};
use serde_json::{Value, json};

const RUNTIME: &str = "/spec/sandboxes/0/runtime/provider";

/// The runtime the journey suggests once `recorded` has been gathered.
async fn suggested_runtime(recorded: &str) -> Option<Value> {
    let mut source = FixtureFacts::new(serde_json::from_str::<FactSheet>(recorded).unwrap());
    let mut facts = FactSheet::new();
    gather(
        &mut source,
        &mut facts,
        |_| environment_needs(),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let state = JourneyDefinition::new("runtime", base)
        .ask([RUNTIME])
        .start(&capabilities)
        .unwrap();
    state
        .resolve_with_facts(&capabilities, &facts)
        .unwrap()
        .question(RUNTIME)
        .unwrap()
        .suggestion()
        .cloned()
}

#[tokio::test]
async fn a_host_with_only_podman_suggests_podman() {
    assert_eq!(
        suggested_runtime(include_str!("fixtures/facts/podman-only.json")).await,
        Some(json!("podman"))
    );
}

#[tokio::test]
async fn a_host_with_only_docker_suggests_docker() {
    assert_eq!(
        suggested_runtime(include_str!("fixtures/facts/docker-only.json")).await,
        Some(json!("docker"))
    );
}

#[tokio::test]
async fn a_host_with_both_engines_keeps_the_template_runtime() {
    assert_eq!(
        suggested_runtime(include_str!("fixtures/facts/both-engines.json")).await,
        Some(json!("docker"))
    );
}

#[tokio::test]
async fn a_host_that_reported_nothing_keeps_the_template_runtime() {
    assert_eq!(suggested_runtime("[]").await, Some(json!("docker")));
}
