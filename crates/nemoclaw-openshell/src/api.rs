// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Endpoint-bound credentials for APIs that are not inference or web search.
use nemoclaw_backend::ObservationError;
use openshell_sdk::raw::proto;
use serde_json::json;

/// The registration's configuration key holding its endpoint list, as JSON.
pub const ENDPOINTS_CONFIG: &str = "NEMOCLAW_API_ENDPOINTS";

/// An API's endpoint list as rows carry it: a JSON array of URLs.
pub fn endpoints(json: &str) -> Result<Vec<String>, ObservationError> {
    serde_json::from_str(json).map_err(|_| ObservationError::Query)
}

/// Row field for an API's optional MCP policy.
pub const MCP_POLICY: &str = "mcp_json";

/// An enforced MCP policy for the API's exact path.
#[derive(serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct McpPolicy {
    /// The only MCP requests this endpoint admits.
    rules: Vec<crate::policy::PolicyAllowRule>,
}

/// The variable a sandbox sees an API's key in when none is chosen: a stable
/// placeholder name, independent of the host's credential reference.
pub fn credential_key(name: &str) -> String {
    format!(
        "NEMOCLAW_API_{}_KEY",
        name.replace('-', "_").to_ascii_uppercase()
    )
}

/// Project a declared API into OpenShell's profile: one credential, sent to
/// each endpoint's host, port and path subtree. OpenShell owns credential
/// injection and destination authorization when the sandbox connects, and
/// rejects two providers on one sandbox that claim the same variable.
/// `sandbox_env` names the variable the sandbox sees the key in; empty
/// selects a name derived from `name`.
pub fn definition(
    name: &str,
    endpoints: &[String],
    auth_style: &str,
    header_name: &str,
    mcp_policy: &str,
    sandbox_env: &str,
) -> Result<proto::ProviderProfile, ObservationError> {
    if !crate::valid_name(name) || endpoints.is_empty() {
        return Err(ObservationError::Query);
    }
    // NemoClaw's MCP projection enforces one tool allowlist on one path.
    if !mcp_policy.is_empty() && endpoints.len() != 1 {
        return Err(ObservationError::Query);
    }
    // NemoClaw's MCP projection enforces one tool allowlist on one path.
    let (auth_style, header_name) = match (auth_style, header_name) {
        ("" | "bearer", "") => ("bearer", "Authorization"),
        ("" | "bearer", header) => ("bearer", header),
        ("header", header) if !header.is_empty() => ("header", header),
        _ => return Err(ObservationError::Query),
    };
    // An HTTP field name is a token, never a value containing whitespace or
    // line breaks. Keep invalid names out of the profile creation request.
    if !header_name
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
    {
        return Err(ObservationError::Query);
    }
    let id = format!("nemoclaw-api-{name}");
    let policy_endpoints = endpoints
        .iter()
        .map(|endpoint| policy_endpoint(endpoint, mcp_policy))
        .collect::<Result<Vec<_>, _>>()?;
    let policy = openshell_policy::parse_sandbox_policy(
        &json!({"version": 1, "network_policies": {&id: {
            "name": id, "binaries": [], "endpoints": policy_endpoints
        }}})
        .to_string(),
    )
    .map_err(|_| ObservationError::Query)?;
    let key = if sandbox_env.is_empty() {
        credential_key(name)
    } else {
        sandbox_env.to_owned()
    };
    Ok(proto::ProviderProfile {
        id: id.clone(),
        display_name: format!("NemoClaw API {name}"),
        category: proto::ProviderProfileCategory::Other as i32,
        credentials: vec![proto::ProviderProfileCredential {
            name: key.clone(),
            env_vars: vec![key],
            required: true,
            auth_style: auth_style.into(),
            header_name: header_name.into(),
            ..Default::default()
        }],
        endpoints: policy.network_policies[&id].endpoints.clone(),
        ..Default::default()
    })
}

