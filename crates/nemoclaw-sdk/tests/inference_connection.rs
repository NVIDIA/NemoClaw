// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::{Document, SecretRef};

#[test]
fn missing_inference_provider_does_not_panic() {
    let mut document =
        Document::parse(include_str!("fixtures/config/local.yaml").as_bytes()).unwrap();
    document.spec.inference_providers.clear();
    assert!(document.inference_connection().is_err());
    assert!(document.inference_endpoint().is_err());
}

#[test]
fn bridge_resolution_rejects_malformed_networks_and_overflow() {
    let mut gateway = nemoclaw_sdk::config::ManagedGateway {
        target: nemoclaw_sdk::config::ManagedTarget::Docker(nemoclaw_sdk::config::LocalTarget {
            network_cidr: "10.0.0.0/24".into(),
            ..Default::default()
        }),
        ..Default::default()
    };
    assert_eq!(gateway.bridge().unwrap(), "10.0.0.1");
    for network in ["invalid", "::/64", "255.255.255.255/32"] {
        gateway.target.local_mut().unwrap().network_cidr = network.into();
        assert!(gateway.bridge().is_err(), "{network}");
    }
}

/// The host address and endpoint of the spark fixture's managed vLLM service,
/// with or without a Docker Desktop engine.
fn managed_publication(docker_desktop: bool) -> (Vec<String>, String) {
    let mut document =
        Document::parse(include_str!("fixtures/config/spark.yaml").as_bytes()).unwrap();
    let nemoclaw_sdk::config::Gateway::Managed(gateway) = &mut document.spec.gateway else {
        panic!("expected a managed gateway");
    };
    gateway.target.local_mut().unwrap().docker_desktop = docker_desktop;
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
    let published = graph["resource"]["docker_container"]
        .as_object()
        .unwrap()
        .values()
        .flat_map(|container| container["ports"].as_array().cloned().unwrap_or_default())
        .filter(|port| port["internal"] == 18888)
        .map(|port| port["ip"].as_str().unwrap().to_owned())
        .collect();
    (published, document.inference_endpoint().unwrap())
}

#[test]
fn managed_model_on_docker_desktop_publishes_on_loopback_and_sandboxes_use_the_host_alias() {
    // Docker Desktop also opens each published port on macOS or Windows,
    // which have no address on the engine's bridges (#14903).
    assert_eq!(
        managed_publication(true),
        (
            vec!["127.0.0.1".to_owned()],
            "http://host.openshell.internal:18888/v1".to_owned()
        )
    );
    assert_eq!(
        managed_publication(false),
        (
            vec!["172.30.110.1".to_owned()],
            "http://172.30.110.1:18888/v1".to_owned()
        )
    );
}

#[test]
fn inference_connection_is_resolved_independently_of_the_sandbox_engine() {
    let local = Document::parse(include_str!("fixtures/config/spark.yaml").as_bytes()).unwrap();
    let published = local.inference_connection().unwrap();
    assert_eq!(published.endpoint, local.inference_endpoint().unwrap());
    assert!(published.credential.is_none());
    let mut remote =
        Document::parse(include_str!("fixtures/config/local.yaml").as_bytes()).unwrap();
    let provider = remote.spec.inference_providers.get_mut("local").unwrap();
    provider.endpoint = "https://inference.example.test:9443/v1".into();
    provider.credential = Some(SecretRef {
        env: "MODEL_TOKEN".into(),
    });
    let first = remote.inference_connection().unwrap();
    let nemoclaw_sdk::config::Gateway::External(gateway) = &mut remote.spec.gateway else {
        panic!("expected an external gateway");
    };
    gateway.target = nemoclaw_sdk::config::ExternalTarget::Podman(Default::default());
    remote.validate().unwrap();
    assert_eq!(remote.inference_connection().unwrap(), first);
    assert_eq!(first.endpoint, "https://inference.example.test:9443/v1");
    assert_eq!(first.credential.unwrap().env, "MODEL_TOKEN");
    // Resolution is pure: this address need not be reachable by the CLI host.
    remote
        .spec
        .inference_providers
        .get_mut("local")
        .unwrap()
        .endpoint = "https://unreachable.invalid/v1".into();
    remote.validate().unwrap();
    assert_eq!(
        remote.inference_connection().unwrap().endpoint,
        "https://unreachable.invalid/v1"
    );
}
