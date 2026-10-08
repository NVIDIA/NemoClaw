// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The contract between compiled graphs and the backends that reconcile them:
//! attribute rows, mutation outcomes, bindings, and safe diagnostics.

mod contract;
mod endpoint;
mod error;
mod observation;
mod secrets;

pub use contract::{Backend, Mutation, Row};
pub use endpoint::validate_endpoint;
pub use error::Error;
pub use nemoclaw_runtime::config::ConfigError;
pub use observation::{Binding, Bound, Observation, ObservationError, refresh};
pub use secrets::{EnvironmentSecrets, Secrets};
