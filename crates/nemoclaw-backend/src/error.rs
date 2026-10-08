// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Configuration(#[from] nemoclaw_runtime::config::ConfigError),
    #[error("{0}")]
    Observation(#[from] crate::ObservationError),
    #[error("{0}")]
    State(&'static str),
    #[error("{0}")]
    Bundle(&'static str),
    #[error("{0}")]
    Conflict(&'static str),
    #[error(
        "ordinary apply cannot {action} sandbox '{sandbox}'; its files and conversation history are not separately retained"
    )]
    SandboxChangeRefused {
        sandbox: String,
        action: &'static str,
    },
    #[error("gateway is incompatible with this configuration: {0}")]
    GatewayIncompatible(String),
    #[error(
        "sandbox unavailable: {phase}, reason {reason}, exit code {exit_code}{guidance}; resources retained",
        guidance = sandbox_startup_guidance(.reason)
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
    pub fn into_observation(self) -> crate::ObservationError {
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

impl From<nemoclaw_runtime::Error> for Error {
    fn from(error: nemoclaw_runtime::Error) -> Self {
        match error {
            nemoclaw_runtime::Error::Configuration(e) => Self::Configuration(e),
            nemoclaw_runtime::Error::Hardware(e) => {
                Self::Observation(crate::ObservationError::Hardware(e))
            }
            nemoclaw_runtime::Error::State(e) => Self::State(e),
            nemoclaw_runtime::Error::Conflict(e) => Self::Conflict(e),
            nemoclaw_runtime::Error::Protection(diagnostic) => Self::Execution {
                operation: "memory protection".into(),
                diagnostic,
                postcondition_failures: None,
            },
            nemoclaw_runtime::Error::Cancelled => Self::Cancelled,
            nemoclaw_runtime::Error::ServiceStarting => Self::ServiceStarting,
            nemoclaw_runtime::Error::Observation(e) => Self::Observation(match e {
                nemoclaw_runtime::ObservationError::Authentication => {
                    crate::ObservationError::Authentication
                }
                nemoclaw_runtime::ObservationError::Permission => {
                    crate::ObservationError::Permission
                }
                nemoclaw_runtime::ObservationError::Query => crate::ObservationError::Query,
                nemoclaw_runtime::ObservationError::Incomplete => {
                    crate::ObservationError::Incomplete
                }
                nemoclaw_runtime::ObservationError::Transport => crate::ObservationError::Transport,
            }),
        }
    }
}

/// Explain only recognized reason codes; gateway message text may contain secrets.
pub(crate) fn sandbox_startup_guidance(reason: &str) -> &'static str {
    match reason {
        "IdentityResolutionFailed" => {
            "; workload user or group could not be resolved in the pinned image; check policy.process.run_as_user and run_as_group"
        }
        "ControlSupervisorStartFailed" => {
            "; control supervisor could not start; check the sandbox policy and attached providers"
        }
        _ => "",
    }
}
