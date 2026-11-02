// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A run-owned registry that requires a login, shared by the Docker and
//! Kubernetes private-image tests. Its credentials are public fixture values,
//! valid only for the registry each run creates.
use std::{fs, io::Write, path::Path, process::Stdio, time::Duration};
use tokio::process::Command;

// Docker Official Image registry:3, resolved 2026-10-17. Test dependency only.
pub(crate) const REGISTRY: &str = "docker.io/library/registry@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8";
// Public fixture credentials, valid only in a run's own registry.
pub(crate) const USER: &str = "nemoclaw-registry-fixture";
pub(crate) const PASSWORD: &str = "fixture-password-for-nemoclaw-tests-only";
pub(crate) const HTPASSWD: &str =
    "nemoclaw-registry-fixture:$2y$05$DSYXtCwu5fi5A0HdC3HLje4ACbf.67QujUPxS10rCH.fHgk5Byc.O\n";

/// Run a Docker command for a fixture, failing the test on error and bounding
/// what it reads.
pub(crate) async fn docker(operation: &'static str, args: &[&str], capture: bool) -> Vec<u8> {
    let output = tokio::time::timeout(
        Duration::from_secs(120),
        Command::new("docker")
            .args(args)
            .stdin(Stdio::null())
            .stdout(if capture {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("owned registry fixture command timed out")
    .expect("cannot execute Docker for the owned registry fixture");
    assert!(
        output.status.success(),
        "owned registry fixture {operation} failed: {}",
        output.status
    );
    assert!(
        output.stdout.len() <= 1024 * 1024,
        "fixture response exceeded its bound"
    );
    output.stdout
}

/// Write a file only its owner can read.
pub(crate) fn private_file(path: &Path, bytes: &[u8]) {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).unwrap().write_all(bytes).unwrap();
}
