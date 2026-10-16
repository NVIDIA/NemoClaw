// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A sandbox's service exposures, passed to OpenShell at creation in its
//! terms, and the URLs the gateway reports for them.
//!
//! `services_json` lists each exposure's `name`, `target_port`, and optional
//! `authorization_mode`. Like `driver_config`, it is part of the creation
//! request; OpenShell resolves an omitted mode to STRIP.

use nemoclaw_backend::{ObservationError, Row};
use openshell_sdk::raw::proto;
use serde_json::{Map, Value};

pub(crate) const FIELD: &str = "services_json";
pub(crate) const URLS: &str = "service_urls_json";

/// One exposure as written.
struct Exposure {
    name: String,
    target_port: u32,
    mode: Option<proto::ServiceAuthorizationMode>,
}

/// One endpoint the gateway reports for the sandbox.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Endpoint {
    pub name: String,
    pub target_port: u32,
    pub mode: proto::ServiceAuthorizationMode,
    pub url: String,
}

fn exposures(json: &str) -> Result<Vec<Exposure>, ObservationError> {
    if json.is_empty() {
        return Ok(Vec::new());
    }
    let Ok(Value::Array(services)) = serde_json::from_str(json) else {
        return Err(ObservationError::Query);
    };
    services
        .iter()
        .map(|service| {
            let mode = match &service["authorization_mode"] {
                Value::Null => None,
                Value::String(mode) => Some(
                    proto::ServiceAuthorizationMode::from_str_name(&format!(
                        "SERVICE_AUTHORIZATION_MODE_{mode}"
                    ))
                    .ok_or(ObservationError::Query)?,
                ),
                _ => return Err(ObservationError::Query),
            };
            Ok(Exposure {
                name: service["name"]
                    .as_str()
                    .ok_or(ObservationError::Query)?
                    .to_owned(),
                target_port: service["target_port"]
                    .as_u64()
                    .and_then(|port| u32::try_from(port).ok())
                    .ok_or(ObservationError::Query)?,
                mode,
            })
        })
        .collect()
}

/// The names of the exposures a row requests, in order.
pub(crate) fn names(json: &str) -> Result<Vec<String>, ObservationError> {
    Ok(exposures(json)?
        .into_iter()
        .map(|exposure| exposure.name)
        .collect())
}

/// The creation request's exposures, with an omitted mode left unspecified for
/// OpenShell to resolve.
pub(crate) fn request(json: &str) -> Result<Vec<proto::SandboxServiceExposure>, ObservationError> {
    Ok(exposures(json)?
        .into_iter()
        .map(|exposure| proto::SandboxServiceExposure {
            service: exposure.name,
            target_port: exposure.target_port,
            authorization_mode: exposure
                .mode
                .unwrap_or(proto::ServiceAuthorizationMode::Unspecified)
                as i32,
        })
        .collect())
}

/// The `services_json` the observed endpoints correspond to, written as the
/// reference writes it: STRIP stays omitted where the reference omits the mode,
/// so OpenShell's default is no change.
pub(crate) fn observed(
    endpoints: &[Endpoint],
    reference: &str,
) -> Result<String, ObservationError> {
    if endpoints.is_empty() {
        return Ok(if reference.is_empty() {
            String::new()
        } else {
            "[]".into()
        });
    }
    let written = exposures(reference)?;
    let services: Vec<Value> = endpoints
        .iter()
        .map(|endpoint| {
            let mut service = Map::new();
            let omitted = endpoint.mode == proto::ServiceAuthorizationMode::Strip
                && written
                    .iter()
                    .any(|exposure| exposure.name == endpoint.name && exposure.mode.is_none());
            if !omitted {
                let mode = endpoint.mode.as_str_name();
                service.insert(
                    "authorization_mode".into(),
                    mode.trim_start_matches("SERVICE_AUTHORIZATION_MODE_")
                        .into(),
                );
            }
            service.insert("name".into(), endpoint.name.clone().into());
            service.insert("target_port".into(), endpoint.target_port.into());
            Value::Object(service)
        })
        .collect();
    serde_json::to_string(&services).map_err(|_| ObservationError::Incomplete)
}

/// The URLs the gateway reported, by service name; none is invented for an
/// endpoint it reports without one.
pub(crate) fn urls(endpoints: &[Endpoint]) -> String {
    let urls: Map<String, Value> = endpoints
        .iter()
        .filter(|endpoint| !endpoint.url.is_empty())
        .map(|endpoint| (endpoint.name.clone(), endpoint.url.clone().into()))
        .collect();
    Value::Object(urls).to_string()
}

/// Read a reported endpoint, which must belong to the bound sandbox.
pub(crate) fn endpoint(
    response: proto::ServiceEndpointResponse,
    workspace: &str,
    sandbox: &Row,
) -> Result<Endpoint, ObservationError> {
    let endpoint = response.endpoint.ok_or(ObservationError::Incomplete)?;
    let id = sandbox.get("id").map(String::as_str).unwrap_or_default();
    let name = sandbox.get("name").map(String::as_str).unwrap_or_default();
    if id.is_empty()
        || endpoint.sandbox != name
        || endpoint.sandbox_id != id
        || endpoint
            .metadata
            .as_ref()
            .is_some_and(|meta| meta.workspace != workspace)
    {
        return Err(ObservationError::BindingMismatch);
    }
    let mode = match proto::ServiceAuthorizationMode::try_from(endpoint.authorization_mode) {
        Ok(proto::ServiceAuthorizationMode::Unspecified) => proto::ServiceAuthorizationMode::Strip,
        Ok(mode) => mode,
        Err(_) => return Err(ObservationError::Incomplete),
    };
    Ok(Endpoint {
        name: endpoint.name,
        target_port: endpoint.target_port,
        mode,
        url: response.url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creation_sends_exposures_as_written() {
        let sent = request(
            r#"[{"name":"writer","authorization_mode":"BEARER_PASSTHROUGH","target_port":7000},{"name":"research","target_port":8080}]"#,
        )
        .unwrap();
        assert_eq!(
            (sent[0].service.as_str(), sent[0].authorization_mode),
            (
                "writer",
                proto::ServiceAuthorizationMode::BearerPassthrough as i32
            )
        );
        assert_eq!(
            (sent[1].target_port, sent[1].authorization_mode),
            (8080, proto::ServiceAuthorizationMode::Unspecified as i32)
        );
        assert!(
            request(r#"[{"name":"web","target_port":80,"authorization_mode":"ALLOW"}]"#).is_err()
        );
    }

    #[test]
    fn observed_strip_matches_an_omitted_or_explicit_mode() {
        let strip = [Endpoint {
            name: "web".into(),
            target_port: 8080,
            mode: proto::ServiceAuthorizationMode::Strip,
            url: String::new(),
        }];
        let omitted = r#"[{"name":"web","target_port":8080}]"#;
        let explicit = r#"[{"authorization_mode":"STRIP","name":"web","target_port":8080}]"#;
        assert_eq!(observed(&strip, omitted).unwrap(), omitted);
        assert_eq!(observed(&strip, explicit).unwrap(), explicit);
        assert_eq!(urls(&strip), "{}");
    }
}
