// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{Agent, ConfigError, Document, Harness, Inference};

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

impl Document {
    /// Resolve an agent's harness configuration from its enclosing definitions.
    pub fn agent_harness<'a>(&'a self, agent: &'a Agent) -> Result<&'a Harness, ConfigError> {
        match (&agent.harness, &agent.harness_ref) {
            (Some(harness), None) => Ok(harness),
            (None, Some(name)) => self
                .spec
                .harnesses
                .get(name)
                .or_else(|| self.spec.sandboxes[0].harnesses.get(name))
                .ok_or(ConfigError("harness reference has no visible definition")),
            _ => Err(ConfigError(
                "agent requires exactly one of harness or harnessRef",
            )),
        }
    }

    pub(super) fn validate_harness_references(&self) -> Result<(), ConfigError> {
        let sandbox = &self.spec.sandboxes[0];
        for name in self.spec.harnesses.keys().chain(sandbox.harnesses.keys()) {
            if !super::validation::SLUG.is_match(name) {
                return Err(ConfigError("harness definitions require lowercase names"));
            }
        }
        if sandbox
            .harnesses
            .keys()
            .any(|name| self.spec.harnesses.contains_key(name))
        {
            return Err(ConfigError(
                "harness names must not shadow enclosing definitions",
            ));
        }
        for harness in self
            .spec
            .harnesses
            .values()
            .chain(sandbox.harnesses.values())
            .chain(
                sandbox
                    .agents
                    .iter()
                    .filter_map(|agent| agent.harness.as_ref()),
            )
        {
            harness.validate()?;
        }
        let first = sandbox
            .agents
            .first()
            .ok_or(ConfigError("at least one agent is required"))?;
        let selected = self.agent_harness(first)?;
        for agent in &sandbox.agents {
            if self.agent_harness(agent)? != selected {
                return Err(ConfigError(
                    "agents in a sandbox must share identical harness settings",
                ));
            }
        }
        Ok(())
    }
}

impl Harness {
    pub fn runtime(&self) -> String {
        format!("fabric-{}", self.kind)
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        if !super::is_fabric_harness(&self.kind) {
            return Err(ConfigError("harness requires a supported kind"));
        }
        if let Some(interfaces) = &self.interfaces {
            interfaces.validate(&self.kind)?;
        }
        if let Some(execution) = &self.execution {
            execution.validate(&self.kind)?;
        }
        if let Some(observability) = &self.observability {
            observability.validate(&self.kind)?;
            if observability.uses_relay() && self.interfaces.is_some() {
                return Err(ConfigError(
                    "Hermes Relay tracing cannot be combined with native Hermes interfaces",
                ));
            }
        }
        Ok(())
    }
}
