// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Decisions that depend on the environment are tested by replaying observations,
//! with no engine or hardware present. Each host is tried against a template that
//! names Docker and one that names Podman, so a suggestion that ignored the host
//! could not pass by agreeing with the template.
use nemoclaw_authoring::{Capabilities, JourneyDefinition, PartialDocument};
use nemoclaw_discovery::DiscoveryObservations;
use nemoclaw_sdk::{
    config::ComputeDriver,
    discovery::{
        DiscoveryObservation, DiscoveryQuery, DiscoveryRequest, EngineObservation,
        ObservationStatus,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};

/// A host as onboarding found it: the engines its environment named, and what
/// each said when asked. The recorded fixture replays this shape from JSON.
#[derive(Deserialize)]
struct RecordedHost {
    candidates: Vec<DiscoveryRequest>,
    observations: DiscoveryObservations,
}

const RUNTIME: &str = "/spec/gateway/runtime/provider";

const PODMAN_ONLY: &str = include_str!("fixtures/observations/podman-only.json");

/// A host whose Docker and Podman engines answered as given.
fn host(docker: ObservationStatus, podman: ObservationStatus) -> RecordedHost {
    let mut candidates = Vec::new();
    let mut observations = DiscoveryObservations::new();
    for (engine, compute_driver, status) in [
        ("unix:///var/run/docker.sock", ComputeDriver::Docker, docker),
        (
            "unix:///run/user/1000/podman/podman.sock",
            ComputeDriver::Podman,
            podman,
        ),
    ] {
        let request = DiscoveryRequest {
            engine: engine.into(),
            compute_driver,
        };
        observations.record(
            DiscoveryQuery::Engine(request.clone()),
            DiscoveryObservation::Engine(EngineObservation {
                status,
                reason: None,
                source: "fixture".into(),
                server_version: None,
                architecture: None,
                operating_system: None,
                memory_bytes: None,
                cpus: None,
            }),
        );
        candidates.push(request);
    }
    RecordedHost {
        candidates,
        observations,
    }
}

/// The runtime the journey suggests for a template that names `template`, once
/// the environment queries have been answered by `host`.
fn suggested_runtime(host: &RecordedHost, template: &str) -> Option<Value> {
    let capabilities = Capabilities::available();
    let yaml =
        String::from_utf8(include_bytes!("../../../examples/onboarding/openclaw.yaml").to_vec())
            .unwrap();
    // The example names its runtime exactly once.
    let yaml = yaml.replace("provider: docker", &format!("provider: {template}"));
    let base = PartialDocument::from_yaml(yaml.as_bytes()).unwrap();
    let mut state = JourneyDefinition::new("runtime", base)
        .ask([RUNTIME])
        .start(&capabilities)
        .unwrap();
    state.use_local_engines(&host.candidates, &host.observations);
    state
        .resolve_with_observations(&capabilities, &host.observations)
        .unwrap()
        .question(RUNTIME)
        .unwrap()
        .suggestion()
        .cloned()
}

#[test]
fn the_suggested_runtime_is_the_only_engine_that_answered_else_the_templates() {
    use ObservationStatus::{Available, Unavailable};
    // (host, docker's answer, podman's answer, template, expected suggestion)
    let rows = [
        ("docker only", Available, Unavailable, "docker", "docker"),
        ("docker only", Available, Unavailable, "podman", "docker"),
        ("podman only", Unavailable, Available, "docker", "podman"),
        ("podman only", Unavailable, Available, "podman", "podman"),
        ("both engines", Available, Available, "docker", "docker"),
        ("both engines", Available, Available, "podman", "podman"),
        ("no engine", Unavailable, Unavailable, "docker", "docker"),
        ("no engine", Unavailable, Unavailable, "podman", "podman"),
    ];
    for (name, docker, podman, template, expected) in rows {
        assert_eq!(
            suggested_runtime(&host(docker, podman), template),
            Some(json!(expected)),
            "{name} with a {template} template"
        );
    }
}

#[test]
fn a_recorded_host_with_only_podman_overrides_a_docker_template() {
    let recorded = serde_json::from_str::<RecordedHost>(PODMAN_ONLY).unwrap();
    assert_eq!(
        suggested_runtime(&recorded, "docker"),
        Some(json!("podman"))
    );
}

#[test]
fn a_host_that_named_no_engines_keeps_the_templates_runtime() {
    let nothing = RecordedHost {
        candidates: Vec::new(),
        observations: DiscoveryObservations::new(),
    };
    for template in ["docker", "podman"] {
        assert_eq!(
            suggested_runtime(&nothing, template),
            Some(json!(template)),
            "{template} template"
        );
    }
}
