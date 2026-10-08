// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Collector grant adapted from NVIDIA/NemoClaw at 97745a7ad9649f851704493e4b670b3674f875aa,
// nemoclaw-blueprint/policies/presets/openclaw-diagnostics-otel-local.yaml (Apache-2.0).
// 2026-09-15: derive a reserved, exact trace endpoint grant from desired telemetry.
// 2026-09-28: use owner policy types independently of the transport client.
//! Managed web search providers: their profiles, registration names, and egress policy.

use crate::policy::PolicyRule;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
/// Search provider supported by the managed profile.
pub enum SearchProvider {
    Brave,
    Tavily,
}
impl SearchProvider {
    pub fn name(self) -> &'static str {
        match self {
            Self::Brave => "brave",
            Self::Tavily => "tavily",
        }
    }
    pub fn profile(self) -> &'static str {
        match self {
            Self::Brave => "nemoclaw-brave",
            Self::Tavily => "nemoclaw-tavily",
        }
    }
    pub fn image_profile(self, scope: &str) -> String {
        format!("{}-{scope}", self.profile())
    }
    pub fn credential_env(self) -> &'static str {
        match self {
            Self::Brave => "BRAVE_API_KEY",
            Self::Tavily => "TAVILY_API_KEY",
        }
    }
    pub fn endpoint(self) -> &'static str {
        match self {
            Self::Brave => "https://api.search.brave.com",
            Self::Tavily => "https://api.tavily.com",
        }
    }
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "brave" => Some(Self::Brave),
            "tavily" => Some(Self::Tavily),
            _ => None,
        }
    }
    pub fn from_profile(profile: &str) -> Option<Self> {
        [Self::Brave, Self::Tavily].into_iter().find(|provider| {
            profile == provider.profile()
                || profile
                    .strip_prefix(&format!("{}-", provider.profile()))
                    .is_some_and(|scope| {
                        scope.len() == 24 && scope.bytes().all(|c| c.is_ascii_hexdigit())
                    })
        })
    }
}

/// Stable registration identity for a search credential reference, never its value.
pub fn search_provider_name(provider: SearchProvider, reference: &str, profile: &str) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "{}-search-{}",
        provider.name(),
        &Sha256::digest(format!("{reference}\0{profile}"))
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()[..24]
    )
}

/// The egress grant a sandbox needs to call a search provider.
pub fn search_policy(provider: SearchProvider) -> PolicyRule {
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
