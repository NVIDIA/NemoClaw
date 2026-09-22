// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_e2e::{assert_same_managed_resources, openshell::Fixture};
use nemoclaw_sdk::{CancellationToken, Deployment, config::Document};
use std::{fs, path::PathBuf};

fn document() -> Document {
    Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml")
            .replace("provider: docker", "provider: kubernetes")
            .as_bytes(),
    )
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires verified NEMOCLAW_TEST_BUNDLE; isolated Kubernetes gateway protocol fixture"]
async fn kubernetes_lifecycle_preserves_bindings_across_export_reapply_and_driver_drift() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    fixture.state.lock().unwrap().driver = Some("kubernetes".into());
    let mut document = document();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    deployment.plan(&document, &cancel).await.unwrap();
    assert_eq!(fixture.state.lock().unwrap().effects, 0);
    deployment.apply(&document, &cancel).await.unwrap();
    let bindings = fs::read(directory.path().join("terraform.tfstate")).unwrap();
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
    assert_same_managed_resources(
        &fs::read(directory.path().join("terraform.tfstate")).unwrap(),
        &bindings,
    );
    let effects = fixture.state.lock().unwrap().effects;
    fixture.state.lock().unwrap().driver = Some("docker".into());
    assert!(deployment.apply(&document, &cancel).await.is_err());
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    assert_same_managed_resources(
        &fs::read(directory.path().join("terraform.tfstate")).unwrap(),
        &bindings,
    );
    fixture.state.lock().unwrap().driver = Some("kubernetes".into());
    deployment.destroy(&cancel).await.unwrap();
    let state = fixture.state.lock().unwrap();
    assert!(state.sandboxes.is_empty());
    assert!(state.providers.is_empty());
    assert_eq!(state.workspaces.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires verified NEMOCLAW_TEST_BUNDLE; isolated gateway protocol fixture"]
async fn kubernetes_rejects_a_docker_gateway_without_mutation() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = document();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    assert!(
        Deployment::new(directory.path(), &bundle)
            .apply(&document, &CancellationToken::new())
            .await
            .is_err()
    );
    assert_eq!(fixture.state.lock().unwrap().effects, 0);
}
