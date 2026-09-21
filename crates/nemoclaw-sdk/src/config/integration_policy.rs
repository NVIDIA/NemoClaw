// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Collector grant adapted from NVIDIA/NemoClaw at 97745a7ad9649f851704493e4b670b3674f875aa,
// nemoclaw-blueprint/policies/presets/openclaw-diagnostics-otel-local.yaml (Apache-2.0).
// 2026-09-15: derive a reserved, exact trace endpoint grant from desired telemetry.
use super::{ConfigError, ExplicitPolicy, Sandbox, SearchProvider};
use openshell_core::proto;
use serde_json::json;

impl Sandbox {
    pub(crate) fn policy_proto(
        &self,
        web_search: Option<SearchProvider>,
        observability: Option<&super::AgentObservability>,
    ) -> Result<proto::SandboxPolicy, ConfigError> {
        let base = self.network.policy_proto()?;
        if observability.is_none() && web_search.is_none() {
            return Ok(base);
        }
        let mut value = openshell_policy::sandbox_policy_to_json_value(&base)
            .map_err(|_| ConfigError::new("cannot encode sandbox policy"))?;
        value
            .as_object_mut()
            .expect("policy object")
            .entry("network_policies")
            .or_insert_with(|| json!({}));
        let mut policy: ExplicitPolicy = serde_json::from_value(value)
            .map_err(|_| ConfigError::new("cannot represent sandbox policy"))?;
        if observability.is_some_and(|observability| observability.uses_otlp()) {
            let name = "nemoclaw-otlp";
            if policy.network_policies.contains_key(name) {
                return Err(ConfigError::new(
                    "nemoclaw-otlp is reserved for the declared tracing integration",
                ));
            }
            policy.network_policies.insert(
                name.into(),
                serde_json::from_value(json!({
                    "name": name,
                    "endpoints": [{"host":"host.openshell.internal", "port":4318,
                        "protocol":"rest", "enforcement":"enforce",
                        "allowed_ips":["10.0.0.0/8","172.16.0.0/12","192.168.0.0/16"],
                        "rules":[{"allow":{"method":"POST","path":"/v1/traces"}}]}],
                    "binaries":[{"path":"/usr/local/bin/node"}]
                }))
                .expect("typed OTLP policy"),
            );
        }
        if let Some(provider) = web_search {
            let name = provider.profile();
            if policy.network_policies.contains_key(name) {
                return Err(ConfigError::new(
                    "the managed search policy name is reserved for web search",
                ));
            }
            policy
                .network_policies
                .insert(name.into(), search_policy(provider));
        }
        policy.to_proto()
    }
}

pub(crate) fn search_policy(provider: SearchProvider) -> super::PolicyRule {
    let (host, rules, python) = match provider {
        SearchProvider::Brave => (
            "api.search.brave.com",
            json!([{"allow":{"method":"GET","path":"/res/v1/web/search"}}]),
            "/usr/local/bin/python3.14",
        ),
        SearchProvider::Tavily => (
            "api.tavily.com",
            json!([
                {"allow":{"method":"POST","path":"/search"}},
                {"allow":{"method":"POST","path":"/extract"}}
            ]),
            "/usr/local/bin/python3.13",
        ),
    };
    let endpoint = json!({
        "host": host, "port":443, "protocol":"rest", "tls":"terminate",
        "enforcement":"enforce", "rules": rules
    });
    serde_json::from_value(json!({
        "name": provider.profile(), "endpoints":[endpoint],
        "binaries":[{"path":"/usr/local/bin/node"},{"path":python}]
    }))
    .expect("typed search policy")
}
