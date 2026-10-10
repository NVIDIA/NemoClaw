// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! A fake OpenShell gateway, owned OpenTofu workspaces, the bundle they run,
//! and fixture executables, shared by the provider contract tests and the
//! end-to-end tests.
pub mod bundle;
pub mod openshell;
pub mod ssh;
pub mod tofu;

pub use bundle::Bundle;

/// The fake `ssh` relay, beside the test executables.
#[must_use]
pub fn ssh_relay() -> std::path::PathBuf {
    fixture_executable("nemoclaw-fixture-ssh")
}

/// A fixture executable from this crate, such as `nemoclaw-fixture-ssh-simulator`,
/// or from `nemoclaw-fixture-provider`.
///
/// Cargo sets `CARGO_BIN_EXE_*` only for a package's own tests, so other
/// packages find these beside their test executables: Cargo writes test
/// executables to the target's `deps` directory and binaries to its parent,
/// and nextest extracts an archive with the same layout.
#[must_use]
pub fn fixture_executable(name: &str) -> std::path::PathBuf {
    let current = std::env::current_exe().unwrap();
    let path = current
        .parent()
        .and_then(std::path::Path::parent)
        .unwrap()
        .join(executable(name));
    assert!(
        path.is_file(),
        "{} is missing; build it with cargo build -p nemoclaw-test-fixtures -p nemoclaw-fixture-provider",
        path.display()
    );
    path
}

/// `name` as an executable on this platform.
pub fn executable(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}

/// PATH with `bin` first.
pub fn path_with(bin: &std::path::Path) -> std::ffi::OsString {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::join_paths(std::iter::once(bin.to_owned()).chain(std::env::split_paths(&path)))
        .unwrap()
}
