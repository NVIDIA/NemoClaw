// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Programmatic desired-state contracts shared by NemoClaw consumers.
//!
//! Backend mutation belongs to the provider, outside the SDK API:
//!
//! ```compile_fail
//! use nemoclaw_sdk::openshell::OpenShell;
//! let _ = OpenShell::connect;
//! ```
//!
//! Download callbacks are delivered through deployment progress:
//!
//! ```compile_fail
//! use nemoclaw_sdk::with_download_progress;
//! ```
//!
//! Engine operations are implemented by the bundled provider:
//!
//! ```compile_fail
//! use nemoclaw_sdk::docker::Engine;
//! ```

use std::fmt;

pub mod fabric_capabilities;
pub mod fabric_catalog;
pub mod fabric_config;
pub mod image_metadata;
pub mod image_runtime;

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

/// Diagnostic categories and explicitly bounded, redacted backend rejections.
#[derive(Clone, Debug, PartialEq, Eq)]
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
    Rejected {
        operation: &'static str,
        code: &'static str,
        detail: Box<str>,
    },
    ModelRuntimeStopped {
        reason: &'static str,
        exit_code: Option<i32>,
        detail: Box<str>,
    },
    UnrecordedResource {
        kind: String,
        namespace: String,
        name: String,
    },
    Admission {
        kind: String,
        name: String,
        detail: Box<str>,
    },
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
            Self::Rejected {
                operation,
                code,
                detail,
            } => write!(f, "OpenShell {operation} rejected ({code}): {detail}"),
            Self::UnrecordedResource {
                kind,
                namespace,
                name,
            } => write!(
                f,
                "Kubernetes {kind} {namespace}/{name} may have been created before its identity was recorded; verify and remove that object before retrying; resources retained"
            ),
            Self::Admission { kind, name, detail } => {
                write!(f, "Kubernetes rejected {kind} {name}: {detail}")
            }
            Self::ModelRuntimeStopped {
                reason,
                exit_code,
                detail,
            } => {
                if matches!(*reason, "ErrImageNeverPull" | "InvalidImageName") {
                    write!(
                        f,
                        "model runtime cannot start: reason {reason}; storage retained"
                    )
                } else {
                    write!(
                        f,
                        "model runtime stopped: reason {reason}, exit code {}",
                        exit_code.map_or_else(|| "unknown".into(), |code| code.to_string())
                    )?;
                    if !detail.is_empty() {
                        write!(f, "; {detail}")?;
                    }
                    f.write_str("; inspect the model Pod logs; storage retained")
                }
            }
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
                error::sandbox_startup_guidance(reason)
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

impl ObservationError {
    /// Bound backend diagnostics and remove credentials before they enter public errors.
    pub fn sanitized_detail(detail: &str) -> Box<str> {
        use std::sync::OnceLock;
        static CREDENTIALS: OnceLock<regex::Regex> = OnceLock::new();
        static BEARER: OnceLock<regex::Regex> = OnceLock::new();
        static TOKENS: OnceLock<regex::Regex> = OnceLock::new();
        let printable: String = detail
            .chars()
            .map(|character| {
                if character.is_ascii_graphic() || character == ' ' {
                    character
                } else {
                    ' '
                }
            })
            .collect();
        let bearer = BEARER.get_or_init(|| {
            regex::Regex::new(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+")
                .expect("constant diagnostic bearer pattern")
        });
        let credentials = CREDENTIALS.get_or_init(|| {
            regex::Regex::new(r#"(?i)["']?(?:authorization|api[_-]?key|token|password|secret)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)"#)
                .expect("constant diagnostic credential pattern")
        });
        let tokens = TOKENS.get_or_init(|| {
            regex::Regex::new(r"[A-Za-z0-9_+/=-]{32,}").expect("constant diagnostic token pattern")
        });
        // Redact Bearer first: a key/value match alone would consume only the scheme.
        let hidden = bearer.replace_all(&printable, "[REDACTED]");
        let hidden = credentials.replace_all(&hidden, "[REDACTED]");
        let hidden = tokens.replace_all(&hidden, "[REDACTED]");
        let mut result = hidden.split_whitespace().collect::<Vec<_>>().join(" ");
        if result.len() > 1024 {
            result.truncate(1021);
            result.push_str("...");
        }
        result.into_boxed_str()
    }
}

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
mod secrets;
pub use secrets::{EnvironmentSecrets, Secrets};
mod gateway_observation;
#[doc(hidden)]
pub mod services;
mod state;
pub use error::Error;
pub mod bundle;
mod process;
pub use tokio_util::sync::CancellationToken;
mod deployment;
pub use deployment::{
    Change, Deployment, DeploymentConnection, DiscoveryObservation, DiscoveryReport,
    DiscoveryScope, DiscoveryTarget, OperationResult, Outcome, PlanObservation, Progress,
    ReportedObservation, ResourceInventoryEntry, ResourceSource, StepOutcome,
};

pub mod managed;

pub mod kubernetes;

pub mod hardware_discovery;

mod tofu_ui;

mod download;
pub use download::{ByteProgress, DownloadPhase, DownloadProgress};

mod docker_compute;

/// What a deployment needs to know about its target, and what each read reports.
pub mod discovery;

mod discovery_graph;

/// Read-only inference metadata and direct credential availability.
pub mod inference_discovery;
