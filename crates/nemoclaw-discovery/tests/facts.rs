// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]
use crate::transport;
use nemoclaw_discovery::{Direct, observe_engine, observe_fabric, observe_hardware};
use nemoclaw_sdk::{
    config::ComputeDriver, discovery::DiscoveryRequest, discovery::ObservationStatus,
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
        &Direct,
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
        &Direct,
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
    let image = observe_fabric(&Direct, &fixture.endpoint, "missing:image").await;
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
    let observed = observe_fabric(&Direct, &fixture.endpoint, "labeled:image").await;
    assert_eq!(observed.status, ObservationStatus::Available);
    assert_eq!(observed.catalog, Some(expected));
    assert_eq!(observed.image_id.as_deref(), Some("sha256:known"));
    let absent = observe_fabric(&Direct, &fixture.endpoint, "old:image").await;
    assert_eq!(absent.status, ObservationStatus::Unknown);
    assert!(absent.catalog.is_none());
}

#[tokio::test]
async fn image_platform_and_digest_survive_missing_adapter_metadata() {
    let fixture = transport::Fixture::start(|request| {
        assert_eq!(request.method, "GET");
        Some((200, serde_json::to_vec(&json!({"Id":"sha256:platform", "Architecture":"arm64", "Os":"linux", "RepoDigests":["registry/runtime@sha256:abc"], "Size":1234})).unwrap()))
    }).await;
    let observed = observe_fabric(&Direct, &fixture.endpoint, "runtime:test").await;
    let encoded = serde_json::to_value(observed).unwrap();
    assert_eq!(encoded["image"]["architecture"], "arm64");
    assert_eq!(
        encoded["image"]["repo_digests"][0],
        "registry/runtime@sha256:abc"
    );
    assert_eq!(encoded["status"], "unknown");
}

#[tokio::test]
async fn passive_inventory_uses_selected_engine_only_and_never_invents_gpu_measurements() {
    let fixture = transport::Fixture::start(|request| {
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/info");
        assert!(request.body.is_empty());
        Some((200, serde_json::to_vec(&json!({
            "ID":"remote-daemon", "Architecture":"s390x", "OSType":"linux", "MemTotal":16000000000_u64, "NCPU":7,
            "GenericResources":[{"NamedResourceSpec":{"Kind":"NVIDIA-GPU","Value":"GPU-remote"}}]
        })).unwrap()))
    }).await;
    let observed = observe_hardware(&Direct, &fixture.endpoint).await;
    assert_eq!(observed.status, ObservationStatus::Available);
    assert_eq!(observed.architecture.as_deref(), Some("s390x"));
    assert_eq!(observed.memory_bytes, Some(16000000000));
    assert_eq!(observed.cpus, Some(7));
    assert_eq!(observed.gpus.len(), 1);
    assert_eq!(observed.gpus[0].id.as_deref(), Some("GPU-remote"));
    assert!(observed.gpus[0].memory_total_bytes.is_none());
    assert!(observed.gpus[0].driver_major.is_none());
    assert!(observed.gpus[0].compute_capability.is_none());
    assert!(!observed.gpu_inventory_complete);
}

#[tokio::test]
async fn no_advertised_gpu_and_failed_target_are_unknown_not_zero_capacity() {
    let fixture = transport::Fixture::start(|request| {
        assert_eq!(request.path, "/info");
        Some((
            200,
            br#"{"ID":"remote-daemon","Architecture":"arm64"}"#.to_vec(),
        ))
    })
    .await;
    let observed = observe_hardware(&Direct, &fixture.endpoint).await;
    assert_eq!(observed.gpu_status, ObservationStatus::Unknown);
    assert!(observed.gpus.is_empty());
    assert!(!observed.gpu_inventory_complete);
    assert!(observed.memory_bytes.is_none());
    let missing = observe_hardware(&Direct, "unix:///missing-engine.sock").await;
    assert_eq!(missing.status, ObservationStatus::Unknown);
    assert!(missing.architecture.is_none());
    assert!(missing.memory_bytes.is_none());
}
