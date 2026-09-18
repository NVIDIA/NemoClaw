// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "linux")]
use nemoclaw_e2e::qualification::{
    Evidence, InferenceRuntime, LiveInputs, PreparedObservation, ResourceIdentities, StateSnapshot,
};
use nemoclaw_sdk::{CancellationToken, Deployment, config::Document};
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn state(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

async fn capture(directory: &Path) -> PreparedObservation {
    let mut ids = ResourceIdentities::default();
    for file in ["terraform.tfstate", "runtime/terraform.tfstate"] {
        let state = StateSnapshot::read(&directory.join(file)).unwrap();
        // This Spark case owns four resources in each graph; this is not a reader invariant.
        assert_eq!(state.len(), 4);
        ids.merge(state.identities()).unwrap();
    }
    let runtime = InferenceRuntime::connect(directory).unwrap();
    PreparedObservation {
        ids,
        receipts: runtime.receipts().await.unwrap(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_LIVE_SPARK_CONFIG, NEMOCLAW_LIVE_SPARK_STATE, NEMOCLAW_TEST_BUNDLE; mutates only that owned experiment"]
async fn spark_apply_export_capacity_and_watchdog_recovery_preserve_identity_and_data() {
    let inputs =
        LiveInputs::from_env("NEMOCLAW_LIVE_SPARK_CONFIG", "NEMOCLAW_LIVE_SPARK_STATE").unwrap();
    let directory = inputs.state;
    let bundle = inputs.bundle;
    let document = Document::parse(fs::File::open(inputs.config).unwrap()).unwrap();
    assert_eq!(document.spec.gateway.management, "managed");
    assert!(document.spec.inference_providers[0].service.is_some());
    fs::create_dir_all(&directory).unwrap();
    let mut evidence = Evidence::new(directory.join("spark-validation.json"),
        json!({"deployment":document.metadata.uid,"startedEpoch":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()})).unwrap();
    evidence
        .record("bundle", state(&bundle.join("manifest.json")))
        .unwrap();
    let deployment = Deployment::new(&directory, &bundle);
    let cancel = CancellationToken::new();
    let initial = deployment.apply(&document, &cancel).await.unwrap();
    evidence
        .record(
            "initialAgentReply",
            nemoclaw_e2e::verify_agent(&document, &directory).await,
        )
        .unwrap();
    evidence.record("initialApply", initial).unwrap();
    let before = capture(&directory).await;
    evidence.record("before", &before).unwrap();
    let unchanged = deployment.apply(&document, &cancel).await.unwrap();
    assert!(unchanged.changes.is_empty());
    evidence
        .record(
            "unchangedAgentReply",
            nemoclaw_e2e::verify_agent(&document, &directory).await,
        )
        .unwrap();
    assert_eq!(before, capture(&directory).await);
    evidence.record("unchangedApply", unchanged).unwrap();
    let exported = deployment.export(&cancel).await.unwrap();
    assert_eq!(exported.digest(), document.digest());
    fs::write(
        directory.join("spark-export.yaml"),
        exported.yaml().unwrap(),
    )
    .unwrap();
    let reapplied = deployment.apply(&exported, &cancel).await.unwrap();
    assert!(reapplied.changes.is_empty());
    assert_eq!(before, capture(&directory).await);
    evidence.record("exportReapply", reapplied).unwrap();
    let mut oversized = document.clone();
    oversized.spec.inference_providers[0]
        .service
        .as_mut()
        .unwrap()
        .memory
        .host_reserve_gib = 64;
    oversized.validate().unwrap();
    let rejection = deployment
        .plan(&oversized, &cancel)
        .await
        .expect_err("capacity must reject without allocating memory");
    assert!(rejection.to_string().contains("reserve"), "{rejection}");
    assert_eq!(before, capture(&directory).await);
    evidence
        .record("capacityRejection", rejection.to_string())
        .unwrap();
    let runtime = InferenceRuntime::connect(&directory).unwrap();
    assert!(runtime.observe().await.unwrap().running);
    runtime.signal_watchdog().await.unwrap();
    let stopped = runtime.wait_stopped(Duration::from_secs(60)).await.unwrap();
    let status = runtime.engine.runtime_status(&stopped).await.unwrap();
    assert_eq!(status.phase, "stopped");
    evidence.record("watchdogStop", status).unwrap();
    for _ in 0..10 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(
            !runtime.observe().await.unwrap().running,
            "watchdog must not enter a restart loop"
        );
    }
    let plan = deployment.plan(&document, &cancel).await.unwrap();
    assert_eq!(plan.changes.len(), 1);
    assert_eq!(
        plan.changes[0].resource,
        "nemoclaw_inference_service.inference_qwen"
    );
    assert_eq!(plan.changes[0].actions, ["update"]);
    assert!(
        !runtime.observe().await.unwrap().running,
        "plan must not restart inference"
    );
    evidence.record("stoppedPlan", plan).unwrap();
    let recovered = deployment.apply(&document, &cancel).await.unwrap();
    assert_eq!(recovered.changes.len(), 1);
    evidence
        .record(
            "recoveredAgentReply",
            nemoclaw_e2e::verify_agent(&document, &directory).await,
        )
        .unwrap();
    assert_eq!(before, capture(&directory).await);
    evidence.record("recoveryApply", recovered).unwrap();
    evidence.record("after", capture(&directory).await).unwrap();
    evidence.finish().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit Spark YAML with a changed runtime image pin, established state and verified bundle; replaces only the owned inference process"]
async fn spark_image_change_preserves_independent_bindings_and_prepared_data() {
    let inputs =
        LiveInputs::from_env("NEMOCLAW_LIVE_SPARK_CONFIG", "NEMOCLAW_LIVE_SPARK_STATE").unwrap();
    let directory = inputs.state;
    let bundle = inputs.bundle;
    let document = Document::parse(fs::File::open(inputs.config).unwrap()).unwrap();
    let old: Document =
        serde_json::from_value(state(&directory.join("intent.json"))["document"].clone()).unwrap();
    let mut comparison = document.clone();
    let new_image = document.spec.inference_providers[0]
        .service
        .as_ref()
        .unwrap()
        .image
        .clone();
    let old_image = old.spec.inference_providers[0]
        .service
        .as_ref()
        .unwrap()
        .image
        .clone();
    assert_ne!(old_image, new_image);
    comparison.spec.inference_providers[0]
        .service
        .as_mut()
        .unwrap()
        .image = old_image.clone();
    assert_eq!(comparison, old, "only the artifact pin may change");
    let before = capture(&directory).await;
    let mut evidence = Evidence::new(directory.join("spark-artifact-validation.json"),
        json!({"deployment":document.metadata.uid,"oldImage":old_image,"newImage":new_image,"before":before})).unwrap();
    let deployment = Deployment::new(&directory, &bundle);
    let cancel = CancellationToken::new();
    let plan = deployment.plan(&document, &cancel).await.unwrap();
    assert_eq!(plan.changes.len(), 1);
    assert_eq!(
        plan.changes[0].resource,
        "nemoclaw_inference_service.inference_qwen"
    );
    assert_eq!(plan.changes[0].actions, ["delete", "create"]);
    assert_eq!(
        capture(&directory).await,
        before,
        "plan changed runtime or storage"
    );
    evidence.record("plan", plan).unwrap();
    let applied = deployment.apply(&document, &cancel).await.unwrap();
    assert!(
        !nemoclaw_e2e::verify_agent(&document, &directory)
            .await
            .is_empty()
    );
    let after = capture(&directory).await;
    assert_eq!(before.receipts, after.receipts);
    before
        .ids
        .require_replacement(&after.ids, "nemoclaw_inference_service.inference_qwen")
        .unwrap();
    evidence.record("apply", applied).unwrap();
    evidence.record("after", after.clone()).unwrap();
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
    assert_eq!(capture(&directory).await, after);
    evidence.record("exportReapply", true).unwrap();
    evidence.finish().unwrap();
}
