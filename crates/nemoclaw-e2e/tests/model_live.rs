// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "linux")]
use nemoclaw_provider::docker::Engine;
use nemoclaw_runtime::vllm::recipes::huggingface;
use nemoclaw_sdk::{CancellationToken, Deployment, config::Document, config::ServiceDefinition};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
fn bindings(directory: &Path) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    for stage in ["terraform.tfstate"] {
        let state: Value =
            serde_json::from_slice(&fs::read(directory.join(stage)).unwrap()).unwrap();
        for resource in state["resources"].as_array().unwrap() {
            if resource["mode"] == "data" {
                continue;
            }
            let address = format!(
                "{}.{}",
                resource["type"].as_str().unwrap(),
                resource["name"].as_str().unwrap()
            );
            assert!(
                result
                    .insert(
                        address,
                        resource["instances"][0]["attributes"]["id"]
                            .as_str()
                            .unwrap()
                            .into()
                    )
                    .is_none()
            );
        }
    }
    result
}
/// The model service's container, as OpenTofu state records it.
fn service_container(directory: &Path) -> String {
    let containers: Vec<_> = bindings(directory)
        .into_iter()
        .filter(|(address, _)| address.starts_with("docker_container.inference_service_"))
        .collect();
    assert_eq!(containers.len(), 1, "one model service container");
    containers[0].1.clone()
}
/// Whether the container runs, or None when it is gone.
async fn running(engine: &Engine, container: &str) -> Option<bool> {
    let observed = engine.container(container).await.unwrap()?;
    Some(
        observed
            .state
            .and_then(|state| state.running)
            .unwrap_or(false),
    )
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_LIVE_MODEL_CONFIG, NEMOCLAW_LIVE_MODEL_STATE, NEMOCLAW_TEST_BUNDLE; owns and destroys this experiment only"]
async fn selected_model_apply_export_and_watchdog_recovery_preserve_data_and_identity() {
    exercise(true).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit owned model configuration, state and bundle; resumes established resources and destroys workloads only after verification"]
async fn selected_model_continues_from_retained_state() {
    exercise(false).await;
}
// Qualify model storage and supervision; explicit agent invocation is covered by fabric_live.
async fn exercise(fresh: bool) {
    let explicit = |name| {
        let p = PathBuf::from(std::env::var_os(name).expect(name));
        assert!(p.is_absolute());
        p
    };
    let document =
        Document::parse(fs::File::open(explicit("NEMOCLAW_LIVE_MODEL_CONFIG")).unwrap()).unwrap();
    let directory = explicit("NEMOCLAW_LIVE_MODEL_STATE");
    let deployment = Deployment::new(&directory, &explicit("NEMOCLAW_TEST_BUNDLE"));
    let cancel = CancellationToken::new();
    let service_name = document.spec.inference_providers[0]
        .service_ref
        .as_ref()
        .unwrap();
    let ServiceDefinition::Vllm(desired) = &document.spec.services[service_name] else {
        panic!("expected vLLM service");
    };
    let planned = deployment.plan(&document, &cancel).await.unwrap();
    if fresh {
        assert!(!planned.changes.is_empty());
        // A first plan must not leave any actual resource binding.
        if let Ok(bytes) = fs::read(directory.join("terraform.tfstate")) {
            let state: Value = serde_json::from_slice(&bytes).unwrap();
            assert!(state["resources"].as_array().is_none_or(|resources| {
                resources.iter().all(|resource| resource["mode"] == "data")
            }));
        }
    } else {
        assert!(directory.join("terraform.tfstate").is_file());
    }
    deployment.apply(&document, &cancel).await.unwrap();
    let before = bindings(&directory);
    assert_eq!(
        before
            .keys()
            .filter(|address| address.starts_with("docker_container.inference_service_"))
            .count(),
        1
    );
    // The service runs on its explicit placement, or on the managed gateway's engine.
    let endpoint = desired.placement.as_ref().map_or_else(
        || document.spec.gateway.as_managed().unwrap().engine.clone(),
        |placement| placement.engine.clone(),
    );
    let engine = Engine::connect(&endpoint).unwrap();
    let container = service_container(&directory);
    assert_eq!(running(&engine, &container).await, Some(true));
    let model = format!("/data/{}", huggingface::directory(desired));
    let manifest_path = format!("{model}/.nemoclaw-manifest.json");
    let manifest = engine
        .read_file(&container, &manifest_path, 4 << 20)
        .await
        .unwrap()
        .unwrap();
    assert!(
        engine
            .stat_file(&container, "/data/prepared")
            .await
            .unwrap()
            .is_none(),
        "generic model ran model-specific preparation"
    );
    assert!(
        deployment
            .plan(&document, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert!(
        deployment
            .apply(&document, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    let exported = deployment.export(&cancel).await.unwrap();
    assert_eq!(exported, document);
    assert!(
        deployment
            .apply(&exported, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(bindings(&directory), before);
    assert_eq!(
        engine
            .read_file(&container, &manifest_path, 4 << 20)
            .await
            .unwrap()
            .unwrap(),
        manifest
    );
    // Safe operator trip exercises the resident guard without exhausting memory.
    assert!(
        std::process::Command::new("docker")
            .args(["kill", "--signal=USR1", &container])
            .status()
            .unwrap()
            .success()
    );
    tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            if running(&engine, &container).await != Some(true) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(
        running(&engine, &container).await,
        Some(false),
        "automatic restart loop"
    );
    deployment.apply(&document, &cancel).await.unwrap();
    let recovered = bindings(&directory);
    // OpenShell objects and the model cache volume are durable; the
    // container may be replaced.
    for (address, id) in before.iter().filter(|(address, _)| {
        address.starts_with("openshell_") || address.starts_with("docker_volume.")
    }) {
        assert_eq!(
            recovered.get(address),
            Some(id),
            "durable identity changed: {address}"
        );
    }
    let container = service_container(&directory);
    assert_eq!(running(&engine, &container).await, Some(true));
    assert_eq!(
        engine
            .read_file(&container, &manifest_path, 4 << 20)
            .await
            .unwrap()
            .unwrap(),
        manifest
    );
    deployment.destroy(&cancel).await.unwrap();
    // Destroy removes disposable compute while retaining durable storage bindings.
    assert!(engine.container(&container).await.unwrap().is_none());
    // Destroy deletes the workspace with the gateway; only data remains.
    let retained = bindings(&directory);
    assert_eq!(retained.len(), 2);
    for address in [
        "openshell_gateway_storage.runtime",
        before
            .keys()
            .find(|address| address.starts_with("docker_volume.inference_storage_"))
            .expect("a model cache volume")
            .as_str(),
    ] {
        assert_eq!(retained.get(address), before.get(address));
        assert!(retained.contains_key(address));
    }
}
