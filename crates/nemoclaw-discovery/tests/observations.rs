// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    config::ComputeDriver,
    discovery::{
        CredentialRequest, DiscoveryObservation, DiscoveryObservations, DiscoveryQuery,
        DiscoveryRequest, EngineObservation, HardwareRequest, ObservationStatus,
    },
    hardware_discovery::HardwareObservation,
    inference_discovery::CredentialObservation,
};

fn engine(status: ObservationStatus) -> EngineObservation {
    EngineObservation {
        status,
        reason: None,
        source: "fixture".into(),
        server_version: None,
        architecture: Some("aarch64".into()),
        operating_system: Some("linux".into()),
        memory_bytes: None,
        cpus: None,
    }
}

fn docker() -> DiscoveryRequest {
    DiscoveryRequest {
        engine: "unix:///var/run/docker.sock".into(),
        compute_driver: ComputeDriver::Docker,
    }
}

fn status_of(
    observations: &DiscoveryObservations,
    request: &DiscoveryRequest,
) -> Option<ObservationStatus> {
    observations.get(request).map(|engine| engine.status)
}

#[test]
fn observations_are_found_by_the_inputs_that_produced_them() {
    let observations = DiscoveryObservations::new().with(
        DiscoveryQuery::Engine(docker()),
        DiscoveryObservation::Engine(engine(ObservationStatus::Available)),
    );
    assert_eq!(
        status_of(&observations, &docker()),
        Some(ObservationStatus::Available)
    );
    let other = DiscoveryRequest {
        engine: "ssh://gpu-box".into(),
        ..docker()
    };
    assert!(observations.get(&other).is_none());
    assert!(!observations.contains(&DiscoveryQuery::Engine(other)));
    assert!(
        observations
            .get(&DiscoveryQuery::Hardware(HardwareRequest {
                engine: "unix:///var/run/docker.sock".into(),
            }))
            .is_none()
    );
}

#[test]
fn a_query_is_asked_even_when_its_recorded_answer_is_of_another_kind() {
    let observations = DiscoveryObservations::new().with(
        DiscoveryQuery::Engine(docker()),
        DiscoveryObservation::Hardware(HardwareObservation::unknown()),
    );
    assert!(observations.contains(&docker()));
    assert!(observations.get(&docker()).is_none());
}

#[test]
fn a_read_that_could_not_be_made_is_recorded_and_not_asked_again() {
    let failed = DiscoveryQuery::Hardware(HardwareRequest {
        engine: "ssh://gpu-box".into(),
    });
    let unasked = DiscoveryQuery::Engine(docker());
    let observations = DiscoveryObservations::new().with(
        failed.clone(),
        DiscoveryObservation::Hardware(HardwareObservation::unknown_because("engine unreachable")),
    );
    assert_eq!(
        observations.missing(&[failed, unasked.clone(), unasked.clone()]),
        vec![unasked]
    );
}

#[test]
fn recording_again_replaces_the_earlier_observation() {
    let query = DiscoveryQuery::Engine(docker());
    let mut observations = DiscoveryObservations::new().with(
        query.clone(),
        DiscoveryObservation::Engine(engine(ObservationStatus::Unknown)),
    );
    observations.merge(DiscoveryObservations::new().with(
        query,
        DiscoveryObservation::Engine(engine(ObservationStatus::Available)),
    ));
    assert_eq!(
        status_of(&observations, &docker()),
        Some(ObservationStatus::Available)
    );
}

#[test]
fn observations_survive_a_round_trip_through_json() {
    let observations = DiscoveryObservations::new()
        .with(
            DiscoveryQuery::Engine(docker()),
            DiscoveryObservation::Engine(engine(ObservationStatus::Available)),
        )
        .with(
            DiscoveryQuery::Hardware(HardwareRequest {
                engine: "unix:///var/run/docker.sock".into(),
            }),
            DiscoveryObservation::Hardware(HardwareObservation::unknown()),
        )
        .with(
            DiscoveryQuery::Credential(CredentialRequest {
                reference: "API_KEY".into(),
            }),
            DiscoveryObservation::Credential(CredentialObservation {
                reference: "API_KEY".into(),
                status: ObservationStatus::Available,
                reason: None,
            }),
        );
    assert!(!observations.is_empty());
    let encoded = serde_json::to_string(&observations).unwrap();
    assert_eq!(
        serde_json::from_str::<DiscoveryObservations>(&encoded).unwrap(),
        observations
    );
}
