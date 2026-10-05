// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A read that could not be made is recorded as an unknown observation with
//! its reason, never as absence.
use nemoclaw_sdk::{
    discovery::{
        DiscoveryObservation, EngineObservation, FabricObservation, GatewayObservation,
        ObservationStatus,
    },
    hardware_discovery::HardwareObservation,
    inference_discovery::{CredentialObservation, EndpointObservation},
};

#[test]
fn every_observation_kind_can_be_unknown_with_a_reason() {
    let engine = EngineObservation::unknown("engine unreachable");
    assert_eq!(engine.status, ObservationStatus::Unknown);
    assert_eq!(engine.reason.as_deref(), Some("engine unreachable"));

    let fabric = FabricObservation::unknown("image unreadable");
    assert_eq!(fabric.status, ObservationStatus::Unknown);
    assert_eq!(fabric.reason.as_deref(), Some("image unreadable"));
    assert!(fabric.image_id.is_none() && fabric.catalog.is_none());

    let gateway = GatewayObservation::unknown("gateway unreachable");
    assert_eq!(gateway.status, ObservationStatus::Unknown);
    assert_eq!(gateway.reason.as_deref(), Some("gateway unreachable"));
    assert!(gateway.capabilities.is_none() && gateway.compatible.is_none());

    let endpoint = EndpointObservation::unknown("catalog unreadable");
    assert_eq!(endpoint.status, ObservationStatus::Unknown);
    assert_eq!(endpoint.reason.as_deref(), Some("catalog unreadable"));

    let hardware = HardwareObservation::unknown_because("engine unreachable");
    assert_eq!(hardware.status, ObservationStatus::Unknown);
    assert_eq!(hardware.reason.as_deref(), Some("engine unreachable"));
}

#[test]
fn a_credential_observation_travels_in_the_shared_enum() {
    let observation = DiscoveryObservation::Credential(CredentialObservation {
        reference: "API_KEY".into(),
        status: ObservationStatus::Available,
        reason: None,
    });
    let encoded = serde_json::to_string(&observation).unwrap();
    assert_eq!(
        serde_json::from_str::<DiscoveryObservation>(&encoded).unwrap(),
        observation
    );
}
