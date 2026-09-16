// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::config::Gateway;
use std::{sync::Arc, time::Duration};
use tonic::{
    Request,
    metadata::MetadataValue,
    transport::{Certificate, Channel, ClientTlsConfig, Identity},
};

pub trait Secrets: Send + Sync {
    fn resolve(&self, reference: &str) -> Result<String, ObservationError>;
}
pub struct EnvironmentSecrets;
impl Secrets for EnvironmentSecrets {
    fn resolve(&self, reference: &str) -> Result<String, ObservationError> {
        std::env::var(reference)
            .ok()
            .filter(|v| !v.is_empty())
            .ok_or(ObservationError::Authentication)
    }
}
#[derive(Clone)]
pub struct OpenShell {
    channel: Channel,
    bearer: Option<MetadataValue<tonic::metadata::Ascii>>,
    pub(super) secrets: Arc<dyn Secrets>,
}
impl OpenShell {
    /// Configure a lazy channel without network mutation or automatic RPC retry.
    /// Secret references are resolved locally; raw credentials never enter rows.
    pub fn connect(gateway: &Gateway, secrets: Arc<dyn Secrets>) -> Result<Self, ObservationError> {
        crate::config::validate_endpoint(&gateway.endpoint, true)
            .map_err(|_| ObservationError::Query)?;
        if gateway.endpoint.starts_with("http:")
            && (gateway.credential.is_some() || gateway.tls.is_some())
        {
            return Err(ObservationError::Authentication);
        }
        let mut endpoint = Channel::from_shared(gateway.endpoint.clone())
            .map_err(|_| ObservationError::Transport)?
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(90));
        if gateway.endpoint.starts_with("https:") {
            let mut tls = ClientTlsConfig::new().with_native_roots();
            if let Some(references) = &gateway.tls {
                let file = |name: &str| -> Result<Vec<u8>, ObservationError> {
                    std::fs::read(secrets.resolve(name)?)
                        .map_err(|_| ObservationError::Authentication)
                };
                tls = ClientTlsConfig::new()
                    .ca_certificate(Certificate::from_pem(file(&references.ca.env)?))
                    .identity(Identity::from_pem(
                        file(&references.certificate.env)?,
                        file(&references.key.env)?,
                    ));
            }
            endpoint = endpoint
                .tls_config(tls)
                .map_err(|_| ObservationError::Authentication)?;
        }
        let bearer = gateway
            .credential
            .as_ref()
            .map(|credential| {
                let token = secrets.resolve(&credential.env)?;
                let mut value = MetadataValue::try_from(format!("Bearer {token}"))
                    .map_err(|_| ObservationError::Authentication)?;
                value.set_sensitive(true);
                Ok::<_, ObservationError>(value)
            })
            .transpose()?;
        Ok(Self {
            channel: endpoint.connect_lazy(),
            bearer,
            secrets,
        })
    }
    pub(super) fn grpc(&self) -> proto::open_shell_client::OpenShellClient<Channel> {
        proto::open_shell_client::OpenShellClient::new(self.channel.clone())
    }
    pub(super) fn request<T>(&self, value: T) -> Request<T> {
        let mut request = Request::new(value);
        if let Some(token) = &self.bearer {
            request
                .metadata_mut()
                .insert("authorization", token.clone());
        }
        request.set_timeout(Duration::from_secs(30));
        request
    }
    async fn workspace(&self, name: &str, removing: bool) -> Result<Option<Row>, ObservationError> {
        let response = authoritative(
            self.grpc()
                .get_workspace(self.request(proto::GetWorkspaceRequest { name: name.into() }))
                .await,
        )?;
        response
            .map(|response| workspace_row(response, name, removing))
            .transpose()
    }
    pub async fn observe(
        &self,
        kind: &str,
        workspace: &str,
        name: &str,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        if name.is_empty()
            || ((kind == "workspace") != workspace.is_empty())
            || name.contains('\0')
            || workspace.contains('\0')
        {
            return Err(ObservationError::Query);
        }
        let row = match kind {
            "workspace" => return self.workspace(name, removing).await,
            "provider_profile" => self.observe_profile(workspace, name).await?,
            "provider" => {
                let response = authoritative(
                    self.grpc()
                        .get_provider(self.request(proto::GetProviderRequest {
                            name: name.into(),
                            workspace_scope: Some(proto::workspace_selector(workspace)),
                        }))
                        .await,
                )?;
                response
                    .map(|response| provider_row(response, name, removing))
                    .transpose()?
            }
            "sandbox" => {
                let Some(response) = authoritative(
                    self.grpc()
                        .get_sandbox(self.request(proto::GetSandboxRequest {
                            name: name.into(),
                            workspace_scope: Some(proto::workspace_selector(workspace)),
                        }))
                        .await,
                )?
                else {
                    return Ok(None);
                };
                let (row, ready) = sandbox_row(response, name, removing)?;
                if ready {
                    let status = self
                        .grpc()
                        .get_sandbox_policy_status(self.request(
                            proto::GetSandboxPolicyStatusRequest {
                                name: name.into(),
                                workspace_scope: Some(proto::workspace_selector(workspace)),
                                ..Default::default()
                            },
                        ))
                        .await
                        .map_err(|error| remote_error(&error))?
                        .into_inner();
                    active_policy(status, &row["policy_json"])?;
                }
                Some(row)
            }
            _ => return Err(ObservationError::Query),
        };
        Ok(row.map(|mut row| {
            row.insert("workspace".into(), workspace.into());
            row
        }))
    }
}
