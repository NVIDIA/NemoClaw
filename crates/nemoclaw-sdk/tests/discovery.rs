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

#[tokio::test]
async fn image_platform_and_digest_survive_missing_adapter_metadata() {
    let fixture = transport::Fixture::start(|request| {
        assert_eq!(request.method, "GET");
        Some((200, serde_json::to_vec(&json!({"Id":"sha256:platform", "Architecture":"arm64", "Os":"linux", "RepoDigests":["registry/runtime@sha256:abc"], "Size":1234})).unwrap()))
    }).await;
    let observed = observe_fabric(&Connections::default(), &fixture.endpoint, "runtime:test").await;
    let encoded = serde_json::to_value(observed).unwrap();
    assert_eq!(encoded["image"]["architecture"], "arm64");
    assert_eq!(
        encoded["image"]["repo_digests"][0],
        "registry/runtime@sha256:abc"
    );
    assert_eq!(encoded["status"], "unknown");
}

#[test]
fn compiled_discovery_includes_selected_endpoints_and_target_hardware() {
    let document = nemoclaw_sdk::config::Document::parse(
        include_str!("../../../examples/onboarding/openclaw.yaml").as_bytes(),
    )
    .unwrap();
    let graph = nemoclaw_sdk::compile::compile(
        &document,
        &nemoclaw_sdk::compile::Generations::from([
            (
                "workspace".into(),
                "11111111-1111-4111-8111-111111111111".into(),
            ),
            (
                "provider".into(),
                "11111111-1111-4111-8111-111111111111".into(),
            ),
            (
                "sandbox".into(),
                "11111111-1111-4111-8111-111111111111".into(),
            ),
        ]),
        "0.1.0",
    )
    .unwrap();
    assert!(graph["data"]["nemoclaw_inference_capabilities"].is_object());
    assert!(graph["data"]["nemoclaw_target_hardware"].is_object());
}

#[test]
fn external_gateway_discovery_never_substitutes_the_client_engine_for_a_service_target() {
    use nemoclaw_sdk::{
        config::{Document, ExternalGateway, Gateway},
        services::{
            ServiceDefinition,
            placement::{ServicePlacement, ServicePublication},
        },
    };
    let mut document =
        Document::parse(include_str!("fixtures/config/spark.yaml").as_bytes()).unwrap();
    document.spec.gateway = Gateway::External(ExternalGateway {
        endpoint: "http://127.0.0.1:17681".into(),
        ..Default::default()
    });
    let ServiceDefinition::Vllm(service) = document.spec.services.get_mut("qwen").unwrap() else {
        panic!("fixture service")
    };
    service.placement = Some(ServicePlacement {
        engine: "ssh://operator@192.168.1.50".into(),
        network_cidr: "172.30.111.0/24".into(),
    });
    service.publication = Some(ServicePublication {
        endpoint: "http://192.168.1.50:18888/v1".into(),
        bind_address: "192.168.1.50".into(),
    });
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    let graph = nemoclaw_sdk::compile::compile(&document, &generations, "0.1.0").unwrap();
    assert_eq!(
        graph["data"]["nemoclaw_target_hardware"]["target_0"]["engine"],
        "ssh://operator@192.168.1.50"
    );
    assert!(graph["data"].get("nemoclaw_engine_capabilities").is_none());
    assert!(graph["data"].get("nemoclaw_fabric_capabilities").is_none());
    assert_eq!(
        graph["data"]["nemoclaw_target_hardware"]
            .as_object()
            .unwrap()
            .len(),
        1
    );
}