/// One endpoint's policy rule: the URL's path subtree, or with an MCP policy
/// its exact path and allowed requests.
fn policy_endpoint(
    endpoint: &str,
    mcp_policy: &str,
) -> Result<serde_json::Value, ObservationError> {
    nemoclaw_backend::validate_endpoint_url(endpoint).map_err(|_| ObservationError::Query)?;
    let url = url::Url::parse(endpoint).map_err(|_| ObservationError::Query)?;
    let host = url.host_str().ok_or(ObservationError::Query)?;
    if host.contains(['*', '?', '{', '}']) || url.path().contains(['*', '?', '[', ']']) {
        return Err(ObservationError::Query);
    }
    // Match inference profiles: authorize only a selected literal IP, never
    // its surrounding private network. DNS destinations remain OpenShell's.
    let allowed_ips: Vec<String> = host
        .trim_matches(['[', ']'])
        .parse::<std::net::IpAddr>()
        .ok()
        .into_iter()
        .map(|ip| format!("{ip}/{}", if ip.is_ipv4() { 32 } else { 128 }))
        .collect();
    let port = url
        .port_or_known_default()
        .filter(|port| *port != 0)
        .ok_or(ObservationError::Query)?;
    let mut policy_endpoint = json!({ "host": host, "port": port, "allowed_ips": allowed_ips });
    if mcp_policy.is_empty() {
        policy_endpoint["path"] = json!(format!("{}/**", url.path().trim_end_matches('/')));
        policy_endpoint["protocol"] = json!("rest");
        policy_endpoint["access"] = json!("full");
        return Ok(policy_endpoint);
    }
    let path = url.path();
    // OpenShell matches the selector against the canonical request path.
    // Reject paths it would rewrite or refuse instead of installing an unusable rule.
    if path.contains("//")
        || path.contains([';', '^', '|'])
        || endpoint.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(ObservationError::Query);
    }
    let mcp: McpPolicy = serde_json::from_str(mcp_policy).map_err(|_| ObservationError::Query)?;
    // OpenShell lowers both selectors to params.name and keeps an explicit
    // params.name over tool. Reject the ambiguity before lowering.
    if mcp.rules.is_empty()
        || mcp.rules.iter().any(|rule| {
            rule.allow.tool.is_some()
                && rule
                    .allow
                    .params
                    .as_ref()
                    .is_some_and(|params| params.contains_key("name"))
        })
    {
        return Err(ObservationError::Query);
    }
    policy_endpoint["path"] = json!(path);
    policy_endpoint["protocol"] = json!("mcp");
    policy_endpoint["enforcement"] = json!("enforce");
    policy_endpoint["rules"] = json!(mcp.rules);
    Ok(policy_endpoint)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MCP_RULE: &str = r#"{"rules":[{"allow":{"method":"tools/call","tool":"get_quote"}}]}"#;

    #[test]
    fn mcp_rules_reject_two_selectors_for_the_same_tool_name() {
        let policy = r#"{"rules":[{"allow":{"method":"tools/call","tool":"get_quote","params":{"name":"*"}}}]}"#;
        let url = "https://booking.example.com/mcp";
        assert!(definition("booking", &[url.to_string()], "", "", policy, "").is_err());

        let policy =
            r#"{"rules":[{"allow":{"method":"tools/call","params":{"name":"get_quote"}}}]}"#;
        let explicit_name = definition("booking", &[url.to_string()], "", "", policy, "").unwrap();
        let tool = definition("booking", &[url.to_string()], "", "", MCP_RULE, "").unwrap();
        assert_eq!(explicit_name.endpoints, tool.endpoints);
    }

    #[test]
    fn mcp_endpoints_reject_paths_openshell_rewrites_before_matching() {
        for path in [
            "//mcp",
            "/team//mcp",
            "/mcp;v=1",
            "/mcp^v",
            "/mcp|v",
            "/mcp\x7f",
        ] {
            let url = format!("https://booking.example.com{path}");
            assert!(
                definition("booking", std::slice::from_ref(&url), "", "", MCP_RULE, "").is_err(),
                "{url}"
            );
            assert!(
                definition("booking", std::slice::from_ref(&url), "", "", "", "").is_ok(),
                "{url}"
            );
        }

        for path in ["/", "/mcp", "/mcp/", "/team/mcp"] {
            let url = format!("https://booking.example.com{path}");
            let profile =
                definition("booking", std::slice::from_ref(&url), "", "", MCP_RULE, "").unwrap();
            assert_eq!(profile.endpoints[0].path, path);
        }
    }

    #[test]
    fn literal_endpoint_grants_only_its_address_and_dns_grants_no_private_network() {
        for (url, host, port, allowed_ips) in [
            (
                "http://10.42.0.7:8080/mcp",
                "10.42.0.7",
                8080,
                vec!["10.42.0.7/32"],
            ),
            (
                "https://[fd00::7]/mcp",
                "[fd00::7]",
                443,
                vec!["fd00::7/128"],
            ),
            (
                "https://booking.example.com/mcp",
                "booking.example.com",
                443,
                vec![],
            ),
        ] {
            let profile = definition("booking", &[url.to_string()], "", "", "", "").unwrap();
            assert_eq!(profile.endpoints.len(), 1);
            let endpoint = &profile.endpoints[0];
            assert_eq!(endpoint.host, host);
            assert_eq!(endpoint.port, port);
            assert_eq!(endpoint.path, "/mcp/**");
            assert_eq!(endpoint.allowed_ips, allowed_ips);
        }
    }
    #[test]
    fn one_key_reaches_every_endpoint_under_the_variable_the_sandbox_sees() {
        let endpoints = [
            "https://integrate.api.nvidia.com/v1".to_string(),
            "https://ai.api.nvidia.com/v1".to_string(),
        ];
        let profile = definition("nvidia", &endpoints, "", "", "", "NVIDIA_API_KEY").unwrap();
        let bound: Vec<_> = profile
            .endpoints
            .iter()
            .map(|endpoint| {
                (
                    endpoint.host.as_str(),
                    endpoint.port,
                    endpoint.path.as_str(),
                )
            })
            .collect();
        assert_eq!(
            bound,
            [
                ("integrate.api.nvidia.com", 443, "/v1/**"),
                ("ai.api.nvidia.com", 443, "/v1/**")
            ],
            "each URL must bind its own host, port and path subtree"
        );
        assert_eq!(profile.credentials.len(), 1, "one key for every endpoint");
        assert_eq!(profile.credentials[0].env_vars, ["NVIDIA_API_KEY"]);

        let derived = definition("nvidia", &endpoints, "", "", "", "").unwrap();
        assert_eq!(
            derived.credentials[0].env_vars,
            ["NEMOCLAW_API_NVIDIA_KEY"],
            "without a chosen name the sandbox sees the derived one"
        );
        assert!(
            definition("nvidia", &[], "", "", "", "").is_err(),
            "an API needs an endpoint"
        );
    }

    #[test]
    fn an_mcp_policy_takes_exactly_one_endpoint() {
        let one = ["https://booking.example.com/mcp".to_string()];
        assert!(definition("booking", &one, "", "", MCP_RULE, "").is_ok());
        let two = [one[0].clone(), "https://quotes.example.com/mcp".to_string()];
        assert!(definition("booking", &two, "", "", MCP_RULE, "").is_err());
    }
}
