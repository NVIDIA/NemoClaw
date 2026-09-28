// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Curated public types for the high-level SDK surface.
//!
//! These types intentionally diverge from the raw protobuf shapes so future
//! language bindings (TypeScript via napi, Python via `PyO3`) can render them
//! idiomatically. In particular, enum-valued fields use Rust enums that map
//! to string literals in TypeScript rather than numeric proto enums; nested
//! `Option<...>` chains from proto are flattened where one of the wrappers
//! is structurally meaningless.
//!
//! The raw proto clients are still accessible via [`crate::raw`] as an
//! escape hatch for callers who need fields not exposed here.

use openshell_core::proto;
use std::collections::HashMap;
use std::time::Duration;

/// Missing targets are errors unless explicitly allowed.
#[derive(Clone, Copy, Debug, Default)]
pub struct DeleteOptions {
    pub allow_missing: bool,
}

/// A deletion acknowledgement is not necessarily completion.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum DeletionOutcome {
    Unspecified,
    Completed,
    Accepted,
    AlreadyAbsent,
    Unknown(i32),
}

impl From<i32> for DeletionOutcome {
    fn from(value: i32) -> Self {
        match proto::DeletionOutcome::try_from(value) {
            Ok(proto::DeletionOutcome::Unspecified) => Self::Unspecified,
            Ok(proto::DeletionOutcome::Completed) => Self::Completed,
            Ok(proto::DeletionOutcome::Accepted) => Self::Accepted,
            Ok(proto::DeletionOutcome::AlreadyAbsent) => Self::AlreadyAbsent,
            Err(_) => Self::Unknown(value),
        }
    }
}

#[test]
fn deletion_outcomes_preserve_unknown_values() {
    assert_eq!(DeletionOutcome::from(0), DeletionOutcome::Unspecified);
    assert_eq!(DeletionOutcome::from(1), DeletionOutcome::Completed);
    assert_eq!(DeletionOutcome::from(2), DeletionOutcome::Accepted);
    assert_eq!(DeletionOutcome::from(3), DeletionOutcome::AlreadyAbsent);
    assert_eq!(DeletionOutcome::from(99), DeletionOutcome::Unknown(99));
}

/// Result for the original target, never a same-name replacement.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeletionResult {
    pub outcome: DeletionOutcome,
    /// Present for sandbox deletions that found a target.
    pub sandbox_id: Option<String>,
}

/// Gateway health snapshot.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub struct Health {
    pub status: ServiceStatus,
    pub version: String,
}

/// Coarse gateway service status.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum ServiceStatus {
    Unspecified,
    Healthy,
    Degraded,
    Unhealthy,
}

impl From<proto::ServiceStatus> for ServiceStatus {
    fn from(value: proto::ServiceStatus) -> Self {
        match value {
            proto::ServiceStatus::Healthy => Self::Healthy,
            proto::ServiceStatus::Degraded => Self::Degraded,
            proto::ServiceStatus::Unhealthy => Self::Unhealthy,
            proto::ServiceStatus::Unspecified => Self::Unspecified,
        }
    }
}

impl From<i32> for ServiceStatus {
    fn from(value: i32) -> Self {
        proto::ServiceStatus::try_from(value).map_or(Self::Unspecified, Self::from)
    }
}

/// High-level sandbox lifecycle phase.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum SandboxPhase {
    Unspecified,
    Provisioning,
    Ready,
    Error,
    Deleting,
    Unknown,
    Stopping,
    Stopped,
    Starting,
    Completed,
}

impl From<proto::SandboxPhase> for SandboxPhase {
    fn from(value: proto::SandboxPhase) -> Self {
        match value {
            proto::SandboxPhase::Unspecified => Self::Unspecified,
            proto::SandboxPhase::Provisioning => Self::Provisioning,
            proto::SandboxPhase::Ready => Self::Ready,
            proto::SandboxPhase::Error => Self::Error,
            proto::SandboxPhase::Deleting => Self::Deleting,
            proto::SandboxPhase::Unknown => Self::Unknown,
            proto::SandboxPhase::Stopping => Self::Stopping,
            proto::SandboxPhase::Stopped => Self::Stopped,
            proto::SandboxPhase::Starting => Self::Starting,
            proto::SandboxPhase::Completed => Self::Completed,
        }
    }
}

impl From<i32> for SandboxPhase {
    fn from(value: i32) -> Self {
        proto::SandboxPhase::try_from(value).map_or(Self::Unspecified, Self::from)
    }
}

/// Caller intent for a new sandbox.
///
/// Only the most commonly used fields are exposed. Callers that need the
/// full proto surface (volume claim templates, runtime classes, struct
/// resources, etc.) should drop down to [`crate::raw`].
#[derive(Clone, Debug, Default)]
pub struct SandboxSpec {
    /// Optional user-supplied sandbox name. When empty the server generates one.
    pub name: Option<String>,
    /// Container image reference (e.g. `ghcr.io/nvidia/openshell-community/sandboxes/python:latest`).
    pub image: Option<String>,
    /// Labels attached to the sandbox.
    pub labels: HashMap<String, String>,
    /// Environment variables injected into the sandbox runtime.
    pub environment: HashMap<String, String>,
    /// Provider names to attach.
    pub providers: Vec<String>,
    /// Request a GPU. Driver-specific device selection is configured via
    /// driver config on the raw proto surface (see [`crate::raw`]).
    pub gpu: bool,
    /// Exact canonical command. Empty selects the gateway's scratch login shell.
    pub command: Vec<String>,
    /// Allocate a retained pseudo-terminal for the canonical command.
    pub tty: bool,
}

