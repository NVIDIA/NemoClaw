// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::ObservationError;
use openshell_core::proto;

/// Build the endpoint and credential boundary for a native inference provider.
pub fn definition(
    name: &str,
    endpoint: &str,
    api: &str,
    authenticated: bool,
) -> Result<proto::ProviderProfile, ObservationError> {
    if name.is_empty()
        || name.len() > 40
        || !name.as_bytes()[0].is_ascii_lowercase()
        || !name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || !matches!(api, "openai" | "anthropic")
    {
        return Err(ObservationError::Query);
    }
    crate::config::validate_endpoint(endpoint, false).map_err(|_| ObservationError::Query)?;
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
    let allowed_ips: Vec<String> = host
        .parse::<std::net::IpAddr>()
        .ok()
        .map(|ip| format!("{ip}/{}", if ip.is_ipv4() { 32 } else { 128 }))
        .into_iter()
        .collect();
    let policy = openshell_policy::parse_sandbox_policy(
        &serde_json::json!({
            "version": 1,
            "network_policies": { &id: {
                "name": id,
                "endpoints": [{"host": host, "port": port, "path": path,
                    "protocol": "rest", "access": "full", "allowed_ips": allowed_ips}],
                "binaries": [{"path": "/opt/fabric/bin/python"}, {"path": "/usr/local/bin/node"}]
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
                auth_style: if api == "anthropic" {
                    "header"
                } else {
                    "bearer"
                }
                .into(),
                header_name: if api == "anthropic" {
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
    fn inference_credentials_and_policy_are_bound_to_the_selected_endpoint() {
        let profile = definition("local", "http://172.20.0.1:11436/v1", "openai", true).unwrap();
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
        let other = definition("oracle", "https://api.example.com/v1", "anthropic", true).unwrap();
        assert_ne!(
            other.credentials[0].env_vars,
            profile.credentials[0].env_vars
        );
        assert_eq!(other.credentials[0].header_name, "x-api-key");
    }

    #[test]
    fn credentialless_models_need_no_placeholder_and_invalid_urls_fail_closed() {
        assert!(
            definition("local", "http://172.20.0.1:11434/v1", "openai", false)
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
            assert!(definition("local", endpoint, "openai", true).is_err());
        }
    }
}
