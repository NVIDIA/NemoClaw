// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
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
    assert_eq!(
        graph["data"]["nemoclaw_fabric_capabilities"]["sandbox_0"]["engine"],
        ""
    );
    assert!(graph["data"].get("nemoclaw_engine_capabilities").is_none());
    assert_eq!(
        graph["data"]["nemoclaw_target_hardware"]
            .as_object()
            .unwrap()
            .len(),
        1
    );
}
