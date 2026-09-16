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

    /// Resolve the single provider selected by routes, preserving its declaration scope.
    pub fn inference_provider(&self) -> Result<&InferenceProvider, ConfigError> {
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
        let mut selected: Option<&InferenceProvider> = None;
        for agent in &sandbox.agents {
            let (inference, sandbox_visible) = self.scoped_inference(agent)?;
            let [route] = inference.routes.as_slice() else {
                return Err(ConfigError("exactly one primary route is required"));
            };
            let provider = self.route_provider(route, sandbox_visible)?;
            if selected.is_some_and(|previous| !std::ptr::eq(previous, provider)) {
                return Err(ConfigError(
                    "a sandbox supports only one selected inference provider definition",
                ));
            }
            selected = Some(provider);
        }
        selected.ok_or(ConfigError("at least one agent is required"))
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
