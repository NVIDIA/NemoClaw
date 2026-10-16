// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A sandbox's service endpoints: OpenShell's sandbox service exposures, in
//! OpenShell's terms, and the URLs the gateway reports for them.
//!
//! A sandbox owns every endpoint on it. Its `services_json` row field lists
//! each endpoint's `name`, `target_port`, and optional `authorization_mode`;
//! OpenShell resolves an omitted mode to STRIP, and an empty name is its
//! unnamed endpoint.

use nemoclaw_backend::{ObservationError, Row};
use openshell_sdk::raw::proto;
use serde_json::{Map, Value};

pub(crate) const FIELD: &str = "services_json";
pub(crate) const URLS: &str = "service_urls_json";

/// One endpoint as authored: its port, and the mode as written, if any.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Exposure {
    pub target_port: u32,
    pub mode: Option<proto::ServiceAuthorizationMode>,
}

impl Exposure {
    /// The mode OpenShell applies: an omitted one is STRIP.
    fn effective(&self) -> proto::ServiceAuthorizationMode {
        self.mode.unwrap_or(proto::ServiceAuthorizationMode::Strip)
    }
}

/// One endpoint the gateway reports for a sandbox.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Endpoint {
    pub name: String,
    pub target_port: u32,
    pub mode: proto::ServiceAuthorizationMode,
    pub url: String,
}

fn mode_name(mode: proto::ServiceAuthorizationMode) -> &'static str {
    match mode {
        proto::ServiceAuthorizationMode::BearerPassthrough => "BEARER_PASSTHROUGH",
        _ => "STRIP",
    }
}

/// Check an authored mode, explaining a rejection without echoing it.
pub(crate) fn parse_mode(name: &str) -> Option<proto::ServiceAuthorizationMode> {
    match name {
        "STRIP" => Some(proto::ServiceAuthorizationMode::Strip),
        "BEARER_PASSTHROUGH" => Some(proto::ServiceAuthorizationMode::BearerPassthrough),
        _ => None,
    }
}

/// The exposures a row requests, in order, by service name. An empty field
/// requests none; a name may appear once.
pub(crate) fn desired(json: &str) -> Result<Vec<(String, Exposure)>, ObservationError> {
    if json.is_empty() {
        return Ok(Vec::new());
    }
    let Ok(Value::Array(services)) = serde_json::from_str(json) else {
        return Err(ObservationError::Query);
    };
    let mut desired: Vec<(String, Exposure)> = Vec::with_capacity(services.len());
    for service in services {
        let name = service["name"].as_str().ok_or(ObservationError::Query)?;
        let target_port = service["target_port"]
            .as_u64()
            .and_then(|port| u32::try_from(port).ok())
            .ok_or(ObservationError::Query)?;
        let mode = match &service["authorization_mode"] {
            Value::Null => None,
            Value::String(mode) => Some(parse_mode(mode).ok_or(ObservationError::Query)?),
            _ => return Err(ObservationError::Query),
        };
        if desired.iter().any(|(seen, _)| seen == name) {
            return Err(ObservationError::Query);
        }
        desired.push((name.to_owned(), Exposure { target_port, mode }));
    }
    Ok(desired)
}

/// Explain why a `services_json` value is invalid, without echoing it.
pub(crate) fn check(json: &str) -> Result<(), std::borrow::Cow<'static, str>> {
    desired(json).map(|_| ()).map_err(|_| {
        "each service needs a distinct name and a whole target_port, and authorization_mode must be STRIP or BEARER_PASSTHROUGH".into()
    })
}

/// The creation request's exposures, with an omitted mode left unspecified for
/// OpenShell to resolve.
pub(crate) fn request(json: &str) -> Result<Vec<proto::SandboxServiceExposure>, ObservationError> {
    Ok(desired(json)?
        .into_iter()
        .map(|(service, exposure)| proto::SandboxServiceExposure {
            service,
            target_port: exposure.target_port,
            authorization_mode: exposure
                .mode
                .unwrap_or(proto::ServiceAuthorizationMode::Unspecified)
                as i32,
        })
        .collect())
}

