// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{
    backend::Backend,
    compile::{Generations, targets},
    config::Document,
    openshell::{EnvironmentSecrets, OpenShell},
};
use std::sync::Arc;

#[tokio::test]
async fn owning_api_reconciles_lost_create_reply_and_checks_conditional_updates() {
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    document.spec.gateway.endpoint = fixture.endpoint.clone();
    let client = OpenShell::connect(&document.spec.gateway, Arc::new(EnvironmentSecrets)).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .into_iter()
        .map(|k| (k.into(), format!("{k}-generation")))
        .collect();
    let targets = targets(&document, &generations).unwrap();
    let workspace = client.ensure("workspace", &targets[0].values).await;
    assert!(workspace.error.is_none());
    assert!(workspace.state.is_some());
    fixture.state.lock().unwrap().lose_create = true;
    let first = client.ensure("provider", &targets[1].values).await;
    assert!(first.error.is_some());
    let effects = fixture.state.lock().unwrap().effects;
    let recovered = client.ensure("provider", &targets[1].values).await;
    assert!(recovered.error.is_none());
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    let mut provider = recovered.state.unwrap();
    let id = provider["id"].clone();
    provider.insert("endpoint".into(), "https://changed.example/v1".into());
    let updated = client.ensure("provider", &provider).await;
    assert!(updated.error.is_none());
    assert_eq!(updated.state.unwrap()["id"], id);
    assert_eq!(fixture.state.lock().unwrap().conditional_updates, 1);
    fixture.state.lock().unwrap().fail_read = Some(("provider", tonic::Code::Unauthenticated));
    let error = client.read("provider", &provider, false).await.unwrap_err();
    assert!(!error.to_string().contains("secret"));
    fixture.state.lock().unwrap().fail_read = None;
    fixture.state.lock().unwrap().lose_delete = true;
    assert!(client.remove("provider", &provider, true).await.is_err());
    let effects = fixture.state.lock().unwrap().effects;
    assert!(client.remove("provider", &provider, true).await.is_ok());
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    assert!(
        client
            .remove("workspace", &workspace.state.unwrap(), true)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn sandbox_launch_policy_and_route_identity_survive_read_failures() {
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    document.spec.gateway.endpoint = fixture.endpoint.clone();
    let client = OpenShell::connect(&document.spec.gateway, Arc::new(EnvironmentSecrets)).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .into_iter()
        .map(|k| (k.into(), format!("{k}-generation")))
        .collect();
    let targets = targets(&document, &generations).unwrap();
    let mut rows = Vec::new();
    for target in &targets {
        let result = client.ensure(&target.kind, &target.values).await;
        assert!(
            result.error.is_none(),
            "{}: {:?}",
            target.kind,
            result.error
        );
        rows.push(result.state.unwrap());
    }
    let effects = fixture.state.lock().unwrap().effects;
    for (target, row) in targets.iter().zip(&rows) {
        assert!(client.ensure(&target.kind, row).await.error.is_none());
    }
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    assert_eq!(rows[2]["id"], format!("{}/primary", rows[0]["id"]));
    fixture.state.lock().unwrap().fail_read = Some(("policy", tonic::Code::NotFound));
    assert!(client.read("sandbox", &rows[3], false).await.is_err());
    fixture.state.lock().unwrap().fail_read = None;
    let key = format!("{}/{}", document.workspace(), rows[3]["name"]);
    fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .get_mut(&key)
        .unwrap()
        .spec
        .as_mut()
        .unwrap()
        .command
        .push("foreign".into());
    assert!(client.read("sandbox", &rows[3], false).await.is_err());
    fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .get_mut(&key)
        .unwrap()
        .spec
        .as_mut()
        .unwrap()
        .command
        .pop();
    for i in [3, 2, 1] {
        assert!(
            client
                .remove(&targets[i].kind, &rows[i], true)
                .await
                .is_ok()
        );
    }
    assert!(
        client
            .read("sandbox", &rows[3], false)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        client
            .read("workspace", &rows[0], false)
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn sandbox_exec_deadline_bounds_a_stream_that_never_finishes() {
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    document.spec.gateway.endpoint = fixture.endpoint.clone();
    let client = OpenShell::connect(&document.spec.gateway, Arc::new(EnvironmentSecrets)).unwrap();
    let generations = ["workspace", "provider", "sandbox"]
        .into_iter()
        .map(|k| (k.into(), format!("{k}-generation")))
        .collect();
    let mut sandbox = None;
    for target in targets(&document, &generations).unwrap() {
        let result = client.ensure(&target.kind, &target.values).await;
        assert!(result.error.is_none());
        if target.kind == "sandbox" {
            sandbox = result.state;
        }
    }
    fixture.state.lock().unwrap().exec_stalled = true;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        client.exec_bound(
            &sandbox.unwrap(),
            vec!["fixture".into()],
            Default::default(),
            1,
        ),
    )
    .await;
    assert!(
        result.is_ok(),
        "server accepted the deadline but never completed its stream"
    );
    assert!(result.unwrap().is_err());
}