/// Caller intent for creating a sandbox from a named workload template.
#[derive(Clone, Debug, Default)]
pub struct SandboxTemplateCreateSpec {
    /// Optional user-supplied sandbox name. When empty the server generates one.
    pub name: Option<String>,
    /// Workspace-scoped template name to resolve at creation time.
    pub template_name: String,
    /// Labels attached to the sandbox.
    pub labels: HashMap<String, String>,
    /// Provider names to attach.
    pub providers: Vec<String>,
    /// Exact canonical command. Empty selects the gateway's scratch login shell.
    pub command: Vec<String>,
    /// Allocate a retained pseudo-terminal for the canonical command.
    pub tty: bool,
    /// Create-time sandbox policy. The named workload template supplies runtime
    /// workload fields; policy remains part of the sandbox's governance spec.
    pub policy: Option<proto::SandboxPolicy>,
}

/// Reusable sandbox workload template resource.
///
/// This is a raw proto alias because template specs intentionally expose the
/// full portable workload shape plus driver-owned config.
pub type SandboxWorkloadTemplate = proto::SandboxWorkloadTemplate;

/// Desired reusable workload shape for a [`SandboxWorkloadTemplate`].
pub type SandboxWorkloadTemplateSpec = proto::SandboxWorkloadTemplateSpec;

/// Portable sandbox workload configuration for template-backed sandboxes.
pub type SandboxWorkloadConfig = proto::SandboxWorkloadConfig;

/// Portable resource requirements for template-backed sandboxes.
pub type SandboxResources = proto::SandboxResources;

/// Desired service level for sandboxes created from a template.
pub type SandboxServiceLevel = proto::SandboxServiceLevel;

/// Startup service-level settings for template-backed sandboxes.
pub type SandboxStartup = proto::SandboxStartup;

/// Options for listing reusable sandbox templates.
#[derive(Clone, Debug, Default)]
pub struct SandboxTemplateListOptions {
    /// Maximum templates requested per page. `0` uses the server default.
    pub page_size: i32,
    /// Opaque token from a previous page. Empty starts at the beginning.
    pub page_token: String,
    /// Optional label selector in `key=value,key2=value2` form.
    pub label_selector: String,
}

/// Reference to a sandbox owned by the gateway.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub struct SandboxRef {
    pub id: String,
    pub name: String,
    pub workspace: String,
    pub phase: SandboxPhase,
    pub labels: HashMap<String, String>,
    pub resource_version: u64,
    pub exit_code: Option<i32>,
    pub created_from_workload_template: Option<SandboxWorkloadTemplateProvenance>,
}

/// Reusable workload template revision used to create a sandbox.
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub struct SandboxWorkloadTemplateProvenance {
    pub name: String,
    pub resource_version: String,
}

impl SandboxRef {
    pub(crate) fn from_proto(sandbox: proto::Sandbox) -> Self {
        let phase = sandbox.phase().into();
        let exit_code = sandbox.status.as_ref().and_then(|status| status.exit_code);
        let created_from_workload_template =
            sandbox
                .created_from_workload_template
                .map(|p| SandboxWorkloadTemplateProvenance {
                    name: p.name,
                    resource_version: p.resource_version,
                });
        let meta = sandbox.metadata.unwrap_or_default();
        Self {
            id: meta.id,
            name: meta.name,
            workspace: meta.workspace,
            phase,
            labels: meta.labels,
            resource_version: meta.resource_version,
            exit_code,
            created_from_workload_template,
        }
    }
}

/// Reference to a workspace on the gateway.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub struct WorkspaceRef {
    pub name: String,
    pub phase: String,
    pub labels: HashMap<String, String>,
}

impl WorkspaceRef {
    pub(crate) fn from_proto(workspace: proto::Workspace) -> Self {
        let meta = workspace.metadata.unwrap_or_default();
        let phase = workspace
            .status
            .and_then(|s| proto::datamodel::v1::WorkspacePhase::try_from(s.phase).ok())
            .map_or("Unknown", |p| match p {
                proto::datamodel::v1::WorkspacePhase::Unspecified => "Unspecified",
                proto::datamodel::v1::WorkspacePhase::Active => "Active",
                proto::datamodel::v1::WorkspacePhase::Terminating => "Terminating",
            });
        Self {
            name: meta.name,
            phase: phase.to_string(),
            labels: meta.labels,
        }
    }
}

/// Options for listing sandboxes.
#[derive(Clone, Debug, Default)]
pub struct ListOptions {
    /// Maximum resources requested per page. `0` uses the server default.
    pub page_size: i32,
    /// Opaque token from a previous page. Empty starts at the beginning.
    pub page_token: String,
    /// Optional Kubernetes-style label selector (e.g. `env=prod,team=core`).
    pub label_selector: Option<String>,
}

/// Options for [`crate::client::OpenShellClient::exec`].
#[derive(Clone, Debug, Default)]
pub struct ExecOptions {
    /// Working directory inside the sandbox.
    pub workdir: Option<String>,
    /// Environment overrides for the exec.
    pub environment: HashMap<String, String>,
    /// Optional command timeout. `None` lets the gateway choose.
    pub timeout: Option<Duration>,
    /// Optional stdin payload.
    pub stdin: Option<Vec<u8>>,
    /// Skip sourcing shell login/profile startup files before the command.
    /// Default (`false`) preserves login-shell behavior.
    pub no_login_shell: bool,
}

/// Result of a non-streaming exec call.
///
/// `stdout` and `stderr` are buffered to the end of the command. Use the
/// raw streaming RPC ([`crate::raw`]) for long-running output.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
