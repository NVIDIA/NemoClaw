// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::diagnostics::diagnostic;
use crate::{Answers, Capabilities, Diagnostics};
use nemoclaw_sdk::config::Document;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompletionBoundary {
    GeneratedDesiredState,
}

/// Generated YAML and its SDK-validated document, without deployment effects.
#[derive(Debug)]
pub struct AuthoredDocument {
    pub(crate) yaml: String,
    pub(crate) document: Document,
    pub(crate) completion_boundary: CompletionBoundary,
}

impl AuthoredDocument {
    pub fn yaml(&self) -> &str {
        &self.yaml
    }

    pub fn document(&self) -> &Document {
        &self.document
    }

    pub fn completion_boundary(&self) -> CompletionBoundary {
        self.completion_boundary
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IdentityEdits {
    pub deployment_name: Option<String>,
    pub sandbox_name: Option<String>,
    pub agent_name: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InferenceEdits {
    pub provider_name: Option<String>,
    pub endpoint: Option<String>,
    pub model: Option<String>,
    pub credential_env: Option<String>,
}

/// A validated desired-state document being edited by a frontend.
#[derive(Clone, Debug)]
pub struct Draft {
    pub(crate) document: Document,
    selected_route: Option<String>,
    pub(crate) decisions: std::collections::BTreeMap<crate::EditableField, crate::AnswerStatus>,
    pub(crate) skipped_settings: std::collections::BTreeMap<String, serde_json::Value>,
    pub(crate) delegated_settings: Vec<String>,
}

impl Draft {
    /// Starts a draft from a validated document.
    pub fn from_document(document: Document) -> Result<Self, Diagnostics> {
        document
            .validate()
            .map_err(|error| diagnostic("document", &error.to_string()))?;
        Ok(Self {
            document,
            selected_route: None,
            decisions: Default::default(),
            skipped_settings: Default::default(),
            delegated_settings: Vec::new(),
        })
    }

    /// Returns the complete desired state owned by this draft.
    pub fn document(&self) -> &Document {
        &self.document
    }

    /// Returns the guided-onboarding view when this document matches a preset.
    pub fn guided_answers(&self, capabilities: &Capabilities) -> Result<Answers, Diagnostics> {
        guided_answers(self, capabilities)
    }

    /// Replaces the guided preset while retaining the deployment UID.
    pub fn replace_answers(
        &mut self,
        capabilities: &Capabilities,
        answers: Answers,
    ) -> Result<(), Diagnostics> {
        let before = self.guided_answers(capabilities)?;
        let mut candidate = self.clone();
        candidate.document.metadata.name = answers.deployment_name.clone();
        candidate.document.spec.sandboxes[0].name = answers.sandbox_name.clone();
        candidate.document.spec.sandboxes[0].agent.name = answers.agent_name.clone();
        candidate.document.spec.sandboxes[0].image.ref_ = answers.image.clone();
        candidate.document.spec.sandboxes[0].runtime.provider = answers.runtime;
        if let Some(gateway) = candidate.document.spec.gateway.as_managed_mut()
            && (before.engine != answers.engine
                || (before.runtime != answers.runtime && before.engine.is_none()))
        {
            gateway.engine = answers
                .engine
                .clone()
                .unwrap_or_else(|| match answers.runtime {
                    nemoclaw_sdk::config::ComputeDriver::Podman => {
                        "unix:///run/user/1000/podman/podman.sock".into()
                    }
                    _ => "unix:///var/run/docker.sock".into(),
                });
        }
        let harness = candidate.harness_mut()?;
        harness.kind = answers.harness.clone();
        harness.settings = answers.harness_settings.clone();
        harness.config = answers.harness_config.clone();
        let route = candidate.route_mut()?;
        route.overrides.model = answers.model.clone();
        route.overrides.settings = answers.model_settings.clone();
        let sandbox_name = candidate.document.spec.sandboxes[0].name.clone();
        let route_name = candidate.current_route()?.to_owned();
        let provider = candidate
            .document
            .sandbox_route_provider_mut(&sandbox_name, &route_name)
            .map_err(|error| diagnostic("provider", &error.to_string()))?;
        if before.provider_name != answers.provider_name {
            // Renaming a shared definition requires updating its references too.
            provider.name = answers.provider_name.clone();
        }
        provider.api = answers.provider_api;
        if before.inference != answers.inference {
            provider.provider = answers.inference.profile().kind;
        }
        if provider.service_ref.is_none() {
            provider.endpoint = answers.endpoint.clone();
            provider.credential =
                (!answers.credential_env.is_empty()).then(|| nemoclaw_sdk::config::Credential {
                    env: answers.credential_env.clone(),
                });
        } else if before.endpoint != answers.endpoint
            || before.credential_env != answers.credential_env
            || before.inference != answers.inference
        {
            return Err(diagnostic(
                "provider",
                "Managed inference connections come from the selected service. Change the service configuration instead.",
            ));
        }
        if before.provider_name != answers.provider_name {
            let inference = candidate.inference_mut()?;
            for route in &mut inference.routes {
                if route.provider_ref.as_deref() == Some(&before.provider_name) {
                    route.provider_ref = Some(answers.provider_name.clone());
                }
            }
        }
        candidate
            .document
            .validate()
            .map_err(|error| diagnostic("document", &error.to_string()))?;
        if before.harness != answers.harness {
            candidate.skipped_settings.clear();
            candidate.delegated_settings.clear();
        }
        candidate.decisions.clear();
        *self = candidate;
        Ok(())
    }

    /// Apply a fully validated SDK document without losing unrelated defaults.
    pub(crate) fn replace_document(&mut self, document: Document) -> Result<(), Diagnostics> {
        document
            .validate()
            .map_err(|error| diagnostic("document", &error.to_string()))?;
        let capabilities = Capabilities::available();
        let before = self.guided_answers(&capabilities)?;
        let mut candidate = self.clone();
        candidate.document = document;
        if candidate.current_route().is_err() {
            candidate.selected_route = None;
        }
        let after = candidate.guided_answers(&capabilities)?;
        let target_unchanged = before.image == after.image
            && self.document.spec.gateway == candidate.document.spec.gateway;
        candidate.decisions.retain(|field, status| {
            crate::guided::current_value(&before, *field)
                == crate::guided::current_value(&after, *field)
                && !crate::EditableField::GUIDED.iter().any(|dependency| {
                    crate::DependencyGraph.depends_on(*field, *dependency)
                        && crate::guided::current_value(&before, *dependency)
                            != crate::guided::current_value(&after, *dependency)
                })
                && (*status != crate::AnswerStatus::Delegated || target_unchanged)
        });
        if before.harness != after.harness {
            candidate.skipped_settings.clear();
            candidate.delegated_settings.clear();
        }
        *self = candidate;
        Ok(())
    }

    pub fn route_names(&self) -> Result<Vec<String>, Diagnostics> {
        Ok(self
            .inference()?
            .routes
            .iter()
            .map(|route| route.name.clone())
            .collect())
    }
    pub fn current_route(&self) -> Result<&str, Diagnostics> {
        let inference = self.inference()?;
        let name = self
            .selected_route
            .as_deref()
            .or(inference.default.as_deref())
            .or_else(|| inference.routes.first().map(|route| route.name.as_str()))
            .ok_or_else(|| diagnostic("route", "An inference route is required."))?;
        if !inference.routes.iter().any(|route| route.name == name) {
            return Err(diagnostic("route", "The selected route no longer exists."));
        }
        Ok(name)
    }
    pub fn select_route(&mut self, name: &str) -> Result<(), Diagnostics> {
        if !self.route_names()?.iter().any(|route| route == name) {
            return Err(diagnostic("route", "Unknown inference route."));
        }
        if self.current_route()? != name {
            self.selected_route = Some(name.into());
            self.decisions.retain(|field, _| {
                matches!(
                    field,
                    crate::EditableField::Harness
                        | crate::EditableField::Runtime
                        | crate::EditableField::DeploymentName
                        | crate::EditableField::SandboxName
                        | crate::EditableField::AgentName
                )
            });
            self.skipped_settings
                .retain(|path, _| !path.starts_with("model:"));
            self.delegated_settings
                .retain(|path| !path.starts_with("model:"));
        }
        Ok(())
    }
    pub fn selected_provider_is_managed(&self) -> Result<bool, Diagnostics> {
        Ok(self.provider()?.service_ref.is_some())
    }
    pub(crate) fn inference(&self) -> Result<&nemoclaw_sdk::config::Inference, Diagnostics> {
        let [sandbox] = self.document.spec.sandboxes.as_slice() else {
            return Err(diagnostic("sandbox", "Authoring requires one sandbox."));
        };
        self.document
            .sandbox_inference(sandbox)
            .map_err(|error| diagnostic("inference", &error.to_string()))
    }
    pub(crate) fn route(&self) -> Result<&nemoclaw_sdk::config::Route, Diagnostics> {
        let name = self.current_route()?;
        self.inference()?
            .routes
            .iter()
            .find(|route| route.name == name)
            .ok_or_else(|| diagnostic("route", "Unknown route."))
    }
    pub(crate) fn provider(&self) -> Result<&nemoclaw_sdk::config::InferenceProvider, Diagnostics> {
        self.document
            .sandbox_route_provider(&self.document.spec.sandboxes[0], self.route()?)
            .map_err(|error| diagnostic("provider", &error.to_string()))
    }
    pub(crate) fn inference_mut(
        &mut self,
    ) -> Result<&mut nemoclaw_sdk::config::Inference, Diagnostics> {
        let selected = self.inference()? as *const _;
        if let Some(name) = self
            .document
            .spec
            .inferences
            .iter()
            .find_map(|(name, value)| std::ptr::eq(value, selected).then(|| name.clone()))
        {
            return Ok(self.document.spec.inferences.get_mut(&name).unwrap());
        }
        let sandbox = &mut self.document.spec.sandboxes[0];
        if let Some(name) = sandbox
            .inferences
            .iter()
            .find_map(|(name, value)| std::ptr::eq(value, selected).then(|| name.clone()))
        {
            return Ok(sandbox.inferences.get_mut(&name).unwrap());
        }
        sandbox
            .agent
            .inference
            .as_mut()
            .ok_or_else(|| diagnostic("inference", "Missing inference definition."))
    }
    pub(crate) fn route_mut(&mut self) -> Result<&mut nemoclaw_sdk::config::Route, Diagnostics> {
        let name = self.current_route()?.to_owned();
        self.inference_mut()?
            .routes
            .iter_mut()
            .find(|route| route.name == name)
            .ok_or_else(|| diagnostic("route", "Unknown route."))
    }
    pub(crate) fn harness_mut(
        &mut self,
    ) -> Result<&mut nemoclaw_sdk::config::Harness, Diagnostics> {
        let selected = self
            .document
            .sandbox_harness(&self.document.spec.sandboxes[0])
            .map_err(|error| diagnostic("harness", &error.to_string()))?
            as *const _;
        if let Some(name) = self
            .document
            .spec
            .harnesses
            .iter()
            .find_map(|(name, value)| std::ptr::eq(value, selected).then(|| name.clone()))
        {
            return Ok(self.document.spec.harnesses.get_mut(&name).unwrap());
        }
        let sandbox = &mut self.document.spec.sandboxes[0];
        if let Some(name) = sandbox
            .harnesses
            .iter()
            .find_map(|(name, value)| std::ptr::eq(value, selected).then(|| name.clone()))
        {
            return Ok(sandbox.harnesses.get_mut(&name).unwrap());
        }
        sandbox
            .harness
            .as_mut()
            .ok_or_else(|| diagnostic("harness", "Missing harness definition."))
    }

    /// Reopens any valid V1 document. Comments and formatting are not retained.
    pub fn from_yaml(bytes: &[u8]) -> Result<Self, Diagnostics> {
        let document =
            Document::parse(bytes).map_err(|error| diagnostic("document", &error.to_string()))?;
        Self::from_document(document)
    }

    /// Validate the current adapter schema before producing reviewable YAML.
    pub fn review_with(&self, capabilities: &Capabilities) -> Result<Review, Diagnostics> {
        self.validate_settings(capabilities)?;
        self.review()
    }

    /// Produces a validated snapshot for a frontend to render or accept.
    pub fn review(&self) -> Result<Review, Diagnostics> {
        let yaml = self
            .document
            .yaml()
            .map_err(|error| diagnostic("document", &error.to_string()))?;
        Ok(Review {
            authored: AuthoredDocument {
                yaml,
                document: self.document.clone(),
                completion_boundary: CompletionBoundary::GeneratedDesiredState,
            },
        })
    }

    /// Validates all proposed changes before replacing the current guided preset.
    pub fn edit_identity(
        &mut self,
        capabilities: &Capabilities,
        edits: IdentityEdits,
    ) -> Result<(), Diagnostics> {
        let mut candidate = self.guided_answers(capabilities)?;
        if let Some(value) = edits.deployment_name {
            candidate.deployment_name = value;
        }
        if let Some(value) = edits.sandbox_name {
            candidate.sandbox_name = value;
        }
        if let Some(value) = edits.agent_name {
            candidate.agent_name = value;
        }
        self.replace_answers(capabilities, candidate)
    }

    /// Validates all proposed changes before replacing the current guided preset.
    pub fn edit_inference(
        &mut self,
        capabilities: &Capabilities,
        edits: InferenceEdits,
    ) -> Result<(), Diagnostics> {
        let mut candidate = self.guided_answers(capabilities)?;
        if let Some(value) = edits.provider_name {
            candidate.provider_name = value;
        }
        if let Some(value) = edits.endpoint {
            candidate.endpoint = value;
        }
        if let Some(value) = edits.model {
            candidate.model = value;
        }
        if let Some(value) = edits.credential_env {
            candidate.credential_env = value;
        }
        self.replace_answers(capabilities, candidate)
    }
}

fn guided_answers(draft: &Draft, _capabilities: &Capabilities) -> Result<Answers, Diagnostics> {
    let document = draft.document();
    let [sandbox] = document.spec.sandboxes.as_slice() else {
        return Err(diagnostic(
            "document",
            "guided editing requires one onboarding sandbox",
        ));
    };
    let agent = &sandbox.agent;
    let harness = document
        .sandbox_harness(sandbox)
        .map_err(|_| diagnostic("document", "guided editing requires a harness"))?;
    let provider = draft.provider()?;
    let route = draft.route()?;
    let credential_env = provider
        .credential
        .as_ref()
        .map(|credential| credential.env.clone())
        .unwrap_or_default();
    let api = provider
        .api
        .unwrap_or_else(|| nemoclaw_sdk::config::InferenceApi::for_provider(provider.provider));
    let preset = crate::ProviderPreset::ALL
        .into_iter()
        .filter(|preset| preset.profile().kind == provider.provider && preset.apis().contains(&api))
        .max_by_key(|preset| {
            usize::from(preset.profile().endpoint == provider.endpoint) * 4
                + usize::from(preset.profile().custom_endpoint)
        })
        .ok_or_else(|| {
            diagnostic(
                "document",
                "document does not match a guided endpoint preset",
            )
        })?;
    let answers = Answers {
        deployment_name: document.metadata.name.clone(),
        sandbox_name: sandbox.name.clone(),
        agent_name: agent.name.clone(),
        harness: harness.kind.clone(),
        image: sandbox.image.ref_.clone(),
        harness_settings: harness.settings.clone(),
        harness_config: harness.config.clone(),
        runtime: sandbox.runtime.provider,
        engine: document.spec.gateway.as_managed().and_then(|gateway| {
            let preset = if sandbox.runtime.provider == nemoclaw_sdk::config::ComputeDriver::Podman
            {
                "unix:///run/user/1000/podman/podman.sock".to_owned()
            } else {
                "unix:///var/run/docker.sock".to_owned()
            };
            (gateway.engine != preset).then(|| gateway.engine.clone())
        }),
        inference: preset,
        api,
        provider_api: provider.api,
        provider_name: provider.name.clone(),
        endpoint: provider.endpoint.clone(),
        model: route.overrides.model.clone(),
        model_settings: route.overrides.settings.clone(),
        credential_env,
    };
    Ok(answers)
}

/// A validated snapshot for a frontend to render or accept.
#[derive(Debug)]
pub struct Review {
    authored: AuthoredDocument,
}

impl Review {
    pub fn uid(&self) -> &str {
        &self.authored.document.metadata.uid
    }

    pub fn deployment_name(&self) -> &str {
        &self.authored.document.metadata.name
    }

    pub fn credential_references(&self) -> Vec<&str> {
        self.authored.document.credential_names()
    }

    pub fn yaml(&self) -> &str {
        self.authored.yaml()
    }

    pub fn document(&self) -> &Document {
        self.authored.document()
    }

    pub fn into_authored(self) -> AuthoredDocument {
        self.authored
    }
}
