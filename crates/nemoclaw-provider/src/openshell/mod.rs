// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[cfg(test)]
mod tests;

mod agent;
mod agent_configuration;
mod connected;
mod protocol;
pub use protocol::AgentSnapshot;
mod network;
mod profile;
pub use nemoclaw_sdk::config::{inference_profile, policy_json};
mod inference;
use inference::{PROVIDERS_ENV, inference_environment};
use network::{row_policy, validate_row_policy};
mod gateway;
mod transport;
use nemoclaw_sdk::{ObservationError, backend::Row};

use nemoclaw_sdk::config::credential_metadata;
pub use nemoclaw_sdk::{EnvironmentSecrets, Secrets};
use openshell_sdk::raw::proto;
pub use transport::OpenShell;
use transport::{ConnectedOpenShellGateway, SandboxPhase};

pub const OWNER: &str = "nemoclaw.nvidia.com/uid";
pub const GENERATION: &str = "nemoclaw.nvidia.com/generation";
pub use nemoclaw_sdk::config::credential_metadata::CREDENTIAL_SOURCE;
pub const CREDENTIAL: &str = "nemoclaw.nvidia.com/credential-env";
pub const AGENT: &str = "nemoclaw.nvidia.com/agent";
pub const AGENT_RUNTIME: &str = "nemoclaw.nvidia.com/agent-runtime";

