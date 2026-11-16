// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! A fake OpenShell gateway, owned OpenTofu workspaces, the bundle they run,
//! fixture executables, and schema snapshots, shared by the provider tests and
//! the end-to-end tests.
pub mod bundle;
#[path = "../../test-support/http.rs"]
pub mod http;
pub mod openshell;
pub mod schema;
pub mod ssh;
pub mod tofu;

pub use bundle::Bundle;

/// The fake `ssh` relay.
#[must_use]
pub fn ssh_relay() -> std::path::PathBuf {
    fixture_executable("nemoclaw-fixture-ssh")
}

/// A fixture executable from this crate, such as `nemoclaw-fixture-ssh-simulator`,
/// or from `nemoclaw-fixture-provider`, in the directory `NEMOCLAW_TEST_FIXTURES`
/// names.
///
/// Cargo sets `CARGO_BIN_EXE_*` only for a package's own tests, so the test
/// runner names the directory: `cargo ci` sets it to `target/debug`, where
/// Cargo puts a build's executables.
#[must_use]
pub fn fixture_executable(name: &str) -> std::path::PathBuf {
    let directory = std::env::var_os("NEMOCLAW_TEST_FIXTURES").expect(
        "set NEMOCLAW_TEST_FIXTURES to the absolute path of the fixture executables, such as target/debug after cargo build -p nemoclaw-test-fixtures -p nemoclaw-fixture-provider",
    );
    let path = std::path::Path::new(&directory).join(executable(name));
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
