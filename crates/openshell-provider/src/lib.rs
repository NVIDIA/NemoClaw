// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[cfg(test)]
mod fake_gateway_tests;
#[cfg(test)]
mod tests;

pub mod agent;
mod client;
mod composite;
mod connected;
mod driver_config;
mod gateway_source;
mod network;
mod profile;
mod provider;
mod services;
pub use nemoclaw_openshell::pairs::{inference_rows, web_search_rows};
pub use nemoclaw_openshell::{policy::policy_json, profile::definition as inference_profile};
mod inference;
use inference::{PROVIDERS_ENV, inference_environment};
use network::{row_policy, validate_row_policy};
mod gateway;
mod transport;
use nemoclaw_backend::{ObservationError, Row};

pub use client::{
    GatewayClient, GatewayConfig, GatewayConnection, GatewaySettings, KubernetesConnection,
    KubernetesConnector, OpenShellBackend,
};
pub use gateway_source::{GatewayDataSource, GatewayState, observe_with_wait};
pub use nemoclaw_backend::{EnvironmentSecrets, Secrets};
use nemoclaw_openshell::credential_metadata;
use openshell_sdk::raw::proto;
pub use provider::OpenShellProvider;
use transport::ConnectedOpenShellGateway;
pub use transport::{OpenShell, RESPONSE_LIMIT, SandboxPhase};

/// Deployment-owned inference service identity and credential checks.
#[async_trait::async_trait]
pub trait Services: Send + Sync {
    fn validate_credential_source(
        &self,
        source: &str,
        owner: &str,
        endpoint: &str,
    ) -> Result<(), ObservationError>;
    async fn resolve_credential_source(
        &self,
        source: &str,
        owner: &str,
        endpoint: &str,
    ) -> Result<String, ObservationError>;
    /// Verify the retained source owner, exact endpoint, and authentication mode.
    fn validate_cluster_source(&self, row: &Row) -> Result<(), ObservationError>;
    /// Observe addresses only after verifying the retained Service identity.
    async fn cluster_addresses(&self, row: &Row)
    -> Result<Vec<std::net::IpAddr>, ObservationError>;
}

/// Docker credentials for callers without managed cluster services.
pub struct DockerServices;

#[async_trait::async_trait]
impl Services for DockerServices {
    fn validate_credential_source(
        &self,
        source: &str,
        owner: &str,
        endpoint: &str,
    ) -> Result<(), ObservationError> {
        nemoclaw_docker::credentials::Source::parse(source, owner, endpoint).map(|_| ())
    }

    async fn resolve_credential_source(
        &self,
        source: &str,
        owner: &str,
        endpoint: &str,
    ) -> Result<String, ObservationError> {
        nemoclaw_docker::credentials::resolve(&nemoclaw_docker::credentials::Source::parse(
            source, owner, endpoint,
        )?)
        .await
    }

    fn validate_cluster_source(&self, _: &Row) -> Result<(), ObservationError> {
        Err(ObservationError::BindingMismatch)
    }

    async fn cluster_addresses(&self, _: &Row) -> Result<Vec<std::net::IpAddr>, ObservationError> {
        Err(ObservationError::BindingMismatch)
    }
}

pub const OWNER: &str = "nemoclaw.nvidia.com/uid";
pub const GENERATION: &str = "nemoclaw.nvidia.com/generation";
pub use nemoclaw_openshell::credential_metadata::CREDENTIAL_SOURCE;
pub const CREDENTIAL: &str = "nemoclaw.nvidia.com/credential-env";
pub const AGENT: &str = "nemoclaw.nvidia.com/agent";
pub const AGENT_RUNTIME: &str = "nemoclaw.nvidia.com/agent-runtime";

