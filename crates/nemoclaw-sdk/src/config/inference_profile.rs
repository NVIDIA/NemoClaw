// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{ObservationError, config::InferenceProviderKind};
use openshell_core::proto;

/// Build the endpoint and credential projection for a native inference provider.
/// The caller must supply image-resolved binaries before importing the profile.
pub fn definition(
    name: &str,
    endpoint: &str,
    kind: InferenceProviderKind,
    authenticated: bool,
) -> Result<proto::ProviderProfile, ObservationError> {
    crate::config::validate_endpoint(endpoint, false).map_err(|_| ObservationError::Query)?;
    let url = url::Url::parse(endpoint).map_err(|_| ObservationError::Query)?;
    let allowed_ips = url
        .host_str()
        .and_then(|host| host.parse::<std::net::IpAddr>().ok())
        .into_iter()
        .collect::<Vec<_>>();
    profile(name, endpoint, kind, authenticated, &allowed_ips)
}

/// Project a document-owned service before its cluster address exists. This does
/// not grant private destinations; the provider adds verified Service addresses.
pub fn for_provider(
    document: &crate::config::Document,
    provider: &crate::config::InferenceProvider,
    name: &str,
    authenticated: bool,
) -> Result<proto::ProviderProfile, ObservationError> {
    let endpoint = document
        .provider_connection(provider)
        .map_err(|_| ObservationError::Query)?
        .endpoint;
    if provider
        .service_ref
        .as_ref()
        .and_then(|name| document.spec.services.get(name))
        .is_some_and(|service| service.kubernetes().is_some())
    {
        profile(name, &endpoint, provider.provider, authenticated, &[])
    } else {
        definition(name, &endpoint, provider.provider, authenticated)
    }
}

/// Build a policy for a bound cluster service using only its observed addresses.
/// Callers must verify the Service identity before supplying these addresses.
pub fn cluster_definition(
    name: &str,
    endpoint: &str,
    kind: InferenceProviderKind,
    authenticated: bool,
    storage: &crate::kubernetes::services::StorageSpec,
    addresses: &[std::net::IpAddr],
) -> Result<proto::ProviderProfile, ObservationError> {
    storage
        .validate()
        .map_err(|_| ObservationError::BindingMismatch)?;
    let url = url::Url::parse(endpoint).map_err(|_| ObservationError::Query)?;
    let host = format!("{}.{}.svc", storage.name, storage.namespace());
    if authenticated != storage.authenticated
        || url.scheme() != "http"
        || url.host_str() != Some(host.as_str())
        || url.port().is_none_or(|port| port == 0)
        || url.path() != "/v1"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || addresses.iter().any(|address| {
            address.is_unspecified()
                || address.is_loopback()
                || address.is_multicast()
                || match address {
                    std::net::IpAddr::V4(ip) => ip.is_link_local(),
                    std::net::IpAddr::V6(ip) => ip.is_unicast_link_local(),
                }
        })
    {
        return Err(ObservationError::BindingMismatch);
    }
    profile(name, endpoint, kind, authenticated, addresses)
}

