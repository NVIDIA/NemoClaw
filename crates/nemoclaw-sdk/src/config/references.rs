// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{Agent, ConfigError, Document, Harness, Inference, Route, Sandbox};

impl Document {
    pub fn sandbox(&self, name: &str) -> Result<&Sandbox, ConfigError> {
        self.spec
            .sandboxes
            .iter()
            .find(|sandbox| sandbox.name == name)
            .ok_or(ConfigError("sandbox name has no definition"))
    }

    /// Resolve an agent's inference without replacing its authored reference.
    pub fn agent_inference<'a>(&'a self, agent: &'a Agent) -> Result<&'a Inference, ConfigError> {
        Ok(self.scoped_inference(agent)?.0)
    }

    // An enclosing sandbox supplies local definitions; deployment definitions have no sandbox scope.
    pub(super) fn scoped_inference<'a>(
        &'a self,
        agent: &'a Agent,
    ) -> Result<(&'a Inference, Option<&'a Sandbox>), ConfigError> {
        let sandbox = self
            .spec
            .sandboxes
            .iter()
            .find(|sandbox| sandbox.agents.iter().any(|item| std::ptr::eq(item, agent)))
            .ok_or(ConfigError("agent does not belong to this document"))?;
        match (&agent.inference, &agent.inference_ref) {
            (Some(inference), None) => Ok((inference, Some(sandbox))),
            (None, Some(name)) => {
                if let Some(inference) = self.spec.inferences.get(name) {
                    return Ok((inference, None));
                }
                sandbox
                    .inferences
                    .get(name)
                    .map(move |inference| (inference, Some(sandbox)))
                    .ok_or(ConfigError("inference reference has no visible definition"))
            }
            _ => Err(ConfigError(
                "agent requires exactly one of inference or inferenceRef",
            )),
        }
    }

    pub(super) fn inference_definitions(
        &self,
    ) -> impl Iterator<Item = (&Inference, Option<&Sandbox>)> {
        self.spec
            .inferences
            .values()
            .map(|inference| (inference, None))
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
                    .map(move |inference| (inference, Some(sandbox)))
            }))
    }

    pub(super) fn validate_inference_references(&self) -> Result<(), ConfigError> {
        for sandbox in &self.spec.sandboxes {
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
            for agent in &sandbox.agents {
                self.agent_inference(agent)?;
            }
        }
        for (inference, sandbox_visible) in self.inference_definitions() {
            inference.validate_choices()?;
            for route in &inference.routes {
                self.route_provider(route, sandbox_visible)?;
            }
        }
        Ok(())
    }
}

impl Document {
    /// Resolve the sandbox's harness without replacing its authored selection.
    pub fn sandbox_harness<'a>(&'a self, sandbox: &'a Sandbox) -> Result<&'a Harness, ConfigError> {
        match (&sandbox.harness, &sandbox.harness_ref) {
            (Some(harness), None) => Ok(harness),
            (None, Some(name)) => self
                .spec
                .harnesses
                .get(name)
                .or_else(|| sandbox.harnesses.get(name))
                .ok_or(ConfigError("harness reference has no visible definition")),
            _ => Err(ConfigError(
                "sandbox requires exactly one of harness or harnessRef",
            )),
        }
    }

    pub(super) fn validate_harness_references(&self) -> Result<(), ConfigError> {
        for sandbox in &self.spec.sandboxes {
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
                .chain(sandbox.harness.iter())
            {
                harness.validate()?;
            }
            self.sandbox_harness(sandbox)?;
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

impl Inference {
    pub fn default_route(&self) -> Result<&Route, ConfigError> {
        match (&self.default, self.routes.as_slice()) {
            (None, [route]) => Ok(route),
            (Some(name), routes) => {
                routes
                    .iter()
                    .find(|route| &route.name == name)
                    .ok_or(ConfigError(
                        "default inference choice has no matching route",
                    ))
            }
            _ => Err(ConfigError(
                "multiple inference choices require an explicit default",
            )),
        }
    }

    fn validate_choices(&self) -> Result<(), ConfigError> {
        self.default_route()?;
        if self.routes.len() > 32 {
            return Err(ConfigError("at most 32 model choices are supported"));
        }
        let mut names = std::collections::BTreeSet::new();
        for route in &self.routes {
            if !super::validation::SLUG.is_match(&route.name)
                || !names.insert(&route.name)
                || !super::validation::valid_model(&route.overrides.model)
            {
                return Err(ConfigError(
                    "inference choices require unique lowercase names and valid models",
                ));
            }
            route.overrides.tuning.validate("openclaw")?;
            if self.default_route()?.name != route.name
                && route
                    .overrides
                    .tuning
                    .reasoning_effort
                    .is_some_and(|effort| effort != super::ReasoningEffort::Default)
            {
                return Err(ConfigError(
                    "reasoningEffort configures the initial default model; omit it on other choices",
                ));
            }
        }
        Ok(())
    }
}

impl Sandbox {
    pub(crate) fn sole_agent(&self) -> Result<&Agent, ConfigError> {
        match self.agents.as_slice() {
            [agent] => Ok(agent),
            _ => Err(ConfigError("harness requires exactly one agent")),
        }
    }
}
