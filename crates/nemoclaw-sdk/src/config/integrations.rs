// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{AgentTools, ConfigError, Credential, Document, Sandbox};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
/// Integration configuration attached inline to an agent or selected through integrationRefs. Unsupported kinds are rejected.
pub enum Integration {
    /// Brave Search with gateway-held credentials and explicit agent grants.
    WebSearch(WebSearch),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Web search through the native OpenClaw Brave plugin.
pub struct WebSearch {
    /// Supported search service.
    pub provider: SearchProvider,
    /// Host environment reference. OpenShell supplies a BRAVE_API_KEY placeholder to the sandbox.
    pub credential: Credential,
}

/// A definition and its explicitly attached agents in one sandbox.
#[derive(Debug)]
pub struct IntegrationBinding<'a> {
    /// Name of the selected definition in its declaration scope.
    pub name: &'a str,
    /// Owning agent for an inline definition; None for an enclosing definition.
    pub agent: Option<&'a str>,
    pub definition: &'a Integration,
    pub agent_refs: Vec<&'a str>,
}

impl Sandbox {
    /// Resolve deployment and sandbox definitions without implicitly granting access.
    pub fn integration_bindings<'a>(
        &'a self,
        shared: &'a BTreeMap<String, Integration>,
    ) -> Result<Vec<IntegrationBinding<'a>>, ConfigError> {
        validate_definitions(shared)?;
        validate_definitions(&self.integrations)?;
        if self
            .integrations
            .keys()
            .any(|name| shared.contains_key(name))
        {
            return Err(ConfigError(
                "sandbox integration names must not shadow deployment definitions",
            ));
        }
        let mut bindings = BTreeMap::new();
        for agent in &self.agents {
            validate_definitions(&agent.integrations)?;
            if agent
                .integrations
                .keys()
                .any(|name| shared.contains_key(name) || self.integrations.contains_key(name))
            {
                return Err(ConfigError(
                    "agent integration names must not shadow enclosing definitions",
                ));
            }
            let mut names = BTreeSet::new();
            let references = agent.integration_refs.iter().map(|name| {
                let definition = self
                    .integrations
                    .get(name)
                    .or_else(|| shared.get(name))
                    .ok_or(ConfigError(
                        "agent integration reference has no visible definition",
                    ))?;
                Ok((None, name.as_str(), definition))
            });
            let inline = agent.integrations.iter().map(|(name, definition)| {
                Ok((Some(agent.name.as_str()), name.as_str(), definition))
            });
            for definition in references.chain(inline) {
                let (owner, name, definition) = definition?;
                if !names.insert(name) {
                    return Err(ConfigError("agent integration references must be unique"));
                }
                match definition {
                    Integration::WebSearch(_)
                        if matches!(agent.tools, Some(AgentTools::ReadOnly { .. })) =>
                    {
                        return Err(ConfigError(
                            "web search requires unrestricted OpenClaw agents",
                        ));
                    }
                    Integration::WebSearch(_) => {}
                }
                bindings
                    .entry((owner, name))
                    .or_insert_with(|| IntegrationBinding {
                        name,
                        agent: owner,
                        definition,
                        agent_refs: Vec::new(),
                    })
                    .agent_refs
                    .push(&agent.name);
            }
        }
        Ok(bindings.into_values().collect())
    }
}

impl Document {
    pub(crate) fn web_search(&self) -> Result<Option<RuntimeWebSearch>, ConfigError> {
        let mut selected = None;
        for binding in self.spec.sandboxes[0].integration_bindings(&self.spec.integrations)? {
            match binding.definition {
                Integration::WebSearch(search) => {
                    if selected.is_some() {
                        return Err(ConfigError(
                            "a sandbox supports only one attached web search definition",
                        ));
                    }
                    selected = Some(RuntimeWebSearch {
                        provider: search.provider.clone(),
                        credential: search.credential.clone(),
                        agent_refs: binding.agent_refs.into_iter().map(str::to_owned).collect(),
                    });
                }
            }
        }
        Ok(selected)
    }
}

fn validate_definitions(definitions: &BTreeMap<String, Integration>) -> Result<(), ConfigError> {
    for (name, definition) in definitions {
        if !super::validation::SLUG.is_match(name) {
            return Err(ConfigError("integration names must be lowercase names"));
        }
        match definition {
            Integration::WebSearch(search) => {
                super::validation::credential(&Some(search.credential.clone()))?;
            }
        }
    }
    Ok(())
}

// Preserve the native adapter wire contract while deriving grants from agent references.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RuntimeWebSearch {
    pub provider: SearchProvider,
    pub agent_refs: Vec<String>,
    pub credential: Credential,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
/// Search provider supported by the managed profile.
pub enum SearchProvider {
    Brave,
}
impl RuntimeWebSearch {
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
