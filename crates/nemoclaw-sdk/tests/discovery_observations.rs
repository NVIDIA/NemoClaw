// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    CancellationToken,
    config::ComputeDriver,
    discovery::{DiscoveryObservation, DiscoveryRequest, EngineObservation, ObservationStatus},
    discovery_session::{
        DiscoveryObservations, DiscoveryQuery, DiscoverySource, RecordedDiscovery, discover,
    },
    hardware_discovery::HardwareObservation,
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
    observations.engine(request).map(|engine| engine.status)
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
    assert!(observations.engine(&other).is_none());
    assert!(!observations.contains(&DiscoveryQuery::Engine(other)));
    assert!(
        observations
            .hardware("unix:///var/run/docker.sock")
            .is_none()
    );
}

#[test]
fn a_read_that_could_not_be_made_is_recorded_as_unknown_and_not_asked_again() {
    let failed = DiscoveryQuery::Hardware {
        engine: "ssh://gpu-box".into(),
    };
    let unasked = DiscoveryQuery::Engine(docker());
    let observations =
        DiscoveryObservations::new().with(failed.clone(), failed.unknown("engine unreachable"));
    let recorded = observations.hardware("ssh://gpu-box").unwrap();
    assert_eq!(recorded.status, ObservationStatus::Unknown);
    assert_eq!(recorded.reason.as_deref(), Some("engine unreachable"));
    assert_eq!(
        observations.missing(&[failed, unasked.clone(), unasked.clone()]),
        vec![unasked]
    );
}

#[test]
fn an_unknown_observation_matches_the_kind_of_its_query() {
    let observation = DiscoveryQuery::Engine(docker()).unknown("unreachable");
    assert!(matches!(
        observation,
        DiscoveryObservation::Engine(ref engine) if engine.status == ObservationStatus::Unknown
    ));
    let credential = DiscoveryQuery::Credential {
        reference: "KEY".into(),
    }
    .unknown("not resolved");
    assert!(matches!(
        credential,
        DiscoveryObservation::Credential(ref value) if value.reference == "KEY"
            && value.status == ObservationStatus::Unknown
    ));
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
fn observations_are_empty_until_something_is_recorded() {
    let query = DiscoveryQuery::Credential {
        reference: "KEY".into(),
    };
    assert!(DiscoveryObservations::new().is_empty());
    let recorded = DiscoveryObservations::new().with(query.clone(), query.unknown("unread"));
    assert!(!recorded.is_empty());
}

#[test]
fn observations_survive_a_round_trip_through_json() {
    let observations = DiscoveryObservations::new()
        .with(
            DiscoveryQuery::Engine(docker()),
            DiscoveryObservation::Engine(engine(ObservationStatus::Available)),
        )
        .with(
            DiscoveryQuery::Hardware {
                engine: "unix:///var/run/docker.sock".into(),
            },
            DiscoveryObservation::Hardware(HardwareObservation::unknown()),
        );
    let encoded = serde_json::to_string(&observations).unwrap();
    assert_eq!(
        serde_json::from_str::<DiscoveryObservations>(&encoded).unwrap(),
        observations
    );
}

#[tokio::test]
async fn a_recording_answers_what_it_holds_and_records_the_rest_as_unknown() {
    let known = DiscoveryQuery::Engine(docker());
    let unknown = DiscoveryQuery::Hardware {
        engine: "ssh://gpu-box".into(),
    };
    let mut source = RecordedDiscovery::new(DiscoveryObservations::new().with(
        known.clone(),
        DiscoveryObservation::Engine(engine(ObservationStatus::Available)),
    ));
    let observed = source
        .observe(&[known.clone(), unknown.clone()], &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        status_of(&observed, &docker()),
        Some(ObservationStatus::Available)
    );
    assert_eq!(
        observed
            .hardware("ssh://gpu-box")
            .map(|hardware| hardware.status),
        Some(ObservationStatus::Unknown)
    );
}

#[tokio::test]
async fn discovery_asks_for_dependent_reads_only_after_their_prerequisite() {
    let engine_query = DiscoveryQuery::Engine(docker());
    let fabric = DiscoveryQuery::Fabric {
        engine: docker().engine,
        image: "image@sha256:abc".into(),
    };
    let mut source = RecordedDiscovery::new(DiscoveryObservations::new().with(
        engine_query.clone(),
        DiscoveryObservation::Engine(engine(ObservationStatus::Available)),
    ));
    let mut observations = DiscoveryObservations::new();
    let mut asked: Vec<usize> = Vec::new();
    discover(
        &mut source,
        &mut observations,
        |observations| {
            let mut queries = vec![engine_query.clone()];
            if observations.engine(&docker()).is_some() {
                queries.push(fabric.clone());
            }
            asked.push(queries.len());
            queries
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(observations.contains(&fabric));
    assert_eq!(asked, vec![1, 2, 2]);
}

#[tokio::test]
async fn discovery_stops_when_the_queries_never_settle() {
    let mut source = RecordedDiscovery::new(DiscoveryObservations::new());
    let mut observations = DiscoveryObservations::new();
    let mut round = 0;
    let result = discover(
        &mut source,
        &mut observations,
        |_| {
            round += 1;
            vec![DiscoveryQuery::Credential {
                reference: format!("KEY_{round}"),
            }]
        },
        &CancellationToken::new(),
    )
    .await;
    assert!(result.is_err());
}
