// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::diagnostics::diagnostic;
use crate::{Answers, Capabilities, Diagnostics, Session};
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
    document: Document,
    pub(crate) accepted: Vec<crate::EditableField>,
    pub(crate) delegated: Vec<crate::EditableField>,
}

impl Draft {
    /// Starts a draft from a validated document.
    pub fn from_document(document: Document) -> Result<Self, Diagnostics> {
        document
            .validate()
            .map_err(|error| diagnostic("document", &error.to_string()))?;
        Ok(Self {
            document,
            accepted: Vec::new(),
            delegated: Vec::new(),
        })
    }

    /// Returns the complete desired state owned by this draft.
    pub fn document(&self) -> &Document {
        &self.document
    }

    /// Returns the guided-onboarding view when this document matches a preset.
    pub fn guided_answers(&self, capabilities: &Capabilities) -> Result<Answers, Diagnostics> {
        guided_answers(&self.document, capabilities)
    }

    /// Replaces the guided preset while retaining the deployment UID.
    pub fn replace_answers(
        &mut self,
        capabilities: &Capabilities,
        answers: Answers,
    ) -> Result<(), Diagnostics> {
        let authored =
            Session::with_uid(&self.document.metadata.uid)?.project(capabilities, &answers)?;
        self.document = authored.document;
        self.accepted.clear();
        self.delegated.clear();
        Ok(())
    }

    /// Reopens any valid V1 document. Comments and formatting are not retained.
    pub fn from_yaml(bytes: &[u8]) -> Result<Self, Diagnostics> {
        let document =
            Document::parse(bytes).map_err(|error| diagnostic("document", &error.to_string()))?;
        Self::from_document(document)
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

fn guided_answers(
    document: &Document,
    capabilities: &Capabilities,
) -> Result<Answers, Diagnostics> {
    if !document.spec.services.is_empty() {
        return Err(diagnostic(
            "document",
            "guided onboarding does not support managed inference services yet; use a hosted-endpoint template or edit this YAML directly. No hardware check was performed",
        ));
    }
    let [sandbox] = document.spec.sandboxes.as_slice() else {
        return Err(diagnostic(
            "document",
            "guided editing requires one onboarding sandbox",
        ));
    };
    let agent = &sandbox.agent;
    let harness = document
        .sandbox_harness(sandbox)
        .map_err(|_| diagnostic("document", "guided editing requires a supported harness"))?
        .kind;
    let provider = document
        .inference_provider()
        .map_err(|_| diagnostic("document", "guided editing requires one selected provider"))?;
    let inference = document
        .sandbox_inference(sandbox)
        .map_err(|_| diagnostic("document", "guided editing requires inline agent inference"))?;
    let [route] = inference.routes.as_slice() else {
        return Err(diagnostic(
            "document",
            "guided editing requires one model route",
        ));
    };
    let credential_env = provider
        .credential
        .as_ref()
        .ok_or_else(|| diagnostic("document", "guided editing requires a credential reference"))?
        .env
        .clone();
    let Some(scenario) = capabilities.scenarios().iter().find(|scenario| {
        scenario.harness == harness
            && scenario.runtime == sandbox.runtime.provider
            && scenario.provider_kind == provider.provider
            && scenario.provider_api == provider.api
            && scenario.provider_name == provider.name
            && scenario.credential_env == credential_env
            && (scenario.custom_endpoint || scenario.endpoint == provider.endpoint)
            && (scenario.default_model == Some(route.overrides.model.as_str())
                || scenario.custom_model)
    }) else {
        return Err(diagnostic(
            "document",
            "document does not match a guided onboarding preset",
        ));
    };
    let answers = Answers {
        deployment_name: document.metadata.name.clone(),
        sandbox_name: sandbox.name.clone(),
        agent_name: agent.name.clone(),
        harness,
        runtime: sandbox.runtime.provider,
        inference: scenario.inference,
        api: scenario.api,
        provider_name: provider.name.clone(),
        endpoint: provider.endpoint.clone(),
        model: route.overrides.model.clone(),
        credential_env,
    };
    let projected = Session::with_uid(&document.metadata.uid)?.project(capabilities, &answers)?;
    if projected.document() != document {
        return Err(diagnostic(
            "document",
            "guided editing is unavailable because this document contains additional V1 configuration",
        ));
    }
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
