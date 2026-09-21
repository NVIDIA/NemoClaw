// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::references::{ScopedInference, diagnostic_name, missing_reference};
use super::{ConfigError, Document, Inference, InferenceProvider, Route, Sandbox};
use std::collections::{BTreeMap, BTreeSet};

// The resource key identifies the registration; the authored path distinguishes
// separate definitions with identical values and lets export edit the right one.
pub(crate) struct SelectedProvider<'a> {
    pub definition: &'a InferenceProvider,
    pub key: String,
    path: String,
}
impl<'a> SelectedProvider<'a> {
    fn new(definition: &'a InferenceProvider, sandbox: Option<&Sandbox>, path: String) -> Self {
        use sha2::{Digest, Sha256};
        let key = sandbox.map_or_else(
            || definition.name.clone(),
            |sandbox| {
                let digest = Sha256::digest(format!("{}/{}", sandbox.name, definition.name));
                format!("local-{}", &super::hex(&digest)[..24])
            },
        );
        Self {
            definition,
            key,
            path,
        }
    }
}

fn provider_path(base: &str, name: &str) -> String {
    format!("{base}.inferenceProviders[{}]", diagnostic_name(name))
}
fn sandbox_path(sandbox: &Sandbox) -> String {
    format!("spec.sandboxes[{}]", diagnostic_name(&sandbox.name))
}

impl Document {
    pub(super) fn route_provider<'a>(
        &'a self,
        route: &'a Route,
        inference: &ScopedInference<'a>,
    ) -> Result<SelectedProvider<'a>, ConfigError> {
        let enclosing = || {
            self.spec.inference_providers.iter().chain(
                inference
                    .sandbox
                    .into_iter()
                    .flat_map(|s| &s.inference_providers),
            )
        };
        match (&route.provider, &route.provider_ref) {
            (Some(provider), None) => {
                if enclosing().any(|definition| definition.name == provider.name) {
                    return Err(ConfigError::new(
                        "inline provider names must not shadow enclosing definitions",
                    ));
                }
                Ok(SelectedProvider::new(
                    provider,
                    inference.sandbox,
                    format!("{}.provider", inference.route_path(route)),
                ))
            }
            (None, Some(name)) => {
                if let Some(provider) = self
                    .spec
                    .inference_providers
                    .iter()
                    .find(|p| &p.name == name)
                {
                    return Ok(SelectedProvider::new(
                        provider,
                        None,
                        provider_path("spec", name),
                    ));
                }
                if let Some(sandbox) = inference.sandbox
                    && let Some(provider) =
                        sandbox.inference_providers.iter().find(|p| &p.name == name)
                {
                    return Ok(SelectedProvider::new(
                        provider,
                        Some(sandbox),
                        provider_path(&sandbox_path(sandbox), name),
                    ));
                }
                Err(missing_reference(
                    &format!("{}.providerRef", inference.route_path(route)),
                    "provider",
                    name,
                    enclosing().map(|p| p.name.as_str()),
                ))
            }
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
        Ok(self
            .selected_providers()?
            .into_iter()
            .map(|p| p.definition)
            .collect())
    }

    pub(crate) fn selected_providers(&self) -> Result<Vec<SelectedProvider<'_>>, ConfigError> {
        let mut selected = BTreeMap::new();
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
            let inference = self.scoped_inference(sandbox)?;
            for route in &inference.inference.routes {
                let provider = self.route_provider(route, &inference)?;
                let path = provider.path.clone();
                if let Some(previous) = selected.insert(provider.key.clone(), provider)
                    && previous.path != path
                {
                    return Err(ConfigError::new(
                        "selected provider definitions must have distinct names",
                    ));
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
    ) -> Result<Vec<SelectedProvider<'a>>, ConfigError> {
        let mut selected = BTreeMap::new();
        let inference = self.scoped_inference(sandbox)?;
        for route in &inference.inference.routes {
            let provider = self.route_provider(route, &inference)?;
            selected.insert(provider.key.clone(), provider);
        }
        Ok(selected.into_values().collect())
    }

    pub(crate) fn selected_provider_mut(
        &mut self,
        key: &str,
    ) -> Result<&mut InferenceProvider, ConfigError> {
        let path = self
            .selected_providers()?
            .into_iter()
            .find(|p| p.key == key)
            .ok_or(ConfigError::new("provider is not selected"))?
            .path;
        self.provider_at_mut(&path)
    }

    /// Edit the selected definition in its authored scope without rewriting references.
    pub fn inference_provider_mut(&mut self) -> Result<&mut InferenceProvider, ConfigError> {
        let selected = self.selected_providers()?;
        let [provider] = selected.as_slice() else {
            return Err(ConfigError::new(
                "select an explicit provider in a multi-provider deployment",
            ));
        };
        let path = provider.path.clone();
        self.provider_at_mut(&path)
    }

    pub(crate) fn provider_definitions_mut(
        &mut self,
    ) -> impl Iterator<Item = &mut InferenceProvider> {
        self.provider_locations_mut().map(|(_, provider)| provider)
    }

    fn provider_at_mut(&mut self, path: &str) -> Result<&mut InferenceProvider, ConfigError> {
        self.provider_locations_mut()
            .find(|(location, _)| location == path)
            .map(|(_, provider)| provider)
            .ok_or(ConfigError::new("provider definition no longer exists"))
    }

    fn provider_locations_mut(&mut self) -> impl Iterator<Item = (String, &mut InferenceProvider)> {
        self.spec
            .inference_providers
            .iter_mut()
            .map(|provider| (provider_path("spec", &provider.name), provider))
            .chain(
                self.spec
                    .inferences
                    .iter_mut()
                    .flat_map(|(name, inference)| {
                        inline_providers_mut(
                            inference,
                            format!("spec.inferences[{}]", diagnostic_name(name)),
                        )
                    }),
            )
            .chain(self.spec.sandboxes.iter_mut().flat_map(|sandbox| {
                let base = sandbox_path(sandbox);
                let definitions = base.clone();
                let inferences = base.clone();
                sandbox
                    .inference_providers
                    .iter_mut()
                    .map(move |provider| (provider_path(&definitions, &provider.name), provider))
                    .chain(
                        sandbox
                            .inferences
                            .iter_mut()
                            .flat_map(move |(name, inference)| {
                                inline_providers_mut(
                                    inference,
                                    format!("{inferences}.inferences[{}]", diagnostic_name(name)),
                                )
                            }),
                    )
                    .chain(
                        sandbox
                            .agent
                            .inference
                            .iter_mut()
                            .flat_map(move |inference| {
                                inline_providers_mut(inference, format!("{base}.agent.inference"))
                            }),
                    )
            }))
    }

    pub(super) fn provider_definitions(&self) -> impl Iterator<Item = &InferenceProvider> {
        self.spec
            .inference_providers
            .iter()
            .chain(
                self.spec
                    .sandboxes
                    .iter()
                    .flat_map(|sandbox| &sandbox.inference_providers),
            )
            .chain(self.inference_definitions().flat_map(|selection| {
                selection
                    .inference
                    .routes
                    .iter()
                    .filter_map(|route| route.provider.as_ref())
            }))
    }
}

fn inline_providers_mut(
    inference: &mut Inference,
    base: String,
) -> impl Iterator<Item = (String, &mut InferenceProvider)> {
    inference.routes.iter_mut().filter_map(move |route| {
        let path = format!("{base}.routes[{}].provider", diagnostic_name(&route.name));
        route.provider.as_mut().map(|provider| (path, provider))
    })
}
