// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::diagnostics::diagnostic;
use crate::{
    Answers, ApiChoice, Capabilities, Diagnostics, HarnessChoice, InferenceChoice, RuntimeChoice,
    Session,
};
use nemoclaw_sdk::config::{ComputeDriver, Document, HarnessKind, InferenceApi};

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
    pub model: Option<String>,
    pub credential_env: Option<String>,
}

/// Editable answers with a stable deployment identity.
/// Edit methods change names, model, and credential references, not scenario choices.
#[derive(Clone, Debug)]
pub struct Draft {
    session: Session,
    pub(crate) answers: Answers,
}

impl Draft {
    /// Creates a draft; call `review` to validate its initial answers.
    pub fn new(session: Session, answers: Answers) -> Self {
        Self { session, answers }
    }

    /// Reopens a document only if this authoring model reproduces its semantics.
    /// Comments and formatting are not retained; unsupported customizations fail.
    pub fn from_yaml(capabilities: &Capabilities, bytes: &[u8]) -> Result<Self, Diagnostics> {
        let document =
            Document::parse(bytes).map_err(|error| diagnostic("document", &error.to_string()))?;
        let [sandbox] = document.spec.sandboxes.as_slice() else {
            return Err(diagnostic(
                "document",
                "editing requires one generated onboarding sandbox",
            ));
        };
        let agent = &sandbox.agent;
        let harness = match document.sandbox_harness(sandbox).map(|value| value.kind) {
            Ok(HarnessKind::OpenClaw) => HarnessChoice::OpenClaw,
            Ok(HarnessKind::Hermes) => HarnessChoice::Hermes,
            _ => {
                return Err(diagnostic(
                    "document",
                    "editing requires a supported harness",
                ));
            }
        };
        if sandbox.runtime.provider != ComputeDriver::Docker {
            return Err(diagnostic(
                "document",
                "editing requires the Docker runtime",
            ));
        }
        let provider = document
            .inference_provider()
            .map_err(|_| diagnostic("document", "editing requires one selected provider"))?;
        let inference = document
            .sandbox_inference(sandbox)
            .map_err(|_| diagnostic("document", "editing requires inline agent inference"))?;
        let [route] = inference.routes.as_slice() else {
            return Err(diagnostic(
                "document",
                "editing requires one generated model route",
            ));
        };
        let credential_env = provider
            .credential
            .as_ref()
            .ok_or_else(|| diagnostic("document", "editing requires a credential reference"))?
            .env
            .clone();
        let api = match provider.api.unwrap_or_else(|| {
            InferenceApi::for_harness(match harness {
                HarnessChoice::OpenClaw => HarnessKind::OpenClaw,
                HarnessChoice::Hermes => HarnessKind::Hermes,
            })
        }) {
            InferenceApi::OpenaiCompletions => ApiChoice::OpenAiCompletions,
            InferenceApi::OpenaiResponses => ApiChoice::OpenAiResponses,
            InferenceApi::AnthropicMessages => {
                return Err(diagnostic(
                    "document",
                    "editing requires a supported inference API",
                ));
            }
        };
        let answers = Answers {
            deployment_name: document.metadata.name.clone(),
            sandbox_name: sandbox.name.clone(),
            agent_name: agent.name.clone(),
            harness,
            runtime: RuntimeChoice::Docker,
            inference: InferenceChoice::NvidiaHosted,
            api,
            provider_name: provider.name.clone(),
            model: route.overrides.model.clone(),
            credential_env,
        };
        let draft = Self::new(Session::with_uid(&document.metadata.uid)?, answers);
        if draft.review(capabilities)?.document() != &document {
            return Err(diagnostic(
                "document",
                "editing supports only YAML generated by this onboarding scenario",
            ));
        }
        Ok(draft)
    }

    pub fn review(&self, capabilities: &Capabilities) -> Result<Review, Diagnostics> {
        Ok(Review {
            authored: self.session.project(capabilities, &self.answers)?,
        })
    }

    /// Validates all proposed changes before replacing the current answers.
    pub fn edit_identity(
        &mut self,
        capabilities: &Capabilities,
        edits: IdentityEdits,
    ) -> Result<(), Diagnostics> {
        let mut candidate = self.answers.clone();
        if let Some(value) = edits.deployment_name {
            candidate.deployment_name = value;
        }
        if let Some(value) = edits.sandbox_name {
            candidate.sandbox_name = value;
        }
        if let Some(value) = edits.agent_name {
            candidate.agent_name = value;
        }
        self.session.project(capabilities, &candidate)?;
        self.answers = candidate;
        Ok(())
    }

    /// Validates all proposed changes before replacing the current answers.
    pub fn edit_inference(
        &mut self,
        capabilities: &Capabilities,
        edits: InferenceEdits,
    ) -> Result<(), Diagnostics> {
        let mut candidate = self.answers.clone();
        if let Some(value) = edits.provider_name {
            candidate.provider_name = value;
        }
        if let Some(value) = edits.model {
            candidate.model = value;
        }
        if let Some(value) = edits.credential_env {
            candidate.credential_env = value;
        }
        self.session.project(capabilities, &candidate)?;
        self.answers = candidate;
        Ok(())
    }
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

    pub fn sandbox_name(&self) -> &str {
        &self.authored.document.spec.sandboxes[0].name
    }

    pub fn agent_name(&self) -> &str {
        &self.authored.document.spec.sandboxes[0].agent.name
    }

    pub fn provider_name(&self) -> &str {
        &self.authored.document.spec.inference_providers[0].name
    }

    pub fn model(&self) -> &str {
        &self.authored.document.spec.sandboxes[0]
            .agent
            .inference
            .as_ref()
            .expect("generated review has inline inference")
            .routes[0]
            .overrides
            .model
    }

    pub fn credential_env(&self) -> &str {
        self.authored.document.spec.inference_providers[0]
            .credential
            .as_ref()
            .expect("generated review has a credential reference")
            .env
            .as_str()
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

    pub fn harness_kind(&self) -> HarnessKind {
        let sandbox = &self.authored.document.spec.sandboxes[0];
        self.authored
            .document
            .sandbox_harness(sandbox)
            .expect("generated review has a harness")
            .kind
    }

    pub fn api(&self) -> InferenceApi {
        self.authored.document.spec.inference_providers[0]
            .api
            .unwrap_or_else(|| InferenceApi::for_harness(self.harness_kind()))
    }

    pub fn into_authored(self) -> AuthoredDocument {
        self.authored
    }
}
