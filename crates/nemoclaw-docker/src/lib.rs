// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Docker and Podman engines: the read and file client over a local socket or
//! SSH, retained volume identity and ownership, and managed service credentials.

pub mod credentials;
mod endpoint;
#[cfg(feature = "client")]
mod engine;
#[cfg(all(test, feature = "client"))]
mod fixture;
#[cfg(feature = "client")]
mod ssh;
mod storage;

pub use endpoint::validate_engine_endpoint;
#[cfg(feature = "client")]
pub use engine::{Direct, Engine, Engines, archive, is_missing, optional, remote};
#[cfg(feature = "client")]
pub use ssh::command as ssh_command;
pub use storage::{GENERATION_LABEL, OWNER_LABEL, Storage};
#[cfg(feature = "client")]
pub use storage::{ensure_storage, observe_storage};
