// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::diagnostics::diagnostic;
use crate::{Answers, Capabilities, Diagnostics, Draft, ProviderPreset};
use nemoclaw_sdk::config::{ComputeDriver, HarnessKind, InferenceApi};

/// A field offered by the guided onboarding frontend.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum EditableField {
    Harness,
    Runtime,
    Inference,
    Api,
    DeploymentName,
    SandboxName,
    AgentName,
    ProviderName,
    Endpoint,
    Model,
    CredentialEnv,
}

impl EditableField {
    pub const GUIDED: [Self; 7] = [
        Self::Harness,
        Self::Runtime,
        Self::Inference,
        Self::Api,
        Self::DeploymentName,
        Self::Endpoint,
        Self::Model,
    ];

    pub const fn is_choice(self) -> bool {
        matches!(
            self,
            Self::Harness | Self::Runtime | Self::Inference | Self::Api | Self::Model
        )
    }

    const fn diagnostic_name(self) -> &'static str {
        match self {
            Self::Harness => "harness",
            Self::Runtime => "runtime",
            Self::Inference => "inference",
            Self::Api => "api",
            Self::DeploymentName => "deployment-name",
            Self::SandboxName => "sandbox-name",
            Self::AgentName => "agent-name",
            Self::ProviderName => "provider-name",
            Self::Endpoint => "endpoint",
            Self::Model => "model",
            Self::CredentialEnv => "credential-env",
        }
    }
}

/// A typed value exposed to a guided frontend.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FieldValue {
    Harness(HarnessKind),
    Runtime(ComputeDriver),
    Inference(ProviderPreset),
    Api(InferenceApi),
    Text(String),
    Model(String),
}

/// Current value and compatible choices for one guided field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuidedField {
    id: EditableField,
    value: FieldValue,
    pub(crate) choices: Vec<FieldValue>,
    accepts_custom: bool,
}

impl GuidedField {
    pub fn id(&self) -> EditableField {
        self.id
    }

    pub fn value(&self) -> &FieldValue {
        &self.value
    }

    pub fn choices(&self) -> &[FieldValue] {
        &self.choices
    }
    pub fn is_choice(&self) -> bool {
        self.id.is_choice()
    }
    pub fn accepts_custom(&self) -> bool {
        self.accepts_custom
    }
}

impl Draft {
    pub fn guided_fields(
        &self,
        capabilities: &Capabilities,
    ) -> Result<Vec<GuidedField>, Diagnostics> {
        let answers = self.guided_answers(capabilities)?;
        Ok(EditableField::GUIDED
            .into_iter()
            .filter(|field| {
                *field != EditableField::Endpoint || answers.inference.profile().custom_endpoint
            })
            .map(|field| field_state(capabilities, &answers, field))
            .collect())
    }

    fn resolve_endpoint_credential(
        &self,
        capabilities: &Capabilities,
        field: EditableField,
        answers: &mut Answers,
    ) -> Result<(), Diagnostics> {
        if field != EditableField::Endpoint || answers.credential_env.is_empty() {
            return Ok(());
        }
        let session = crate::Session::with_uid(&self.document().metadata.uid)?;
        if session.project(capabilities, answers).is_err() {
            let mut anonymous = answers.clone();
            anonymous.credential_env.clear();
            // The SDK's actual schema determines whether this endpoint permits
            // credential binding. Do not maintain another endpoint rule here.
            if session.project(capabilities, &anonymous).is_ok() {
                *answers = anonymous;
            }
        }
        Ok(())
    }

    pub fn set_guided_field(
        &mut self,
        capabilities: &Capabilities,
        field: EditableField,
        value: FieldValue,
    ) -> Result<(), Diagnostics> {
        let mut answers = self.guided_answers(capabilities)?;
        set_value(capabilities, &mut answers, field, value)?;
        self.resolve_endpoint_credential(capabilities, field, &mut answers)?;
        self.replace_answers(capabilities, answers)
    }
}

fn field_state(
    capabilities: &Capabilities,
    answers: &Answers,
    field: EditableField,
) -> GuidedField {
    GuidedField {
        id: field,
        value: current_value(answers, field),
        choices: choices(capabilities, answers, field),
        accepts_custom: field == EditableField::Model
            || (field == EditableField::Endpoint && answers.inference.profile().custom_endpoint),
    }
}

fn current_value(answers: &Answers, field: EditableField) -> FieldValue {
    match field {
        EditableField::Harness => FieldValue::Harness(answers.harness.clone()),
        EditableField::Runtime => FieldValue::Runtime(answers.runtime),
        EditableField::Inference => FieldValue::Inference(answers.inference),
        EditableField::Api => FieldValue::Api(answers.api),
        EditableField::DeploymentName => FieldValue::Text(answers.deployment_name.clone()),
        EditableField::SandboxName => FieldValue::Text(answers.sandbox_name.clone()),
        EditableField::AgentName => FieldValue::Text(answers.agent_name.clone()),
        EditableField::ProviderName => FieldValue::Text(answers.provider_name.clone()),
        EditableField::Endpoint => FieldValue::Text(answers.endpoint.clone()),
        EditableField::Model => FieldValue::Model(answers.model.clone()),
        EditableField::CredentialEnv => FieldValue::Text(answers.credential_env.clone()),
    }
}

