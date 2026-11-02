// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Commands that must fail, which `tofu test` cannot expect: rejected
//! settings, foreign or lost objects, and saved plans rechecked on apply.

mod api;
mod capabilities;
// A managed gateway needs a local engine, which only Unix clients reach.
#[cfg(unix)]
mod gateway_installation;
mod gateway_readiness;
// Managed gateway resources take only a local engine socket, which only Unix
// clients reach.
#[cfg(unix)]
mod gateway_storage;
mod standalone;
