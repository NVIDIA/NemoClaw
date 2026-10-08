// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Bindings, observations, and the safe diagnostic categories backends report.

use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    owner: String,
    generation: String,
    id: String,
}

impl Binding {
    /// Construct a complete binding from non-secret backend identifiers.
    pub fn new(owner: &str, generation: &str, id: &str) -> Result<Self, ObservationError> {
        if [owner, generation, id].iter().any(|part| part.is_empty()) {
            return Err(ObservationError::Incomplete);
        }
        Ok(Self {
            owner: owner.into(),
            generation: generation.into(),
            id: id.into(),
        })
    }

    pub fn owner(&self) -> &str {
        &self.owner
    }
    pub fn generation(&self) -> &str {
        &self.generation
    }
    pub fn id(&self) -> &str {
        &self.id
    }
}

/// Complete, non-secret observed configuration and its durable binding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bound<T> {
    pub binding: Binding,
    pub configuration: T,
}

/// A successful observation. Backend adapters must verify response completeness
/// before constructing `Present`. Only authoritative object absence permits
/// `Absent`; an empty, partial, or failed query is not absence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Observation<T> {
    Present(Bound<T>),
    Absent,
}

/// Safe diagnostic categories. Raw backend messages can contain credentials and
/// must not be copied into public errors.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObservationError {
    Authentication,
    Permission,
    Transport,
    Query,
    Extension,
    Incomplete,
    BindingMismatch,
    /// A fixed, non-secret diagnostic from an owning backend.
    Backend(&'static str),
    Hardware(nemoclaw_runtime::hardware::HardwareDiagnostic),
    FabricConfiguration {
        stage: &'static str,
        code: &'static str,
        runtime_state: &'static str,
    },
    SandboxConfigurationRejected {
        reason: &'static str,
    },
    SandboxStartup {
        phase: &'static str,
        reason: &'static str,
        exit_code: Option<i32>,
    },
}

impl fmt::Display for ObservationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SandboxConfigurationRejected { reason } => write!(
                f,
                "OpenShell configuration rejected: {reason}; resources retained"
            ),
            Self::SandboxStartup {
                phase,
                reason,
                exit_code,
            } => write!(
                f,
                "sandbox unavailable: {phase}, reason {reason}, exit code {}{}; resources retained",
                exit_code.map_or_else(|| "unknown".into(), |code| code.to_string()),
                crate::error::sandbox_startup_guidance(reason)
            ),
            Self::FabricConfiguration {
                stage,
                code,
                runtime_state,
            } => write!(
                f,
                "Fabric runtime operation failed at {stage} ({code}); agent runtime is {runtime_state}; resources retained"
            ),
            Self::Hardware(diagnostic) => diagnostic.fmt(f),
            Self::Backend(message) => f.write_str(message),
            Self::Authentication => f.write_str("observation authentication failed"),
            Self::Permission => f.write_str("observation permission denied"),
            Self::Transport => f.write_str("observation transport failed"),
            Self::Query => f.write_str("observation query failed"),
            Self::Extension => f.write_str("observation extension failed"),
            Self::Incomplete => f.write_str("observation is incomplete"),
            Self::BindingMismatch => {
                f.write_str("observed ownership, generation, or durable identity changed")
            }
        }
    }
}

impl std::error::Error for ObservationError {}

/// Validate an observation against retained state without consuming that state.
///
/// `Ok(None)` alone authorizes retiring the binding. Errors must stop planning;
/// callers retain prior state. Configuration changes remain visible as drift.
pub fn refresh<T>(
    prior: &Bound<T>,
    observation: Result<Observation<T>, ObservationError>,
) -> Result<Option<Bound<T>>, ObservationError> {
    match observation? {
        Observation::Absent => Ok(None),
        Observation::Present(observed) => {
            if observed.binding != prior.binding {
                return Err(ObservationError::BindingMismatch);
            }
            Ok(Some(observed))
        }
    }
}
