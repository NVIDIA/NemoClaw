// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! A fake OpenShell gateway and owned OpenTofu workspaces, shared by the
//! provider contract tests and the end-to-end tests.
pub mod openshell;
pub mod tofu;

/// `name` as an executable on this platform.
pub fn executable(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}
