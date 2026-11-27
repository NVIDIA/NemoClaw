// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]
use crate::transport;
use nemoclaw_discovery::{
    Direct, docker_desktop, observe_agent_images, observe_engine, observe_engine_facts,
    observe_fabric, observe_gateway_prerequisites, observe_hardware,
};
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

/// Engine facts never consult a compute driver: they read only `/info`.
#[tokio::test]
async fn engine_facts_read_only_engine_info() {
    let fixture = transport::Fixture::start(|request| {
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/info");
        Some((200, serde_json::to_vec(&json!({"ID":"remote-engine", "ServerVersion":"28.0", "Architecture":"arm64", "OSType":"linux"})).unwrap()))
    })
    .await;
    let observed = observe_engine_facts(&Direct, &fixture.endpoint).await;
    assert_eq!(observed.status, ObservationStatus::Available);
    assert_eq!(observed.architecture.as_deref(), Some("arm64"));
    assert_eq!(observed.operating_system.as_deref(), Some("linux"));
}

/// Docker Desktop names itself in `/info`'s `OperatingSystem`; any other
/// answer is another engine, and an engine that doesn't answer is unknown.
#[tokio::test]
async fn docker_desktop_is_recognized_from_engine_info() {
    for (operating_system, expected) in [("Docker Desktop", true), ("Ubuntu 24.04.3 LTS", false)] {
        let fixture = transport::Fixture::start(move |request| {
            assert_eq!(request.method, "GET");
            assert_eq!(request.path, "/info");
            Some((
                200,
                serde_json::to_vec(
                    &json!({"ID":"engine", "OSType":"linux", "OperatingSystem":operating_system}),
                )
                .unwrap(),
            ))
        })
        .await;
        assert_eq!(
            docker_desktop(&Direct, &fixture.endpoint).await,
            Some(expected),
            "{operating_system}"
        );
    }
    let fixture = transport::Fixture::start(|_| Some((500, b"{}".to_vec()))).await;
    assert_eq!(docker_desktop(&Direct, &fixture.endpoint).await, None);
}

