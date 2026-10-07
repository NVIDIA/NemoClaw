// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! An OpenShell gateway's version and compute drivers, read over its authenticated channel.
use nemoclaw_sdk::{
    ObservationError, Secrets,
    config::{ComputeDriver, Gateway},
    discovery::{GatewayCapabilities, GatewayObservation},
};
use openshell_sdk::{EdgeAuthInterceptor, OpenShellClient};
use std::time::Duration;
use tonic::{
    Request,
    transport::{Certificate, Channel, ClientTlsConfig, Identity},
};

/// Configure a lazy channel without network mutation or automatic RPC retry.
/// Secret references are resolved locally; raw credentials never leave this client.
pub fn client(
    gateway: &Gateway,
    secrets: &dyn Secrets,
) -> Result<OpenShellClient, ObservationError> {
    nemoclaw_sdk::config::validate_endpoint(gateway.endpoint(), true)
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
                std::fs::read(secrets.resolve(name)?).map_err(|_| ObservationError::Authentication)
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
    Ok(OpenShellClient::from_parts(
        endpoint.connect_lazy(),
        authentication(token.as_deref())?,
    ))
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

/// A request bounded to 30 seconds.
pub fn request<T>(value: T) -> Request<T> {
    let mut request = Request::new(value);
    request.set_timeout(Duration::from_secs(30));
    request
}

pub async fn capabilities(
    client: &OpenShellClient,
) -> Result<GatewayCapabilities, ObservationError> {
    let response = tokio::time::timeout(Duration::from_secs(30), async {
        client
            .raw_grpc()
            .get_gateway_info(request(openshell_sdk::raw::proto::GetGatewayInfoRequest {}))
            .await
    })
    .await
    .map_err(|_| ObservationError::Transport)?
    .map_err(|error| remote_error(&error))?;
    response.into_inner().try_into()
}

/// The gateway's capabilities judged against the drivers its sandboxes require.
/// A failure is an unknown observation, never absence.
pub async fn observe_gateway(
    gateway: &Gateway,
    required: &[ComputeDriver],
    secrets: &dyn Secrets,
) -> GatewayObservation {
    let observed = match client(gateway, secrets) {
        Ok(client) => capabilities(&client).await,
        Err(error) => Err(error),
    };
    GatewayObservation::from_result(observed, required)
}

pub fn remote_error(status: &tonic::Status) -> ObservationError {
    match status.code() {
        tonic::Code::Unauthenticated => ObservationError::Authentication,
        tonic::Code::PermissionDenied => ObservationError::Permission,
        tonic::Code::Unavailable | tonic::Code::DeadlineExceeded | tonic::Code::Cancelled => {
            ObservationError::Transport
        }
        // A lazy tonic Channel reports connector failures as Unknown with this
        // fixed message before an RPC reaches the server.
        tonic::Code::Unknown if status.message() == "transport error" => {
            ObservationError::Transport
        }
        _ => ObservationError::Query,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tonic::service::Interceptor;

    #[test]
    fn authentication_keeps_the_bearer_sensitive_and_requests_bounded() {
        let mut interceptor = authentication(Some("secret-sentinel")).unwrap();
        let request = interceptor.call(request(())).unwrap();
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
