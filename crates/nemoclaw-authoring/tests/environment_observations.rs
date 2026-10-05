// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Decisions that depend on the environment are tested by replaying recorded
//! observations, with no engine or hardware present. Each host is tried against
//! a template that names Docker and one that names Podman, so a suggestion that
//! ignored the host could not pass by agreeing with the template.
use nemoclaw_authoring::{Capabilities, JourneyDefinition, PartialDocument};
use nemoclaw_discovery::DiscoveryObservations;
use serde_json::{Value, json};

const RUNTIME: &str = "/spec/sandboxes/0/runtime/provider";

const DOCKER_ONLY: &str = include_str!("fixtures/observations/docker-only.json");
const PODMAN_ONLY: &str = include_str!("fixtures/observations/podman-only.json");
const BOTH_ENGINES: &str = include_str!("fixtures/observations/both-engines.json");
const NOTHING_RECORDED: &str = "[]";

/// The runtime the journey suggests for a template that names `template`, once
/// the environment queries have been answered as `recorded`.
async fn suggested_runtime(recorded: &str, template: &str) -> Option<Value> {
    let observations = serde_json::from_str::<DiscoveryObservations>(recorded).unwrap();
    let capabilities = Capabilities::available();
    let yaml =
        String::from_utf8(include_bytes!("../../../examples/onboarding/openclaw.yaml").to_vec())
            .unwrap();
    // The example names its runtime exactly once.
    let yaml = yaml.replace("provider: docker", &format!("provider: {template}"));
    let base = PartialDocument::from_yaml(yaml.as_bytes()).unwrap();
    let state = JourneyDefinition::new("runtime", base)
        .ask([RUNTIME])
        .start(&capabilities)
        .unwrap();
    state
        .resolve_with_observations(&capabilities, &observations)
        .unwrap()
        .question(RUNTIME)
        .unwrap()
        .suggestion()
        .cloned()
}

#[tokio::test]
async fn a_host_with_only_podman_overrides_a_docker_template() {
    assert_eq!(
        suggested_runtime(PODMAN_ONLY, "docker").await,
        Some(json!("podman"))
    );
}

#[tokio::test]
async fn a_host_with_only_docker_overrides_a_podman_template() {
    assert_eq!(
        suggested_runtime(DOCKER_ONLY, "podman").await,
        Some(json!("docker"))
    );
}

#[tokio::test]
async fn a_host_with_only_docker_confirms_a_docker_template() {
    assert_eq!(
        suggested_runtime(DOCKER_ONLY, "docker").await,
        Some(json!("docker"))
    );
}

#[tokio::test]
async fn a_host_with_only_podman_confirms_a_podman_template() {
    assert_eq!(
        suggested_runtime(PODMAN_ONLY, "podman").await,
        Some(json!("podman"))
    );
}

#[tokio::test]
async fn a_host_with_both_engines_keeps_a_docker_template() {
    assert_eq!(
        suggested_runtime(BOTH_ENGINES, "docker").await,
        Some(json!("docker"))
    );
}

#[tokio::test]
async fn a_host_with_both_engines_keeps_a_podman_template() {
    assert_eq!(
        suggested_runtime(BOTH_ENGINES, "podman").await,
        Some(json!("podman"))
    );
}

#[tokio::test]
async fn a_host_that_reported_nothing_keeps_a_docker_template() {
    assert_eq!(
        suggested_runtime(NOTHING_RECORDED, "docker").await,
        Some(json!("docker"))
    );
}

#[tokio::test]
async fn a_host_that_reported_nothing_keeps_a_podman_template() {
    assert_eq!(
        suggested_runtime(NOTHING_RECORDED, "podman").await,
        Some(json!("podman"))
    );
}
