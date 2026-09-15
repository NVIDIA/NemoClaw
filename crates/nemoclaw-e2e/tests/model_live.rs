// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "linux")]
use nemoclaw_sdk::{
    CancellationToken, Deployment, config::Document, docker::Engine, managed::Spec,
    recipes::huggingface,
};
use serde_json::{Value, json};
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
    let state: Value =
        serde_json::from_slice(&fs::read(directory.join("runtime/terraform.tfstate")).unwrap())
            .unwrap();
    let resource = state["resources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["type"] == "nemoclaw_inference_service")
        .unwrap();
    let attrs = &resource["instances"][0]["attributes"];
    (
        serde_json::from_str(attrs["spec"].as_str().unwrap()).unwrap(),
        attrs["id"].as_str().unwrap().into(),
    )
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
    let desired = document.spec.inference_providers[0]
        .service
        .as_ref()
        .unwrap();
    assert_eq!(desired.backend, "vllm");
    let planned = deployment.plan(&document, &cancel).await.unwrap();
    if fresh {
        assert!(!planned.changes.is_empty());
        // A first plan must not leave any actual resource binding.
        if let Ok(bytes) = fs::read(directory.join("runtime/terraform.tfstate")) {
            let state: Value = serde_json::from_slice(&bytes).unwrap();
            assert!(state["resources"].as_array().is_none_or(Vec::is_empty));
        }
    } else {
        assert!(directory.join("runtime/terraform.tfstate").is_file());
    }
    let applied = deployment.apply(&document, &cancel).await.unwrap();
    assert!(
        applied
            .agent_response
            .trim_matches('.')
            .eq_ignore_ascii_case("FOUR")
    );
    let before = bindings(&directory);
    assert_eq!(before.len(), 8);
    let (spec, id) = service(&directory);
    let engine = Engine::connect(&spec.gateway.engine).unwrap();
    let observed = engine.observe_runtime(&spec, &id).await.unwrap().unwrap();
    engine.verify_artifacts(&observed).await.unwrap();
    let model = format!("/data/{}", huggingface::directory(desired));
    let receipt_path = format!("{model}/.nemoclaw-complete.json");
    let receipt = engine
        .read_file(&observed.container_id, &receipt_path, 1 << 20)
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
    fs::write(directory.join("exported.yaml"), exported.yaml().unwrap()).unwrap();
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
            .read_file(&observed.container_id, &receipt_path, 1 << 20)
            .await
            .unwrap()
            .unwrap(),
        receipt
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
                .observe_runtime(&spec, &id)
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
            .observe_runtime(&spec, &id)
            .await
            .unwrap()
            .unwrap()
            .running,
        "automatic restart loop"
    );
    let recovered = deployment.apply(&document, &cancel).await.unwrap();
    assert!(
        recovered
            .agent_response
            .trim_matches('.')
            .eq_ignore_ascii_case("FOUR")
    );
    assert_eq!(bindings(&directory), before);
    assert_eq!(
        engine
            .read_file(&observed.container_id, &receipt_path, 1 << 20)
            .await
            .unwrap()
            .unwrap(),
        receipt
    );
    deployment.destroy(&cancel).await.unwrap();
    // Refresh rejects a missing bound container to prevent accidental recreation.
    // Intentional destroy removes that binding; verify Docker and retained state.
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
        "nemoclaw_inference_storage.runtime",
    ] {
        assert_eq!(retained.get(address), before.get(address));
        assert!(retained.contains_key(address));
    }
    let proof = json!({"passed":true,"freshApply":fresh,"model":desired.model,"image":desired.image,"deployment":document.metadata.uid,"bindings":before,"containerId":observed.container_id,"agentReply":applied.agent_response,"recoveredReply":recovered.agent_response,"unchangedApply":true,"exportReapply":true,"receiptUnchanged":true,"noPreparation":true,"watchdogStoppedWithoutRestart":true,"explicitRecoveryPreservedIdentity":true,"destroyedWithStorageRetained":true});
    fs::write(
        directory.join("model-proof.json"),
        serde_json::to_vec_pretty(&proof).unwrap(),
    )
    .unwrap();
}
