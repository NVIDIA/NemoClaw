// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{Agent, ConfigError, Document, Inference};

impl Document {
    /// Resolve an agent's inference without replacing its authored reference.
    pub fn agent_inference<'a>(&'a self, agent: &'a Agent) -> Result<&'a Inference, ConfigError> {
        Ok(self.scoped_inference(agent)?.0)
    }

    // The boolean indicates whether sandbox definitions are visible from the declaration.
    pub(super) fn scoped_inference<'a>(
        &'a self,
        agent: &'a Agent,
    ) -> Result<(&'a Inference, bool), ConfigError> {
        match (&agent.inference, &agent.inference_ref) {
            (Some(inference), None) => Ok((inference, true)),
            (None, Some(name)) => {
                if let Some(inference) = self.spec.inferences.get(name) {
                    return Ok((inference, false));
                }
                self.spec.sandboxes[0]
                    .inferences
                    .get(name)
                    .map(|inference| (inference, true))
                    .ok_or(ConfigError("inference reference has no visible definition"))
            }
            _ => Err(ConfigError(
                "agent requires exactly one of inference or inferenceRef",
            )),
        }
    }

    pub(super) fn inference_definitions(&self) -> impl Iterator<Item = (&Inference, bool)> {
        self.spec
            .inferences
            .values()
            .map(|inference| (inference, false))
            .chain(self.spec.sandboxes.iter().flat_map(|sandbox| {
                sandbox
                    .inferences
                    .values()
                    .chain(
                        sandbox
                            .agents
                            .iter()
                            .filter_map(|agent| agent.inference.as_ref()),
                    )
                    .map(|inference| (inference, true))
            }))
    }

    pub(super) fn validate_inference_references(&self) -> Result<(), ConfigError> {
        let sandbox = &self.spec.sandboxes[0];
        for name in self.spec.inferences.keys().chain(sandbox.inferences.keys()) {
            if !super::validation::SLUG.is_match(name) {
                return Err(ConfigError("inference definitions require lowercase names"));
            }
        }
        if sandbox
            .inferences
            .keys()
            .any(|name| self.spec.inferences.contains_key(name))
        {
            return Err(ConfigError(
                "inference names must not shadow enclosing definitions",
            ));
        }
        for (inference, sandbox_visible) in self.inference_definitions() {
            let [route] = inference.routes.as_slice() else {
                return Err(ConfigError("exactly one primary route is required"));
            };
            if route.name != "primary" || !super::validation::valid_model(&route.overrides.model) {
                return Err(ConfigError("primary route requires a valid model"));
            }
            route.overrides.tuning.validate("openclaw")?;
            self.route_provider(route, sandbox_visible)?;
        }
        for agent in &sandbox.agents {
            self.agent_inference(agent)?;
        }
        Ok(())
    }
}