/// A Podman gateway needs a Podman engine, and rootless Podman needs pasta
/// networking; either failure makes the engine unavailable for it.
#[tokio::test]
async fn gateway_prerequisites_reject_engines_a_gateway_cannot_use() {
    let podman = |rootless: bool, network: &'static str, components: &'static str| {
        transport::Fixture::start(move |request| {
            let path = request.path.split('?').next().unwrap().to_owned();
            let body = if path.ends_with("/libpod/info") {
                json!({"host":{"security":{"rootless":rootless},"rootlessNetworkCmd":network}})
            } else if path.ends_with("/version") {
                json!({"Version":"5.0", "ApiVersion":"1.41", "Components":[{"Name":components, "Version":"5.0"}]})
            } else if path.ends_with("/info") {
                json!({"ID":"engine"})
            } else {
                panic!("unexpected engine query {path}")
            };
            Some((200, serde_json::to_vec(&body).unwrap()))
        })
    };
    let request = |endpoint: &str, compute_driver| DiscoveryRequest {
        engine: endpoint.to_owned(),
        compute_driver,
    };
    let ready = podman(false, "", "Podman Engine").await;
    let observed =
        observe_gateway_prerequisites(&Direct, &request(&ready.endpoint, ComputeDriver::Podman))
            .await;
    assert_eq!(
        observed.status,
        ObservationStatus::Available,
        "{observed:?}"
    );
    assert_eq!(observed.reason, None);
    let docker = podman(false, "", "Engine").await;
    let observed =
        observe_gateway_prerequisites(&Direct, &request(&docker.endpoint, ComputeDriver::Podman))
            .await;
    assert_eq!(observed.status, ObservationStatus::Unavailable);
    assert_eq!(
        observed.reason.as_deref(),
        Some("Podman sandbox driver requires a Podman engine socket")
    );
    let slirp = podman(true, "slirp4netns", "Podman Engine").await;
    let observed =
        observe_gateway_prerequisites(&Direct, &request(&slirp.endpoint, ComputeDriver::Podman))
            .await;
    assert_eq!(observed.status, ObservationStatus::Unavailable);
    assert!(observed.reason.unwrap().contains("pasta networking"));
    // Docker has no driver-specific prerequisite beyond a reachable engine.
    let observed =
        observe_gateway_prerequisites(&Direct, &request(&docker.endpoint, ComputeDriver::Docker))
            .await;
    assert_eq!(observed.status, ObservationStatus::Available);
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

/// The images that install an adapter are those whose catalog label
/// installs its runtime and that the engine records by digest, newest first.
#[tokio::test]
async fn agent_images_install_the_adapter_and_have_a_digest_newest_first() {
    use nemoclaw_sdk::fabric_catalog::{FabricCatalog, IMAGE_CATALOG_LABEL};
    let installed = |adapter: &str| {
        let mut catalog = FabricCatalog::bundled().for_adapter(adapter);
        let mut runtime: serde_json::Value =
            serde_json::from_str(include_str!("../../../image/fabric/runtime.json")).unwrap();
        runtime["binaries"] = json!({adapter: ["/usr/local/bin/python3.99"]});
        catalog.runtime = Some(serde_json::from_value(runtime).unwrap());
        serde_json::to_string(&catalog).unwrap()
    };
    let image = |created: i64, digest: &str, catalog: String| {
        json!({"Id": "sha256:id", "ParentId": "", "RepoTags": ["hermes:local"], "RepoDigests": [digest],
               "Created": created, "Size": 1, "SharedSize": -1, "Containers": -1,
               "Labels": {IMAGE_CATALOG_LABEL: catalog, "org.opencontainers.image.revision": "abc123"}})
    };
    let older = format!("old@sha256:{}", "1".repeat(64));
    let newer = format!("new@sha256:{}", "2".repeat(64));
    let images = json!([
        image(1, &older, installed("nvidia.fabric.hermes")),
        image(2, &newer, installed("nvidia.fabric.hermes")),
        image(
            3,
            &format!("claw@sha256:{}", "3".repeat(64)),
            installed("nvidia.fabric.openclaw")
        ),
        // Docker's classic image store records a local build without a digest.
        image(4, "<none>@<none>", installed("nvidia.fabric.hermes")),
        // A catalog that installs no runtime.
        image(
            5,
            &format!("bare@sha256:{}", "4".repeat(64)),
            serde_json::to_string(&FabricCatalog::bundled()).unwrap()
        ),
    ]);
    let fixture = transport::Fixture::start(move |request| {
        assert!(request.path.starts_with("/images/json"), "{}", request.path);
        Some((200, serde_json::to_vec(&images).unwrap()))
    })
    .await;
    let observed = observe_agent_images(&Direct, &fixture.endpoint, "nvidia.fabric.hermes").await;
    assert_eq!(
        observed.status,
        ObservationStatus::Available,
        "{:?}",
        observed.reason
    );
    assert_eq!(observed.references, [newer.clone(), older]);
    let details = serde_json::to_value(&observed).unwrap();
    assert_eq!(details["details"][&newer]["tags"], json!(["hermes:local"]));
    assert_eq!(details["details"][&newer]["created"], 2);
    assert_eq!(details["details"][&newer]["revision"], "abc123");
}

#[tokio::test]
async fn matching_images_without_repository_digests_are_not_reported_as_missing_harnesses() {
    use nemoclaw_sdk::fabric_catalog::{FabricCatalog, IMAGE_CATALOG_LABEL};
    let mut catalog = FabricCatalog::bundled().for_adapter("nvidia.fabric.hermes");
    let mut runtime: serde_json::Value =
        serde_json::from_str(include_str!("../../../image/fabric/runtime.json")).unwrap();
    runtime["binaries"] = json!({"nvidia.fabric.hermes": ["/usr/local/bin/python3.99"]});
    catalog.runtime = Some(serde_json::from_value(runtime).unwrap());
    let images = json!([{
        "Id": "sha256:local", "ParentId": "", "RepoTags": ["hermes:local"], "RepoDigests": [],
        "Created": 1, "Size": 1, "SharedSize": -1, "Containers": -1,
        "Labels": {IMAGE_CATALOG_LABEL: serde_json::to_string(&catalog).unwrap()}
    }]);
    let fixture =
        transport::Fixture::start(move |_| Some((200, serde_json::to_vec(&images).unwrap()))).await;
    let observed = observe_agent_images(&Direct, &fixture.endpoint, "nvidia.fabric.hermes").await;
    assert_eq!(observed.status, ObservationStatus::Available);
    assert!(observed.references.is_empty());
    let reason = observed.reason.unwrap_or_default();
    assert!(reason.contains("repository digest"), "{reason}");
    assert!(reason.contains("containerd"), "{reason}");
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