use nemoclaw_openshell::remote_error;
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
    services: &dyn Services,
) -> Result<Row, ObservationError> {
    let provider = response.provider.ok_or(ObservationError::Incomplete)?;
    if provider.r#type == format!("nemoclaw-api-{name}") {
        let metadata = provider
            .metadata
            .as_ref()
            .ok_or(ObservationError::Incomplete)?;
        if metadata.workspace.is_empty()
            || provider.profile_workspace != metadata.workspace
            || provider.config.len() != 1
            || metadata.labels.contains_key(CREDENTIAL_SOURCE)
            || !credential_metadata::unpack(&metadata.annotations)?.is_empty()
        {
            return Err(ObservationError::BindingMismatch);
        }
        let endpoint = provider
            .config
            .get("NEMOCLAW_API_ENDPOINT")
            .filter(|endpoint| !endpoint.is_empty())
            .ok_or(ObservationError::Incomplete)?
            .clone();
        let credential = metadata
            .labels
            .get(CREDENTIAL)
            .filter(|credential| !credential.is_empty())
            .ok_or(ObservationError::Incomplete)?
            .clone();
        let mut row = base(provider.metadata, name, removing)?;
        row.extend([
            ("endpoint".into(), endpoint),
            ("credential_env".into(), credential),
            ("provider_type".into(), "api".into()),
            ("profile_name".into(), provider.r#type),
            ("credential_source".into(), String::new()),
        ]);
        return Ok(row);
    }
    if nemoclaw_openshell::search::SearchProvider::from_profile(&provider.r#type).is_some() {
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
        services.validate_credential_source(&source, &row["owner"], endpoint)?;
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
    let spec = sandbox.spec.ok_or(ObservationError::Incomplete)?;
    let template = spec.template.ok_or(ObservationError::Incomplete)?;
    let driver_config = driver_config::observed(template.driver_config.as_ref());
    let image = template.image;
    let environment: Row = spec.environment.into_iter().collect();
    let inference = environment.get(PROVIDERS_ENV).cloned().unwrap_or_default();
    let launch_json = meta
        .annotations
        .get(agent::LAUNCH)
        .ok_or(ObservationError::Incomplete)?
        .clone();
    let policy_input = meta
        .annotations
        .get(agent::POLICY)
        .ok_or(ObservationError::Incomplete)?
        .clone();
    let launch = nemoclaw_openshell::runtime::Launch::from_json(&launch_json)?;
    let input: nemoclaw_openshell::runtime::PolicyInput =
        serde_json::from_str(&policy_input).map_err(|_| ObservationError::Incomplete)?;
    let mut expected_environment = launch.environment.clone();
    if !inference.is_empty() {
        expected_environment.insert(PROVIDERS_ENV.into(), inference.clone());
    }
    let observed_policy = spec.policy.as_ref().ok_or(ObservationError::Incomplete)?;
    let grants = network::recorded_grants(&input, observed_policy)?;
    if policy_json(observed_policy)? != policy_json(&launch.granted_policy(&input, &grants)?)? {
        return Err(ObservationError::BindingMismatch);
    }
    let expected_providers = inference::provider_names(&inference)?;
    if spec.providers != expected_providers {
        return Err(ObservationError::BindingMismatch);
    }
    if image.is_empty() || spec.command != launch.command || environment != expected_environment {
        return Err(ObservationError::BindingMismatch);
    }
    let phase = sandbox.status.ok_or(ObservationError::Incomplete)?.phase;
    let phase = proto::SandboxPhase::try_from(phase).map_err(|_| ObservationError::Incomplete)?;
    if phase == proto::SandboxPhase::Unspecified {
        return Err(ObservationError::Incomplete);
    }
    let ready = phase == proto::SandboxPhase::Ready && meta.deletion_time.is_none();
    let mut row = base(sandbox.metadata.clone(), name, removing)?;
    row.insert("provider_names_json".into(), inference);
    row.insert("image".into(), image);
    row.insert("driver_config_json".into(), driver_config);
    row.insert("policy_json".into(), policy_input);
    row.insert("launch_json".into(), launch_json);
    // Empty until the loaded policy is observed.
    row.insert(POLICY_HASH.into(), String::new());
    // Empty unless OpenShell reports that the sandbox exited.
    row.insert(EXITED.into(), String::new());
    // Phase is used by active checks, but is not a Terraform schema attribute.
    Ok((row, ready, grants))
}
/// The state attribute recording the loaded policy revision's hash.
pub(crate) const POLICY_HASH: &str = "policy_hash";
/// The state attribute recording why OpenShell reports the sandbox exited:
/// its terminal phase, reason, and exit code. A sandbox that exited plans a
/// replacement.
pub(crate) const EXITED: &str = "exited";

/// The hash of the loaded policy revision, once it keeps every declared rule.
fn active_policy(
    response: proto::GetSandboxPolicyStatusResponse,
    expected: &str,
) -> Result<String, ObservationError> {
    let revision = response.revision.ok_or(ObservationError::Incomplete)?;
    if response.active_version == 0
        || response.active_version != revision.version
        || revision.status != proto::PolicyStatus::Loaded as i32
        || revision.policy_hash.is_empty()
        || !network::loaded_policy_contains(
            revision
                .policy
                .as_ref()
                .ok_or(ObservationError::Incomplete)?,
            expected,
        )?
    {
        return Err(ObservationError::Incomplete);
    }
    Ok(revision.policy_hash)
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

/// A profile's executables change in place only when its observation reported
/// them empty: the profile was missing, and recreating it leaves the
/// registration a sandbox attaches in place. Any other change replaces the
/// resource.
fn binaries_changes(field: &str, prior: &nemoclaw_tofu::State, _: &nemoclaw_tofu::State) -> bool {
    use tf_provider::value::Value;
    field == "binaries_json"
        && !matches!(prior.get(field), Some(Value::Null) | None)
        && !matches!(prior.get(field), Some(Value::Value(value)) if value.is_empty() || value == "[]")
}

/// An inference resource's replacement rule: authentication mode, then
/// executables.
fn inference_changes(
    field: &str,
    prior: &nemoclaw_tofu::State,
    proposed: &nemoclaw_tofu::State,
) -> bool {
    authentication_mode_changes(field, prior, proposed) || binaries_changes(field, prior, proposed)
}

/// Credential references rotate in place; adding or removing authentication
/// requires replacement.
fn authentication_mode_changes(
    field: &str,
    prior: &nemoclaw_tofu::State,
    proposed: &nemoclaw_tofu::State,
) -> bool {
    field == "credential_env" && authentication_mode(prior) != authentication_mode(proposed)
}

fn authentication_mode(state: &nemoclaw_tofu::State) -> Option<bool> {
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

/// The registration a provider row registers: its name.
fn provider_registration(known: &Row, unknown: &[&str]) -> Option<String> {
    (!unknown.contains(&"name")).then(|| known.get("name").cloned().unwrap_or_default())
}

/// The variable sandboxes see an inference registration's key in; empty for
/// a server that needs none.
fn inference_sandbox_env(known: &Row, unknown: &[&str]) -> Option<String> {
    if ["name", "credential_env", "credential_source"]
        .iter()
        .any(|field| unknown.contains(field))
    {
        return None;
    }
    let value = |field: &str| known.get(field).map(String::as_str).unwrap_or_default();
    let authenticated =
        !value("credential_env").is_empty() || !value("credential_source").is_empty();
    Some(if authenticated {
        nemoclaw_openshell::profile::inference_key_env(value("name"))
    } else {
        String::new()
    })
}

/// The registration a web search row registers, derived from the inputs that
/// name it.
fn web_search_registration(known: &Row, unknown: &[&str]) -> Option<String> {
    if ["name", "provider_type", "credential_env"]
        .iter()
        .any(|field| unknown.contains(field))
    {
        return None;
    }
    nemoclaw_openshell::registration_name(composite::WEB_SEARCH, known)
}

/// OpenShell objects and their planning rules.
pub fn definitions() -> [nemoclaw_tofu::Definition; 5] {
    use nemoclaw_tofu::Definition;
    [
        Definition::new("workspace", &["name", "owner", "generation"], &[]),
        Definition::new(
            composite::API,
            &[
                "workspace",
                "name",
                "owner",
                "generation",
                "endpoint",
                "credential_env",
                "binaries_json",
                "auth_style",
                "header_name",
            ],
            &["credential_env", "binaries_json"],
        )
        .optional(&[
            "endpoint",
            "credential_env",
            "binaries_json",
            "auth_style",
            "header_name",
        ])
        .reset_when_omitted(&[
            "endpoint",
            "credential_env",
            "binaries_json",
            "auth_style",
            "header_name",
        ])
        .validate_inputs(composite::validate_api)
        .replaces(binaries_changes)
        .derived("registration", provider_registration),
        // A web search provider's profile and registration, as one resource
        // whose owner is its workspace's. Every input names them, so changes
        // replace. `credential_env` and `binaries` are required by plans,
        // not the schema: an observation reports them empty when their half
        // of the pair is missing, which shows as drift.
        Definition::new(
            composite::WEB_SEARCH,
            &[
                "workspace",
                "name",
                "owner",
                "generation",
                "provider_type",
                "credential_env",
                "sandbox_env",
                "binaries_json",
            ],
            &["binaries_json"],
        )
        .optional(&["credential_env", "sandbox_env", "binaries_json"])
        // Omission selects the default, not the previous value.
        .reset_when_omitted(&["credential_env", "sandbox_env", "binaries_json"])
        .replaces(binaries_changes)
        .derived("registration", web_search_registration),
        // An inference server's profile and registration, as one resource
        // whose owner is its workspace's and whose endpoint and credential
        // come from the server's ref. A rotated credential reference updates
        // in place, since OpenShell refuses to delete a registration a sandbox
        // attaches; adding or removing authentication, or any other change,
        // replaces them. The schema lists the server's fields and `binaries` as
        // optional, and plans require them, for the same reason as web
        // search's.
        Definition::new(
            composite::INFERENCE,
            &[
                "workspace",
                "name",
                "owner",
                "generation",
                "endpoint",
                "credential_env",
                "credential_source",
                "api",
                "binaries_json",
                "cluster_source",
            ],
            &["credential_env", "binaries_json"],
        )
        .optional(&[
            "endpoint",
            "credential_env",
            "credential_source",
            "binaries_json",
            "cluster_source",
        ])
        // Omission selects the default, not the previous value.
        .reset_when_omitted(&[
            "credential_env",
            "credential_source",
            "binaries_json",
            "cluster_source",
        ])
        .replaces(inference_changes)
        .derived("registration", provider_registration)
        .derived("sandbox_env", inference_sandbox_env),
        Definition::new(
            "sandbox",
            &[
                "workspace",
                "name",
                "owner",
                "generation",
                "image",
                "launch_json",
                "policy_json",
                "provider_names_json",
                "driver_config_json",
                services::FIELD,
            ],
            &[],
        )
        // The policy hash is empty until the loaded policy is observed.
        .optional(&[
            "policy_json",
            "provider_names_json",
            "driver_config_json",
            services::FIELD,
            POLICY_HASH,
            EXITED,
        ])
        .validate_inputs(network::validate_grant_names)
        // The URLs of the sandbox's exposures, which are part of its creation.
        .computed(services::URLS, nemoclaw_tofu::carry_prior)
        // The loaded policy's hash, OpenShell's additions included; later
        // observations must find the same one.
        .computed(POLICY_HASH, nemoclaw_tofu::carry_prior)
        // OpenShell doesn't restart an exited sandbox, so it is replaced.
        .computed(EXITED, nemoclaw_tofu::replace_when_observed)
        .replace_on_change(&[EXITED]),
    ]
    .map(lifecycle_rules)
    .map(|mut definition| {
        // Each object names the gateway that holds it; the gateway does not
        // observe how it was reached, so rows carry the connection.
        let gateway = nemoclaw_openshell::GATEWAY_FIELDS.map(|(_, field)| field);
        definition.fields.extend(gateway);
        // Credential and TLS references rotate in place; another endpoint is
        // another gateway, which retained objects refuse.
        definition.mutable.extend(&gateway[1..]);
        definition.optional.extend(&gateway[1..]);
        definition.carried.extend(gateway);
        definition.structured = nemoclaw_openshell::structured_inputs(definition.kind);
        definition.export = nemoclaw_openshell::export(definition.kind);
        definition.references = nemoclaw_openshell::references(definition.kind);
        // Version 1 took refs instead of names; version 2 takes a generic
        // launch instead of a Fabric runtime binding. Earlier state is rejected.
        definition
            .schema_version(2)
            .generated("owner", nemoclaw_backend::generate_owner)
            .generated("generation", nemoclaw_backend::generate_generation)
    })
}

/// Retained objects keep their bindings and refuse replacement.
fn lifecycle_rules(definition: nemoclaw_tofu::Definition) -> nemoclaw_tofu::Definition {
    use nemoclaw_openshell::{OpenShellLifecycle, openshell_lifecycle};
    use nemoclaw_tofu::Protection;
    match openshell_lifecycle(definition.kind) {
        // OpenTofu's prevent_destroy retains a workspace; generated graphs set
        // it. Without it, explicit teardown may delete the workspace.
        Some(OpenShellLifecycle::Retained) => definition
            .protect(Protection::UnlessDestroying)
            .refuse_replacement(),
        Some(OpenShellLifecycle::Reconstructible) | None => definition,
    }
}
