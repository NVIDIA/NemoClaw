// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! A fake OpenShell gateway and owned OpenTofu workspaces, shared by the
//! provider contract tests and the end-to-end tests.
pub mod openshell;
pub mod tofu;

/// The fake `ssh` relay built beside the test executables, which live in the
/// target's `deps` directory.
#[must_use]
pub fn ssh_relay() -> std::path::PathBuf {
    let current = std::env::current_exe().unwrap();
    let relay = current
        .parent()
        .and_then(std::path::Path::parent)
        .unwrap()
        .join(executable("nemoclaw-fixture-ssh"));
    assert!(
        relay.is_file(),
        "{} is missing; build it with cargo build -p nemoclaw-test-fixtures",
        relay.display()
    );
    relay
}

/// `name` as an executable on this platform.
pub fn executable(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}
