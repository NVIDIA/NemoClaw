// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    CancellationToken,
    config::ComputeDriver,
    discovery::{DiscoveryRequest, EngineObservation, ObservationStatus},
    facts::{Fact, FactQuery, FactSheet, FactSource, FixtureFacts, gather},
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

#[test]
fn facts_are_found_by_the_inputs_that_produced_them() {
    let sheet = FactSheet::new().with(
        FactQuery::Engine(docker()),
        Some(Fact::Engine(engine(ObservationStatus::Available))),
    );
    assert_eq!(
        sheet.engine(&docker()).map(|engine| engine.status),
        Some(ObservationStatus::Available)
    );
    let other = DiscoveryRequest {
        engine: "ssh://gpu-box".into(),
        ..docker()
    };
    assert!(sheet.engine(&other).is_none());
    assert!(!sheet.attempted(&FactQuery::Engine(other)));
    assert!(sheet.hardware("unix:///var/run/docker.sock").is_none());
}

#[test]
fn a_sheet_is_empty_until_something_is_attempted() {
    let query = FactQuery::Credential {
        reference: "KEY".into(),
    };
    assert!(FactSheet::new().is_empty());
    assert!(!FactSheet::new().with(query, None).is_empty());
}

#[test]
fn an_attempt_without_a_fact_is_not_asked_again() {
    let unobserved = FactQuery::Hardware {
        engine: "ssh://gpu-box".into(),
    };
    let unasked = FactQuery::Engine(docker());
    let sheet = FactSheet::new().with(unobserved.clone(), None);
    assert!(sheet.attempted(&unobserved));
    assert!(sheet.fact(&unobserved).is_none());
    assert_eq!(
        sheet.missing(&[unobserved, unasked.clone(), unasked.clone()]),
        vec![unasked]
    );
}

#[test]
fn recording_again_replaces_the_earlier_fact() {
    let query = FactQuery::Engine(docker());
    let mut sheet = FactSheet::new().with(
        query.clone(),
        Some(Fact::Engine(engine(ObservationStatus::Unknown))),
    );
    sheet.merge(FactSheet::new().with(
        query,
        Some(Fact::Engine(engine(ObservationStatus::Available))),
    ));
    assert_eq!(
        sheet.engine(&docker()).map(|engine| engine.status),
        Some(ObservationStatus::Available)
    );
}

#[test]
fn a_sheet_survives_a_round_trip_through_json() {
    let sheet = FactSheet::new()
        .with(
            FactQuery::Engine(docker()),
            Some(Fact::Engine(engine(ObservationStatus::Available))),
        )
        .with(
            FactQuery::Hardware {
                engine: "unix:///var/run/docker.sock".into(),
            },
            Some(Fact::Hardware(HardwareObservation::unknown())),
        )
        .with(
            FactQuery::Credential {
                reference: "KEY".into(),
            },
            None,
        );
    let encoded = serde_json::to_string(&sheet).unwrap();
    assert_eq!(serde_json::from_str::<FactSheet>(&encoded).unwrap(), sheet);
}

#[tokio::test]
async fn a_fixture_answers_what_it_knows_and_records_what_it_does_not() {
    let known = FactQuery::Engine(docker());
    let unknown = FactQuery::Hardware {
        engine: "ssh://gpu-box".into(),
    };
    let mut source = FixtureFacts::new(FactSheet::new().with(
        known.clone(),
        Some(Fact::Engine(engine(ObservationStatus::Available))),
    ));
    let observed = source
        .observe(&[known.clone(), unknown.clone()], &CancellationToken::new())
        .await
        .unwrap();
    assert!(observed.fact(&known).is_some());
    assert!(observed.attempted(&unknown));
    assert!(observed.fact(&unknown).is_none());
}

#[tokio::test]
async fn gathering_asks_for_dependent_facts_only_after_their_prerequisite() {
    let engine_query = FactQuery::Engine(docker());
    let fabric = FactQuery::Fabric {
        engine: docker().engine,
        image: "image@sha256:abc".into(),
    };
    let mut source = FixtureFacts::new(FactSheet::new().with(
        engine_query.clone(),
        Some(Fact::Engine(engine(ObservationStatus::Available))),
    ));
    let mut sheet = FactSheet::new();
    let mut asked: Vec<usize> = Vec::new();
    gather(
        &mut source,
        &mut sheet,
        |sheet| {
            let mut needs = vec![engine_query.clone()];
            if sheet.engine(&docker()).is_some() {
                needs.push(fabric.clone());
            }
            asked.push(needs.len());
            needs
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(sheet.attempted(&fabric));
    assert_eq!(asked, vec![1, 2, 2]);
}

#[tokio::test]
async fn gathering_stops_when_the_needs_never_settle() {
    let mut source = FixtureFacts::new(FactSheet::new());
    let mut sheet = FactSheet::new();
    let mut round = 0;
    let result = gather(
        &mut source,
        &mut sheet,
        |_| {
            round += 1;
            vec![FactQuery::Credential {
                reference: format!("KEY_{round}"),
            }]
        },
        &CancellationToken::new(),
    )
    .await;
    assert!(result.is_err());
}