/// The `services_json` an observation corresponds to, written as the
/// reference writes it: endpoints in its order, then any others by name, and
/// STRIP omitted where it omits the mode, so OpenShell's default plans no
/// change. An empty reference stays empty when there are no endpoints.
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
    let reference = desired(reference).unwrap_or_default();
    let position = |name: &str| {
        reference
            .iter()
            .position(|(written, _)| written == name)
            .unwrap_or(usize::MAX)
    };
    let mut ordered: Vec<&Endpoint> = endpoints.iter().collect();
    ordered.sort_by(|a, b| (position(&a.name), &a.name).cmp(&(position(&b.name), &b.name)));
    let services: Vec<Value> = ordered
        .into_iter()
        .map(|endpoint| {
            let mut service = Map::new();
            let omitted = endpoint.mode == proto::ServiceAuthorizationMode::Strip
                && reference
                    .iter()
                    .any(|(name, exposure)| *name == endpoint.name && exposure.mode.is_none());
            if !omitted {
                service.insert("authorization_mode".into(), mode_name(endpoint.mode).into());
            }
            service.insert("name".into(), endpoint.name.clone().into());
            service.insert("target_port".into(), endpoint.target_port.into());
            Value::Object(service)
        })
        .collect();
    serde_json::to_string(&services).map_err(|_| ObservationError::Incomplete)
}

/// The URLs the gateway reported, by service name; none is invented for an
/// endpoint the gateway reports without one.
pub(crate) fn urls(endpoints: &[Endpoint]) -> String {
    let urls: Map<String, Value> = endpoints
        .iter()
        .filter(|endpoint| !endpoint.url.is_empty())
        .map(|endpoint| (endpoint.name.clone(), endpoint.url.clone().into()))
        .collect();
    Value::Object(urls).to_string()
}

/// The endpoint mutations that make the observed endpoints the desired ones:
/// exposures to create or update, then names to delete.
pub(crate) fn changes(
    desired: &[(String, Exposure)],
    observed: &[Endpoint],
) -> (Vec<(String, Exposure)>, Vec<String>) {
    let expose = desired
        .iter()
        .filter(|(name, exposure)| {
            !observed.iter().any(|endpoint| {
                endpoint.name == **name
                    && endpoint.target_port == exposure.target_port
                    && endpoint.mode == exposure.effective()
            })
        })
        .map(|(name, exposure)| (name.clone(), exposure.clone()))
        .collect();
    let delete = observed
        .iter()
        .filter(|endpoint| !desired.iter().any(|(name, _)| *name == endpoint.name))
        .map(|endpoint| endpoint.name.clone())
        .collect();
    (expose, delete)
}

