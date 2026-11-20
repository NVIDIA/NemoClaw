// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Endpoint-bound credentials for APIs other than inference.
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

/// Row field for an API's optional REST policy.
pub const REST_POLICY: &str = "rest_json";

/// An enforced MCP policy for the API's exact path.
#[derive(serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct McpPolicy {
    /// The only MCP requests this endpoint admits.
    rules: Vec<crate::policy::PolicyAllowRule>,
}

/// An enforced REST policy for the API's host. OpenShell validates the rules.
#[derive(serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RestPolicy {
    /// The only requests this endpoint admits, by method and path glob.
    rules: Vec<crate::policy::PolicyAllowRule>,
}

/// What an API's endpoints admit: full access to each URL's path subtree, or
/// the requests one policy lists, as JSON. A policy takes exactly one endpoint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rules<'a> {
    Subtree,
    Mcp(&'a str),
    Rest(&'a str),
}

impl<'a> Rules<'a> {
    /// The rules a row's policy fields select; at most one may be set.
    pub fn from_fields(mcp: &'a str, rest: &'a str) -> Result<Self, ObservationError> {
        match (mcp.is_empty(), rest.is_empty()) {
            (true, true) => Ok(Self::Subtree),
            (false, true) => Ok(Self::Mcp(mcp)),
            (true, false) => Ok(Self::Rest(rest)),
            (false, false) => Err(ObservationError::Query),
        }
    }
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
/// each endpoint's host, port and path subtree, or only with the requests
/// `rules` admit. OpenShell owns credential injection and destination
/// authorization when the sandbox connects, and rejects two providers on one
/// sandbox that claim the same variable.
/// `sandbox_env` names the variable the sandbox sees the key in; empty
/// selects a name derived from `name`.
pub fn definition(
    name: &str,
    endpoints: &[String],
    auth_style: &str,
    header_name: &str,
    rules: Rules<'_>,
    sandbox_env: &str,
) -> Result<proto::ProviderProfile, ObservationError> {
    if !crate::valid_name(name) || endpoints.is_empty() {
        return Err(ObservationError::Query);
    }
    // A policy lists the requests of one endpoint.
    if rules != Rules::Subtree && endpoints.len() != 1 {
        return Err(ObservationError::Query);
    }
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
        .map(|endpoint| policy_endpoint(endpoint, rules))
        .collect::<Result<Vec<_>, _>>()?;
    let policy = openshell_policy::parse_sandbox_policy(
        &json!({"version": 1, "network_policies": {&id: {
            "name": id, "binaries": [], "endpoints": policy_endpoints
        }}})
        .to_string(),
    )
    .map_err(|_| ObservationError::Query)?;
    // OpenShell's gateway validates the profile's rules when it is imported;
    // apply the same validation here so a plan fails before any change.
    openshell_policy::validate_and_canonicalize_sandbox_policy(policy.clone())
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

/// One endpoint's policy rule: the URL's path subtree, with an MCP policy its
/// exact path and allowed requests, or with a REST policy its host's allowed
/// requests.
fn policy_endpoint(
    endpoint: &str,
    rules: Rules<'_>,
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
    let mcp_policy = match rules {
        Rules::Subtree => {
            policy_endpoint["path"] = json!(format!("{}/**", url.path().trim_end_matches('/')));
            policy_endpoint["protocol"] = json!("rest");
            policy_endpoint["access"] = json!("full");
            return Ok(policy_endpoint);
        }
        Rules::Rest(rest_policy) => {
            // The rules name whole request paths, so the URL names only a host.
            if !matches!(url.path(), "" | "/") {
                return Err(ObservationError::Query);
            }
            let rest: RestPolicy =
                serde_json::from_str(rest_policy).map_err(|_| ObservationError::Query)?;
            policy_endpoint["protocol"] = json!("rest");
            policy_endpoint["enforcement"] = json!("enforce");
            policy_endpoint["rules"] = json!(rest.rules);
            return Ok(policy_endpoint);
        }
        Rules::Mcp(mcp_policy) => mcp_policy,
    };
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
        assert!(
            definition(
                "booking",
                &[url.to_string()],
                "",
                "",
                Rules::Mcp(policy),
                ""
            )
            .is_err()
        );

        let policy =
            r#"{"rules":[{"allow":{"method":"tools/call","params":{"name":"get_quote"}}}]}"#;
        let explicit_name = definition(
            "booking",
            &[url.to_string()],
            "",
            "",
            Rules::Mcp(policy),
            "",
        )
        .unwrap();
        let tool = definition(
            "booking",
            &[url.to_string()],
            "",
            "",
            Rules::Mcp(MCP_RULE),
            "",
        )
        .unwrap();
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
                definition(
                    "booking",
                    std::slice::from_ref(&url),
                    "",
                    "",
                    Rules::Mcp(MCP_RULE),
                    ""
                )
                .is_err(),
                "{url}"
            );
            assert!(
                definition(
                    "booking",
                    std::slice::from_ref(&url),
                    "",
                    "",
                    Rules::Subtree,
                    ""
                )
                .is_ok(),
                "{url}"
            );
        }

        for path in ["/", "/mcp", "/mcp/", "/team/mcp"] {
            let url = format!("https://booking.example.com{path}");
            let profile = definition(
                "booking",
                std::slice::from_ref(&url),
                "",
                "",
                Rules::Mcp(MCP_RULE),
                "",
            )
            .unwrap();
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
            let profile =
                definition("booking", &[url.to_string()], "", "", Rules::Subtree, "").unwrap();
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
        let profile = definition(
            "nvidia",
            &endpoints,
            "",
            "",
            Rules::Subtree,
            "NVIDIA_API_KEY",
        )
        .unwrap();
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

        let derived = definition("nvidia", &endpoints, "", "", Rules::Subtree, "").unwrap();
        assert_eq!(
            derived.credentials[0].env_vars,
            ["NEMOCLAW_API_NVIDIA_KEY"],
            "without a chosen name the sandbox sees the derived one"
        );
        assert!(
            definition("nvidia", &[], "", "", Rules::Subtree, "").is_err(),
            "an API needs an endpoint"
        );
    }

    const REST_RULES: &str = r#"{"rules":[{"allow":{"method":"POST","path":"/search"}},{"allow":{"method":"POST","path":"/extract"}}]}"#;

    #[test]
    fn rest_rules_enforce_only_the_listed_requests_on_the_endpoint_host() {
        let profile = definition(
            "search",
            &["https://api.tavily.com".to_string()],
            "",
            "",
            Rules::Rest(REST_RULES),
            "TAVILY_API_KEY",
        )
        .unwrap();
        assert_eq!(profile.endpoints.len(), 1);
        let endpoint = &profile.endpoints[0];
        assert_eq!(endpoint.host, "api.tavily.com");
        assert_eq!(endpoint.port, 443);
        assert_eq!(endpoint.protocol, "rest");
        assert_eq!(
            endpoint.enforcement,
            proto::NetworkEnforcementMode::Enforce as i32
        );
        assert_eq!(
            endpoint.access,
            proto::NetworkAccessPreset::Unspecified as i32,
            "rules replace full access"
        );
        assert_eq!(endpoint.path, "", "the rules carry the request paths");
        let allowed: Vec<_> = endpoint
            .rules
            .iter()
            .map(|rule| {
                let allow = rule.allow.as_ref().unwrap();
                (allow.method.as_str(), allow.path.as_str())
            })
            .collect();
        assert_eq!(allowed, [("POST", "/search"), ("POST", "/extract")]);
    }

    #[test]
    fn rest_rules_take_one_host_endpoint_and_openshell_validates_them() {
        let host = ["https://api.tavily.com".to_string()];
        let rest = |rules: &str| definition("search", &host, "", "", Rules::Rest(rules), "");
        assert!(rest(REST_RULES).is_ok());
        // OpenShell decides which rules admit traffic: it accepts a method or a
        // path alone, and refuses rules that admit nothing.
        for rules in [
            r#"{"rules":[{"allow":{"method":"POST"}}]}"#,
            r#"{"rules":[{"allow":{"path":"/search"}}]}"#,
        ] {
            assert!(rest(rules).is_ok(), "{rules}");
        }
        for rules in [r#"{"rules":[]}"#, r#"{"rules":[{"allow":{}}]}"#, "not JSON"] {
            assert!(rest(rules).is_err(), "{rules}");
        }
        // The rules name request paths, so the endpoint names only a host.
        let pathed = ["https://api.tavily.com/v1".to_string()];
        assert!(definition("search", &pathed, "", "", Rules::Rest(REST_RULES), "").is_err());
        let two = [host[0].clone(), "https://api.example.com".to_string()];
        assert!(definition("search", &two, "", "", Rules::Rest(REST_RULES), "").is_err());
    }

    #[test]
    fn an_mcp_policy_takes_exactly_one_endpoint() {
        let one = ["https://booking.example.com/mcp".to_string()];
        assert!(definition("booking", &one, "", "", Rules::Mcp(MCP_RULE), "").is_ok());
        let two = [one[0].clone(), "https://quotes.example.com/mcp".to_string()];
        assert!(definition("booking", &two, "", "", Rules::Mcp(MCP_RULE), "").is_err());
    }
}