fn profile(
    name: &str,
    endpoint: &str,
    kind: InferenceProviderKind,
    authenticated: bool,
    addresses: &[std::net::IpAddr],
) -> Result<proto::ProviderProfile, ObservationError> {
    if name.is_empty()
        || name.len() > 40
        || !name.as_bytes()[0].is_ascii_lowercase()
        || !name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(ObservationError::Query);
    }
    let url = url::Url::parse(endpoint).map_err(|_| ObservationError::Query)?;
    if url.query().is_some()
        || url.fragment().is_some()
        || url.path().contains(['*', '?', '[', ']', '{', '}'])
    {
        return Err(ObservationError::Query);
    }
    let host = url.host_str().ok_or(ObservationError::Query)?;
    let port = url.port_or_known_default().ok_or(ObservationError::Query)?;
    let id = format!("nemoclaw-inference-{name}");
    let key = format!(
        "NEMOCLAW_INFERENCE_{}_KEY",
        name.replace('-', "_").to_ascii_uppercase()
    );
    let path = format!("{}/**", url.path().trim_end_matches('/'));
    // Private addresses require an explicit destination-validation grant. Grant
    // only the selected literal address, never a whole private network.
    let allowed_ips: Vec<String> = addresses
        .iter()
        .map(|ip| format!("{ip}/{}", if ip.is_ipv4() { 32 } else { 128 }))
        .collect();
    let policy = openshell_policy::parse_sandbox_policy(
        &serde_json::json!({
            "version": 1,
            "network_policies": { &id: {
                "name": id,
                "endpoints": [{"host": host, "port": port, "path": path,
                    "protocol": "rest", "access": "full", "allowed_ips": allowed_ips}],
                "binaries": []
            }}
        })
        .to_string(),
    )
    .map_err(|_| ObservationError::Query)?;
    let rule = &policy.network_policies[&id];
    Ok(proto::ProviderProfile {
        id,
        display_name: format!("NemoClaw inference {name}"),
        category: proto::ProviderProfileCategory::Inference as i32,
        inference_capable: true,
        credentials: if authenticated {
            vec![proto::ProviderProfileCredential {
                name: key.clone(),
                env_vars: vec![key],
                required: true,
                auth_style: if kind == InferenceProviderKind::Anthropic {
                    "header"
                } else {
                    "bearer"
                }
                .into(),
                header_name: if kind == InferenceProviderKind::Anthropic {
                    "x-api-key"
                } else {
                    "Authorization"
                }
                .into(),
                ..Default::default()
            }]
        } else {
            vec![]
        },
        endpoints: rule.endpoints.clone(),
        binaries: rule.binaries.clone(),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cluster_model_projection_accepts_owned_dns_without_allowing_authored_http_dns() {
        assert!(
            crate::config::validate_endpoint("http://arbitrary.default.svc:8000/v1", false)
                .is_err()
        );
        let document = crate::config::Document::parse(
            include_bytes!("../../../../examples/kubernetes/local-vllm.yaml").as_slice(),
        )
        .unwrap();
        let sandbox = &document.spec.sandboxes[0];
        let projected = crate::fabric_config::for_sandbox(&document, sandbox).unwrap();
        assert!(
            projected["models"]["default"]["base_url"]
                .as_str()
                .unwrap()
                .contains(".nemoclaw-local-vllm.svc:")
        );
        assert_eq!(projected["models"]["default"]["api"], "openai-completions");
        let policy = crate::image_runtime::PolicyInput::for_sandbox(&document, sandbox).unwrap();
        let encoded = serde_json::to_value(policy).unwrap();
        assert!(!encoded["managed"].as_object().unwrap().is_empty());
        assert!(
            encoded["managed"]
                .as_object()
                .unwrap()
                .values()
                .all(|rule| rule["endpoints"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|endpoint| endpoint["allowed_ips"].as_array().is_none_or(Vec::is_empty)))
        );
    }

    #[test]
    fn inference_credentials_and_policy_are_bound_to_the_selected_endpoint() {
        let profile = definition(
            "local",
            "http://172.20.0.1:11436/v1",
            InferenceProviderKind::Openai,
            true,
        )
        .unwrap();
        assert_eq!(profile.id, "nemoclaw-inference-local");
        assert_eq!(
            profile.credentials[0].env_vars,
            ["NEMOCLAW_INFERENCE_LOCAL_KEY"]
        );
        assert_eq!(profile.endpoints.len(), 1);
        let endpoint = &profile.endpoints[0];
        assert_eq!(endpoint.host, "172.20.0.1");
        assert_eq!(endpoint.port, 11436);
        assert_eq!(endpoint.path, "/v1/**");
        assert_eq!(endpoint.protocol, "rest");
        assert!(endpoint.allowed_ips.contains(&"172.20.0.1/32".to_string()));
        let other = definition(
            "hosted",
            "https://api.example.com/v1",
            InferenceProviderKind::Anthropic,
            true,
        )
        .unwrap();
        assert_ne!(
            other.credentials[0].env_vars,
            profile.credentials[0].env_vars
        );
        assert_eq!(other.credentials[0].header_name, "x-api-key");
    }

    #[test]
    fn endpoint_projection_grants_no_implicit_interpreters() {
        let profile = definition(
            "local",
            "http://172.20.0.1:11436/v1",
            InferenceProviderKind::Openai,
            false,
        )
        .unwrap();
        assert!(profile.binaries.is_empty());
        assert_eq!(profile.endpoints.len(), 1);
        assert_eq!(profile.endpoints[0].allowed_ips, ["172.20.0.1/32"]);
    }

    #[test]
    fn credentialless_models_need_no_placeholder_and_invalid_urls_fail_closed() {
        assert!(
            definition(
                "local",
                "http://172.20.0.1:11434/v1",
                InferenceProviderKind::Openai,
                false
            )
            .unwrap()
            .credentials
            .is_empty()
        );
        for endpoint in [
            "https://user:secret@example.com/v1",
            "https://example.com/v1?key=secret",
            "https://example.com/v1#fragment",
            "file:///tmp/model",
        ] {
            assert!(definition("local", endpoint, InferenceProviderKind::Openai, true).is_err());
        }
    }
}
