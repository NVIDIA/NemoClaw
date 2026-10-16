// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Bindings, observations, and the safe diagnostic categories backends report.

use regex::{Captures, Regex, Replacer};
use std::{fmt, sync::LazyLock};

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
    /// An identity or authored-field mismatch, without expected or observed values.
    KubernetesObjectMismatch {
        kind: String,
        namespace: String,
        name: String,
        field: &'static str,
    },
    /// A fixed, non-secret diagnostic from an owning backend.
    Backend(&'static str),
    Rejected {
        operation: &'static str,
        code: &'static str,
        detail: Box<str>,
    },
    /// The owned model Pod's runtime stopped or cannot start.
    ModelRuntimeStopped {
        namespace: String,
        name: String,
        reason: &'static str,
        exit_code: Option<i32>,
        detail: Box<str>,
    },
    ModelScheduling {
        name: String,
        detail: Box<str>,
    },
    ModelUpdateRefused {
        name: String,
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
            Self::KubernetesObjectMismatch {
                kind,
                namespace,
                name,
                field,
            } => write!(
                f,
                "Kubernetes {} {}/{} does not match its saved binding at {field}; resources retained",
                kind.escape_default(),
                namespace.escape_default(),
                name.escape_default()
            ),
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
            Self::ModelScheduling { name, detail } => write!(
                f,
                "Kubernetes model Pod {} cannot be scheduled: {detail}; resources retained; correct scheduling constraints or capacity and apply again",
                name.escape_default()
            ),
            Self::ModelUpdateRefused { name } => write!(
                f,
                "Kubernetes model Pod {} is preserved by service updatePolicy: Preserve; replacing it requires explicit updatePolicy: Recreate, which permits downtime if the replacement cannot start; Pod, configuration, and saved receipt retained",
                name.escape_default()
            ),
            Self::ModelRuntimeStopped {
                namespace,
                name,
                reason,
                exit_code,
                detail,
            } => {
                write!(
                    f,
                    "Kubernetes model Pod {}/{} ",
                    namespace.escape_default(),
                    name.escape_default()
                )?;
                if matches!(*reason, "ErrImageNeverPull" | "InvalidImageName") {
                    write!(f, "cannot start: reason {reason}; storage retained")
                } else {
                    write!(
                        f,
                        "stopped: reason {reason}, exit code {}",
                        exit_code.map_or_else(|| "unknown".into(), |code| code.to_string())
                    )?;
                    if !detail.is_empty() {
                        write!(f, "; {detail}")?;
                    }
                    f.write_str("; inspect its runtime container logs; storage retained")
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

impl std::error::Error for ObservationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::KubernetesObjectMismatch { .. } => Some(&Self::BindingMismatch),
            _ => None,
        }
    }
}

static BEARER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+").expect("constant diagnostic bearer pattern")
});
static CREDENTIALS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)["']?(?:authorization|api[_-]?key|token|password|secret)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)"#)
        .expect("constant diagnostic credential pattern")
});
static TOKENS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[A-Za-z0-9_+/=-]{32,}").expect("constant diagnostic token pattern")
});

impl ObservationError {
    /// Bound backend diagnostics and remove credentials before they enter public errors.
    pub fn sanitized_detail(detail: &str) -> Box<str> {
        Self::sanitize(detail, "[REDACTED]")
    }

    /// Preserve an exact non-secret resource name obtained from the request or
    /// verified binding, never from the diagnostic. Credential fields remain redacted.
    pub fn sanitized_resource_detail(detail: &str, resource_name: &str) -> Box<str> {
        // Long generated object names resemble tokens. Only the caller's known
        // name is exempt, after credential values have been removed.
        Self::sanitize(detail, |token: &Captures<'_>| {
            if &token[0] == resource_name {
                resource_name
            } else {
                "[REDACTED]"
            }
        })
    }

    fn sanitize(detail: &str, tokens: impl Replacer) -> Box<str> {
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
        // Redact Bearer first: a key/value match alone would consume only the scheme.
        let hidden = BEARER.replace_all(&printable, "[REDACTED]");
        let hidden = CREDENTIALS.replace_all(&hidden, "[REDACTED]");
        let hidden = TOKENS.replace_all(&hidden, tokens);
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

/// Whether a discovery read found what it looked for. `Unknown` is a failed
/// read, never absence.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationStatus {
    Available,
    Unavailable,
    Unknown,
}
