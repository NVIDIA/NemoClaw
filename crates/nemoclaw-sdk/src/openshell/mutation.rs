// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::backend::{Backend, Mutation};
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
    fn provider(&self, want: &Row) -> Result<proto::Provider, ObservationError> {
        let (kind, endpoint_key, secret_key) = match value(want, "provider_type") {
            "" => ("openai", "OPENAI_BASE_URL", "OPENAI_API_KEY"),
            "anthropic" => ("anthropic", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"),
            _ => return Err(ObservationError::Query),
        };
        let credential = match value(want, "credential_env") {
            "" => "empty".into(),
            reference => self.secrets.resolve(reference)?,
        };
        let mut labels = labels(want);
        labels.insert(CREDENTIAL.into(), value(want, "credential_env").into());
        Ok(proto::Provider {
            metadata: Some(proto::ObjectMeta {
                name: value(want, "name").into(),
                labels,
                ..Default::default()
            }),
            r#type: kind.into(),
            config: [(endpoint_key.into(), value(want, "endpoint").into())].into(),
            credentials: [(secret_key.into(), credential)].into(),
            ..Default::default()
        })
    }
    async fn reconcile(&self, kind: &str, want: &Row) -> Mutation {
        match self.reconcile_inner(kind, want).await {
            Ok(mutation) => mutation,
            Err(error) => Mutation::failed(error),
        }
    }
    async fn reconcile_inner(&self, kind: &str, want: &Row) -> Result<Mutation, ObservationError> {
        let name = value(want, "name");
        let workspace = value(want, "workspace");
        let parent = if kind != "workspace" {
            let parent = self
                .observe("workspace", "", workspace, false)
                .await?
                .ok_or(ObservationError::BindingMismatch)?;
            if value(&parent, "owner") != value(want, "owner") {
                return Err(ObservationError::BindingMismatch);
            }
            Some(parent)
        } else {
            None
        };
        let live = self.observe(kind, workspace, name, false).await?;
        if let Some(row) = &live {
            verify_identity(want, row)?;
        } else if !value(want, "id").is_empty() {
            return Err(ObservationError::BindingMismatch);
        }
        let mut established = live.clone();
        if live.is_none() {
            let id = match kind {
                "workspace" => {
                    let response = self
                        .grpc()
                        .create_workspace(self.request(proto::CreateWorkspaceRequest {
                            name: name.into(),
                            labels: labels(want),
                        }))
                        .await
                        .map_err(remote_error)?
                        .into_inner();
                    let row = base(response.workspace.and_then(|w| w.metadata), name, false)?;
                    verify_identity(want, &row)?;
                    row["id"].clone()
                }
                "provider" => {
                    let response = self
                        .grpc()
                        .create_provider(self.request(proto::CreateProviderRequest {
                            provider: Some(self.provider(want)?),
                            workspace: workspace.into(),
                        }))
                        .await
                        .map_err(remote_error)?
                        .into_inner();
                    let row = base(response.provider.and_then(|p| p.metadata), name, false)?;
                    verify_identity(want, &row)?;
                    row["id"].clone()
                }
                "route" => {
                    self.set_route(want).await?;
                    format!(
                        "{}/primary",
                        parent.as_ref().ok_or(ObservationError::Incomplete)?["id"]
                    )
                }
                "sandbox" => {
                    if !value(want, "agent_runtime")
                        .strip_prefix("fabric-")
                        .is_some_and(crate::config::is_fabric_harness)
                    {
                        return Err(ObservationError::BindingMismatch);
                    }
                    let mut labels = labels(want);
                    labels.insert(AGENT.into(), value(want, "agent_name").into());
                    if !value(want, "agent_runtime").is_empty() {
                        labels.insert(AGENT_RUNTIME.into(), value(want, "agent_runtime").into());
                    }
                    let response = self
                        .grpc()
                        .create_sandbox(
                            self.request(proto::CreateSandboxRequest {
                                name: name.into(),
                                workspace: workspace.into(),
                                labels,
                                spec: Some(proto::SandboxSpec {
                                    template: Some(proto::SandboxTemplate {
                                        image: value(want, "image").into(),
                                        ..Default::default()
                                    }),
                                    command: command(value(want, "agent_runtime")),
                                    environment: environment(
                                        value(want, "agent_name"),
                                        value(want, "agent_runtime"),
                                    )
                                    .into_iter()
                                    .collect(),
                                    policy: Some(policy()),
                                    ..Default::default()
                                }),
                                ..Default::default()
                            }),
                        )
                        .await
                        .map_err(remote_error)?
                        .into_inner();
                    let row = base(response.sandbox.and_then(|s| s.metadata), name, false)?;
                    verify_identity(want, &row)?;
                    row["id"].clone()
                }
                _ => return Err(ObservationError::Query),
            };
            let mut row = want.clone();
            row.insert("id".into(), id);
            established = Some(row);
        } else if let Some(live) = &live {
            match kind {
                "provider" => {
                    if value(live, "provider_type") != value(want, "provider_type") {
                        return Err(ObservationError::BindingMismatch);
                    }
                    if ["endpoint", "credential_env"]
                        .iter()
                        .any(|key| value(live, key) != value(want, key))
                    {
                        // This direct read supplies the version used for the conditional write.
                        let current = self
                            .grpc()
                            .get_provider(self.request(proto::GetProviderRequest {
                                name: name.into(),
                                workspace: workspace.into(),
                            }))
                            .await
                            .map_err(remote_error)?
                            .into_inner()
                            .provider
                            .ok_or(ObservationError::Incomplete)?;
                        let meta = current.metadata.ok_or(ObservationError::Incomplete)?;
                        verify_identity(want, &base(Some(meta.clone()), name, false)?)?;
                        if meta.resource_version == 0 {
                            return Err(ObservationError::Incomplete);
                        }
                        let mut provider = self.provider(want)?;
                        let mut metadata = provider
                            .metadata
                            .take()
                            .ok_or(ObservationError::Incomplete)?;
                        metadata.id = meta.id;
                        metadata.resource_version = meta.resource_version;
                        provider.metadata = Some(metadata);
                        self.grpc()
                            .update_provider(self.request(proto::UpdateProviderRequest {
                                provider: Some(provider),
                                workspace: workspace.into(),
                                ..Default::default()
                            }))
                            .await
                            .map_err(remote_error)?;
                    }
                }
                "route"
                    if ["provider_name", "model"]
                        .iter()
                        .any(|key| value(live, key) != value(want, key)) =>
                {
                    self.set_route(want).await?;
                }
                _ => {}
            }
        }
        match self.observe(kind, workspace, name, false).await {
            Ok(Some(row)) => {
                verify_identity(want, &row)?;
                if want
                    .iter()
                    .any(|(key, v)| key != "id" && row.get(key) != Some(v))
                {
                    return Ok(Mutation {
                        state: Some(row),
                        error: Some(ObservationError::Incomplete),
                    });
                }
                Ok(Mutation::complete(row))
            }
            Ok(None) => Ok(Mutation {
                state: established,
                error: Some(ObservationError::Incomplete),
            }),
            Err(error) => Ok(Mutation {
                state: established,
                error: Some(error),
            }),
        }
    }
    async fn set_route(&self, want: &Row) -> Result<(), ObservationError> {
        self.inference()
            .set_inference_route(self.request(proto::SetInferenceRouteRequest {
                workspace: value(want, "workspace").into(),
                provider_name: value(want, "provider_name").into(),
                model_id: value(want, "model").into(),
                timeout_secs: 120,
                ..Default::default()
            }))
            .await
            .map_err(remote_error)?;
        Ok(())
    }
    async fn delete_bound(&self, kind: &str, want: &Row) -> Result<(), ObservationError> {
        let name = value(want, "name");
        let workspace = value(want, "workspace");
        if value(want, "id").is_empty() {
            return Err(ObservationError::BindingMismatch);
        }
        let Some(row) = self.observe(kind, workspace, name, true).await? else {
            return Ok(());
        };
        verify_identity(want, &row)?;
        // Upstream deletion is name-addressed without an ID/version condition.
        // Verify immediately before sending; never retry an ambiguous mutation.
        let result = match kind {
            "sandbox" => {
                let mut request = self.request(proto::DeleteSandboxRequest {
                    name: name.into(),
                    workspace: workspace.into(),
                });
                // Podman's default graceful stop is 45 seconds. Allow cleanup
                // after that stop without retrying an ambiguous deletion.
                request.set_timeout(std::time::Duration::from_secs(90));
                self.grpc().delete_sandbox(request).await.map(|_| ())
            }
            "provider" => self
                .grpc()
                .delete_provider(self.request(proto::DeleteProviderRequest {
                    name: name.into(),
                    workspace: workspace.into(),
                }))
                .await
                .map(|_| ()),
            "route" => self
                .inference()
                .delete_inference_route(self.request(proto::DeleteInferenceRouteRequest {
                    workspace: workspace.into(),
                    route_name: String::new(),
                }))
                .await
                .map(|_| ()),
            _ => return Err(ObservationError::Query),
        };
        if let Err(status) = result
            && status.code() != tonic::Code::NotFound
        {
            return Err(remote_error(status));
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
    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        self.observe(
            kind,
            value(prior, "workspace"),
            value(prior, "name"),
            removing,
        )
        .await
    }
    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
        let fields: &[&str] = match kind {
            "workspace" => &["name", "owner", "generation"],
            "provider" => &["name", "owner", "generation", "workspace", "endpoint"],
            "route" => &[
                "name",
                "owner",
                "generation",
                "workspace",
                "provider_name",
                "model",
            ],
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
        self.reconcile(kind, desired).await
    }
    async fn remove(
        &self,
        kind: &str,
        prior: &Row,
        destroying: bool,
    ) -> Result<(), ObservationError> {
        if !destroying || !matches!(kind, "sandbox" | "provider" | "route") {
            return Err(ObservationError::Query);
        }
        tokio::time::timeout(Duration::from_secs(300), self.delete_bound(kind, prior))
            .await
            .map_err(|_| ObservationError::Transport)?
    }
}
