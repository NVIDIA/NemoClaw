// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! A fake OpenShell gateway, owned OpenTofu workspaces, the bundle they run,
//! fixture executables, and schema snapshots, shared by the provider tests and
//! the end-to-end tests.
pub mod bundle;
#[path = "../../test-support/http.rs"]
pub mod http;
pub mod middleware;
pub mod openshell;
pub mod schema;
pub mod ssh;
pub mod tofu;

pub use bundle::Bundle;
pub use http::fixture_executable;

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