/// Check that a reported endpoint belongs to the bound sandbox, and read it.
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
        Ok(
            proto::ServiceAuthorizationMode::Unspecified | proto::ServiceAuthorizationMode::Strip,
        ) => proto::ServiceAuthorizationMode::Strip,
        Ok(mode) => mode,
        Err(_) => return Err(ObservationError::Incomplete),
    };
    if endpoint.target_port == 0 {
        return Err(ObservationError::Incomplete);
    }
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

    fn endpoint(name: &str, port: u32, mode: proto::ServiceAuthorizationMode) -> Endpoint {
        Endpoint {
            name: name.into(),
            target_port: port,
            mode,
            url: format!("http://{name}.test/"),
        }
    }

    #[test]
    fn creation_sends_exposures_as_written() {
        let sent = request(
            r#"[{"name":"writer","authorization_mode":"BEARER_PASSTHROUGH","target_port":7000},{"name":"research","target_port":8080}]"#,
        )
        .unwrap();
        assert_eq!(sent[0].service, "writer");
        assert_eq!(
            sent[0].authorization_mode,
            proto::ServiceAuthorizationMode::BearerPassthrough as i32
        );
        assert_eq!(sent[1].target_port, 8080);
        assert_eq!(
            sent[1].authorization_mode,
            proto::ServiceAuthorizationMode::Unspecified as i32
        );
        assert!(request("").unwrap().is_empty());
    }

    #[test]
    fn invalid_exposures_are_rejected_before_reaching_the_gateway() {
        for json in [
            r#"[{"name":"web","target_port":8080,"authorization_mode":"ALLOW"}]"#,
            r#"[{"name":"web","target_port":8080.5}]"#,
            r#"[{"name":"web","target_port":-1}]"#,
            r#"[{"name":"web"}]"#,
            r#"[{"target_port":80}]"#,
            r#"[{"name":"web","target_port":80},{"name":"web","target_port":81}]"#,
            "{}",
        ] {
            assert!(desired(json).is_err(), "{json}");
            assert!(check(json).is_err(), "{json}");
        }
    }

    #[test]
    fn observed_strip_matches_an_omitted_or_explicit_mode() {
        let observed_strip = [endpoint(
            "web",
            8080,
            proto::ServiceAuthorizationMode::Strip,
        )];
        let omitted = r#"[{"name":"web","target_port":8080}]"#;
        let explicit = r#"[{"authorization_mode":"STRIP","name":"web","target_port":8080}]"#;
        assert_eq!(observed(&observed_strip, omitted).unwrap(), omitted);
        assert_eq!(observed(&observed_strip, explicit).unwrap(), explicit);
        // An endpoint outside the reference reports its mode.
        assert_eq!(observed(&observed_strip, "").unwrap(), explicit);
    }

    #[test]
    fn observed_endpoints_keep_the_written_order() {
        let live = [
            endpoint("a", 1, proto::ServiceAuthorizationMode::Strip),
            endpoint("debug", 3, proto::ServiceAuthorizationMode::Strip),
            endpoint("z", 2, proto::ServiceAuthorizationMode::Strip),
        ];
        let written = r#"[{"name":"z","target_port":2},{"name":"a","target_port":1}]"#;
        assert_eq!(
            observed(&live, written).unwrap(),
            r#"[{"name":"z","target_port":2},{"name":"a","target_port":1},{"authorization_mode":"STRIP","name":"debug","target_port":3}]"#
        );
    }

    #[test]
    fn no_endpoints_match_the_reference_form_of_none() {
        assert_eq!(observed(&[], "").unwrap(), "");
        assert_eq!(observed(&[], "[]").unwrap(), "[]");
        assert_eq!(
            observed(&[], r#"[{"name":"web","target_port":8080}]"#).unwrap(),
            "[]"
        );
    }

    #[test]
    fn urls_report_only_what_the_gateway_reported() {
        let mut unrouted = endpoint("api", 80, proto::ServiceAuthorizationMode::Strip);
        unrouted.url.clear();
        let reported = [
            unrouted,
            endpoint("web", 80, proto::ServiceAuthorizationMode::Strip),
        ];
        assert_eq!(urls(&reported), r#"{"web":"http://web.test/"}"#);
        assert_eq!(urls(&[]), "{}");
    }

    #[test]
    fn changes_expose_differences_and_delete_undeclared_endpoints() {
        let want = desired(
            r#"[{"name":"research","target_port":9090},{"name":"same","authorization_mode":"STRIP","target_port":1},{"name":"new","target_port":2}]"#,
        )
        .unwrap();
        let live = [
            endpoint("research", 8080, proto::ServiceAuthorizationMode::Strip),
            endpoint("same", 1, proto::ServiceAuthorizationMode::Strip),
            endpoint("debug", 3, proto::ServiceAuthorizationMode::Strip),
        ];
        let (expose, delete) = changes(&want, &live);
        let exposed: Vec<&str> = expose.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(exposed, ["research", "new"]);
        assert_eq!(delete, ["debug"]);
        // A mode change alone is a change.
        let bearer = desired(
            r#"[{"name":"same","authorization_mode":"BEARER_PASSTHROUGH","target_port":1}]"#,
        )
        .unwrap();
        assert_eq!(changes(&bearer, &live[1..2]).0.len(), 1);
    }

    #[test]
    fn endpoints_of_another_sandbox_are_not_this_ones() {
        let sandbox = Row::from([
            ("id".into(), "sb-1".into()),
            ("name".into(), "agent".into()),
        ]);
        let response =
            |sandbox_id: &str, name: &str, workspace: &str| proto::ServiceEndpointResponse {
                endpoint: Some(proto::ServiceEndpoint {
                    metadata: Some(proto::ObjectMeta {
                        workspace: workspace.into(),
                        ..Default::default()
                    }),
                    sandbox_id: sandbox_id.into(),
                    sandbox: name.into(),
                    name: "web".into(),
                    target_port: 80,
                    domain: true,
                    authorization_mode: 0,
                }),
                url: String::new(),
            };
        assert_eq!(
            super::endpoint(response("sb-1", "agent", "team"), "team", &sandbox)
                .unwrap()
                .mode,
            proto::ServiceAuthorizationMode::Strip
        );
        for (id, name, workspace) in [
            ("sb-2", "agent", "team"),
            ("sb-1", "other", "team"),
            ("sb-1", "agent", "else"),
        ] {
            assert_eq!(
                super::endpoint(response(id, name, workspace), "team", &sandbox),
                Err(ObservationError::BindingMismatch)
            );
        }
    }
}
