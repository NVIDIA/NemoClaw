// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Collector grant adapted from NVIDIA/NemoClaw at 97745a7ad9649f851704493e4b670b3674f875aa,
// nemoclaw-blueprint/policies/presets/openclaw-diagnostics-otel-local.yaml (Apache-2.0).
// 2026-09-15: derive a reserved, exact trace endpoint grant from desired telemetry.
// 2026-09-23: obtain protocol types through the pinned OpenShell SDK's raw API.
// 2026-09-28: use owner policy types independently of the transport client.
use super::SearchProvider;
use serde_json::json;

pub fn search_policy(provider: SearchProvider) -> super::PolicyRule {
    let (host, rules) = match provider {
        SearchProvider::Brave => (
            "api.search.brave.com",
            json!([{"allow":{"method":"GET","path":"/res/v1/web/search"}}]),
        ),
        SearchProvider::Tavily => (
            "api.tavily.com",
            json!([
                {"allow":{"method":"POST","path":"/search"}},
                {"allow":{"method":"POST","path":"/extract"}}
            ]),
        ),
    };
    let endpoint = json!({
        "host": host, "port":443, "protocol":"rest",
        "enforcement":"enforce", "rules": rules
    });
    serde_json::from_value(json!({
        "name": provider.profile(), "endpoints":[endpoint],
        "binaries":[]
    }))
    .expect("typed search policy")
}
