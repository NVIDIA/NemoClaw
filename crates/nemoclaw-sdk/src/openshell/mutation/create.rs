// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl OpenShell {
    pub(super) async fn create_resource(
        &self,
        kind: &str,
        want: &Row,
        parent: Option<&Row>,
    ) -> Result<Row, ObservationError> {
        let id = match kind {
            "workspace" => self.create_workspace(want).await?,
            "provider" => self.create_provider(want).await?,
            "sandbox" => self.create_sandbox(want).await?,
            "route" => {
                self.set_route(want).await?;
                format!(
                    "{}/primary",
                    parent.ok_or(ObservationError::Incomplete)?["id"]
                )
            }
            _ => return Err(ObservationError::Query),
        };
        let mut row = want.clone();
        row.insert("id".into(), id);
        Ok(row)
    }
    async fn create_workspace(&self, want: &Row) -> Result<String, ObservationError> {
        let name = value(want, "name");
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
        Ok(row["id"].clone())
    }
    async fn create_provider(&self, want: &Row) -> Result<String, ObservationError> {
        let name = value(want, "name");
        let workspace = value(want, "workspace");
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
        Ok(row["id"].clone())
    }
    async fn create_sandbox(&self, want: &Row) -> Result<String, ObservationError> {
        let name = value(want, "name");
        let workspace = value(want, "workspace");
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
        Ok(row["id"].clone())
    }
}
