// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[cfg(test)]
mod tests;

mod agent;
mod transport;
use crate::{ObservationError, backend::Row};
pub use agent::{command, environment, policy, policy_matches};
use openshell_core::proto;
pub use transport::{EnvironmentSecrets, OpenShell, Secrets};

pub const OWNER: &str = "nemoclaw.nvidia.com/uid";
pub const GENERATION: &str = "nemoclaw.nvidia.com/generation";
pub const CREDENTIAL: &str = "nemoclaw.nvidia.com/credential-env";
pub const AGENT: &str = "nemoclaw.nvidia.com/agent";
pub const AGENT_RUNTIME: &str = "nemoclaw.nvidia.com/agent-runtime";

fn remote_error(status: tonic::Status) -> ObservationError {
    match status.code() {
        tonic::Code::Unauthenticated => ObservationError::Authentication,
        tonic::Code::PermissionDenied => ObservationError::Permission,
        tonic::Code::Unavailable | tonic::Code::DeadlineExceeded | tonic::Code::Cancelled => {
            ObservationError::Transport
        }
        _ => ObservationError::Query,
    }
}
fn authoritative<T>(
    result: Result<tonic::Response<T>, tonic::Status>,
) -> Result<Option<T>, ObservationError> {
    match result {
        Ok(response) => Ok(Some(response.into_inner())),
        Err(status) if status.code() == tonic::Code::NotFound => Ok(None),
        Err(status) => Err(remote_error(status)),
    }
}
fn base(
    meta: Option<proto::ObjectMeta>,
    name: &str,
    removing: bool,
) -> Result<Row, ObservationError> {
    let meta = meta.ok_or(ObservationError::Incomplete)?;
    if meta.name != name || (!removing && meta.deletion_timestamp_ms != 0) {
        return Err(ObservationError::BindingMismatch);
    }
    let row: Row = [
        ("id", meta.id),
        ("name", meta.name),
        ("owner", meta.labels.get(OWNER).cloned().unwrap_or_default()),
        (
            "generation",
            meta.labels.get(GENERATION).cloned().unwrap_or_default(),
        ),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v))
    .collect();
    if row.values().any(String::is_empty) {
        return Err(ObservationError::Incomplete);
    }
    Ok(row)
}
fn workspace_row(
    response: proto::GetWorkspaceResponse,
    name: &str,
    removing: bool,
) -> Result<Row, ObservationError> {
    let workspace = response.workspace.ok_or(ObservationError::Incomplete)?;
    let phase = workspace.status.ok_or(ObservationError::Incomplete)?.phase;
    if phase != 1 && !(removing && phase == 2) {
        return Err(ObservationError::Incomplete);
    }
    base(workspace.metadata, name, removing)
}
fn provider_row(
    response: proto::ProviderResponse,
    name: &str,
    removing: bool,
) -> Result<Row, ObservationError> {
    let provider = response.provider.ok_or(ObservationError::Incomplete)?;
    if !matches!(provider.r#type.as_str(), "openai" | "anthropic") {
        return Err(ObservationError::Incomplete);
    }
    let credential = provider
        .metadata
        .as_ref()
        .and_then(|m| m.labels.get(CREDENTIAL))
        .cloned()
        .unwrap_or_default();
    let mut row = base(provider.metadata, name, removing)?;
    let key = if provider.r#type == "anthropic" {
        "ANTHROPIC_BASE_URL"
    } else {
        "OPENAI_BASE_URL"
    };
    let endpoint = provider
        .config
        .get(key)
        .filter(|v| !v.is_empty())
        .ok_or(ObservationError::Incomplete)?;
    row.insert("endpoint".into(), endpoint.clone());
    row.insert("credential_env".into(), credential);
    row.insert(
        "provider_type".into(),
        if provider.r#type == "anthropic" {
            "anthropic"
        } else {
            ""
        }
        .into(),
    );
    Ok(row)
}
fn sandbox_row(
    response: proto::SandboxResponse,
    name: &str,
    removing: bool,
) -> Result<(Row, bool), ObservationError> {
    let sandbox = response.sandbox.ok_or(ObservationError::Incomplete)?;
    let meta = sandbox
        .metadata
        .as_ref()
        .ok_or(ObservationError::Incomplete)?;
    let agent = meta
        .labels
        .get(AGENT)
        .filter(|v| !v.is_empty())
        .ok_or(ObservationError::Incomplete)?;
    let runtime = meta.labels.get(AGENT_RUNTIME).cloned().unwrap_or_default();
    if !runtime.is_empty()
        && !runtime
            .strip_prefix("fabric-")
            .is_some_and(crate::config::is_fabric_harness)
    {
        return Err(ObservationError::Incomplete);
    }
    let spec = sandbox.spec.ok_or(ObservationError::Incomplete)?;
    let image = spec.template.ok_or(ObservationError::Incomplete)?.image;
    if image.is_empty()
        || spec.command != command(&runtime)
        || spec.environment.into_iter().collect::<Row>() != environment(agent, &runtime)
        || !spec.policy.as_ref().is_some_and(policy_matches)
    {
        return Err(ObservationError::BindingMismatch);
    }
    let phase = sandbox.status.ok_or(ObservationError::Incomplete)?.phase;
    let phase = proto::SandboxPhase::try_from(phase).map_err(|_| ObservationError::Incomplete)?;
    if phase == proto::SandboxPhase::Unspecified {
        return Err(ObservationError::Incomplete);
    }
    let ready = phase == proto::SandboxPhase::Ready && meta.deletion_timestamp_ms == 0;
    let mut row = base(sandbox.metadata.clone(), name, removing)?;
    row.insert("agent_name".into(), agent.clone());
    row.insert("agent_runtime".into(), runtime);
    row.insert("image".into(), image);
    // Phase is used by active checks, but is not a Terraform schema attribute.
    Ok((row, ready))
}
fn active_policy(response: proto::GetSandboxPolicyStatusResponse) -> Result<(), ObservationError> {
    let revision = response.revision.ok_or(ObservationError::Incomplete)?;
    if response.active_version == 0
        || response.active_version != revision.version
        || revision.status != proto::PolicyStatus::Loaded as i32
        || !revision.policy.as_ref().is_some_and(policy_matches)
    {
        return Err(ObservationError::Incomplete);
    }
    Ok(())
}

mod mutation;
pub fn verify_identity(expected: &Row, observed: &Row) -> Result<(), ObservationError> {
    for field in ["owner", "generation"] {
        if expected.get(field).is_none_or(String::is_empty)
            || expected.get(field) != observed.get(field)
        {
            return Err(ObservationError::BindingMismatch);
        }
    }
    if expected.get("id").is_some_and(|id| !id.is_empty())
        && expected.get("id") != observed.get("id")
    {
        return Err(ObservationError::BindingMismatch);
    }
    Ok(())
}
mod probes;
