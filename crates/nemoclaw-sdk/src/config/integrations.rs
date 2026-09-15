// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{AgentTools, ConfigError, Credential, Sandbox};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Optional integrations shared by named agents in a sandbox.
pub struct Integrations {
    /// Brave Search with gateway-held credentials and explicit agent grants.
    pub web_search: WebSearch,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Web search through the native OpenClaw Brave plugin.
pub struct WebSearch {
    /// Supported search service.
    pub provider: SearchProvider,
    #[schemars(length(min = 1))]
    /// Unique names of unrestricted OpenClaw agents permitted to search.
    pub agent_refs: Vec<String>,
    /// Host environment reference. OpenShell supplies a BRAVE_API_KEY placeholder to the sandbox.
    pub credential: Credential,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
/// Search provider supported by the managed profile.
pub enum SearchProvider {
    Brave,
}
impl WebSearch {
    pub(crate) fn validate<'a>(
        &self,
        harness: &str,
        agents: impl Iterator<Item = (&'a str, Option<&'a AgentTools>)>,
    ) -> Result<(), ConfigError> {
        let agents: std::collections::BTreeMap<_, _> = agents.collect();
        let mut names = std::collections::BTreeSet::new();
        if harness != "openclaw"
            || self.agent_refs.is_empty()
            || self.agent_refs.iter().any(|name| {
                !names.insert(name)
                    || !agents.contains_key(name.as_str())
                    || matches!(agents[name.as_str()], Some(AgentTools::ReadOnly { .. }))
            })
        {
            return Err(ConfigError(
                "web search requires unique unrestricted OpenClaw agent references",
            ));
        }
        super::validation::credential(&Some(self.credential.clone()))
    }
}
impl Sandbox {
    pub(crate) fn web_search(&self) -> Option<&WebSearch> {
        self.integrations.as_ref().map(|i| &i.web_search)
    }
}
