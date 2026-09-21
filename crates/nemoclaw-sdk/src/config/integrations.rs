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
    /// One managed VoiceClaw service bound to one selected sandboxed agent.
    Voiceclaw(VoiceclawIntegration),
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

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
/// Select one managed VoiceClaw service. Agent identity comes only from integrationRefs.
pub struct VoiceclawIntegration {
    /// Name of a VoiceClaw service in spec.services.
    pub service_ref: String,
}

/// Selected VoiceClaw consumer identity. It contains no credential value.
pub(crate) struct VoiceclawBinding<'a> {
    pub integration: &'a str,
    pub sandbox: &'a str,
    pub agent: &'a str,
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
                Integration::Voiceclaw(_) => {}
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
                Integration::Voiceclaw(_) => {}
            }
        }
        if let Some(search) = &mut selected {
            search.agent_refs.sort();
        }
        Ok(selected)
    }
}

fn validate_definitions(definitions: &BTreeMap<String, Integration>) -> Result<(), ConfigError> {
    for (name, definition) in definitions {
        if !super::validation::SLUG.is_match(name) {
            return Err(ConfigError::new(
                "integration names must be lowercase names",
            ));
        }
        match definition {
            Integration::WebSearch(search) => {
                super::validation::credential(&Some(search.credential.clone()))?;
            }
            Integration::Voiceclaw(voiceclaw) => {
                super::validation::require(
                    super::validation::SLUG.is_match(&voiceclaw.service_ref),
                    "VoiceClaw serviceRef must be a lowercase service name",
                )?;
            }
        }
    }
    Ok(())
}

impl Document {
    pub(crate) fn validate_voiceclaw_integrations(&self) -> Result<(), ConfigError> {
        let definitions = self
            .spec
            .integrations
            .values()
            .chain(
                self.spec
                    .sandboxes
                    .iter()
                    .flat_map(|sandbox| sandbox.integrations.values()),
            )
            .chain(
                self.spec
                    .sandboxes
                    .iter()
                    .flat_map(|sandbox| sandbox.agent.integrations.values()),
            );
        for definition in definitions {
            let Integration::Voiceclaw(voiceclaw) = definition else {
                continue;
            };
            let service = self
                .spec
                .services
                .get(&voiceclaw.service_ref)
                .ok_or_else(|| {
                    super::references::missing_reference(
                        "integrations[].serviceRef",
                        "service",
                        &voiceclaw.service_ref,
                        self.spec.services.keys().map(String::as_str),
                    )
                })?;
            if !matches!(service, crate::services::ServiceDefinition::Voiceclaw(_)) {
                return Err(ConfigError::new(
                    "VoiceClaw serviceRef must name a VoiceClaw service",
                ));
            }
        }

        let mut selected = Vec::new();
        for sandbox in &self.spec.sandboxes {
            for binding in sandbox.integration_bindings(&self.spec.integrations)? {
                let Integration::Voiceclaw(voiceclaw) = binding.definition else {
                    continue;
                };
                if binding.agent.is_some() || binding.agent_refs.len() != 1 {
                    return Err(ConfigError::new(
                        "VoiceClaw requires one integrationRef-selected agent",
                    ));
                }
                selected.push((
                    voiceclaw.service_ref.as_str(),
                    sandbox.name.as_str(),
                    binding.name,
                    binding.agent_refs[0],
                ));
            }
        }
        if selected.len() > 1 {
            return Err(ConfigError::new(
                "the initial VoiceClaw profile supports exactly one selected agent",
            ));
        }
        Ok(())
    }

    pub(crate) fn active_voiceclaw_services(&self) -> Result<BTreeSet<String>, ConfigError> {
        let mut active = BTreeSet::new();
        for sandbox in &self.spec.sandboxes {
            for binding in sandbox.integration_bindings(&self.spec.integrations)? {
                if let Integration::Voiceclaw(voiceclaw) = binding.definition {
                    active.insert(voiceclaw.service_ref.clone());
                }
            }
        }
        Ok(active)
    }

    pub(crate) fn voiceclaw_binding(
        &self,
        service: &str,
    ) -> Result<Option<VoiceclawBinding<'_>>, ConfigError> {
        let mut selected = None;
        for sandbox in &self.spec.sandboxes {
            for binding in sandbox.integration_bindings(&self.spec.integrations)? {
                let Integration::Voiceclaw(voiceclaw) = binding.definition else {
                    continue;
                };
                if voiceclaw.service_ref != service {
                    continue;
                }
                if selected.is_some() || binding.agent_refs.len() != 1 {
                    return Err(ConfigError::new("VoiceClaw service selection is ambiguous"));
                }
                selected = Some(VoiceclawBinding {
                    integration: binding.name,
                    sandbox: &sandbox.name,
                    agent: binding.agent_refs[0],
                });
            }
        }
        Ok(selected)
    }
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
        if !matches!(harness, "openclaw" | "deepagents")
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
