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

/// Opt in only for gateway operations whose requests contain no credentials.
pub fn remote_rejection(operation: &'static str, status: &tonic::Status) -> ObservationError {
    if !matches!(
        operation,
        "CreateWorkspace" | "CreateSandbox" | "DeleteProvider" | "DeleteProviderProfile"
    ) {
        return remote_error(status);
    }
    let code = match status.code() {
        tonic::Code::FailedPrecondition => "FailedPrecondition",
        tonic::Code::InvalidArgument => "InvalidArgument",
        tonic::Code::AlreadyExists => "AlreadyExists",
        tonic::Code::OutOfRange => "OutOfRange",
        tonic::Code::ResourceExhausted => "ResourceExhausted",
        _ => return remote_error(status),
    };
    ObservationError::Rejected {
        operation,
        code,
        detail: ObservationError::sanitized_detail(status.message()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tonic::service::Interceptor;

    #[test]
    fn live_endpoint_ambiguity_keeps_its_conflict_kind() {
        let detail = "network endpoint ambiguity validation failed: network policies 'nemoclaw-inference-qwen-example' endpoint[0] (nc-0123456789abcdef-model-0123456789abcdef.agents.svc.cluster.local:18888/v1/**) and '_provider_qwen_example' endpoint[0] (nc-0123456789abcdef-model-0123456789abcdef.agents.svc.cluster.local:18888/v1/**) overlap on port(s) 18888 with conflicting metadata: allowed_ips=[] vs [\"10.96.189.228/32\"]";
        let error = remote_rejection("CreateSandbox", &tonic::Status::failed_precondition(detail));
        assert!(
            error
                .to_string()
                .contains("conflicting metadata: allowed_ips=[]")
        );
        assert!(error.to_string().contains("CreateSandbox"));
    }

    #[test]
    fn definitive_rejections_keep_bounded_gateway_text_and_other_statuses_stay_fixed() {
        for operation in [
            "CreateWorkspace",
            "CreateSandbox",
            "DeleteProvider",
            "DeleteProviderProfile",
        ] {
            for code in [
                tonic::Code::FailedPrecondition,
                tonic::Code::InvalidArgument,
                tonic::Code::AlreadyExists,
                tonic::Code::OutOfRange,
                tonic::Code::ResourceExhausted,
            ] {
                let status = tonic::Status::new(
                    code,
                    format!("validation failed\n{}", "detail ".repeat(300)),
                );
                let error = remote_rejection(operation, &status);
                let ObservationError::Rejected { detail, .. } = error else {
                    panic!("missing operation rejection");
                };
                assert!(detail.len() <= 1024);
                assert!(detail.bytes().all(|byte| (b' '..=b'~').contains(&byte)));
            }
        }
        for operation in [
            "CreateProvider",
            "UpdateProvider",
            "GetSandbox",
            "ExecSandbox",
            "ImportProviderProfiles",
        ] {
            let status = tonic::Status::failed_precondition("credential-sentinel");
            assert_eq!(
                remote_rejection(operation, &status),
                ObservationError::Query
            );
        }
        for code in [
            tonic::Code::Unknown,
            tonic::Code::Internal,
            tonic::Code::Unauthenticated,
            tonic::Code::PermissionDenied,
            tonic::Code::Unavailable,
            tonic::Code::DeadlineExceeded,
            tonic::Code::Cancelled,
            tonic::Code::NotFound,
        ] {
            let status = tonic::Status::new(code, "credential-sentinel");
            assert_eq!(
                remote_rejection("CreateSandbox", &status),
                remote_error(&status)
            );
            assert!(
                !remote_rejection("CreateSandbox", &status)
                    .to_string()
                    .contains("credential-sentinel")
            );
        }
    }

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
