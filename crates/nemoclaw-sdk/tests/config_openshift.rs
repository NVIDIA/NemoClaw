// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    compile::{compile, compile_runtime, runtime_targets},
    config::{ComputeDriver, Document, schema},
};
use serde_json::{Value, json};

fn input(managed: bool) -> Value {
    let original =
        Document::parse(include_bytes!("fixtures/config/local.yaml").as_slice()).unwrap();
    let mut input = serde_json::to_value(original).unwrap();
    input["spec"]["gateway"]["runtime"] = json!({"provider": "openshift"});
    input["spec"]["sandboxes"][0]["image"]["metadata"] = json!({"env":"TEST_IMAGE_METADATA"});
    if managed {
        input["spec"]["gateway"] = json!({
            "management": "managed", "runtime": {"provider": "openshift"}, "endpoint": "https://127.0.0.1:17671",
            "kubernetes": {
                "kubeconfig":{"env":"TEST_OPENSHIFT_CONFIG"},
                "context":"explicit-openshift", "namespace":"owned-agents",
                "authentication":{"profile":"development"}
            }
        });
    }
    input
}

#[test]
fn openshift_preserves_authored_profile_and_uses_the_upstream_kubernetes_driver() {
    assert_eq!(
        ComputeDriver::OpenShift.openshell_driver(),
        ComputeDriver::Kubernetes
    );
    assert!(ComputeDriver::OpenShift.is_kubernetes());
    assert!(!ComputeDriver::Docker.is_kubernetes());
    for managed in [false, true] {
        let input = input(managed);
        assert!(jsonschema::is_valid(&schema::input_schema(), &input));
        let document = Document::parse(input.to_string().as_bytes()).unwrap();
        assert_eq!(
            document.spec.gateway.runtime().provider,
            ComputeDriver::OpenShift
        );
        let exported = document.yaml().unwrap();
        let imported = Document::parse(exported.as_bytes()).unwrap();
        assert_eq!(imported, document);
        assert_eq!(imported.digest(), document.digest());
        assert_eq!(serde_json::to_value(imported).unwrap(), input);
        if managed {
            assert!(document.spec.gateway.as_kubernetes().is_some());
            assert!(document.spec.gateway.as_local_managed().is_none());
        }
    }
}

#[test]
fn the_runtime_alone_selects_openshift() {
    let schema = schema::input_schema();
    // The Kubernetes target has no separate platform field to disagree with.
    let mut value = input(true);
    value["spec"]["gateway"]["kubernetes"]["distribution"] = json!("openshift");
    assert!(!jsonschema::is_valid(&schema, &value));
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
    // A managed cluster target accepts only the two cluster runtimes.
    for provider in ["docker", "podman"] {
        let mut value = input(true);
        value["spec"]["gateway"]["runtime"]["provider"] = json!(provider);
        assert!(!jsonschema::is_valid(&schema, &value), "{provider}");
        assert!(
            Document::parse(value.to_string().as_bytes()).is_err(),
            "{provider}"
        );
    }
}

#[test]
fn openshift_never_defaults_an_image_or_uses_a_local_managed_gateway() {
    for managed in [false, true] {
        let mut value = input(managed);
        value["spec"]["sandboxes"][0]
            .as_object_mut()
            .unwrap()
            .remove("image");
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
        let mut document = Document::parse(input(managed).to_string().as_bytes()).unwrap();
        document.spec.sandboxes[0].image = Default::default();
        document.defaults();
        assert!(document.spec.sandboxes[0].image.ref_.is_empty());
        assert!(document.validate().is_err());
    }
    let mut value = input(false);
    value["spec"]["gateway"] = json!({"management":"managed"});
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
}

#[test]
fn openshift_compiles_platform_identity_and_wire_driver_without_docker() {
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "kubernetes_gateway",
        "kubernetes_storage",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    for managed in [false, true] {
        let document = Document::parse(input(managed).to_string().as_bytes()).unwrap();
        let graph = compile(&document, &generations, "0.1.0").unwrap();
        assert!(graph["provider"].get("docker").is_none());
        for phase in ["current", "apply"] {
            assert_eq!(
                graph["data"]["openshell_gateway"][phase]["required_compute_drivers"],
                json!(["kubernetes"])
            );
        }
        assert!(graph["data"].get("nemoclaw_engine_capabilities").is_none());
        assert!(graph["data"].get("nemoclaw_target_hardware").is_none());
        let targets = runtime_targets(&document, &generations).unwrap();
        if managed {
            assert_eq!(targets.len(), 4);
            for target in targets
                .iter()
                .filter(|target| target.kind != "helm_release")
            {
                assert_eq!(target.values["compute_driver"], "openshift");
            }
            let platform = compile_runtime(&document, &generations, "0.1.0").unwrap();
            // The platform stage has no gateway, so it omits the gateway providers.
            assert_eq!(platform["provider"]["nemoclaw"], json!({}));
            for provider in ["openshell", "fabric"] {
                assert!(platform["provider"].get(provider).is_none(), "{provider}");
                assert!(
                    platform["terraform"]["required_providers"]
                        .get(provider)
                        .is_none(),
                    "{provider}"
                );
            }
            assert!(platform.get("data").is_none());
            assert_eq!(
                platform["resource"]["nemoclaw_kubernetes_storage"]["runtime"]["lifecycle"]["prevent_destroy"],
                true
            );
        } else {
            assert!(targets.is_empty());
        }
    }
}