fn choices(
    capabilities: &Capabilities,
    answers: &Answers,
    field: EditableField,
) -> Vec<FieldValue> {
    match field {
        EditableField::Harness => {
            let mut harnesses = capabilities.harnesses().to_vec();
            if !harnesses.contains(&answers.harness) {
                harnesses.push(answers.harness.clone());
            }
            harnesses.into_iter().map(FieldValue::Harness).collect()
        }
        EditableField::Runtime => [ComputeDriver::Docker, ComputeDriver::Podman]
            .into_iter()
            .map(FieldValue::Runtime)
            .collect(),
        EditableField::Inference => ProviderPreset::ALL
            .into_iter()
            .map(FieldValue::Inference)
            .collect(),
        EditableField::Api => answers
            .inference
            .apis()
            .iter()
            .copied()
            .map(FieldValue::Api)
            .collect(),
        EditableField::Model => answers
            .inference
            .profile()
            .default_model
            .into_iter()
            .map(|model| FieldValue::Model(model.into()))
            .collect(),
        _ => Vec::new(),
    }
}

fn set_value(
    capabilities: &Capabilities,
    answers: &mut Answers,
    field: EditableField,
    value: FieldValue,
) -> Result<(), Diagnostics> {
    let state = field_state(capabilities, answers, field);
    if state.is_choice() && !state.accepts_custom() && !state.choices().contains(&value) {
        return Err(diagnostic(
            field.diagnostic_name(),
            "value is not available for the current guided choices",
        ));
    }
    match (field, value) {
        (EditableField::Harness, FieldValue::Harness(value)) => {
            if answers.harness != value {
                answers.harness_settings = None;
            }
            answers.harness = value;
        }
        (EditableField::Runtime, FieldValue::Runtime(value)) => answers.runtime = value,
        (EditableField::Inference, FieldValue::Inference(value)) => {
            if answers.inference != value {
                *answers = answers.clone().for_provider(value);
            }
        }
        (EditableField::Api, FieldValue::Api(value)) => {
            answers.api = value;
            answers.provider_api = Some(value);
        }
        (EditableField::Model, FieldValue::Model(value)) => answers.model = value,
        (EditableField::DeploymentName, FieldValue::Text(value)) => answers.deployment_name = value,
        (EditableField::SandboxName, FieldValue::Text(value)) => answers.sandbox_name = value,
        (EditableField::AgentName, FieldValue::Text(value)) => answers.agent_name = value,
        (EditableField::ProviderName, FieldValue::Text(value)) => answers.provider_name = value,
        (EditableField::Endpoint, FieldValue::Text(value)) => answers.endpoint = value,
        (EditableField::CredentialEnv, FieldValue::Text(value)) => answers.credential_env = value,
        _ => {
            return Err(diagnostic(
                field.diagnostic_name(),
                "value has the wrong type for this field",
            ));
        }
    }
    Ok(())
}

/// An accepted answer affected by a proposed edit. Nothing is committed yet.
#[derive(Clone, Debug)]
pub struct AnswerChange {
    pub field: EditableField,
    pub before: FieldValue,
    pub after: FieldValue,
}

/// A validated edit that a frontend must present before replacing accepted answers.
#[derive(Clone, Debug)]
pub struct GuidedEdit {
    draft: Draft,
    conflicts: Vec<AnswerChange>,
}

impl GuidedEdit {
    pub fn conflicts(&self) -> &[AnswerChange] {
        &self.conflicts
    }

    /// Commit after the user accepts any conflicts. Affected answers become suggestions again.
    pub fn accept(self) -> Draft {
        self.draft
    }
}

impl Draft {
    pub fn is_accepted(&self, field: EditableField) -> bool {
        self.decisions.contains_key(&field)
    }

    /// Prepare an answer without changing this draft or silently revising accepted answers.
    pub fn propose_guided_edit(
        &self,
        capabilities: &Capabilities,
        field: EditableField,
        value: FieldValue,
    ) -> Result<GuidedEdit, Diagnostics> {
        let before = self.guided_answers(capabilities)?;
        let mut after = before.clone();
        set_value(capabilities, &mut after, field, value)?;
        self.resolve_endpoint_credential(capabilities, field, &mut after)?;
        let conflicts: Vec<_> = self
            .decisions
            .keys()
            .copied()
            .filter(|other| *other != field)
            .filter_map(|other| {
                let old = current_value(&before, other);
                let new = current_value(&after, other);
                // A model identifier must be reconfirmed when its interpretation changes.
                let delegated = self.answer_status(other) == crate::AnswerStatus::Delegated;
                let needs_confirmation = ((other == EditableField::Model || delegated)
                    && EditableField::GUIDED.iter().any(|dependency| {
                        crate::DependencyGraph.depends_on(other, *dependency)
                            && current_value(&before, *dependency)
                                != current_value(&after, *dependency)
                    }))
                    // A new engine invalidates the evidence used for delegated
                    // settings, even if their suggested strings stay the same.
                    || (delegated && other != EditableField::DeploymentName
                        && before.runtime != after.runtime);
                (old != new || needs_confirmation).then_some(AnswerChange {
                    field: other,
                    before: old,
                    after: new,
                })
            })
            .collect();
        let mut draft = self.clone();
        draft.replace_answers(capabilities, after)?;
        draft.decisions = self.decisions.clone();
        draft.decisions.retain(|other, _| {
            *other != field && !conflicts.iter().any(|change| change.field == *other)
        });
        draft.decisions.insert(field, crate::AnswerStatus::Accepted);
        Ok(GuidedEdit { draft, conflicts })
    }
}

impl Capabilities {
    /// Whether current discovery offers a menu value. This does not assert
    /// compatibility with the adapter's complete configuration.
    pub fn offers(&self, answers: &Answers, field: EditableField, value: &FieldValue) -> bool {
        if let (EditableField::Harness, FieldValue::Harness(harness)) = (field, value) {
            return self.harnesses().contains(harness);
        }
        let state = field_state(self, answers, field);
        state.accepts_custom() || !state.is_choice() || state.choices().contains(value)
    }
}
