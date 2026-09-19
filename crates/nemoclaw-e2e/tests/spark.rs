// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "linux")]

use nemoclaw_sdk::{
    CancellationToken, Change, Deployment, OperationResult, Outcome,
    config::{Document, ServiceDefinition},
    services::installers::vllm::Service,
};
use std::{fs, path::PathBuf};

fn explicit_path(name: &str) -> PathBuf {
    let path = PathBuf::from(std::env::var_os(name).expect(name));
    assert!(path.is_absolute(), "{name} must be an absolute path");
    path
}

fn vllm(document: &Document) -> &Service {
    let name = document.spec.inference_providers[0]
        .service_ref
        .as_ref()
        .unwrap();
    let ServiceDefinition::Vllm(service) = &document.spec.services[name] else {
        panic!("expected vLLM service");
    };
    service
}

fn vllm_mut(document: &mut Document) -> &mut Service {
    let name = document.spec.inference_providers[0]
        .service_ref
        .clone()
        .unwrap();
    let ServiceDefinition::Vllm(service) = document.spec.services.get_mut(&name).unwrap() else {
        panic!("expected vLLM service");
    };
    service
}

fn creates(resources: &[&str]) -> Vec<Change> {
    resources
        .iter()
        .map(|resource| Change {
            resource: (*resource).into(),
            actions: vec!["create".into()],
        })
        .collect()
}

fn assert_applied(result: &OperationResult, expected_changes: &[Change]) {
    assert_eq!(result.outcome, Outcome::Succeeded);
    assert_eq!(result.changes, expected_changes);
    assert!(result.deferred.is_empty());
    assert!(result.retained.is_empty());
    assert_eq!(result.health.len(), 1);
    assert_eq!(result.health[0].sandbox, "assistant");
    assert_eq!(result.health[0].agents, ["assistant"]);
    assert!(result.health[0].health.allows_apply_completion());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned Spark YAML, an unused NEMOCLAW_LIVE_SPARK_STATE path, and NEMOCLAW_TEST_BUNDLE; leaves workloads running"]
async fn spark_yaml_plans_and_applies_expected_resources() {
    // Use a copy of examples/spark/spark-inline.yaml with this host's image pins,
    // a fresh deployment UID, and available gateway port and subnet.
    let document =
        Document::parse(fs::File::open(explicit_path("NEMOCLAW_LIVE_SPARK_CONFIG")).unwrap())
            .unwrap();
    let directory = explicit_path("NEMOCLAW_LIVE_SPARK_STATE");
    let bundle = explicit_path("NEMOCLAW_TEST_BUNDLE");
    fs::create_dir(&directory).expect("Spark test requires a new state directory");
    let deployment = Deployment::new(&directory, &bundle);
    let cancel = CancellationToken::new();

    let expected_runtime = creates(&[
        "nemoclaw_gateway_storage.runtime",
        "nemoclaw_inference_service.inference_qwen",
        "nemoclaw_inference_storage.inference_qwen",
        "nemoclaw_managed_gateway.runtime",
    ]);
    let plan = deployment.plan(&document, &cancel).await.unwrap();
    assert_eq!(
        plan,
        OperationResult {
            outcome: Outcome::Planned,
            changes: expected_runtime.clone(),
            deferred: vec!["OpenShell registration and sandbox require the managed gateway".into(),],
            retained: vec![],
            health: vec![],
        }
    );

    let mut expected_apply = expected_runtime;
    expected_apply.extend(creates(&[
        "nemoclaw_provider.inference_qwen",
        "nemoclaw_provider_profile.inference_qwen",
        "nemoclaw_sandbox.assistant",
        "nemoclaw_workspace.deployment",
    ]));
    let applied = deployment.apply(&document, &cancel).await.unwrap();
    assert_applied(&applied, &expected_apply);

    let unchanged = deployment.plan(&document, &cancel).await.unwrap();
    assert_eq!(
        unchanged,
        OperationResult {
            outcome: Outcome::Planned,
            changes: vec![],
            deferred: vec![],
            retained: vec![],
            health: vec![],
        }
    );
    let reapplied = deployment.apply(&document, &cancel).await.unwrap();
    assert_applied(&reapplied, &[]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned Spark YAML with a changed inference image pin, established state, and NEMOCLAW_TEST_BUNDLE; replaces that inference process"]
async fn spark_image_change_plans_and_applies_replacement() {
    let document =
        Document::parse(fs::File::open(explicit_path("NEMOCLAW_LIVE_SPARK_CONFIG")).unwrap())
            .unwrap();
    let directory = explicit_path("NEMOCLAW_LIVE_SPARK_STATE");
    let bundle = explicit_path("NEMOCLAW_TEST_BUNDLE");
    let deployment = Deployment::new(&directory, &bundle);
    let cancel = CancellationToken::new();

    let previous = deployment.export(&cancel).await.unwrap();
    let mut comparison = document.clone();
    let old_image = vllm(&previous).image.clone();
    let new_image = vllm(&comparison).image.clone();
    assert_ne!(new_image, old_image);
    vllm_mut(&mut comparison).image = old_image;
    assert_eq!(
        comparison, previous,
        "only the inference image pin may change"
    );

    let expected_changes = vec![Change {
        resource: "nemoclaw_inference_service.inference_qwen".into(),
        actions: vec!["delete".into(), "create".into()],
    }];
    let plan = deployment.plan(&document, &cancel).await.unwrap();
    assert_eq!(
        plan,
        OperationResult {
            outcome: Outcome::Planned,
            changes: expected_changes.clone(),
            deferred: vec![],
            retained: vec![],
            health: vec![],
        }
    );
    let applied = deployment.apply(&document, &cancel).await.unwrap();
    assert_applied(&applied, &expected_changes);
}
