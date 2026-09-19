// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Programmatic desired-state contracts shared by NemoClaw consumers.

use std::fmt;

mod artifact_pins {
    include!(concat!(env!("OUT_DIR"), "/artifact_pins.rs"));
}

/// Identity that must survive refresh, independently of configuration drift.
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
}

impl fmt::Display for ObservationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Backend(message) => message,
            Self::Authentication => "observation authentication failed",
            Self::Permission => "observation permission denied",
            Self::Transport => "observation transport failed",
            Self::Query => "observation query failed",
            Self::Extension => "observation extension failed",
            Self::Incomplete => "observation is incomplete",
            Self::BindingMismatch => "observed ownership, generation, or durable identity changed",
        })
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

pub mod backend;
pub mod compile;
pub mod config;
mod error;
mod health;
pub use health::{RuntimeHealth, SandboxHealth};
pub mod openshell;
#[doc(hidden)]
pub mod services;
mod state;
pub use error::Error;
pub mod bundle;
mod process;
pub use tokio_util::sync::CancellationToken;
mod deployment;
pub use deployment::{Change, Deployment, OperationResult, Outcome, Progress, StepOutcome};

pub mod snapshot;

pub mod docker;

pub mod managed;

pub mod hardware;

mod tofu_ui;

mod download;
pub use download::{
    ByteProgress, DownloadPhase, DownloadProgress, with_download_progress,
    with_provider_download_progress,
};
