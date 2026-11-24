// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The telemetry record of schema 5.0 and its sender, defined in
//! `internal-docs/design/telemetry.md`: one flat record when `apply`, `destroy`,
//! or a configuration-writing `onboard` finishes.
#![allow(
    dead_code,
    reason = "the commands call this module once the sender is wired in"
)]

pub mod gate;
pub mod identity;
pub mod project;
pub mod record;
pub mod send;
