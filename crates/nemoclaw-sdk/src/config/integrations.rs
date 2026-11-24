// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{ConfigError, Document, NamedSandbox, SecretRef};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
/// Integration configuration attached inline to an agent or selected through integrationRefs. Unsupported kinds are rejected.
pub enum Integration {
    /// Web search with gateway-held credentials and explicit agent grants.
    WebSearch(WebSearch),
    /// A key-authenticated HTTP API, such as an MCP service, with a gateway-held key.
    Api(Api),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// A key-authenticated HTTP API. OpenShell injects the key into requests to each endpoint's host, port and path subtree from the harness's executables.
pub struct Api {
    #[schemars(length(min = 1))]
    /// The API's HTTPS URLs. One key reaches each URL's host, port and path subtree.
    pub endpoints: Vec<String>,
    /// Host environment reference holding the API key.
    pub credential: SecretRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String")]
    /// Variable name the sandbox sees for the key, such as NVIDIA_API_KEY for tools that read it. Defaults to `NEMOCLAW_API_<registration>_KEY`.
    pub sandbox_env: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ApiAuthStyle")]
    /// How the key is sent: bearer, the default, as a bearer token, or header, as the raw value of headerName.
    pub auth_style: Option<ApiAuthStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String")]
    /// The header that carries the key. Defaults to Authorization for bearer; required for header.
    pub header_name: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
/// How an API key is sent.
pub enum ApiAuthStyle {
    Bearer,
    Header,
}

impl ApiAuthStyle {
    pub fn name(self) -> &'static str {
        match self {
            Self::Bearer => "bearer",
            Self::Header => "header",
        }
    }
}

/// An API definition attached to a sandbox.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RuntimeApi {
    pub name: String,
    pub api: Api,
    pub agent_refs: Vec<String>,
}

