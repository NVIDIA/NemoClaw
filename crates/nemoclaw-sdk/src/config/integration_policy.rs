// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Collector grant adapted from NVIDIA/NemoClaw at 97745a7ad9649f851704493e4b670b3674f875aa,
// nemoclaw-blueprint/policies/presets/openclaw-diagnostics-otel-local.yaml (Apache-2.0).
// 2026-09-15: derive a reserved, exact trace endpoint grant from desired telemetry.
use super::{ConfigError, ExplicitPolicy, Sandbox};
use openshell_core::proto;
use serde_json::json;

impl Sandbox {
    pub(crate) fn policy_proto(&self) -> Result<proto::SandboxPolicy, ConfigError> {
        let base = self.network.policy_proto()?;
        if self
            .agents
            .first()
            .is_none_or(|a| a.observability.is_none())
            && self.web_search().is_none()
        {
            return Ok(base);
        }
        let mut value = openshell_policy::sandbox_policy_to_json_value(&base)
            .map_err(|_| ConfigError("cannot encode sandbox policy"))?;
        value
            .as_object_mut()
            .expect("policy object")
            .entry("network_policies")
            .or_insert_with(|| json!({}));
        let mut policy: ExplicitPolicy = serde_json::from_value(value)
            .map_err(|_| ConfigError("cannot represent sandbox policy"))?;
        if self
            .agents
            .first()
            .is_some_and(|a| a.observability.is_some())
        {
            let name = "nemoclaw-otlp";
            if policy.network_policies.contains_key(name) {
                return Err(ConfigError(
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
        if self.web_search().is_some() {
            if policy.network_policies.contains_key("nemoclaw-brave") {
                return Err(ConfigError("nemoclaw-brave is reserved for web search"));
            }
            policy
                .network_policies
                .insert("nemoclaw-brave".into(), brave_policy());
        }
        policy.to_proto()
    }
}

pub(crate) fn brave_policy() -> super::PolicyRule {
    serde_json::from_value(json!({"name":"nemoclaw-brave", "endpoints":[{
        "host":"api.search.brave.com", "port":443, "protocol":"rest", "tls":"terminate", "enforcement":"enforce",
        "rules":[{"allow":{"method":"GET","path":"/res/v1/web/search"}}]}],
        "binaries":[{"path":"/usr/local/bin/node"}]})).expect("typed Brave policy")
}
