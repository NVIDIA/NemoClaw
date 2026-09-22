// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{AgentTools, ConfigError, Credential, Document, Sandbox};
use crate::config::HarnessKind;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
/// Integration configuration attached inline to an agent or selected through integrationRefs. Unsupported kinds are rejected.
pub enum Integration {
    /// Brave Search with gateway-held credentials and explicit agent grants.
    WebSearch(WebSearch),
    /// Explicit VoiceClaw R0 connection to the selected OpenClaw agent.
    #[serde(rename = "voiceclawR0")]
    VoiceclawR0 {
        #[serde(rename = "agentRef")]
        /// Name of the attached OpenClaw agent.
        agent_ref: String,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Brave web search through OpenClaw or Deep Agents native tool configuration.
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
            return Err(ConfigError::new(
                "sandbox integration names must not shadow deployment definitions",
            ));
        }
        let mut bindings = BTreeMap::new();
        let agent = &self.agent;
        validate_definitions(&agent.integrations)?;
        if agent
            .integrations
            .keys()
            .any(|name| shared.contains_key(name) || self.integrations.contains_key(name))
        {
            return Err(ConfigError::new(
                "agent integration names must not shadow enclosing definitions",
            ));
        }
        let mut names = BTreeSet::new();
        let references = agent
            .integration_refs
            .iter()
            .enumerate()
            .map(|(index, name)| {
                let definition = self
                    .integrations
                    .get(name)
                    .or_else(|| shared.get(name))
                    .ok_or_else(|| {
                        super::references::missing_reference(
                            &format!(
                                "spec.sandboxes[{}].agent.integrationRefs[{index}]",
                                super::references::diagnostic_name(&self.name)
                            ),
                            "integration",
                            name,
                            shared
                                .keys()
                                .chain(self.integrations.keys())
                                .map(String::as_str),
                        )
                    })?;
                Ok((None, name.as_str(), definition))
            });
        let inline = agent
            .integrations
            .iter()
            .map(|(name, definition)| Ok((Some(agent.name.as_str()), name.as_str(), definition)));
        for definition in references.chain(inline) {
            let (owner, name, definition) = definition?;
            if !names.insert(name) {
                return Err(ConfigError::new(
                    "agent integration references must be unique",
                ));
            }
            match definition {
                Integration::WebSearch(_)
                    if matches!(agent.tools, Some(AgentTools::ReadOnly { .. })) =>
                {
                    return Err(ConfigError::new(
                        "web search requires unrestricted OpenClaw agents",
                    ));
                }
                Integration::WebSearch(_) => {}
                Integration::VoiceclawR0 { agent_ref } if agent_ref == &agent.name => {}
                Integration::VoiceclawR0 { .. } => {
                    return Err(ConfigError::new(
                        "VoiceClaw agentRef must match its attached agent",
                    ));
                }
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

        Ok(bindings.into_values().collect())
    }
}

impl Document {
    pub(crate) fn web_search(
        &self,
        sandbox: &super::Sandbox,
    ) -> Result<Option<RuntimeWebSearch>, ConfigError> {
        let mut selected = None;
        for binding in sandbox.integration_bindings(&self.spec.integrations)? {
            match binding.definition {
                Integration::VoiceclawR0 { .. } => {}
                Integration::WebSearch(search) => {
                    if selected.is_some() {
                        return Err(ConfigError::new(
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
        if let Some(search) = &mut selected {
            search.agent_refs.sort();
        }
        Ok(selected)
    }
}

fn validate_definitions(definitions: &BTreeMap<String, Integration>) -> Result<(), ConfigError> {
    super::schema::validate_property("Spec", "integrations", &definitions)
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
        harness: HarnessKind,
        agents: impl Iterator<Item = (&'a str, Option<&'a AgentTools>)>,
    ) -> Result<(), ConfigError> {
        let agents: std::collections::BTreeMap<_, _> = agents.collect();
        let mut names = std::collections::BTreeSet::new();
        if !matches!(harness, HarnessKind::OpenClaw | HarnessKind::DeepAgents)
            || self.agent_refs.is_empty()
            || self.agent_refs.iter().any(|name| {
                !names.insert(name)
                    || !agents.contains_key(name.as_str())
                    || matches!(agents[name.as_str()], Some(AgentTools::ReadOnly { .. }))
            })
        {
            return Err(ConfigError::new(
                "web search requires unique unrestricted OpenClaw or Deep Agents references",
            ));
        }
        super::validation::credential(&Some(self.credential.clone()))
    }
}

/// Stable registration identity for a search credential reference, never its value.
pub(crate) fn search_provider_name(reference: &str) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "brave-search-{}",
        &super::hex(&Sha256::digest(reference))[..24]
    )
}

impl Document {
    pub(crate) fn voiceclaw_r0_binding(&self) -> Result<Option<(&str, &Sandbox)>, ConfigError> {
        let mut selected = None;
        for sandbox in &self.spec.sandboxes {
            for binding in sandbox.integration_bindings(&self.spec.integrations)? {
                if matches!(binding.definition, Integration::VoiceclawR0 { .. }) {
                    if selected.is_some()
                        || self.sandbox_harness(sandbox)?.kind != HarnessKind::OpenClaw
                    {
                        return Err(ConfigError::new(
                            "VoiceClaw R0 requires one attached OpenClaw agent",
                        ));
                    }
                    selected = Some((binding.name, sandbox));
                }
            }
        }
        Ok(selected)
    }
}
