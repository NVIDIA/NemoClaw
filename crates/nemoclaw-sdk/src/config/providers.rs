// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{ConfigError, Document, InferenceProvider, Route, Sandbox};
use std::collections::BTreeSet;

impl Document {
    /// Stable native identity; sandbox-local definitions have their own namespace.
    pub(crate) fn provider_key(&self, provider: &InferenceProvider) -> String {
        use sha2::{Digest, Sha256};
        for sandbox in &self.spec.sandboxes {
            let local = sandbox.inference_providers.iter().chain(
                sandbox
                    .inferences
                    .values()
                    .chain(
                        sandbox
                            .agents
                            .iter()
                            .filter_map(|agent| agent.inference.as_ref()),
                    )
                    .flat_map(|inference| {
                        inference
                            .routes
                            .iter()
                            .filter_map(|route| route.provider.as_ref())
                    }),
            );
            if local
                .into_iter()
                .any(|candidate| std::ptr::eq(candidate, provider))
            {
                let digest = Sha256::digest(format!("{}/{}", sandbox.name, provider.name));
                return format!("local-{}", &super::hex(&digest)[..24]);
            }
        }
        provider.name.clone()
    }

    pub(super) fn route_provider<'a>(
        &'a self,
        route: &'a Route,
        sandbox: Option<&'a Sandbox>,
    ) -> Result<&'a InferenceProvider, ConfigError> {
        let enclosing = || {
            self.spec.inference_providers.iter().chain(
                sandbox
                    .into_iter()
                    .flat_map(|sandbox| &sandbox.inference_providers),
            )
        };
        match (&route.provider, &route.provider_ref) {
            (Some(provider), None) => {
                if enclosing().any(|definition| definition.name == provider.name) {
                    return Err(ConfigError::new(
                        "inline provider names must not shadow enclosing definitions",
                    ));
                }
                Ok(provider)
            }
            (None, Some(name)) => enclosing()
                .find(|provider| &provider.name == name)
                .ok_or_else(|| {
                    super::references::missing_reference(
                        &format!("{}.providerRef", self.route_path(route)),
                        "provider",
                        name,
                        enclosing().map(|p| p.name.as_str()),
                    )
                }),
            _ => Err(ConfigError::new(
                "route requires exactly one of provider or providerRef",
            )),
        }
    }

    /// Resolve an unambiguous deployment provider. Multi-provider callers must select by identity.
    pub fn inference_provider(&self) -> Result<&InferenceProvider, ConfigError> {
        let providers = self.selected_inference_providers()?;
        match providers.as_slice() {
            [provider] => Ok(provider),
            _ => Err(ConfigError::new(
                "select an explicit provider in a multi-provider deployment",
            )),
        }
    }

    /// Providers selected across all sandboxes, deduplicated by scoped definition identity.
    pub fn selected_inference_providers(&self) -> Result<Vec<&InferenceProvider>, ConfigError> {
        let mut selected = std::collections::BTreeMap::new();
        for sandbox in &self.spec.sandboxes {
            let mut names = BTreeSet::new();
            for definition in self
                .spec
                .inference_providers
                .iter()
                .chain(&sandbox.inference_providers)
            {
                if !super::validation::SLUG.is_match(&definition.name)
                    || !names.insert(&definition.name)
                {
                    return Err(ConfigError::new(
                        "provider names must be unique lowercase names without shadowing",
                    ));
                }
            }
            for agent in &sandbox.agents {
                let (inference, sandbox_visible) = self.scoped_inference(agent)?;
                for route in &inference.routes {
                    let provider = self.route_provider(route, sandbox_visible)?;
                    if let Some(previous) = selected.insert(self.provider_key(provider), provider)
                        && !std::ptr::eq(previous, provider)
                    {
                        return Err(ConfigError::new(
                            "selected provider definitions must have distinct names",
                        ));
                    }
                }
            }
        }
        if selected.is_empty() || selected.len() > 32 {
            return Err(ConfigError::new(
                "a deployment requires between one and 32 selected providers",
            ));
        }
        Ok(selected.into_values().collect())
    }

    pub(crate) fn sandbox_inference_providers<'a>(
        &'a self,
        sandbox: &'a Sandbox,
    ) -> Result<Vec<&'a InferenceProvider>, ConfigError> {
        let mut selected = std::collections::BTreeMap::new();
        for agent in &sandbox.agents {
            let (inference, scope) = self.scoped_inference(agent)?;
            for route in &inference.routes {
                let provider = self.route_provider(route, scope)?;
                selected.insert(self.provider_key(provider), provider);
            }
        }
        Ok(selected.into_values().collect())
    }

    // Ollama lifecycle callers still require one selected daemon/proxy.
    // Managed services are compiled independently for each selected provider.
    pub(crate) fn lifecycle_provider(&self) -> Result<&InferenceProvider, ConfigError> {
        let providers = self.selected_inference_providers()?;
        let mut managed = providers
            .into_iter()
            .filter(|provider| provider.ollama.is_some() || provider.ollama_proxy.is_some());
        let selected = managed.next();
        if managed.next().is_some() {
            return Err(ConfigError::new(
                "a deployment supports at most one provider with managed inference dependencies",
            ));
        }
        selected.map_or_else(
            || {
                self.selected_inference_providers()?
                    .into_iter()
                    .min_by_key(|p| &p.name)
                    .ok_or(ConfigError::new("no selected providers"))
            },
            Ok,
        )
    }

    pub(crate) fn provider_model<'a>(
        &'a self,
        provider: &InferenceProvider,
    ) -> Result<&'a str, ConfigError> {
        for agent in self
            .spec
            .sandboxes
            .iter()
            .flat_map(|sandbox| &sandbox.agents)
        {
            let (inference, scope) = self.scoped_inference(agent)?;
            for route in &inference.routes {
                if std::ptr::eq(self.route_provider(route, scope)?, provider) {
                    return Ok(&route.overrides.model);
                }
            }
        }
        Err(ConfigError::new("provider has no selected model"))
    }

    pub(crate) fn selected_provider_mut(
        &mut self,
        name: &str,
    ) -> Result<&mut InferenceProvider, ConfigError> {
        let selected = self
            .selected_inference_providers()?
            .into_iter()
            .find(|provider| self.provider_key(provider) == name)
            .ok_or(ConfigError::new("provider is not selected"))?;
        let index = self
            .provider_definitions()
            .position(|provider| std::ptr::eq(provider, selected))
            .unwrap();
        Ok(self.provider_definitions_mut().nth(index).unwrap())
    }

    /// Edit the selected definition in its authored scope without rewriting references.
    pub fn inference_provider_mut(&mut self) -> Result<&mut InferenceProvider, ConfigError> {
        let selected = self.inference_provider()?;
        let index = self
            .provider_definitions()
            .position(|provider| std::ptr::eq(provider, selected))
            .expect("selected provider belongs to document");
        Ok(self.provider_definitions_mut().nth(index).unwrap())
    }

    pub(super) fn provider_definitions(&self) -> impl Iterator<Item = &InferenceProvider> {
        self.spec
            .inference_providers
            .iter()
            .chain(self.spec.inferences.values().flat_map(|inference| {
                inference
                    .routes
                    .iter()
                    .filter_map(|route| route.provider.as_ref())
            }))
            .chain(self.spec.sandboxes.iter().flat_map(|sandbox| {
                sandbox.inference_providers.iter().chain(
                    sandbox
                        .inferences
                        .values()
                        .chain(
                            sandbox
                                .agents
                                .iter()
                                .filter_map(|agent| agent.inference.as_ref()),
                        )
                        .flat_map(|inference| {
                            inference
                                .routes
                                .iter()
                                .filter_map(|route| route.provider.as_ref())
                        }),
                )
            }))
    }

    pub(crate) fn provider_definitions_mut(
        &mut self,
    ) -> impl Iterator<Item = &mut InferenceProvider> {
        self.spec
            .inference_providers
            .iter_mut()
            .chain(self.spec.inferences.values_mut().flat_map(|inference| {
                inference
                    .routes
                    .iter_mut()
                    .filter_map(|route| route.provider.as_mut())
            }))
            .chain(self.spec.sandboxes.iter_mut().flat_map(|sandbox| {
                sandbox.inference_providers.iter_mut().chain(
                    sandbox
                        .inferences
                        .values_mut()
                        .chain(
                            sandbox
                                .agents
                                .iter_mut()
                                .filter_map(|agent| agent.inference.as_mut()),
                        )
                        .flat_map(|inference| {
                            inference
                                .routes
                                .iter_mut()
                                .filter_map(|route| route.provider.as_mut())
                        }),
                )
            }))
    }
}
