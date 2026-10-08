// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use nemoclaw_openshell::search::SearchProvider;
use std::{collections::HashMap, time::Duration};

fn value<'a>(row: &'a Row, field: &str) -> &'a str {
    row.get(field).map(String::as_str).unwrap_or("")
}

fn labels(want: &Row) -> HashMap<String, String> {
    [
        (OWNER.into(), value(want, "owner").into()),
        (GENERATION.into(), value(want, "generation").into()),
    ]
    .into()
}

impl ConnectedOpenShellGateway {
    pub(crate) async fn gateway_capabilities(
        &self,
    ) -> Result<nemoclaw_openshell::GatewayCapabilities, ObservationError> {
        nemoclaw_openshell::capabilities(&self.client).await
    }

    async fn provider(&self, want: &Row) -> Result<proto::Provider, ObservationError> {
        let search = SearchProvider::from_name(value(want, "provider_type"));
        let (kind, endpoint_key, secret_key) = match value(want, "provider_type") {
            "" => ("openai", "OPENAI_BASE_URL", "OPENAI_API_KEY"),
            "anthropic" => ("anthropic", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"),
            "brave" | "tavily"
                if search.is_some_and(|provider| {
                    value(want, "name")
                        == nemoclaw_openshell::search::search_provider_name(
                            provider,
                            value(want, "credential_env"),
                            value(want, "profile_name"),
                        )
                        && nemoclaw_openshell::search::SearchProvider::from_profile(value(
                            want,
                            "profile_name",
                        )) == Some(provider)
                        && value(want, "endpoint") == provider.endpoint()
                        && !value(want, "credential_env").is_empty()
                }) =>
            {
                let search = search.unwrap();
                (value(want, "profile_name"), "", search.credential_env())
            }
            _ => return Err(ObservationError::Query),
        };
        let native = search.is_none();
        let source = value(want, "credential_source");
        let profile = if native {
            Some(inference_profile(
                value(want, "name"),
                value(want, "endpoint"),
                kind.parse().map_err(|_| ObservationError::Query)?,
                !source.is_empty() || !value(want, "credential_env").is_empty(),
            )?)
        } else {
            None
        };
        if let Some(profile) = &profile {
            let bound = self
                .observe_profile(value(want, "workspace"), &profile.id)
                .await?
                .ok_or(ObservationError::BindingMismatch)?;
            if ["owner", "generation", "endpoint", "provider_type"]
                .iter()
                .any(|key| value(&bound, key) != value(want, key))
                || value(&bound, "authenticated")
                    != if profile.credentials.is_empty() {
                        "false"
                    } else {
                        "true"
                    }
            {
                return Err(ObservationError::BindingMismatch);
            }
        }
        let credential = if !source.is_empty() {
            if !value(want, "credential_env").is_empty() {
                return Err(ObservationError::BindingMismatch);
            }
            nemoclaw_docker::credentials::resolve(&nemoclaw_docker::credentials::Source::parse(
                source,
                value(want, "owner"),
                value(want, "endpoint"),
            )?)
            .await?
        } else {
            match value(want, "credential_env") {
                "" => "empty".into(),
                reference => self.secrets.resolve(reference)?,
            }
        };
        let mut labels = labels(want);
        labels.insert(CREDENTIAL.into(), value(want, "credential_env").into());
        Ok(proto::Provider {
            metadata: Some(proto::ObjectMeta {
                name: value(want, "name").into(),
                labels,
                annotations: credential_metadata::pack(source)?,
                ..Default::default()
            }),
            r#type: profile
                .as_ref()
                .map(|p| p.id.clone())
                .unwrap_or_else(|| kind.into()),
            profile_workspace: value(want, "workspace").into(),
            config: if endpoint_key.is_empty() {
                Default::default()
            } else {
                [(endpoint_key.into(), value(want, "endpoint").into())].into()
            },
            credentials: match profile {
                Some(profile) => profile
                    .credentials
                    .first()
                    .map(|c| [(c.name.clone(), credential)].into())
                    .unwrap_or_default(),
                None => [(secret_key.into(), credential)].into(),
            },
            ..Default::default()
        })
    }

    pub(crate) async fn create_workspace(&self, want: &Row) -> Result<String, ObservationError> {
        let name = value(want, "name");
        let response = self
            .client
            .raw_grpc()
            .create_workspace(self.request(proto::CreateWorkspaceRequest {
                name: name.into(),
                labels: labels(want),
                ..Default::default()
            }))
            .await
            .map_err(|error| remote_error(&error))?
            .into_inner();
        let row = base(response.workspace.and_then(|w| w.metadata), name, false)?;
        verify_identity(want, &row)?;
        Ok(row["id"].clone())
    }

    pub(crate) async fn create_provider(&self, want: &Row) -> Result<String, ObservationError> {
        let name = value(want, "name");
        let workspace = value(want, "workspace");
        let response = self
            .client
            .raw_grpc()
            .create_provider(self.request(proto::CreateProviderRequest {
                provider: Some(self.provider(want).await?),
                workspace_scope: Some(proto::workspace_selector(workspace)),
                ..Default::default()
            }))
            .await
            .map_err(|error| remote_error(&error))?
            .into_inner();
        let row = base(response.provider.and_then(|p| p.metadata), name, false)?;
        verify_identity(want, &row)?;
        Ok(row["id"].clone())
    }

    pub(crate) async fn create_sandbox(&self, want: &Row) -> Result<String, ObservationError> {
        let name = value(want, "name");
        let workspace = value(want, "workspace");
        if value(want, "agent_runtime") != "fabric" {
            return Err(ObservationError::BindingMismatch);
        }
        let mut labels = labels(want);
        labels.insert(AGENT.into(), value(want, "agent_name").into());
        if !value(want, "agent_runtime").is_empty() {
            labels.insert(AGENT_RUNTIME.into(), value(want, "agent_runtime").into());
        }
        let response = self
            .client
            .raw_grpc()
            .create_sandbox(
                self.request(proto::CreateSandboxRequest {
                    name: name.into(),
                    workspace_scope: Some(proto::workspace_selector(workspace)),
                    labels,
                    annotations: [
                        (agent::RUNTIME.into(), value(want, "runtime_json").into()),
                        (agent::POLICY.into(), value(want, "policy_json").into()),
                    ]
                    .into(),
                    spec: Some(proto::SandboxSpec {
                        template: Some(proto::SandboxTemplate {
                            image: value(want, "image").into(),
                            ..Default::default()
                        }),
                        command: agent::binding(want)?
                            .command("serve", &["--agent", value(want, "agent_name")]),
                        providers: inference::provider_names(
                            value(want, "provider_names_json"),
                            value(want, "agent_runtime"),
                        )?,
                        environment: inference_environment(want)?.into_iter().collect(),
                        policy: Some(row_policy(want)?),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
            )
            .await
            .map_err(|error| remote_error(&error))?
            .into_inner();
        let row = base(response.sandbox.and_then(|s| s.metadata), name, false)?;
        verify_identity(want, &row)?;
        Ok(row["id"].clone())
    }

    pub(crate) async fn update_provider(
        &self,
        want: &Row,
        live: &Row,
    ) -> Result<(), ObservationError> {
        let name = value(want, "name");
        let workspace = value(want, "workspace");
        if value(live, "credential_source") != value(want, "credential_source")
            || value(live, "provider_type") != value(want, "provider_type")
        {
            return Err(ObservationError::BindingMismatch);
        }
        if ["endpoint", "credential_env"]
            .iter()
            .any(|key| value(live, key) != value(want, key))
        {
            // This direct read supplies the version used for the conditional write.
            let current = self
                .client
                .raw_grpc()
                .get_provider(self.request(proto::GetProviderRequest {
                    name: name.into(),
                    workspace_scope: Some(proto::workspace_selector(workspace)),
                }))
                .await
                .map_err(|error| remote_error(&error))?
                .into_inner()
                .provider
                .ok_or(ObservationError::Incomplete)?;
            let meta = current.metadata.ok_or(ObservationError::Incomplete)?;
            verify_identity(want, &base(Some(meta.clone()), name, false)?)?;
            if meta.resource_version == 0 {
                return Err(ObservationError::Incomplete);
            }
            let mut provider = self.provider(want).await?;
            let mut metadata = provider
                .metadata
                .take()
                .ok_or(ObservationError::Incomplete)?;
            metadata.id = meta.id;
            metadata.resource_version = meta.resource_version;
            provider.metadata = Some(metadata);
            self.client
                .raw_grpc()
                .update_provider(self.request(proto::UpdateProviderRequest {
                    provider: Some(provider),
                    workspace_scope: Some(proto::workspace_selector(workspace)),
                    ..Default::default()
                }))
                .await
                .map_err(|error| remote_error(&error))?;
        }
        Ok(())
    }

    pub(crate) async fn delete_bound_sandbox(&self, want: &Row) -> Result<(), ObservationError> {
        let name = value(want, "name");
        let workspace = value(want, "workspace");
        let client = self.client.workspace(workspace);
        let sandbox = match client.get_sandbox(name).await {
            Ok(sandbox) => sandbox,
            Err(openshell_sdk::SdkError::NotFound { .. }) => return Ok(()),
            Err(error) => return Err(sdk_error(error)),
        };
        if sandbox.id != want["id"]
            || sandbox.name != name
            || sandbox.workspace != workspace
            || [("owner", OWNER), ("generation", GENERATION)]
                .iter()
                .any(|(field, label)| {
                    value(want, field).is_empty()
                        || sandbox.labels.get(*label).map(String::as_str)
                            != Some(value(want, field))
                })
        {
            return Err(ObservationError::BindingMismatch);
        }
        // The channel allows 90 seconds for the gateway's graceful stop.
        // No refresher is configured, so SDK mutations are never retried.
        match client.delete_sandbox(name, Default::default()).await {
            Ok(_) | Err(openshell_sdk::SdkError::NotFound { .. }) => {}
            Err(error) => return Err(sdk_error(error)),
        }
        // Require confirmed absence. A same-name replacement must not be
        // mistaken for successful cleanup of the retained binding.
        client
            .wait_deleted(name, Duration::from_secs(300), None)
            .await
            .map_err(sdk_error)
    }

    pub(crate) async fn delete(
        &self,
        kind: &str,
        workspace: &str,
        name: &str,
    ) -> Result<(), ObservationError> {
        let result = match kind {
            "provider_profile" => self
                .client
                .raw_grpc()
                .delete_provider_profile(self.request(proto::DeleteProviderProfileRequest {
                    allow_missing: false,
                    id: name.into(),
                    workspace_scope: Some(proto::workspace_selector(workspace)),
                    ..Default::default()
                }))
                .await
                .map(|_| ()),
            "provider" => self
                .client
                .raw_grpc()
                .delete_provider(self.request(proto::DeleteProviderRequest {
                    allow_missing: false,
                    name: name.into(),
                    workspace_scope: Some(proto::workspace_selector(workspace)),
                    ..Default::default()
                }))
                .await
                .map(|_| ()),
            _ => return Err(ObservationError::Query),
        };
        if let Err(status) = result
            && status.code() != tonic::Code::NotFound
        {
            return Err(remote_error(&status));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    struct SearchSecrets;
    impl Secrets for SearchSecrets {
        fn resolve(&self, reference: &str) -> Result<String, ObservationError> {
            if reference == "SEARCH_KEY" {
                Ok("fixture-secret".into())
            } else {
                Err(ObservationError::Authentication)
            }
        }
    }

    #[tokio::test]
    async fn search_creation_resolves_only_the_reference_and_observation_drops_the_value() {
        let connection = nemoclaw_openshell::Connection {
            endpoint: "http://127.0.0.1:1".into(),
            ..Default::default()
        };
        let client =
            ConnectedOpenShellGateway::connect(&connection, Arc::new(SearchSecrets)).unwrap();
        for provider in [SearchProvider::Brave, SearchProvider::Tavily] {
            let name = nemoclaw_openshell::search::search_provider_name(
                provider,
                "SEARCH_KEY",
                provider.profile(),
            );
            let want: Row = [
                ("name", name.as_str()),
                ("workspace", "workspace"),
                ("owner", "deployment"),
                ("generation", "generation"),
                ("provider_type", provider.name()),
                ("profile_name", provider.profile()),
                ("endpoint", provider.endpoint()),
                ("credential_env", "SEARCH_KEY"),
            ]
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect();
            let mut message = client.provider(&want).await.unwrap();
            assert_eq!(message.r#type, provider.profile());
            assert_eq!(message.credentials.len(), 1);
            assert_eq!(
                message.credentials[provider.credential_env()],
                "fixture-secret"
            );
            assert!(message.config.is_empty());
            let metadata = message.metadata.as_mut().unwrap();
            metadata.id = "physical".into();
            metadata.workspace = "workspace".into();
            let observed = super::super::provider_row(
                proto::ProviderResponse {
                    provider: Some(message.clone()),
                    ..Default::default()
                },
                &name,
                false,
            )
            .unwrap();
            assert_eq!(observed["credential_env"], "SEARCH_KEY");
            assert_eq!(observed["provider_type"], provider.name());
            assert!(
                !observed
                    .values()
                    .any(|value| value.contains("fixture-secret"))
            );
            for (key, value) in [
                ("name", "other"),
                ("endpoint", "https://other.example"),
                ("credential_env", ""),
            ] {
                let mut changed = want.clone();
                changed.insert(key.into(), value.into());
                assert!(client.provider(&changed).await.is_err());
            }
            message.r#type = "nemoclaw-other".into();
            assert!(profile::provider_row(message, &name, false).is_err());
        }
    }
}
