// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{docker::Engine, managed::Spec};

#[tokio::test]
#[ignore = "requires explicit NEMOCLAW_TEST_RUNTIME_STATE; reads existing owned runtimes only"]
async fn existing_spark_runtime_bindings_are_observed_without_mutations() {
    let path = std::path::PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_RUNTIME_STATE").expect("explicit state file"),
    );
    assert!(path.is_absolute());
    let bytes = std::fs::read(&path).unwrap();
    let state: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let mut observed = 0;
    for resource in state["resources"].as_array().unwrap() {
        if !matches!(
            resource["type"].as_str(),
            Some("nemoclaw_managed_gateway" | "docker_container")
        ) {
            continue;
        }
        let instances = resource["instances"].as_array().unwrap();
        assert_eq!(instances.len(), 1);
        let attributes = &instances[0]["attributes"];
        let id = attributes["id"].as_str().unwrap();
        if resource["type"] == "docker_container" {
            let gateway = resource["name"] == "managed_gateway_runtime";
            let storage = state["resources"]
                .as_array()
                .unwrap()
                .iter()
                .find(|resource| {
                    resource["type"]
                        == if gateway {
                            "nemoclaw_gateway_storage"
                        } else {
                            "nemoclaw_inference_storage"
                        }
                })
                .unwrap();
            let encoded = storage["instances"][0]["attributes"]["spec"]
                .as_str()
                .unwrap();
            let endpoint = if gateway {
                serde_json::from_str::<Spec>(encoded)
                    .unwrap()
                    .gateway
                    .engine
            } else {
                serde_json::from_str::<nemoclaw_sdk::managed::Storage>(encoded)
                    .unwrap()
                    .engine
            };
            let engine = Engine::connect(&endpoint).unwrap();
            let actual = engine
                .container(id)
                .await
                .unwrap()
                .expect("bound service exists");
            assert_eq!(actual.id.as_deref(), Some(id));
            assert_eq!(
                actual
                    .name
                    .as_deref()
                    .map(|name| name.trim_start_matches('/')),
                attributes["name"].as_str()
            );
        } else {
            let spec: Spec = serde_json::from_str(attributes["spec"].as_str().unwrap()).unwrap();
            let engine = Engine::connect(spec.engine()).unwrap();
            let runtime = engine
                .observe_gateway(&spec, id)
                .await
                .unwrap()
                .expect("bound gateway exists");
            assert_eq!(runtime.id, id);
        }
        observed += 1;
    }
    assert_eq!(observed, 2, "both gateway and inference must be observed");
    assert_eq!(
        std::fs::read(path).unwrap(),
        bytes,
        "read-only qualification changed state"
    );
}

#[tokio::test]
#[ignore = "requires explicit NEMOCLAW_TEST_RUNTIME_STATE; reads retained owned storage only"]
async fn retained_inference_volume_preserves_its_reference_binding() {
    let path = std::path::PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_RUNTIME_STATE").expect("explicit state file"),
    );
    assert!(path.is_absolute());
    let bytes = std::fs::read(&path).unwrap();
    let state: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let mut observed = 0;
    for resource in state["resources"].as_array().unwrap() {
        if resource["type"] != "nemoclaw_inference_storage" {
            continue;
        }
        let instances = resource["instances"].as_array().unwrap();
        assert_eq!(instances.len(), 1);
        let attributes = &instances[0]["attributes"];
        let storage: nemoclaw_sdk::managed::Storage =
            serde_json::from_str(attributes["spec"].as_str().unwrap()).unwrap();
        let engine = Engine::connect(&storage.engine).unwrap();
        let id = attributes["id"].as_str().unwrap();
        assert_eq!(
            storage.observe(&engine, id).await.unwrap().as_deref(),
            Some(id)
        );
        observed += 1;
    }
    assert_eq!(observed, 1);
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[tokio::test]
#[ignore = "requires explicit NEMOCLAW_TEST_RUNTIME_STATE; reads retained owned gateway storage only"]
async fn retained_gateway_storage_preserves_its_reference_binding() {
    let path = std::path::PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_RUNTIME_STATE").expect("explicit state file"),
    );
    assert!(path.is_absolute());
    let bytes = std::fs::read(&path).unwrap();
    let state: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let mut observed = 0;
    for resource in state["resources"].as_array().unwrap() {
        if resource["type"] != "nemoclaw_gateway_storage" {
            continue;
        }
        let instances = resource["instances"].as_array().unwrap();
        assert_eq!(instances.len(), 1);
        let attributes = &instances[0]["attributes"];
        let spec: Spec = serde_json::from_str(attributes["spec"].as_str().unwrap()).unwrap();
        let engine = Engine::connect(&spec.gateway.engine).unwrap();
        let id = attributes["id"].as_str().unwrap();
        assert_eq!(
            engine
                .gateway_storage(&spec, id, false)
                .await
                .unwrap()
                .as_deref(),
            Some(id)
        );
        observed += 1;
    }
    assert_eq!(observed, 1);
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}
