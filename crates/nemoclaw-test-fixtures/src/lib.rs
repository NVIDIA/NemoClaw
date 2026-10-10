// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! A fake OpenShell gateway and owned OpenTofu workspaces, shared by the
//! provider contract tests and the end-to-end tests.
pub mod openshell;
pub mod ssh;
pub mod tofu;

/// The fake `ssh` relay: beside `providers`, where archived lifecycle runs
/// unpack it with the providers, or beside the test executables, which live in
/// the target's `deps` directory.
#[must_use]
pub fn ssh_relay(providers: &std::path::Path) -> std::path::PathBuf {
    let name = executable("nemoclaw-fixture-ssh");
    let current = std::env::current_exe().unwrap();
    let built = current
        .parent()
        .and_then(std::path::Path::parent)
        .unwrap()
        .join(&name);
    let candidates = [providers.join(&name), built];
    candidates
        .iter()
        .find(|relay| relay.is_file())
        .unwrap_or_else(|| {
            panic!(
                "{} and {} are missing; build them with cargo build -p nemoclaw-test-fixtures",
                candidates[0].display(),
                candidates[1].display()
            )
        })
        .clone()
}

/// `name` as an executable on this platform.
pub fn executable(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}
