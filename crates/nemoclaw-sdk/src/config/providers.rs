// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{ConfigError, Document, InferenceProvider, Route};
use std::collections::BTreeSet;

impl Document {
    pub(super) fn route_provider<'a>(
        &'a self,
        route: &'a Route,
        sandbox_visible: bool,
    ) -> Result<&'a InferenceProvider, ConfigError> {
        let enclosing = || {
            self.spec.inference_providers.iter().chain(
                self.spec.sandboxes[0]
                    .inference_providers
                    .iter()
                    .filter(move |_| sandbox_visible),
            )
        };
        match (&route.provider, &route.provider_ref) {
            (Some(provider), None) => {
                if enclosing().any(|definition| definition.name == provider.name) {
                    return Err(ConfigError(
                        "inline provider names must not shadow enclosing definitions",
                    ));
                }
                Ok(provider)
            }
            (None, Some(name)) => enclosing()
                .find(|provider| &provider.name == name)
                .ok_or(ConfigError("provider reference has no visible definition")),
            _ => Err(ConfigError(
                "route requires exactly one of provider or providerRef",
            )),
        }
    }

    /// Resolve the provider for the first agent's initial model choice.
    pub fn inference_provider(&self) -> Result<&InferenceProvider, ConfigError> {
        let agent = self
            .spec
            .sandboxes
            .first()
            .and_then(|sandbox| sandbox.agents.first())
            .ok_or(ConfigError("at least one agent is required"))?;
        let (inference, sandbox_visible) = self.scoped_inference(agent)?;
        self.route_provider(inference.default_route()?, sandbox_visible)
    }

    /// Providers selected anywhere in the sandbox, deduplicated by definition identity.
    pub fn selected_inference_providers(&self) -> Result<Vec<&InferenceProvider>, ConfigError> {
        let [sandbox] = self.spec.sandboxes.as_slice() else {
            return Err(ConfigError("exactly one sandbox is required"));
        };
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
                return Err(ConfigError(
                    "provider names must be unique lowercase names without shadowing",
                ));
            }
        }
        let mut selected = std::collections::BTreeMap::new();
        for agent in &sandbox.agents {
            let (inference, sandbox_visible) = self.scoped_inference(agent)?;
            for route in &inference.routes {
                let provider = self.route_provider(route, sandbox_visible)?;
                if let Some(previous) = selected.insert(&provider.name, provider)
                    && !std::ptr::eq(previous, provider)
                {
                    return Err(ConfigError(
                        "selected provider definitions must have distinct names",
                    ));
                }
            }
        }
        if selected.is_empty() || selected.len() > 32 {
            return Err(ConfigError(
                "a sandbox requires between one and 32 selected providers",
            ));
        }
        Ok(selected.into_values().collect())
    }

    // Managed inference currently has one lifecycle per deployment. The initial
    // provider supplies the no-op external case; it need not own a managed service.
    pub(crate) fn lifecycle_provider(&self) -> Result<&InferenceProvider, ConfigError> {
        let providers = self.selected_inference_providers()?;
        let mut managed = providers.into_iter().filter(|provider| {
            provider.service.is_some()
                || provider.ollama.is_some()
                || provider.ollama_proxy.is_some()
        });
        let selected = managed.next();
        if managed.next().is_some() {
            return Err(ConfigError(
                "a deployment supports at most one provider with managed inference dependencies",
            ));
        }
        selected.map_or_else(|| self.inference_provider(), Ok)
    }

    pub(crate) fn provider_model<'a>(
        &'a self,
        provider: &InferenceProvider,
    ) -> Result<&'a str, ConfigError> {
        for agent in &self.spec.sandboxes[0].agents {
            let (inference, scope) = self.scoped_inference(agent)?;
            for route in &inference.routes {
                if std::ptr::eq(self.route_provider(route, scope)?, provider) {
                    return Ok(&route.overrides.model);
                }
            }
        }
        Err(ConfigError("provider has no selected model"))
    }

    pub(crate) fn selected_provider_mut(
        &mut self,
        name: &str,
    ) -> Result<&mut InferenceProvider, ConfigError> {
        let selected = self
            .selected_inference_providers()?
            .into_iter()
            .find(|provider| provider.name == name)
            .ok_or(ConfigError("provider is not selected"))?;
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