use nemoclaw_discovery::gateway::remote_error;
fn sdk_error(error: openshell_sdk::SdkError) -> ObservationError {
    if let Some(status) = error.grpc_status() {
        return remote_error(status);
    }
    match error {
        openshell_sdk::SdkError::Connect { .. } => ObservationError::Transport,
        openshell_sdk::SdkError::Auth { .. } | openshell_sdk::SdkError::Tls { .. } => {
            ObservationError::Authentication
        }
        _ => ObservationError::Incomplete,
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
    if nemoclaw_sdk::config::SearchProvider::from_profile(&provider.r#type).is_some() {
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
        nemoclaw_sdk::services::authentication::Source::parse(&source, &row["owner"], endpoint)?;
    }
    row.insert("profile_name".into(), String::new());
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
) -> Result<(Row, bool, network::ClusterGrants), ObservationError> {
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
    if runtime != "fabric" {
        return Err(ObservationError::Incomplete);
    }
    let spec = sandbox.spec.ok_or(ObservationError::Incomplete)?;
    let image = spec.template.ok_or(ObservationError::Incomplete)?.image;
    let environment: Row = spec.environment.into_iter().collect();
    let inference = environment.get(PROVIDERS_ENV).cloned().unwrap_or_default();
    let runtime_json = meta
        .annotations
        .get(agent::RUNTIME)
        .ok_or(ObservationError::Incomplete)?
        .clone();
    let policy_input = meta
        .annotations
        .get(agent::POLICY)
        .ok_or(ObservationError::Incomplete)?
        .clone();
    let binding = nemoclaw_sdk::image_runtime::RuntimeBinding::from_json(&runtime_json)?;
    let input: nemoclaw_sdk::image_runtime::PolicyInput =
        serde_json::from_str(&policy_input).map_err(|_| ObservationError::Incomplete)?;
    let mut expected_environment = binding.environment(agent);
    if !inference.is_empty() {
        expected_environment.insert(PROVIDERS_ENV.into(), inference.clone());
    }
    let observed_policy = spec.policy.as_ref().ok_or(ObservationError::Incomplete)?;
    let grants = network::recorded_grants(&input, observed_policy)?;
    if policy_json(observed_policy)? != policy_json(&binding.granted_policy(&input, &grants)?)? {
        return Err(ObservationError::BindingMismatch);
    }
    let expected_providers = inference::provider_names(&inference, &runtime)?;
    if spec.providers != expected_providers {
        return Err(ObservationError::BindingMismatch);
    }
    if image.is_empty()
        || spec.command != binding.command("serve", &["--agent", agent])
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
    row.insert("provider_names_json".into(), inference);
    row.insert("image".into(), image);
    row.insert("policy_json".into(), policy_input);
    row.insert("runtime_json".into(), runtime_json);
    // Phase is used by active checks, but is not a Terraform schema attribute.
    Ok((row, ready, grants))
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

async fn checked_sandbox_row_with<F>(
    response: proto::SandboxResponse,
    workspace: &str,
    name: &str,
    removing: bool,
    check: impl FnOnce(Row) -> F,
) -> Result<(Row, bool, network::ClusterGrants), ObservationError>
where
    F: std::future::Future<Output = Result<network::ClusterGrants, ObservationError>>,
{
    let (mut row, ready, grants) = sandbox_row(response, name, removing)?;
    row.insert("workspace".into(), workspace.into());
    if !removing && check(row.clone()).await? != grants {
        return Err(ObservationError::BindingMismatch);
    }
    Ok((row, ready, grants))
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

/// OpenShell objects and their planning rules.
pub(crate) fn definitions() -> [crate::Definition; 5] {
    use crate::{Definition, rerun_when_stopped};
    [
        Definition::new("workspace", &["name", "owner", "generation"], &[]),
        Definition::new(
            "provider",
            &[
                "workspace",
                "name",
                "owner",
                "generation",
                "endpoint",
                "credential_env",
                "provider_type",
                "credential_source",
                "profile_name",
            ],
            // Endpoint and authentication-mode changes also replace the
            // imported profile. Delete the registration first so the API
            // permits profile deletion; ordinary key rotation stays mutable.
            &["credential_env"],
        )
        .optional(&[
            "credential_env",
            "provider_type",
            "credential_source",
            "profile_name",
        ])
        // Omission selects the default, not the previous selection.
        .reset_when_omitted(&["credential_env", "credential_source", "provider_type"])
        .replaces(authentication_mode_changes),
        Definition::new(
            "provider_profile",
            &[
                "workspace",
                "name",
                "owner",
                "generation",
                "endpoint",
                "provider_type",
                "authenticated",
                "binaries_json",
                "cluster_source",
            ],
            &[],
        )
        .optional(&[
            "endpoint",
            "provider_type",
            "authenticated",
            "cluster_source",
        ])
        .reset_when_omitted(&["provider_type", "cluster_source"])
        .bound_fields(&["cluster_source"]),
        Definition::new(
            "sandbox",
            &[
                "workspace",
                "name",
                "owner",
                "generation",
                "image",
                "agent_name",
                "agent_runtime",
                "policy_json",
                "runtime_json",
                "provider_names_json",
            ],
            &[],
        )
        .optional(&["agent_runtime", "policy_json", "provider_names_json"]),
        Definition::new(
            "agent_configuration",
            &[
                "workspace",
                "name",
                "owner",
                "generation",
                "sandbox_id",
                "config_json",
                "running",
            ],
            &["config_json", "running"],
        )
        .computed("running", rerun_when_stopped),
    ]
    .map(lifecycle_rules)
}

/// Retained and stateful objects keep their bindings and refuse replacement.
fn lifecycle_rules(definition: crate::Definition) -> crate::Definition {
    use crate::Protection;
    use nemoclaw_sdk::backend::{OpenShellLifecycle, openshell_lifecycle};
    match openshell_lifecycle(definition.kind) {
        Some(OpenShellLifecycle::Retained) => {
            definition.protect(Protection::Always).refuse_replacement()
        }
        Some(OpenShellLifecycle::Stateful) => definition
            .protect(Protection::UnlessDestroying)
            .refuse_replacement(),
        Some(OpenShellLifecycle::Reconstructible) | None => definition,
    }
}

/// Credential references rotate in place; adding or removing authentication
/// requires replacement.
fn authentication_mode_changes(field: &str, prior: &crate::State, proposed: &crate::State) -> bool {
    field == "credential_env" && authentication_mode(prior) != authentication_mode(proposed)
}

fn authentication_mode(state: &crate::State) -> Option<bool> {
    use tf_provider::value::Value;
    let mut authenticated = false;
    for field in ["credential_env", "credential_source"] {
        match state.get(field) {
            Some(Value::Unknown) => return None,
            Some(Value::Value(value)) => authenticated |= !value.is_empty(),
            Some(Value::Null) | None => {}
        }
    }
    Some(authenticated)
}
