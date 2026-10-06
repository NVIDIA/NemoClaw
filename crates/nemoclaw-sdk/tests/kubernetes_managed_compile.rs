// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    compile::{compile, compile_runtime, runtime_targets},
    config::Document,
};
use serde_json::json;

fn document() -> Document {
    let original =
        Document::parse(include_bytes!("fixtures/config/local.yaml").as_slice()).unwrap();
    let mut value = serde_json::to_value(original).unwrap();
    value["spec"]["gateway"] = json!({
        "management": "managed", "endpoint": "https://127.0.0.1:17671",
        "kubernetes": {
            "kubeconfig": {"env":"TEST_KUBECONFIG"}, "context":"test-cluster", "namespace":"test-agents",
            "authentication":{"profile":"development"}
        }
    });
    value["spec"]["gateway"]["runtime"] = json!({"provider": "kubernetes"});
    value["spec"]["sandboxes"][0]["image"]["metadata"] = json!({"env":"TEST_IMAGE_METADATA"});
    Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap()
}

#[test]
fn managed_kubernetes_stages_owned_platform_before_authenticated_agents() {
    let document = document();
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "kubernetes_gateway",
        "kubernetes_storage",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    let platform = compile_runtime(&document, &generations, "0.1.0").unwrap();
    assert!(document.has_runtime());
    let targets = runtime_targets(&document, &generations).unwrap();
    assert_eq!(targets.len(), 2);
    assert!(
        targets
            .iter()
            .all(|target| target.kind.starts_with("kubernetes_"))
    );
    assert_eq!(platform["provider"]["nemoclaw"]["platform_only"], true);
    assert!(platform.get("data").is_none());
    assert!(
        platform["terraform"]["required_providers"]
            .get("docker")
            .is_none()
    );
    assert_eq!(
        platform["resource"]["nemoclaw_kubernetes_storage"]["runtime"]["lifecycle"]["prevent_destroy"],
        true
    );
    assert_eq!(
        platform["resource"]["nemoclaw_kubernetes_gateway"]["runtime"]["depends_on"],
        json!(["nemoclaw_kubernetes_storage.runtime"])
    );
    for kind in ["nemoclaw_kubernetes_storage", "nemoclaw_kubernetes_gateway"] {
        assert_eq!(
            platform["resource"][kind]["runtime"]["lifecycle"]["postcondition"][0]["condition"],
            "${self.running == \"true\"}"
        );
    }
    let spec: serde_json::Value = serde_json::from_str(
        platform["resource"]["nemoclaw_kubernetes_gateway"]["runtime"]["spec"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        spec["settings"]["kubernetes"]["kubeconfig"]["env"],
        "TEST_KUBECONFIG"
    );
    assert_eq!(spec["generation"], "a".repeat(32));
    let agents = compile(&document, &generations, "0.1.0").unwrap();
    assert_eq!(
        agents["provider"]["nemoclaw"]["credential_env"],
        "NEMOCLAW_MANAGED_K8S_TOKEN"
    );
    assert_eq!(
        agents["provider"]["nemoclaw"]["tls_ca_env"],
        "NEMOCLAW_MANAGED_K8S_CA"
    );
    assert_eq!(
        agents["provider"]["nemoclaw"]["tls_certificate_env"],
        "NEMOCLAW_MANAGED_K8S_CERT"
    );
    assert_eq!(
        agents["provider"]["nemoclaw"]["tls_key_env"],
        "NEMOCLAW_MANAGED_K8S_KEY"
    );
    assert!(
        agents["resource"]
            .get("nemoclaw_kubernetes_gateway")
            .is_none()
    );
    assert!(agents["provider"].get("docker").is_none());
}

#[test]
fn managed_kubernetes_discovery_never_uses_a_local_container_engine() {
    let document = document();
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "kubernetes_gateway",
        "kubernetes_storage",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    let agents = compile(&document, &generations, "0.1.0").unwrap();
    for data_source in ["nemoclaw_engine_capabilities", "nemoclaw_target_hardware"] {
        assert!(
            agents["data"].get(data_source).is_none(),
            "Kubernetes discovery must not contact the client engine: {data_source}"
        );
    }
    assert!(
        agents["data"]
            .get("nemoclaw_gateway_capabilities")
            .is_some()
    );
    assert!(
        agents["data"]
            .get("nemoclaw_inference_capabilities")
            .is_some()
    );
    let image = &agents["data"]["nemoclaw_fabric_capabilities"]["sandbox_0"];
    assert_eq!(image["engine"], "");
    assert_eq!(image["metadata_env"], "TEST_IMAGE_METADATA");
    assert!(image.get("architecture").is_none());
    let platform = compile_runtime(&document, &generations, "0.1.0").unwrap();
    assert!(platform.get("output").is_none());
}
