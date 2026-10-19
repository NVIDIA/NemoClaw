// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The contract between compiled graphs and the backends that reconcile them:
//! attribute rows, mutation outcomes, bindings, and safe diagnostics.

mod contract;
mod endpoint;
mod error;
mod identity;
mod observation;
mod secrets;

pub use contract::{Backend, Mutation, Row};
pub use endpoint::{validate_endpoint, validate_endpoint_url};
pub use error::Error;
pub use identity::{generate_generation, generate_owner};
pub use nemoclaw_runtime::config::ConfigError;
pub use observation::{Binding, Bound, Observation, ObservationError, ObservationStatus, refresh};
pub use secrets::{EnvironmentSecrets, Secrets};

/// Names the directory, in the deployment's private state, where providers
/// keep a backend's own message about a failed operation. Only the SDK sets
/// it: configurations can't name variables with the `NEMOCLAW_INTERNAL_`
/// prefix.
pub const DIAGNOSTICS_ENV: &str = "NEMOCLAW_INTERNAL_DIAGNOSTICS";
