// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{ConfigError, Document, Harness, Inference, Route, Sandbox};

// Borrow authored inference together with its declaration scope and diagnostic path.
// A shared deployment definition cannot see a consuming sandbox's local providers.
pub(super) struct ScopedInference<'a> {
    pub inference: &'a Inference,
    pub sandbox: Option<&'a Sandbox>,
    pub path: String,
}
impl<'a> ScopedInference<'a> {
    fn new(inference: &'a Inference, sandbox: Option<&'a Sandbox>, name: Option<&str>) -> Self {
        let base = sandbox.map_or_else(
            || "spec".into(),
            |s| format!("spec.sandboxes[{}]", diagnostic_name(&s.name)),
        );
        let path = name.map_or_else(
            || format!("{base}.agent.inference"),
            |name| format!("{base}.inferences[{}]", diagnostic_name(name)),
        );
        Self {
            inference,
            sandbox,
            path,
        }
    }
    pub fn route_path(&self, route: &Route) -> String {
        format!("{}.routes[{}]", self.path, diagnostic_name(&route.name))
    }
}

impl Document {
    pub fn sandbox(&self, name: &str) -> Result<&Sandbox, ConfigError> {
        self.spec
            .sandboxes
            .iter()
            .find(|sandbox| sandbox.name == name)
            .ok_or(ConfigError::new("sandbox name has no definition"))
    }

    /// Resolve inference using the supplied sandbox's definitions and this deployment's definitions.
    /// Authored references are preserved; resolution does not depend on object addresses.
    pub fn sandbox_inference<'a>(
        &'a self,
        sandbox: &'a Sandbox,
    ) -> Result<&'a Inference, ConfigError> {
        Ok(self.scoped_inference(sandbox)?.inference)
    }

    pub(super) fn scoped_inference<'a>(
        &'a self,
        sandbox: &'a Sandbox,
    ) -> Result<ScopedInference<'a>, ConfigError> {
        let agent = &sandbox.agent;
        match (&agent.inference, &agent.inference_ref) {
            (Some(inference), None) => Ok(ScopedInference::new(inference, Some(sandbox), None)),
            (None, Some(name)) => {
                if let Some(inference) = self.spec.inferences.get(name) {
                    return Ok(ScopedInference::new(inference, None, Some(name)));
                }
                sandbox
                    .inferences
                    .get(name)
                    .map(|inference| ScopedInference::new(inference, Some(sandbox), Some(name)))
                    .ok_or_else(|| {
                        missing_reference(
                            &format!(
                                "spec.sandboxes[{}].agent.inferenceRef",
                                diagnostic_name(&sandbox.name)
                            ),
                            "inference",
                            name,
                            self.spec
                                .inferences
                                .keys()
                                .chain(sandbox.inferences.keys())
                                .map(String::as_str),
                        )
                    })
            }
            _ => Err(ConfigError::new(
                "agent requires exactly one of inference or inferenceRef",
            )),
        }
    }

    pub(super) fn inference_definitions(&self) -> impl Iterator<Item = ScopedInference<'_>> {
        self.spec
            .inferences
            .iter()
            .map(|(name, inference)| ScopedInference::new(inference, None, Some(name)))
            .chain(self.spec.sandboxes.iter().flat_map(|sandbox| {
                sandbox
                    .inferences
                    .iter()
                    .map(move |(name, inference)| {
                        ScopedInference::new(inference, Some(sandbox), Some(name))
                    })
                    .chain(
                        sandbox.agent.inference.iter().map(move |inference| {
                            ScopedInference::new(inference, Some(sandbox), None)
                        }),
                    )
            }))
    }

    pub(super) fn validate_inference_references(&self) -> Result<(), ConfigError> {
        for sandbox in &self.spec.sandboxes {
            if sandbox
                .inferences
                .keys()
                .any(|name| self.spec.inferences.contains_key(name))
            {
                return Err(ConfigError::new(
                    "inference names must not shadow enclosing definitions",
                ));
            }
            self.sandbox_inference(sandbox)?;
        }
        for selection in self.inference_definitions() {
            selection.inference.validate_choices()?;
            for route in &selection.inference.routes {
                self.route_provider(route, &selection)?;
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
                .ok_or_else(|| {
                    missing_reference(
                        &format!(
                            "spec.sandboxes[{}].harnessRef",
                            diagnostic_name(&sandbox.name)
                        ),
                        "harness",
                        name,
                        self.spec
                            .harnesses
                            .keys()
                            .chain(sandbox.harnesses.keys())
                            .map(String::as_str),
                    )
                }),
            _ => Err(ConfigError::new(
                "sandbox requires exactly one of harness or harnessRef",
            )),
        }
    }

    pub(super) fn validate_harness_references(&self) -> Result<(), ConfigError> {
        for sandbox in &self.spec.sandboxes {
            if sandbox
                .harnesses
                .keys()
                .any(|name| self.spec.harnesses.contains_key(name))
            {
                return Err(ConfigError::new(
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
        super::schema::validate_definition("Harness", self)?;
        if let Some(interfaces) = &self.interfaces {
            interfaces.validate(self.kind)?;
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
                    .ok_or(ConfigError::new(
                        "default inference choice has no matching route",
                    ))
            }
            _ => Err(ConfigError::new(
                "multiple inference choices require an explicit default",
            )),
        }
    }

    fn validate_choices(&self) -> Result<(), ConfigError> {
        self.default_route()?;
        let mut names = std::collections::BTreeSet::new();
        for route in &self.routes {
            if !names.insert(&route.name) {
                return Err(ConfigError::new("inference choices require unique names"));
            }
            route
                .overrides
                .tuning
                .validate(super::HarnessKind::OpenClaw)?;
            if self.default_route()?.name != route.name
                && route
                    .overrides
                    .tuning
                    .reasoning_effort
                    .is_some_and(|effort| effort != super::ReasoningEffort::Default)
            {
                return Err(ConfigError::new(
                    "reasoningEffort configures the initial default model; omit it on other choices",
                ));
            }
        }
        Ok(())
    }
}

// Only bounded schema identifiers may appear in diagnostics; never echo arbitrary YAML.
pub(super) fn diagnostic_name(name: &str) -> &str {
    if name.len() <= 64 && super::validation::valid_name(name) {
        name
    } else {
        "<invalid name>"
    }
}
pub(crate) fn missing_reference<'a>(
    path: &str,
    kind: &str,
    name: &str,
    visible: impl Iterator<Item = &'a str>,
) -> ConfigError {
    let names: std::collections::BTreeSet<_> = visible.map(diagnostic_name).collect();
    let choices = if names.is_empty() {
        "(none)".into()
    } else {
        names.into_iter().collect::<Vec<_>>().join(", ")
    };
    ConfigError(format!(
        "{path}: unknown {kind} {name:?}; visible definitions: {choices}",
        name = diagnostic_name(name)
    ))
}
