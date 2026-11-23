// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! CLI integration tests, linked into one binary.
//! Each file is a module; shared helpers are declared once here.

#[path = "commands.rs"]
mod commands;
#[cfg(unix)]
#[path = "../../test-support/executable.rs"]
mod executable;
#[path = "exit_guards.rs"]
mod exit_guards;
#[path = "output_modes.rs"]
mod output_modes;
