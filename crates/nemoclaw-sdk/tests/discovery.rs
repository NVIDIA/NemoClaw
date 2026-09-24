// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]
#[path = "../../test-support/docker.rs"]
mod transport;
use nemoclaw_sdk::{
    config::ComputeDriver,
    discovery::{DiscoveryRequest, ObservationStatus, observe_engine, observe_fabric},
    docker::Connections,
};
use serde_json::json;

#[tokio::test]
async fn discovery_reads_only_engine_info_and_preserves_target_hardware() {
    let fixture = transport::Fixture::start(|request| {
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/info");
        assert!(request.body.is_empty());
        Some((200, serde_json::to_vec(&json!({"ID":"remote-engine", "ServerVersion":"28.0", "Architecture":"arm64", "OSType":"linux", "MemTotal":16000000000_u64,"NCPU":8})).unwrap()))
    }).await;
    let observed = observe_engine(
        &Connections::default(),
        &DiscoveryRequest {
            engine: fixture.endpoint.clone(),
            compute_driver: ComputeDriver::Docker,
        },
    )
    .await;
    assert_eq!(observed.status, ObservationStatus::Available);
    assert_eq!(observed.architecture.as_deref(), Some("arm64"));
    assert_eq!(observed.memory_bytes, Some(16000000000));
}

#[tokio::test]
async fn transport_failure_is_unknown_and_absent_image_is_unavailable() {
    let fixture = transport::Fixture::start(|request| {
        assert_eq!(request.method, "GET");
        assert!(request.body.is_empty());
        if request.path == "/info" {
            Some((500, br#"{"message":"PRIVATE_SENTINEL"}"#.to_vec()))
        } else {
            Some((404, br#"{"message":"not found"}"#.to_vec()))
        }
    })
    .await;
    let observed = observe_engine(
        &Connections::default(),
        &DiscoveryRequest {
            engine: fixture.endpoint.clone(),
            compute_driver: ComputeDriver::Docker,
        },
    )
    .await;
    assert_eq!(observed.status, ObservationStatus::Unknown);
    assert!(
        !serde_json::to_string(&observed)
            .unwrap()
            .contains("PRIVATE_SENTINEL")
    );
    let image = observe_fabric(&Connections::default(), &fixture.endpoint, "missing:image").await;
    assert_eq!(image.status, ObservationStatus::Unavailable);
    assert!(image.catalog.is_none());
}

#[tokio::test]
async fn image_capabilities_come_from_selected_image_and_missing_metadata_stays_unknown() {
    use nemoclaw_sdk::fabric_catalog::{FabricCatalog, IMAGE_CATALOG_LABEL};
    let mut expected = FabricCatalog::bundled();
    expected.adapters.truncate(1);
    let expected_json = serde_json::to_string(&expected).unwrap();
    let fixture = transport::Fixture::start(move |request| {
        assert_eq!(request.method, "GET");
        assert!(request.body.is_empty());
        let body = if request.path.contains("labeled") {
            json!({"Id":"sha256:known", "Config":{"Labels":{IMAGE_CATALOG_LABEL:expected_json}}})
        } else {
            json!({"Id":"sha256:old", "Config":{"Labels":{}}})
        };
        Some((200, serde_json::to_vec(&body).unwrap()))
    })
    .await;
    let observed =
        observe_fabric(&Connections::default(), &fixture.endpoint, "labeled:image").await;
    assert_eq!(observed.status, ObservationStatus::Available);
    assert_eq!(observed.catalog, Some(expected));
    assert_eq!(observed.image_id.as_deref(), Some("sha256:known"));
    let absent = observe_fabric(&Connections::default(), &fixture.endpoint, "old:image").await;
    assert_eq!(absent.status, ObservationStatus::Unknown);
    assert!(absent.catalog.is_none());
}
