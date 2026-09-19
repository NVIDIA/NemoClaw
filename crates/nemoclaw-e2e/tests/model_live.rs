// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "linux")]
use nemoclaw_sdk::{
    CancellationToken, Deployment,
    config::{Document, ServiceDefinition},
    docker::Engine,
    managed::Spec,
    services::installers::vllm::recipes::huggingface,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
fn bindings(directory: &Path) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    for stage in ["terraform.tfstate", "runtime/terraform.tfstate"] {
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
fn service(directory: &Path) -> (Spec, String) {
    let intent: Value =
        serde_json::from_slice(&fs::read(directory.join("intent.json")).unwrap()).unwrap();
    let document: Document = serde_json::from_value(intent["document"].clone()).unwrap();
    let generations = serde_json::from_value(intent["generations"].clone()).unwrap();
    let targets = nemoclaw_sdk::compile::runtime_targets(&document, &generations).unwrap();
    let target = targets
        .iter()
        .find(|target| target.kind == "inference_service")
        .unwrap();
    let spec = serde_json::from_str(&target.values["spec"]).unwrap();
    (spec, bindings(directory)[&target.address].clone())
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_LIVE_MODEL_CONFIG, NEMOCLAW_LIVE_MODEL_STATE, NEMOCLAW_TEST_BUNDLE; owns and destroys this experiment only"]
async fn selected_model_apply_export_and_watchdog_recovery_preserve_data_and_identity() {
    exercise(true).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit owned model configuration, state and bundle; resumes established resources and destroys workloads only after verification"]
async fn selected_model_continues_from_retained_state() {
    exercise(false).await;
}
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
        if let Ok(bytes) = fs::read(directory.join("runtime/terraform.tfstate")) {
            let state: Value = serde_json::from_slice(&bytes).unwrap();
            assert!(state["resources"].as_array().is_none_or(|resources| {
                resources.iter().all(|resource| resource["mode"] == "data")
            }));
        }
    } else {
        assert!(directory.join("runtime/terraform.tfstate").is_file());
    }
    deployment.apply(&document, &cancel).await.unwrap();
    assert!(
        !nemoclaw_e2e::verify_agent(&document, &directory)
            .await
            .trim()
            .is_empty()
    );
    let before = bindings(&directory);
    assert_eq!(
        before
            .keys()
            .filter(|address| address.starts_with("docker_container.inference_service_"))
            .count(),
        1
    );
    let (spec, id) = service(&directory);
    let engine = Engine::connect(spec.engine()).unwrap();
    let observed = engine.observe_service(&spec, &id).await.unwrap().unwrap();
    let model = format!("/data/{}", huggingface::directory(desired));
    let manifest_path = format!("{model}/.nemoclaw-manifest.json");
    let manifest = engine
        .read_file(&observed.container_id, &manifest_path, 4 << 20)
        .await
        .unwrap()
        .unwrap();
    assert!(
        engine
            .stat_file(&observed.container_id, "/data/prepared")
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
            .read_file(&observed.container_id, &manifest_path, 4 << 20)
            .await
            .unwrap()
            .unwrap(),
        manifest
    );
    // Safe operator trip exercises the resident guard without exhausting memory.
    assert!(
        std::process::Command::new("docker")
            .args(["kill", "--signal=USR1", &observed.container_id])
            .status()
            .unwrap()
            .success()
    );
    tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            if !engine
                .observe_service(&spec, &id)
                .await
                .unwrap()
                .unwrap()
                .running
            {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(
        !engine
            .observe_service(&spec, &id)
            .await
            .unwrap()
            .unwrap()
            .running,
        "automatic restart loop"
    );
    deployment.apply(&document, &cancel).await.unwrap();
    assert!(
        !nemoclaw_e2e::verify_agent(&document, &directory)
            .await
            .trim()
            .is_empty()
    );
    let recovered = bindings(&directory);
    for (address, id) in before
        .iter()
        .filter(|(address, _)| address.starts_with("nemoclaw_"))
    {
        assert_eq!(
            recovered.get(address),
            Some(id),
            "durable identity changed: {address}"
        );
    }
    let (spec, id) = service(&directory);
    let observed = engine.observe_service(&spec, &id).await.unwrap().unwrap();
    assert_eq!(
        engine
            .read_file(&observed.container_id, &manifest_path, 4 << 20)
            .await
            .unwrap()
            .unwrap(),
        manifest
    );
    deployment.destroy(&cancel).await.unwrap();
    // Destroy removes disposable compute while retaining durable storage bindings.
    assert!(
        engine
            .container(&observed.container_id)
            .await
            .unwrap()
            .is_none()
    );
    let retained = bindings(&directory);
    assert_eq!(retained.len(), 3);
    for address in [
        "nemoclaw_workspace.deployment",
        "nemoclaw_gateway_storage.runtime",
        before
            .keys()
            .find(|address| address.starts_with("nemoclaw_inference_storage."))
            .unwrap()
            .as_str(),
    ] {
        assert_eq!(retained.get(address), before.get(address));
        assert!(retained.contains_key(address));
    }
}
