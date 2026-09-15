// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]
use nemoclaw_sdk::docker::Engine;

#[tokio::test]
#[ignore = "requires explicit NEMOCLAW_TEST_SSH_ENGINE and NEMOCLAW_TEST_ENGINE_ID; read-only real SSH/Docker"]
async fn ssh_observes_the_selected_daemon_and_confirmed_absence() {
    let engine = Engine::connect(&std::env::var("NEMOCLAW_TEST_SSH_ENGINE").unwrap()).unwrap();
    let expected = std::env::var("NEMOCLAW_TEST_ENGINE_ID").unwrap();
    assert_eq!(
        engine.info().await.unwrap().id.as_deref(),
        Some(expected.as_str())
    );
    assert_eq!(
        engine.info().await.unwrap().id.as_deref(),
        Some(expected.as_str())
    );
    assert!(
        engine
            .container("nc-ssh-proof-absent-9dc7dbe5")
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
#[ignore = "requires explicit NEMOCLAW_TEST_SSH_ENGINE configured to reject authentication, host trust or transport"]
async fn ssh_failure_is_an_observation_error_never_absence() {
    let engine = Engine::connect(&std::env::var("NEMOCLAW_TEST_SSH_ENGINE").unwrap()).unwrap();
    assert!(engine.info().await.is_err());
    let result = engine.container("nc-ssh-proof-absent-9dc7dbe5").await;
    assert!(result.is_err());
    let diagnostic = result.unwrap_err().to_string();
    assert!(!diagnostic.contains("ssh://"));
    assert!(!diagnostic.contains("IdentityFile"));
}

#[tokio::test]
#[ignore = "requires explicit NEMOCLAW_TEST_SSH_ENGINE and NEMOCLAW_TEST_SSH_CONTAINER; writes only to an experiment-labeled stopped container"]
async fn ssh_upload_and_streamed_download_preserve_container_identity() {
    let engine = Engine::connect(&std::env::var("NEMOCLAW_TEST_SSH_ENGINE").unwrap()).unwrap();
    let id = std::env::var("NEMOCLAW_TEST_SSH_CONTAINER").unwrap();
    let before = engine.container(&id).await.unwrap().unwrap();
    assert_eq!(before.id.as_deref(), Some(id.as_str()));
    assert_eq!(
        before
            .config
            .unwrap()
            .labels
            .unwrap()
            .get("nemoclaw.experiment")
            .map(String::as_str),
        Some("ssh-transport")
    );
    assert_eq!(before.state.unwrap().running, Some(false));
    let bytes = vec![b'x'; 128 * 1024];
    engine
        .write_files(&id, "/tmp", &[("ssh-proof", &bytes, 0o600)])
        .await
        .unwrap();
    assert_eq!(
        engine
            .read_file(&id, "/tmp/ssh-proof", bytes.len())
            .await
            .unwrap()
            .unwrap(),
        bytes
    );
    assert_eq!(
        engine.container(&id).await.unwrap().unwrap().id.as_deref(),
        Some(id.as_str())
    );
}

#[tokio::test]
#[ignore = "requires explicit NEMOCLAW_TEST_SSH_ENGINE on a Linux ARM64 NVIDIA host; read-only remote host collection"]
async fn ssh_capacity_belongs_to_the_selected_docker_host() {
    use nemoclaw_sdk::hardware::{HostObserver, SshHost};
    let engine = Engine::connect(&std::env::var("NEMOCLAW_TEST_SSH_ENGINE").unwrap()).unwrap();
    let observation = SshHost.observe(&engine).await.unwrap();
    let daemon = engine.info().await.unwrap().id.unwrap();
    let capacity = observation.for_engine(&daemon).unwrap();
    assert_eq!(capacity.architecture, "arm64");
    assert!(capacity.total > 0 && capacity.disk_free > 0);
}
