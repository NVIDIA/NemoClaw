// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod create;
mod update;

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
    async fn provider(&self, want: &Row) -> Result<proto::Provider, ObservationError> {
        let (kind, endpoint_key, secret_key) = match value(want, "provider_type") {
            "" => ("openai", "OPENAI_BASE_URL", "OPENAI_API_KEY"),
            "anthropic" => ("anthropic", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"),
            "brave"
                if value(want, "name") == "brave-search"
                    && value(want, "endpoint") == "https://api.search.brave.com"
                    && !value(want, "credential_env").is_empty() =>
            {
                ("nemoclaw-brave", "", "BRAVE_API_KEY")
            }
            _ => return Err(ObservationError::Query),
        };
        let native = kind != "nemoclaw-brave";
        let source = value(want, "credential_source");
        let profile = if native {
            Some(inference_profile(
                value(want, "name"),
                value(want, "endpoint"),
                kind,
                !source.is_empty() || !value(want, "credential_env").is_empty(),
            )?)
        } else {
            None
        };
        let credential = if !source.is_empty() {
            if !value(want, "credential_env").is_empty() {
                return Err(ObservationError::BindingMismatch);
            }
            crate::inference_auth::Source::parse(
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
    async fn reconcile(&self, kind: &str, want: &Row) -> Mutation {
        match self.reconcile_inner(kind, want).await {
            Ok(mutation) => mutation,
            Err(error) => Mutation::failed(error),
        }
    }
    async fn reconcile_inner(&self, kind: &str, want: &Row) -> Result<Mutation, ObservationError> {
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
                self.update_resource(kind, want, &row).await?;
                row
            }
            None => self.create_resource(kind, want).await?,
        };
        self.readback(kind, want, established).await
    }
    async fn readback(
        &self,
        kind: &str,
        want: &Row,
        established: Row,
    ) -> Result<Mutation, ObservationError> {
        let name = value(want, "name");
        let workspace = value(want, "workspace");
        match self.observe(kind, workspace, name, false).await {
            Ok(Some(row)) => {
                verify_identity(want, &row)?;
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
                    workspace_scope: Some(proto::workspace_selector(workspace)),
                });
                // Podman's default graceful stop is 45 seconds. Allow cleanup
                // after that stop without retrying an ambiguous deletion.
                request.set_timeout(std::time::Duration::from_secs(90));
                self.grpc().delete_sandbox(request).await.map(|_| ())
            }
            "provider_profile" => self
                .grpc()
                .delete_provider_profile(self.request(proto::DeleteProviderProfileRequest {
                    id: name.into(),
                    workspace: workspace.into(),
                }))
                .await
                .map(|_| ()),
            "provider" => self
                .grpc()
                .delete_provider(self.request(proto::DeleteProviderRequest {
                    name: name.into(),
                    workspace_scope: Some(proto::workspace_selector(workspace)),
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
    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
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
            && inference_settings(&row["inference_json"], &row["agent_runtime"])?
                .is_some_and(|settings| !settings.agents.is_empty())
        {
            verify_identity(prior, row)?;
            // Refresh verifies native policy. Creation readback retains identity while
            // the separate SDK readiness stage waits for the agent to start.
            self.agent_configuration(row)
                .await
                .map_err(|_| ObservationError::Query)?;
        }
        Ok(observed)
    }
    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
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
        self.reconcile(kind, desired).await
    }
    async fn remove(
        &self,
        kind: &str,
        prior: &Row,
        destroying: bool,
    ) -> Result<(), ObservationError> {
        if !destroying || !matches!(kind, "sandbox" | "provider" | "provider_profile") {
            return Err(ObservationError::Query);
        }
        tokio::time::timeout(Duration::from_secs(300), self.delete_bound(kind, prior))
            .await
            .map_err(|_| ObservationError::Transport)?
    }
}
