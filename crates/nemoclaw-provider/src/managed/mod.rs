// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
mod podman;
pub use nemoclaw_sdk::managed::*;
mod storage;
pub use storage::{ensure_storage, observe_storage};
mod observation;
pub use observation::*;
mod backend;
pub(crate) use backend::service_engine;
mod gateway_storage;
mod keys;
mod mutation;
#[cfg(all(test, unix))]
mod planning_tests;
pub use backend::{ManagedBackend, connection_endpoint, runtime_engine};
