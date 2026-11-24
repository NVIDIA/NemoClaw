// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::source::DefinitionSource;
use super::validation::Placed;
use super::{ConfigError, Document, Harness, Inference, Route, Sandbox};

/// A sandbox definition and its name, the key of its `spec.sandboxes` entry.
/// The definition has no name field, so code that needs both borrows them
/// together; field access reaches the definition through `Deref`.
#[derive(Clone, Copy, Debug)]
pub struct NamedSandbox<'a> {
    pub name: &'a str,
    pub definition: &'a Sandbox,
}
impl std::ops::Deref for NamedSandbox<'_> {
    type Target = Sandbox;
    fn deref(&self) -> &Sandbox {
        self.definition
    }
}

// Borrow authored inference together with its declaration scope and diagnostic path.
// A shared deployment definition cannot see a consuming sandbox's local providers.
pub(crate) struct ScopedInference<'a> {
    pub inference: &'a Inference,
    pub sandbox: Option<NamedSandbox<'a>>,
    pub path: String,
    /// The JSON pointer of the definition.
    pub pointer: String,
}
impl<'a> ScopedInference<'a> {
    fn new(
        inference: &'a Inference,
        sandbox: Option<NamedSandbox<'a>>,
        name: Option<&str>,
    ) -> Self {
        let base = sandbox.map_or_else(
            || "spec".into(),
            |s| format!("spec.sandboxes[{}]", diagnostic_name(s.name)),
        );
        let path = name.map_or_else(
            || format!("{base}.agent.inference"),
            |name| format!("{base}.inferences[{}]", diagnostic_name(name)),
        );
        let base =
            sandbox.map_or_else(|| "/spec".into(), |s| format!("/spec/sandboxes/{}", s.name));
        let pointer = name.map_or_else(
            || format!("{base}/agent/inference"),
            |name| format!("{base}/inferences/{name}"),
        );
        Self {
            inference,
            sandbox,
            path,
            pointer,
        }
    }
    pub fn route_path(&self, route: &Route) -> String {
        format!("{}.routes[{}]", self.path, diagnostic_name(&route.name))
    }
    /// The JSON pointer of one of the definition's routes.
    pub fn route_pointer(&self, route: &Route) -> String {
        let routes = &self.inference.routes;
        match routes
            .iter()
            .position(|candidate| std::ptr::eq(candidate, route))
        {
            Some(index) => format!("{}/routes/{index}", self.pointer),
            None => self.pointer.clone(),
        }
    }
}

impl Document {
    /// Every sandbox with its name, in name order.
    pub fn sandboxes(&self) -> impl Iterator<Item = NamedSandbox<'_>> {
        self.spec
            .sandboxes
            .iter()
            .map(|(name, definition)| NamedSandbox { name, definition })
    }

    pub fn sandbox(&self, name: &str) -> Result<NamedSandbox<'_>, ConfigError> {
        self.spec
            .sandboxes
            .get_key_value(name)
            .map(|(name, definition)| NamedSandbox { name, definition })
            .ok_or(ConfigError::new("sandbox name has no definition"))
    }

    /// Resolve inference using the supplied sandbox's definitions and this deployment's definitions.
    /// Authored references are preserved; resolution does not depend on object addresses.
    pub fn sandbox_inference<'a>(
        &'a self,
        sandbox: NamedSandbox<'a>,
    ) -> Result<&'a Inference, ConfigError> {
        Ok(self.scoped_inference(sandbox)?.inference)
    }

    pub(crate) fn scoped_inference<'a>(
        &'a self,
        sandbox: NamedSandbox<'a>,
    ) -> Result<ScopedInference<'a>, ConfigError> {
        let agent = &sandbox.definition.agent;
        match DefinitionSource::from_parts(
            agent.inference.as_ref(),
            agent.inference_ref.as_deref(),
            "agent requires exactly one of inference or inferenceRef",
        )
        .at(&format!("/spec/sandboxes/{}/agent", sandbox.name))?
        {
            DefinitionSource::Inline(inference) => {
                Ok(ScopedInference::new(inference, Some(sandbox), None))
            }
            DefinitionSource::Reference(name) => {
                if let Some(inference) = self.spec.inferences.get(name) {
                    return Ok(ScopedInference::new(inference, None, Some(name)));
                }
                sandbox
                    .definition
                    .inferences
                    .get(name)
                    .map(|inference| ScopedInference::new(inference, Some(sandbox), Some(name)))
                    .ok_or_else(|| {
                        missing_reference(
                            "inference",
                            name,
                            self.spec
                                .inferences
                                .keys()
                                .chain(sandbox.inferences.keys())
                                .map(String::as_str),
                        )
                        .or_at(&format!(
                            "/spec/sandboxes/{}/agent/inferenceRef",
                            sandbox.name
                        ))
                    })
            }
        }
    }

    pub(super) fn inference_definitions(&self) -> impl Iterator<Item = ScopedInference<'_>> {
        self.spec
            .inferences
            .iter()
            .map(|(name, inference)| ScopedInference::new(inference, None, Some(name)))
            .chain(self.sandboxes().flat_map(|sandbox| {
                sandbox
                    .definition
                    .inferences
                    .iter()
                    .map(move |(name, inference)| {
                        ScopedInference::new(inference, Some(sandbox), Some(name))
                    })
                    .chain(
                        sandbox
                            .definition
                            .agent
                            .inference
                            .iter()
                            .map(move |inference| {
                                ScopedInference::new(inference, Some(sandbox), None)
                            }),
                    )
            }))
    }

    pub(super) fn validate_inference_references(&self) -> Result<(), ConfigError> {
        let mut errors = super::validation::Errors::default();
        for sandbox in self.sandboxes() {
            let pointer = format!("/spec/sandboxes/{}", sandbox.name);
            if let Some(name) = sandbox
                .inferences
                .keys()
                .find(|name| self.spec.inferences.contains_key(*name))
            {
                errors.push(ConfigError::at(
                    format!("{pointer}/inferences/{name}"),
                    "inference names must not shadow enclosing definitions",
                ));
            }
            errors.check(&pointer, self.sandbox_inference(sandbox));
        }
        for selection in self.inference_definitions() {
            errors.check(&selection.pointer, selection.inference.validate_choices());
            for route in &selection.inference.routes {
                errors.check(
                    &selection.route_pointer(route),
                    self.route_provider(route, &selection),
                );
            }
        }
        errors.finish()
    }
}

