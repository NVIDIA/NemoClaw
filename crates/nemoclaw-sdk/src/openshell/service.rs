// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{OpenShell, proto, remote_error};
use crate::ObservationError;

fn route_authority(
    response: proto::ServiceEndpointResponse,
    workspace: &str,
    sandbox: &str,
    sandbox_id: &str,
    service: &str,
    target_port: u16,
) -> Result<String, ObservationError> {
    let endpoint = response.endpoint.ok_or(ObservationError::Incomplete)?;
    let metadata = endpoint
        .metadata
        .as_ref()
        .ok_or(ObservationError::Incomplete)?;
    if metadata.workspace != workspace
        || endpoint.sandbox_name != sandbox
        || endpoint.sandbox_id != sandbox_id
        || endpoint.service_name != service
        || endpoint.target_port != u32::from(target_port)
        || !endpoint.domain
    {
        return Err(ObservationError::BindingMismatch);
    }
    let url = url::Url::parse(&response.url).map_err(|_| ObservationError::Incomplete)?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || url
            .host_str()
            .is_none_or(|host| !host.ends_with(".localhost"))
        || url.port().is_none()
    {
        return Err(ObservationError::Incomplete);
    }
    Ok(url[url::Position::BeforeHost..url::Position::AfterPort].to_string())
}

impl OpenShell {
    pub(crate) async fn expose_service(
        &self,
        workspace: &str,
        sandbox: &str,
        sandbox_id: &str,
        service: &str,
        target_port: u16,
    ) -> Result<String, ObservationError> {
        let response = self
            .grpc()
            .expose_service(self.request(proto::ExposeServiceRequest {
                sandbox: sandbox.into(),
                service: service.into(),
                target_port: u32::from(target_port),
                domain: true,
                workspace_scope: Some(proto::workspace_selector(workspace)),
                request_id: String::new(),
            }))
            .await
            .map_err(|error| remote_error(&error))?
            .into_inner();
        route_authority(
            response,
            workspace,
            sandbox,
            sandbox_id,
            service,
            target_port,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response() -> proto::ServiceEndpointResponse {
        proto::ServiceEndpointResponse {
            endpoint: Some(proto::ServiceEndpoint {
                metadata: Some(proto::ObjectMeta {
                    workspace: "workspace".into(),
                    ..Default::default()
                }),
                sandbox_id: "sandbox-id".into(),
                sandbox_name: "assistant".into(),
                service_name: "voice-voice".into(),
                target_port: 18_800,
                domain: true,
            }),
            url: "http://workspace--assistant--voice-voice.openshell.localhost:17691/".into(),
        }
    }

    #[test]
    fn service_route_is_bound_to_the_requested_sandbox_and_port() {
        assert_eq!(
            route_authority(
                response(),
                "workspace",
                "assistant",
                "sandbox-id",
                "voice-voice",
                18_800,
            )
            .unwrap(),
            "workspace--assistant--voice-voice.openshell.localhost:17691"
        );

        let mut changed = response();
        changed.endpoint.as_mut().unwrap().sandbox_id = "other".into();
        assert_eq!(
            route_authority(
                changed,
                "workspace",
                "assistant",
                "sandbox-id",
                "voice-voice",
                18_800,
            )
            .unwrap_err(),
            ObservationError::BindingMismatch
        );
    }

    #[test]
    fn service_route_rejects_decorated_or_incomplete_urls() {
        for invalid in [
            "",
            "http://user:secret@route.openshell.localhost:17691/",
            "http://route.openshell.localhost:17691/path",
            "http://route.openshell.localhost:17691/?next=other",
        ] {
            let mut value = response();
            value.url = invalid.into();
            assert!(
                route_authority(
                    value,
                    "workspace",
                    "assistant",
                    "sandbox-id",
                    "voice-voice",
                    18_800,
                )
                .is_err()
            );
        }
    }
}
