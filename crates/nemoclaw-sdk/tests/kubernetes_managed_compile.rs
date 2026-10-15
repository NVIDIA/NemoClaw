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
fn managed_gateway_uses_a_pinned_helm_provider_between_auth_and_readiness() {
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "kubernetes_gateway",
        "kubernetes_storage",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    let graph = compile_runtime(&document(), &generations, "0.1.0").unwrap();
    assert_eq!(
        graph["terraform"]["required_providers"]["helm"]["source"],
        "registry.opentofu.org/hashicorp/helm"
    );
    assert_eq!(
        graph["terraform"]["required_providers"]["helm"]["version"],
        "= 3.3.0"
    );
    assert_eq!(
        graph["provider"]["helm"]["kubernetes"]["config_path"],
        "${var.nemoclaw_kubeconfig}"
    );
    assert_eq!(
        graph["provider"]["helm"]["kubernetes"]["config_context"],
        "test-cluster"
    );
    assert!(
        graph["variable"]["nemoclaw_kubeconfig"]
            .get("default")
            .is_none()
    );
    let release = &graph["resource"]["helm_release"]["gateway"];
    assert_eq!(release["chart"], nemoclaw_sdk::kubernetes::gateway::CHART);
    assert_eq!(release["namespace"], "test-agents");
    assert_eq!(release["create_namespace"], false);
    assert_eq!(release["take_ownership"], false);
    assert_eq!(release["upgrade_install"], false);
    assert_eq!(release["wait"], true);
    assert_eq!(release["wait_for_jobs"], true);
    assert_eq!(
        graph["resource"]["openshell_kubernetes_auth"]["runtime"]["depends_on"],
        json!(["openshell_kubernetes_storage.runtime"])
    );
    assert_eq!(
        release["depends_on"],
        json!(["openshell_kubernetes_auth.runtime"])
    );
    assert_eq!(
        graph["resource"]["openshell_kubernetes_gateway"]["runtime"]["depends_on"],
        json!(["helm_release.gateway"])
    );
    assert_eq!(
        graph["resource"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [
            "helm_release",
            "openshell_kubernetes_auth",
            "openshell_kubernetes_gateway",
            "openshell_kubernetes_storage",
        ],
        "one native release owns chart resources; prerequisites and readiness stay separate"
    );
    let targets = runtime_targets(&document(), &generations).unwrap();
    assert!(
        targets
            .iter()
            .any(|target| target.address == "helm_release.gateway")
    );
}

#[test]
fn openshift_chart_values_wait_for_the_observed_namespace_identity() {
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "kubernetes_gateway",
        "kubernetes_storage",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    let kubernetes = compile_runtime(&document(), &generations, "0.1.0").unwrap();
    assert_eq!(
        kubernetes["resource"]["helm_release"]["gateway"]["values"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let mut value = serde_json::to_value(document()).unwrap();
    value["spec"]["gateway"]["runtime"]["provider"] = json!("openshift");
    let document = Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap();
    let openshift = compile_runtime(&document, &generations, "0.1.0").unwrap();
    let values = &openshift["resource"]["helm_release"]["gateway"]["values"];
    assert_eq!(values.as_array().unwrap().len(), 2);
    assert_eq!(
        values[1],
        "${openshell_kubernetes_auth.runtime.gateway_values}"
    );
    assert_eq!(
        values[0],
        kubernetes["resource"]["helm_release"]["gateway"]["values"][0]
    );
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
    assert_eq!(targets.len(), 4);
    assert!(
        targets
            .iter()
            .all(|target| target.kind.starts_with("kubernetes_") || target.kind == "helm_release")
    );
    // The platform stage installs the gateway: openshell serves the Kubernetes
    // gateway types; fabric needs a running gateway, so the stage omits it.
    assert_eq!(platform["provider"]["openshell"], json!({}));
    assert!(platform["provider"].get("fabric").is_none());
    assert!(
        platform["terraform"]["required_providers"]
            .get("fabric")
            .is_none()
    );
    assert!(platform.get("data").is_none());
    assert!(
        platform["terraform"]["required_providers"]
            .get("docker")
            .is_none()
    );
    assert_eq!(
        platform["resource"]["openshell_kubernetes_storage"]["runtime"]["lifecycle"]["prevent_destroy"],
        true
    );
    assert_eq!(
        platform["resource"]["openshell_kubernetes_gateway"]["runtime"]["depends_on"],
        json!(["helm_release.gateway"])
    );
    for kind in [
        "openshell_kubernetes_storage",
        "openshell_kubernetes_auth",
        "openshell_kubernetes_gateway",
    ] {
        assert_eq!(
            platform["resource"][kind]["runtime"]["lifecycle"]["postcondition"][0]["condition"],
            "${self.running == \"true\"}"
        );
    }
    // Every platform resource takes the cluster target as typed attributes.
    for kind in [
        "openshell_kubernetes_storage",
        "openshell_kubernetes_auth",
        "openshell_kubernetes_gateway",
    ] {
        let resource = &platform["resource"][kind]["runtime"];
        assert!(resource.get("spec").is_none(), "{kind}");
        assert_eq!(resource["kubeconfig_env"], "TEST_KUBECONFIG", "{kind}");
        assert_eq!(resource["context"], "test-cluster", "{kind}");
        assert_eq!(resource["namespace"], "test-agents", "{kind}");
        assert_eq!(resource["compute_driver"], "kubernetes", "{kind}");
        assert_eq!(resource["endpoint"], "https://127.0.0.1:17671", "{kind}");
        assert_eq!(resource["authentication_profile"], "development", "{kind}");
        assert_eq!(resource["generation"], "a".repeat(32), "{kind}");
        assert!(resource.get("environment").is_none(), "{kind}");
    }
    let agents = compile(&document, &generations, "0.1.0").unwrap();
    // The gateway data source, whose ref every object takes, carries the
    // managed gateway's specification. Providers connect to the gateway with
    // it, so no connection variables are named.
    let gateway = &agents["data"]["openshell_gateway"]["current"];
    for field in [
        "credential_env",
        "tls_ca_env",
        "tls_certificate_env",
        "tls_key_env",
    ] {
        assert!(gateway.get(field).is_none(), "{field}");
    }
    let spec: nemoclaw_sdk::kubernetes::Spec =
        serde_json::from_str(gateway["kubernetes"].as_str().unwrap()).unwrap();
    assert_eq!(
        Some(spec),
        nemoclaw_sdk::kubernetes::gateway_spec(&document, &generations).unwrap()
    );
    for provider in ["openshell", "fabric"] {
        assert_eq!(agents["provider"][provider], json!({}), "{provider}");
    }
    // One graph installs the gateway and creates the objects it serves; the
    // gateway read waits for the installation.
    assert_eq!(
        gateway["depends_on"],
        json!(["openshell_kubernetes_gateway.runtime"])
    );
    assert!(
        agents["data"]["openshell_gateway"]["apply"]["depends_on"]
            .as_array()
            .unwrap()
            .contains(&json!("openshell_kubernetes_gateway.runtime"))
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
    assert!(
        agents["data"].get("host_engine").is_none(),
        "Kubernetes discovery must not contact the client engine"
    );
    assert!(agents["data"].get("openshell_gateway").is_some());
    // The SDK reads model catalogs itself, outside the graph.
    assert!(
        agents["data"]
            .get("nemoclaw_inference_capabilities")
            .is_none()
    );
    let image = &agents["data"]["fabric_harnesses"]["sandbox_0"];
    assert_eq!(image["engine"], "");
    assert_eq!(image["metadata_env"], "TEST_IMAGE_METADATA");
    assert!(image.get("architecture").is_none());
    let platform = compile_runtime(&document, &generations, "0.1.0").unwrap();
    assert!(platform.get("output").is_none());
}

#[test]
fn kubernetes_attributes_reproduce_each_resource_specification() {
    use nemoclaw_sdk::kubernetes::{AUTH_KIND, GATEWAY_KIND, STORAGE_KIND, Spec};
    let mut value = serde_json::to_value(document()).unwrap();
    value["spec"]["gateway"]["kubernetes"]["environment"] = json!(["AWS_PROFILE"]);
    value["spec"]["gateway"]["runtime"]["provider"] = json!("openshift");
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "kubernetes_gateway",
        "kubernetes_storage",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    for document in [
        document(),
        Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap(),
    ] {
        for target in runtime_targets(&document, &generations)
            .unwrap()
            .into_iter()
            .filter(|target| target.kind.starts_with("kubernetes_"))
        {
            let spec = Spec::from_row(&target.kind, &target.values).unwrap();
            assert_eq!(spec.row().unwrap(), target.values);
            assert_eq!(spec.kind, target.kind);
            let kubernetes = spec.settings.kubernetes.as_ref().unwrap();
            assert_eq!(kubernetes.context, "test-cluster");
            assert_eq!(
                document
                    .spec
                    .gateway
                    .as_managed()
                    .unwrap()
                    .kubernetes
                    .as_ref(),
                Some(kubernetes)
            );
            assert!(matches!(
                target.kind.as_str(),
                STORAGE_KIND | AUTH_KIND | GATEWAY_KIND
            ));
            for (attribute, invalid) in [
                ("compute_driver", "docker"),
                ("namespace", "Not A Namespace"),
                ("kubeconfig_env", "lowercase"),
                ("endpoint", "http://127.0.0.1:17671"),
                ("authentication_profile", "production"),
                ("environment_json", "[\"KUBECONFIG\"]"),
            ] {
                let mut row = target.values.clone();
                row.insert(attribute.into(), invalid.into());
                assert!(Spec::from_row(&target.kind, &row).is_err(), "{attribute}");
            }
            assert!(Spec::from_row("managed_gateway", &target.values).is_err());
        }
    }
}
