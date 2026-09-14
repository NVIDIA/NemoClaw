// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{CancellationToken, Deployment, Outcome, config::Document};
use std::{fs, path::PathBuf, process::Command, time::Duration};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
async fn sdk_apply_cli_export_sdk_reapply_and_cli_destroy_share_state() {
    let bundle =
        PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").expect("explicit bundle path"));
    assert!(bundle.is_absolute());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    document.spec.gateway.endpoint = fixture.endpoint.clone();
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    let planning = deployment.plan(&document, &cancel).await.unwrap();
    assert_eq!(planning.outcome, Outcome::Planned);
    assert_eq!(fixture.state.lock().unwrap().effects, 0);
    fixture.state.lock().unwrap().lose_create = true;
    assert!(deployment.apply(&document, &cancel).await.is_err());
    let record: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.path().join("intent.json")).unwrap()).unwrap();
    assert_eq!(record["pending"], true);
    let mut changed = document.clone();
    changed.spec.sandboxes[0].agents[0].inference.routes[0]
        .overrides
        .model = "changed".into();
    assert!(deployment.apply(&changed, &cancel).await.is_err());
    let timed = cancel.clone();
    let deadline = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(8)).await;
        timed.cancel();
    });
    let applied = deployment.apply(&document, &cancel).await;
    deadline.abort();
    assert!(applied.is_ok(), "{applied:?}");
    let effects = fixture.state.lock().unwrap().effects;
    assert_eq!(effects, 4);
    let exported = Command::new(
        bundle
            .join("bin")
            .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
    )
    .args(["export", "--state-dir"])
    .arg(directory.path())
    .output()
    .unwrap();
    assert!(
        exported.status.success(),
        "{}",
        String::from_utf8_lossy(&exported.stderr)
    );
    let exported = Document::parse(exported.stdout.as_slice()).unwrap();
    assert_eq!(exported, document);
    assert!(
        deployment
            .apply(&exported, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    let preview = deployment.plan_destroy(&cancel).await.unwrap();
    assert_eq!(preview.changes.len(), 3);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    let destroyed = Command::new(
        bundle
            .join("bin")
            .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
    )
    .args(["destroy", "--state-dir"])
    .arg(directory.path())
    .output()
    .unwrap();
    assert!(
        destroyed.status.success(),
        "{}",
        String::from_utf8_lossy(&destroyed.stderr)
    );
    assert!(
        deployment
            .destroy(&cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(fixture.state.lock().unwrap().workspaces.len(), 1);
    assert_eq!(
        deployment
            .apply(&document, &cancel)
            .await
            .unwrap()
            .changes
            .len(),
        3
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
async fn readiness_and_observation_failures_retain_bindings_and_recover_without_recreation() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    document.spec.gateway.endpoint = fixture.endpoint.clone();
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    fixture.state.lock().unwrap().exec_exit = 2;
    assert!(deployment.apply(&document, &cancel).await.is_err());
    let state_path = directory.path().join("terraform.tfstate");
    let established = fs::read(&state_path).unwrap();
    let effects = fixture.state.lock().unwrap().effects;
    assert_eq!(effects, 4);
    let intent: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.path().join("intent.json")).unwrap()).unwrap();
    assert_eq!(intent["pending"], false);
    assert_eq!(intent["succeeded"], false);
    fixture.state.lock().unwrap().exec_exit = 0;
    assert!(
        deployment
            .apply(&document, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(fs::read(&state_path).unwrap(), established);
    fixture.state.lock().unwrap().fail_read = Some(("provider", tonic::Code::Unavailable));
    assert!(deployment.export(&cancel).await.is_err());
    assert!(deployment.plan(&document, &cancel).await.is_err());
    assert!(deployment.apply(&document, &cancel).await.is_err());
    assert_eq!(fs::read(&state_path).unwrap(), established);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    fixture.state.lock().unwrap().fail_read = None;
    fixture.state.lock().unwrap().exec_truncated = true;
    assert!(deployment.export(&cancel).await.is_err());
    fixture.state.lock().unwrap().exec_truncated = false;
    assert_eq!(deployment.export(&cancel).await.unwrap(), document);
    fixture.state.lock().unwrap().lose_delete = true;
    assert!(deployment.destroy(&cancel).await.is_err());
    assert!(deployment.apply(&document, &cancel).await.is_err());
    assert_eq!(
        deployment.destroy(&cancel).await.unwrap().outcome,
        Outcome::Destroyed
    );
    assert_eq!(fixture.state.lock().unwrap().workspaces.len(), 1);
    assert!(fixture.state.lock().unwrap().providers.is_empty());
    assert!(fixture.state.lock().unwrap().sandboxes.is_empty());
}
