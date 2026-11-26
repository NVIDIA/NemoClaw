// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! CLI integration tests, linked into one binary.
//! Each file is a module; shared helpers are declared once here.

#[cfg(unix)]
#[path = "../../nemoclaw-sdk/tests/support/bundle.rs"]
mod bundle;
#[path = "commands.rs"]
mod commands;
#[cfg(unix)]
#[path = "../../test-support/executable.rs"]
mod executable;
#[path = "exit_guards.rs"]
mod exit_guards;
#[cfg(unix)]
mod openshell;
#[path = "output_modes.rs"]
mod output_modes;
#[path = "telemetry.rs"]
mod telemetry;

/// The built CLI with the telemetry record off. Every test that runs the CLI
/// starts here; `telemetry.rs` turns the record back on for a local receiver.
pub(crate) fn nemoclaw() -> std::process::Command {
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_nemoclaw"));
    command.env("NEMOCLAW_DISABLE_TELEMETRY", "1");
    command
}
