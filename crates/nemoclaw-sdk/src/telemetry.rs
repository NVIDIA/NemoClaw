// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! NemoClaw's telemetry switch, which the CLI's record and the OpenShell
//! telemetry of a gateway NemoClaw manages both follow.

use std::ffi::OsStr;

/// The off switch: set, it turns NemoClaw's telemetry off.
pub const DISABLE_ENV: &str = "NEMOCLAW_DISABLE_TELEMETRY";

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
