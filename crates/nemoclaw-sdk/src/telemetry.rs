// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! NemoClaw's telemetry switch, which the CLI's record and the OpenShell
//! telemetry of a gateway NemoClaw manages both follow.

use std::ffi::OsStr;

/// The off switch: set, it turns NemoClaw's telemetry off.
pub const DISABLE_ENV: &str = "NEMOCLAW_DISABLE_TELEMETRY";

/// Any of these, set, means the run is in CI, where NemoClaw's telemetry is
/// off as if the off switch were set.
pub const CI_VARIABLES: [&str; 6] = [
    "CI",
    "GITHUB_ACTIONS",
    "TF_BUILD",
    "BUILD_ID",
    "TEAMCITY_VERSION",
    "CODEBUILD_BUILD_ID",
];

/// Whether a variable that turns something off is set: present, not empty,
/// and not `false` or `0` in any letter case. Someone who sets one wants it
/// off, so `1`, `yes`, `TRUE`, and a typo all count.
pub fn is_set(value: Option<&OsStr>) -> bool {
    value.map(OsStr::to_string_lossy).is_some_and(|value| {
        !value.is_empty() && !value.eq_ignore_ascii_case("false") && value != "0"
    })
}

/// Whether [`DISABLE_ENV`] turns telemetry off for this process.
pub fn disabled() -> bool {
    is_set(std::env::var_os(DISABLE_ENV).as_deref())
}

/// Whether NemoClaw's telemetry is off for this process: [`DISABLE_ENV`] or
/// one of the [`CI_VARIABLES`] is set.
pub fn suppressed() -> bool {
    std::iter::once(&DISABLE_ENV)
        .chain(&CI_VARIABLES)
        .any(|name| is_set(std::env::var_os(name).as_deref()))
}
