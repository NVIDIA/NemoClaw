// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Configuration(#[from] crate::config::ConfigError),
    #[error("{0}")]
    Observation(#[from] crate::ObservationError),
    #[error("{0}")]
    State(&'static str),
    #[error("{0}")]
    Bundle(&'static str),
    #[error("Fabric readiness could not be established; resources retained")]
    Health { health: Box<crate::SandboxHealth> },
    #[error("{0}")]
    Conflict(&'static str),
    #[error("gateway is incompatible with this configuration: {0}")]
    GatewayIncompatible(String),
    #[error(
        "sandbox unavailable: {phase}, reason {reason}, exit code {exit_code}; resources retained"
    )]
    SandboxStartup {
        phase: &'static str,
        reason: &'static str,
        exit_code: String,
    },
    #[error("OpenTofu {operation} failed: {diagnostic}")]
    Execution {
        operation: String,
        diagnostic: String,
        /// Data-source postconditions were the only reported apply failures.
        /// Absent for incomplete output or an ambiguous resource operation.
        postcondition_failures: Option<Vec<String>>,
    },
    #[error("operation interrupted; retain state and reapply the same configuration")]
    Cancelled,
    #[error("managed service connection refused; inventory is unknown")]
    ServiceStarting,
    #[error("managed container is absent but owned persistent resources remain")]
    PartialRuntime,
}

impl Error {
    pub(crate) fn into_observation(self) -> crate::ObservationError {
        match self {
            Self::Observation(error) => error,
            Self::SandboxStartup {
                phase,
                reason,
                exit_code,
            } => crate::ObservationError::SandboxStartup {
                phase,
                reason,
                exit_code: exit_code.parse().ok(),
            },
            _ => crate::ObservationError::Query,
        }
    }
}
