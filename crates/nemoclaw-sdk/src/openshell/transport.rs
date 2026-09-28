// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::config::Gateway;
use openshell_sdk::{EdgeAuthInterceptor, OpenShellClient};
use std::{sync::Arc, time::Duration};
use tonic::{
    Request,
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
    pub(super) client: Arc<OpenShellClient>,
    pub(super) secrets: Arc<dyn Secrets>,
}
impl OpenShell {
    /// Configure a lazy channel without network mutation or automatic RPC retry.
    /// Secret references are resolved locally; raw credentials never enter rows.
    pub fn connect(gateway: &Gateway, secrets: Arc<dyn Secrets>) -> Result<Self, ObservationError> {
        crate::config::validate_endpoint(gateway.endpoint(), true)
            .map_err(|_| ObservationError::Query)?;
        if gateway.endpoint().starts_with("http:")
            && (gateway.credential().is_some() || gateway.tls().is_some())
        {
            return Err(ObservationError::Authentication);
        }
        let mut endpoint = Channel::from_shared(gateway.endpoint().to_owned())
            .map_err(|_| ObservationError::Transport)?
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(90));
        if gateway.endpoint().starts_with("https:") {
            let mut tls = ClientTlsConfig::new().with_native_roots();
            if let Some(references) = gateway.tls() {
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
        let token = gateway
            .credential()
            .map(|credential| secrets.resolve(&credential.env))
            .transpose()?;
        // ClientConfig cannot express mTLS, lazy connection, or call bounds at
        // the pinned revision. from_parts preserves those channel guarantees.
        let client =
            OpenShellClient::from_parts(endpoint.connect_lazy(), authentication(token.as_deref())?);
        Ok(Self {
            client: Arc::new(client),
            secrets,
        })
    }
    pub(super) fn request<T>(&self, value: T) -> Request<T> {
        let mut request = Request::new(value);
        request.set_timeout(Duration::from_secs(30));
        request
    }
    async fn workspace(&self, name: &str, removing: bool) -> Result<Option<Row>, ObservationError> {
        let response = authoritative(
            self.client
                .raw_grpc()
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
                    self.client
                        .raw_grpc()
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
                    self.client
                        .raw_grpc()
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
                        .client
                        .raw_grpc()
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

fn authentication(token: Option<&str>) -> Result<EdgeAuthInterceptor, ObservationError> {
    let interceptor =
        EdgeAuthInterceptor::new(token, None).map_err(|_| ObservationError::Authentication)?;
    // Upstream bearer construction does not mark metadata sensitive. Keep
    // credentials out of diagnostics before handing the slot to the SDK.
    if let Some(slot) = interceptor.bearer_slot()
        && let Some(value) = slot
            .write()
            .map_err(|_| ObservationError::Authentication)?
            .as_mut()
    {
        value.set_sensitive(true);
    }
    Ok(interceptor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tonic::service::Interceptor;

    #[test]
    fn sdk_authentication_preserves_sensitive_bearer_metadata_and_deadlines() {
        let mut interceptor = authentication(Some("secret-sentinel")).unwrap();
        let mut request = Request::new(());
        request.set_timeout(Duration::from_secs(30));
        let request = interceptor.call(request).unwrap();
        let bearer = request.metadata().get("authorization").unwrap();
        assert_eq!(bearer, "Bearer secret-sentinel");
        assert!(bearer.is_sensitive());
        assert!(!format!("{request:?}").contains("secret-sentinel"));
        assert!(request.metadata().contains_key("grpc-timeout"));
        assert!(
            authentication(None)
                .unwrap()
                .call(Request::new(()))
                .unwrap()
                .metadata()
                .get("authorization")
                .is_none()
        );
        assert!(matches!(
            authentication(Some("invalid\nsecret-sentinel")),
            Err(ObservationError::Authentication)
        ));
    }
}
