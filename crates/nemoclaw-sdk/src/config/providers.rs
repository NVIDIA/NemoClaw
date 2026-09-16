// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{ConfigError, Document, InferenceProvider};
use std::collections::BTreeSet;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Location {
    Deployment(usize),
    Sandbox(usize),
    Inline(usize),
}

impl Document {
    fn provider_location(&self) -> Result<Location, ConfigError> {
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
        let mut selected = None;
        for (index, agent) in sandbox.agents.iter().enumerate() {
            let [route] = agent.inference.routes.as_slice() else {
                return Err(ConfigError("exactly one primary route is required"));
            };
            let location = match (&route.provider, route.provider_ref.as_deref()) {
                (Some(provider), None) => {
                    if names.contains(&provider.name) {
                        return Err(ConfigError(
                            "inline provider names must not shadow enclosing definitions",
                        ));
                    }
                    Location::Inline(index)
                }
                (None, Some(reference)) => self
                    .spec
                    .inference_providers
                    .iter()
                    .position(|p| p.name == reference)
                    .map(Location::Deployment)
                    .or_else(|| {
                        sandbox
                            .inference_providers
                            .iter()
                            .position(|p| p.name == reference)
                            .map(Location::Sandbox)
                    })
                    .ok_or(ConfigError("provider reference has no visible definition"))?,
                _ => {
                    return Err(ConfigError(
                        "route requires exactly one of provider or providerRef",
                    ));
                }
            };
            if selected.is_some_and(|previous| previous != location) {
                return Err(ConfigError(
                    "a sandbox supports only one selected inference provider definition",
                ));
            }
            selected = Some(location);
        }
        selected.ok_or(ConfigError("at least one agent is required"))
    }

    /// Resolve the single provider selected by routes, preserving its declaration scope.
    pub fn inference_provider(&self) -> Result<&InferenceProvider, ConfigError> {
        Ok(match self.provider_location()? {
            Location::Deployment(i) => &self.spec.inference_providers[i],
            Location::Sandbox(i) => &self.spec.sandboxes[0].inference_providers[i],
            Location::Inline(i) => self.spec.sandboxes[0].agents[i].inference.routes[0]
                .provider
                .as_ref()
                .unwrap(),
        })
    }

    /// Edit the selected definition in its authored scope without rewriting references.
    pub fn inference_provider_mut(&mut self) -> Result<&mut InferenceProvider, ConfigError> {
        Ok(match self.provider_location()? {
            Location::Deployment(i) => &mut self.spec.inference_providers[i],
            Location::Sandbox(i) => &mut self.spec.sandboxes[0].inference_providers[i],
            Location::Inline(i) => self.spec.sandboxes[0].agents[i].inference.routes[0]
                .provider
                .as_mut()
                .unwrap(),
        })
    }

    pub(crate) fn provider_definitions_mut(
        &mut self,
    ) -> impl Iterator<Item = &mut InferenceProvider> {
        self.spec
            .inference_providers
            .iter_mut()
            .chain(self.spec.sandboxes.iter_mut().flat_map(|sandbox| {
                sandbox
                    .inference_providers
                    .iter_mut()
                    .chain(sandbox.agents.iter_mut().flat_map(|agent| {
                        agent
                            .inference
                            .routes
                            .iter_mut()
                            .filter_map(|route| route.provider.as_mut())
                    }))
            }))
    }
}
