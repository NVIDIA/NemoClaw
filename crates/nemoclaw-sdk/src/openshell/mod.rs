// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[cfg(test)]
mod tests;

mod agent;
pub(crate) use agent::runtime_read_requirements;
mod native_profile;
mod network;
mod profile;
pub use native_profile::definition as inference_profile;
pub use network::policy_json;
mod inference;
use inference::{INFERENCE_ENV, inference_environment, inference_settings};
use network::{launch_command, launch_environment, observed_proxy, row_policy, row_proxy};
mod gateway;
mod transport;
use crate::{ObservationError, backend::Row};
pub use agent::{command, environment, policy, policy_matches};
pub use gateway::GatewayCapabilities;
use openshell_core::proto;
pub use transport::{EnvironmentSecrets, OpenShell, Secrets};

pub const OWNER: &str = "nemoclaw.nvidia.com/uid";
pub const GENERATION: &str = "nemoclaw.nvidia.com/generation";
pub const CREDENTIAL_SOURCE: &str = "nemoclaw.nvidia.com/credential-source";
pub const CREDENTIAL: &str = "nemoclaw.nvidia.com/credential-env";
pub const AGENT: &str = "nemoclaw.nvidia.com/agent";
pub const AGENT_RUNTIME: &str = "nemoclaw.nvidia.com/agent-runtime";

fn remote_error(status: &tonic::Status) -> ObservationError {
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
        Err(status) => Err(remote_error(&status)),
    }
}
fn base(
    meta: Option<proto::ObjectMeta>,
    name: &str,
    removing: bool,
) -> Result<Row, ObservationError> {
    let meta = meta.ok_or(ObservationError::Incomplete)?;
    if meta.name != name || (!removing && meta.deletion_time.is_some()) {
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
    if crate::config::SearchProvider::from_profile(&provider.r#type).is_some() {
        return profile::provider_row(provider, name, removing);
    }
    if provider.r#type != format!("nemoclaw-inference-{name}")
        || provider
            .metadata
            .as_ref()
            .is_none_or(|m| m.workspace.is_empty() || provider.profile_workspace != m.workspace)
    {
        return Err(ObservationError::Incomplete);
    }
    let credential = provider
        .metadata
        .as_ref()
        .and_then(|m| m.labels.get(CREDENTIAL))
        .cloned()
        .unwrap_or_default();
    let metadata = provider
        .metadata
        .as_ref()
        .ok_or(ObservationError::Incomplete)?;
    if metadata.labels.contains_key(CREDENTIAL_SOURCE) {
        return Err(ObservationError::BindingMismatch);
    }
    let source = credential_metadata::unpack(&metadata.annotations)?;
    let mut row = base(provider.metadata, name, removing)?;
    let key = if provider.config.contains_key("ANTHROPIC_BASE_URL") {
        "ANTHROPIC_BASE_URL"
    } else {
        "OPENAI_BASE_URL"
    };
    let endpoint = provider
        .config
        .get(key)
        .filter(|v| !v.is_empty())
        .ok_or(ObservationError::Incomplete)?;
    if !source.is_empty() {
        if !credential.is_empty() {
            return Err(ObservationError::BindingMismatch);
        }
        crate::services::authentication::Source::parse(&source, &row["owner"], endpoint)?;
    }
    row.insert("credential_source".into(), source);
    row.insert("endpoint".into(), endpoint.clone());
    row.insert("credential_env".into(), credential);
    row.insert(
        "provider_type".into(),
        if provider.config.contains_key("ANTHROPIC_BASE_URL") {
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
    if !runtime
        .strip_prefix("fabric-")
        .is_some_and(crate::config::is_fabric_harness)
    {
        return Err(ObservationError::Incomplete);
    }
    let spec = sandbox.spec.ok_or(ObservationError::Incomplete)?;
    let image = spec.template.ok_or(ObservationError::Incomplete)?.image;
    let environment: Row = spec.environment.into_iter().collect();
    let proxy = observed_proxy(&environment)?;
    let inference = environment.get(INFERENCE_ENV).cloned().unwrap_or_default();
    inference_settings(&inference, &runtime)?;
    let mut expected_environment = launch_environment(agent, &runtime, proxy.as_ref());
    if !inference.is_empty() {
        expected_environment.insert(INFERENCE_ENV.into(), inference.clone());
    }
    let policy = policy_json(spec.policy.as_ref().ok_or(ObservationError::Incomplete)?)?;
    let expected_providers = inference::provider_names(&inference, &runtime)?;
    if spec.providers != expected_providers {
        return Err(ObservationError::BindingMismatch);
    }
    if image.is_empty()
        || spec.command != launch_command(&runtime, proxy.as_ref())
        || environment != expected_environment
    {
        return Err(ObservationError::BindingMismatch);
    }
    let phase = sandbox.status.ok_or(ObservationError::Incomplete)?.phase;
    let phase = proto::SandboxPhase::try_from(phase).map_err(|_| ObservationError::Incomplete)?;
    if phase == proto::SandboxPhase::Unspecified {
        return Err(ObservationError::Incomplete);
    }
    let ready = phase == proto::SandboxPhase::Ready && meta.deletion_time.is_none();
    let mut row = base(sandbox.metadata.clone(), name, removing)?;
    row.insert("agent_name".into(), agent.clone());
    row.insert("agent_runtime".into(), runtime);
    row.insert("inference_json".into(), inference);
    row.insert("image".into(), image);
    row.insert("policy_json".into(), policy);
    row.insert(
        "proxy_host".into(),
        proxy.as_ref().map(|p| p.host.clone()).unwrap_or_default(),
    );
    row.insert(
        "proxy_port".into(),
        proxy.map(|p| p.port.to_string()).unwrap_or_default(),
    );
    // Phase is used by active checks, but is not a Terraform schema attribute.
    Ok((row, ready))
}
fn active_policy(
    response: proto::GetSandboxPolicyStatusResponse,
    expected: &str,
) -> Result<(), ObservationError> {
    let revision = response.revision.ok_or(ObservationError::Incomplete)?;
    if response.active_version == 0
        || response.active_version != revision.version
        || revision.status != proto::PolicyStatus::Loaded as i32
        || !network::loaded_policy_matches(
            revision
                .policy
                .as_ref()
                .ok_or(ObservationError::Incomplete)?,
            expected,
        )?
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

pub(crate) mod credential_metadata;
