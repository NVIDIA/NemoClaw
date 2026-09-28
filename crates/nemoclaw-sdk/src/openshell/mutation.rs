// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod create;
mod update;

use super::*;
use crate::backend::{Backend, Mutation, OpenShellLifecycle, openshell_lifecycle};
use async_trait::async_trait;
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
impl OpenShell {
    async fn provider(&self, want: &Row) -> Result<proto::Provider, ObservationError> {
        let search = crate::config::SearchProvider::from_name(value(want, "provider_type"));
        let (kind, endpoint_key, secret_key) = match value(want, "provider_type") {
            "" => ("openai", "OPENAI_BASE_URL", "OPENAI_API_KEY"),
            "anthropic" => ("anthropic", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"),
            "brave" | "tavily"
                if search.is_some_and(|provider| {
                    value(want, "name")
                        == crate::config::search_provider_name(
                            provider,
                            value(want, "credential_env"),
                        )
                        && value(want, "endpoint") == provider.endpoint()
                        && !value(want, "credential_env").is_empty()
                }) =>
            {
                let search = search.unwrap();
                (search.profile(), "", search.credential_env())
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
            crate::services::authentication::Source::parse(
                source,
                value(want, "owner"),
                value(want, "endpoint"),
            )?
            .resolve()
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
    async fn reconcile(&self, kind: &str, want: &Row) -> Result<Mutation, ObservationError> {
        let name = value(want, "name");
        let workspace = value(want, "workspace");
        if kind != "workspace" {
            let parent = self
                .observe("workspace", "", workspace, false)
                .await?
                .ok_or(ObservationError::BindingMismatch)?;
            if value(&parent, "owner") != value(want, "owner") {
                return Err(ObservationError::BindingMismatch);
            }
        }
        let live = self.observe(kind, workspace, name, false).await?;
        if let Some(row) = &live {
            verify_identity(want, row)?;
        } else if !value(want, "id").is_empty() {
            return Err(ObservationError::BindingMismatch);
        }
        let established = match live {
            Some(row) => {
                if kind == "provider" {
                    self.update_provider(want, &row).await?;
                }
                row
            }
            None => {
                let id = match kind {
                    "workspace" => self.create_workspace(want).await?,
                    "provider" => self.create_provider(want).await?,
                    "provider_profile" => self.create_profile(want).await?,
                    "sandbox" => self.create_sandbox(want).await?,
                    _ => return Err(ObservationError::Query),
                };
                let mut row = want.clone();
                row.insert("id".into(), id);
                row
            }
        };
        match self.observe(kind, workspace, name, false).await {
            Ok(Some(row)) => {
                // The mutation response establishes the physical binding even when
                // the desired row did not yet have an ID. Never adopt a substituted
                // object during readback or discard the established recovery state.
                if let Err(error) = verify_identity(&established, &row) {
                    return Ok(Mutation::partial(established, error));
                }
                if want
                    .iter()
                    .any(|(key, v)| key != "id" && row.get(key) != Some(v))
                {
                    return Ok(Mutation::partial(row, ObservationError::Incomplete));
                }
                Ok(Mutation::complete(row))
            }
            Ok(None) => Ok(Mutation::partial(established, ObservationError::Incomplete)),
            Err(error) => Ok(Mutation::partial(established, error)),
        }
    }
    async fn delete_bound(&self, kind: &str, want: &Row) -> Result<(), ObservationError> {
        let name = value(want, "name");
        let workspace = value(want, "workspace");
        if value(want, "id").is_empty() {
            return Err(ObservationError::BindingMismatch);
        }
        if kind == "sandbox" {
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
            return client
                .wait_deleted(name, Duration::from_secs(300), None)
                .await
                .map_err(sdk_error);
        }
        let Some(row) = self.observe(kind, workspace, name, true).await? else {
            return Ok(());
        };
        verify_identity(want, &row)?;
        // Upstream deletion is name-addressed without an ID/version condition.
        // Verify immediately before sending; never retry an ambiguous mutation.
        let result = match kind {
            "provider_profile" => self
                .client
                .raw_grpc()
                .delete_provider_profile(self.request(proto::DeleteProviderProfileRequest {
                    allow_missing: false,
                    id: name.into(),
                    workspace: workspace.into(),
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
        loop {
            let Some(row) = self.observe(kind, workspace, name, true).await? else {
                return Ok(());
            };
            verify_identity(want, &row)?;
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
}
#[async_trait]
impl Backend for OpenShell {
    async fn plan(
        &self,
        kind: &str,
        desired: &Row,
        prior: Option<&Row>,
    ) -> Result<(), crate::Error> {
        if kind == "agent_configuration" {
            return self.plan_configuration(desired).await;
        }
        // Bound resources were refreshed by OpenTofu. New resources still need
        // an ownership check: their names may already exist in the gateway.
        if prior.is_none()
            && let Some(observed) = self
                .observe(
                    kind,
                    value(desired, "workspace"),
                    value(desired, "name"),
                    false,
                )
                .await?
        {
            verify_identity(desired, &observed)?;
        }
        Ok(())
    }
    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        if kind == "agent_configuration" {
            return self.read_configuration(prior, removing).await;
        }
        let observed = self
            .observe(
                kind,
                value(prior, "workspace"),
                value(prior, "name"),
                removing,
            )
            .await?;
        if kind == "sandbox"
            && !removing
            && let Some(row) = &observed
        {
            verify_identity(prior, row)?;
            self.check_sandbox_phase(row)
                .await
                .map_err(crate::Error::into_observation)?;
        }
        Ok(observed)
    }
    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
        if kind == "agent_configuration" {
            return self.ensure_configuration(desired).await;
        }
        let fields: &[&str] = match kind {
            "workspace" => &["name", "owner", "generation"],
            "provider_profile" => &["name", "owner", "generation", "workspace"],
            "provider" => &["name", "owner", "generation", "workspace", "endpoint"],
            "sandbox" => &[
                "name",
                "owner",
                "generation",
                "workspace",
                "image",
                "agent_name",
            ],
            _ => return Mutation::failed(ObservationError::Query),
        };
        if fields
            .iter()
            .any(|field| value(desired, field).is_empty() || value(desired, field).contains('\0'))
        {
            return Mutation::failed(ObservationError::Incomplete);
        }
        if kind == "sandbox" && (row_policy(desired).is_err() || row_proxy(desired).is_err()) {
            return Mutation::failed(ObservationError::Query);
        }
        self.reconcile(kind, desired)
            .await
            .unwrap_or_else(Mutation::failed)
    }
    async fn remove(
        &self,
        kind: &str,
        prior: &Row,
        destroying: bool,
    ) -> Result<(), ObservationError> {
        if kind == "agent_configuration" {
            return self.remove_configuration(prior, destroying).await;
        }
        if !matches!(
            openshell_lifecycle(kind),
            Some(OpenShellLifecycle::Reconstructible)
        ) && !(destroying && openshell_lifecycle(kind) == Some(OpenShellLifecycle::Stateful))
        {
            return Err(ObservationError::Query);
        }
        tokio::time::timeout(Duration::from_secs(300), self.delete_bound(kind, prior))
            .await
            .map_err(|_| ObservationError::Transport)?
    }
}

#[cfg(test)]
mod search_tests {
    use super::*;
    use crate::config::{Gateway, SearchProvider};
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
        let mut gateway = Gateway::default();
        *gateway.endpoint_mut() = "http://127.0.0.1:1".into();
        let client = OpenShell::connect(&gateway, Arc::new(SearchSecrets)).unwrap();
        for provider in [SearchProvider::Brave, SearchProvider::Tavily] {
            let name = crate::config::search_provider_name(provider, "SEARCH_KEY");
            let want: Row = [
                ("name", name.as_str()),
                ("workspace", "workspace"),
                ("owner", "deployment"),
                ("generation", "generation"),
                ("provider_type", provider.name()),
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