impl Document {
    /// Resolve the sandbox's harness without replacing its authored selection.
    pub fn sandbox_harness<'a>(
        &'a self,
        sandbox: NamedSandbox<'a>,
    ) -> Result<&'a Harness, ConfigError> {
        sandbox.resolve_harness(&self.spec.harnesses)
    }

    /// Where the sandbox's harness is authored, for diagnostics: inline, or the
    /// definition its `harnessRef` selects.
    pub fn harness_path(&self, sandbox: NamedSandbox<'_>) -> String {
        let base = self.sandbox_path(sandbox);
        match sandbox.harness_ref.as_deref() {
            None => format!("{base}.harness"),
            Some(name) if self.spec.harnesses.contains_key(name) => {
                format!("spec.harnesses[{}]", diagnostic_name(name))
            }
            Some(name) => format!("{base}.harnesses[{}]", diagnostic_name(name)),
        }
    }

    /// Where the sandbox's agent is authored, for diagnostics.
    pub fn agent_path(&self, sandbox: NamedSandbox<'_>) -> String {
        format!("{}.agent", self.sandbox_path(sandbox))
    }

    /// Where the sandbox is authored, for diagnostics.
    pub fn sandbox_path(&self, sandbox: NamedSandbox<'_>) -> String {
        format!("spec.sandboxes[{}]", diagnostic_name(sandbox.name))
    }

    pub(super) fn validate_harness_references(&self) -> Result<(), ConfigError> {
        let mut errors = super::validation::Errors::default();
        for (name, harness) in &self.spec.harnesses {
            errors.check(&format!("/spec/harnesses/{name}"), harness.validate());
        }
        for sandbox in self.sandboxes() {
            let pointer = format!("/spec/sandboxes/{}", sandbox.name);
            if let Some(name) = sandbox
                .harnesses
                .keys()
                .find(|name| self.spec.harnesses.contains_key(*name))
            {
                errors.push(ConfigError::at(
                    format!("{pointer}/harnesses/{name}"),
                    "harness names must not shadow enclosing definitions",
                ));
            }
            for (name, harness) in &sandbox.harnesses {
                errors.check(&format!("{pointer}/harnesses/{name}"), harness.validate());
            }
            if let Some(harness) = &sandbox.harness {
                errors.check(&format!("{pointer}/harness"), harness.validate());
            }
            errors.check(&pointer, self.sandbox_harness(sandbox));
        }
        errors.finish()
    }
}

impl Harness {
    pub fn runtime(&self) -> String {
        "fabric".into()
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        super::schema::validate_definition("Harness", self)?;
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
            super::schema::validate_tuning(&route.overrides.tuning)?;
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
/// A reference to no visible definition, for the caller to place at the
/// reference.
pub(crate) fn missing_reference<'a>(
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
    ConfigError::from(format!(
        "unknown {kind} {name:?}; visible definitions: {choices}",
        name = diagnostic_name(name)
    ))
}

impl<'a> NamedSandbox<'a> {
    fn resolve_harness(
        self,
        harnesses: &'a std::collections::BTreeMap<String, Harness>,
    ) -> Result<&'a Harness, ConfigError> {
        let sandbox = self.definition;
        match DefinitionSource::from_parts(
            sandbox.harness.as_ref(),
            sandbox.harness_ref.as_deref(),
            "sandbox requires exactly one of harness or harnessRef",
        )
        .at(&format!("/spec/sandboxes/{}", self.name))?
        {
            DefinitionSource::Inline(harness) => Ok(harness),
            DefinitionSource::Reference(name) => harnesses
                .get(name)
                .or_else(|| sandbox.harnesses.get(name))
                .ok_or_else(|| {
                    missing_reference(
                        "harness",
                        name,
                        harnesses
                            .keys()
                            .chain(sandbox.harnesses.keys())
                            .map(String::as_str),
                    )
                    .or_at(&format!("/spec/sandboxes/{}/harnessRef", self.name))
                }),
        }
    }
}