impl RuntimeApi {
    /// The OpenShell registration: one per definition and image scope, since
    /// its executables come from the sandbox's harness.
    pub(crate) fn registration(&self, image_scope: &str) -> String {
        format!("{}-{}", self.name, &image_scope[..12])
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Managed search credentials and network grants. Native integration is configured through Fabric.
pub struct WebSearch {
    /// Supported search service.
    pub provider: SearchProvider,
    /// Host environment reference. OpenShell supplies the search provider's placeholder to the sandbox.
    pub credential: SecretRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String")]
    /// Variable name the sandbox sees for the key, such as BRAVE_SEARCH_API_KEY for Hermes's Brave plugin. Defaults to the provider's own, BRAVE_API_KEY or TAVILY_API_KEY.
    pub sandbox_env: Option<String>,
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

impl<'a> NamedSandbox<'a> {
    /// Resolve deployment and sandbox definitions without implicitly granting access.
    pub fn integration_bindings(
        self,
        shared: &'a BTreeMap<String, Integration>,
    ) -> Result<Vec<IntegrationBinding<'a>>, ConfigError> {
        let sandbox = self.definition;
        validate_definitions(shared)?;
        validate_definitions(&sandbox.integrations)?;
        if sandbox
            .integrations
            .keys()
            .any(|name| shared.contains_key(name))
        {
            return Err(ConfigError::new(
                "sandbox integration names must not shadow deployment definitions",
            ));
        }
        let mut bindings = BTreeMap::new();
        let agent = &sandbox.agent;
        validate_definitions(&agent.integrations)?;
        if agent
            .integrations
            .keys()
            .any(|name| shared.contains_key(name) || sandbox.integrations.contains_key(name))
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
                let definition = sandbox
                    .integrations
                    .get(name)
                    .or_else(|| shared.get(name))
                    .ok_or_else(|| {
                        super::references::missing_reference(
                            &format!(
                                "spec.sandboxes[{}].agent.integrationRefs[{index}]",
                                super::references::diagnostic_name(self.name)
                            ),
                            "integration",
                            name,
                            shared
                                .keys()
                                .chain(sandbox.integrations.keys())
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
        sandbox: NamedSandbox<'_>,
    ) -> Result<Option<RuntimeWebSearch>, ConfigError> {
        let mut selected = None;
        for binding in sandbox.integration_bindings(&self.spec.integrations)? {
            match binding.definition {
                Integration::Api(_) => {}
                Integration::WebSearch(search) => {
                    if selected.is_some() {
                        return Err(ConfigError::new(
                            "a sandbox supports only one attached web search definition",
                        ));
                    }
                    selected = Some(RuntimeWebSearch {
                        provider: search.provider,
                        credential: search.credential.clone(),
                        sandbox_env: search.sandbox_env.clone(),
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

impl Document {
    /// The APIs attached to a sandbox's agent.
    pub(crate) fn apis(&self, sandbox: NamedSandbox<'_>) -> Result<Vec<RuntimeApi>, ConfigError> {
        let mut apis = Vec::new();
        for binding in sandbox.integration_bindings(&self.spec.integrations)? {
            if let Integration::Api(api) = binding.definition {
                let mut agent_refs: Vec<String> =
                    binding.agent_refs.into_iter().map(str::to_owned).collect();
                agent_refs.sort();
                apis.push(RuntimeApi {
                    name: binding.name.to_owned(),
                    api: api.clone(),
                    agent_refs,
                });
            }
        }
        apis.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(apis)
    }
}

fn validate_definitions(definitions: &BTreeMap<String, Integration>) -> Result<(), ConfigError> {
    super::schema::validate_property("Spec", "integrations", &definitions)
}

// Resolve managed credential and network grants from explicit agent references.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RuntimeWebSearch {
    pub provider: SearchProvider,
    pub agent_refs: Vec<String>,
    pub credential: SecretRef,
    pub sandbox_env: Option<String>,
}
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

    /// The variable the sandbox sees the key in unless `sandboxEnv` names
    /// another: the one the provider's own client libraries read.
    pub fn credential_env(self) -> &'static str {
        match self {
            Self::Brave => "BRAVE_API_KEY",
            Self::Tavily => "TAVILY_API_KEY",
        }
    }

    /// The search API's host, as an API endpoint.
    fn endpoint(self) -> &'static str {
        match self {
            Self::Brave => "https://api.search.brave.com",
            Self::Tavily => "https://api.tavily.com",
        }
    }

    /// How the provider's API takes the key: an auth style, and a header
    /// when the style needs one.
    fn authentication(self) -> (ApiAuthStyle, Option<&'static str>) {
        match self {
            Self::Brave => (ApiAuthStyle::Header, Some("X-Subscription-Token")),
            Self::Tavily => (ApiAuthStyle::Bearer, None),
        }
    }

    /// The only requests the key is sent with: Brave's web search, and
    /// Tavily's search and extract.
    fn rest_policy(self) -> serde_json::Value {
        let rules = match self {
            Self::Brave => {
                serde_json::json!([{"allow":{"method":"GET","path":"/res/v1/web/search"}}])
            }
            Self::Tavily => serde_json::json!([
                {"allow":{"method":"POST","path":"/search"}},
                {"allow":{"method":"POST","path":"/extract"}}
            ]),
        };
        serde_json::json!({ "rules": rules })
    }
}

impl RuntimeWebSearch {
    /// The OpenShell registration: one per provider, credential reference,
    /// and image scope, so sandboxes sharing all three share it. OpenShell
    /// names are at most 40 characters, so both are hashed.
    pub(crate) fn registration(&self, image_scope: &str) -> String {
        use sha2::{Digest, Sha256};
        format!(
            "{}-search-{}-{}",
            self.provider.name(),
            &super::hex(&Sha256::digest(&self.credential.env))[..12],
            &image_scope[..12]
        )
    }

    /// The API credential the search compiles to: the provider's host and
    /// authentication, the variable its tools read, and its REST policy.
    pub(crate) fn api(&self) -> (Api, String) {
        let (auth_style, header_name) = self.provider.authentication();
        let api = Api {
            endpoints: vec![self.provider.endpoint().into()],
            credential: self.credential.clone(),
            sandbox_env: Some(
                self.sandbox_env
                    .clone()
                    .unwrap_or_else(|| self.provider.credential_env().into()),
            ),
            auth_style: Some(auth_style),
            header_name: header_name.map(Into::into),
        };
        (api, self.provider.rest_policy().to_string())
    }

    pub(crate) fn validate<'a>(
        &self,
        agents: impl Iterator<Item = &'a str>,
    ) -> Result<(), ConfigError> {
        let agents: std::collections::BTreeSet<_> = agents.collect();
        let mut names = std::collections::BTreeSet::new();
        if self.agent_refs.is_empty()
            || self
                .agent_refs
                .iter()
                .any(|name| !names.insert(name) || !agents.contains(name.as_str()))
        {
            return Err(ConfigError::new(
                "web search requires unique references to configured agents",
            ));
        }
        super::schema::validate_definition("SecretRef", &self.credential)
    }
}
