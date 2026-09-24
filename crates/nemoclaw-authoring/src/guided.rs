// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::diagnostics::diagnostic;
use crate::{Answers, Capabilities, Diagnostics, Draft, ProviderPreset, Scenario};
use nemoclaw_sdk::config::{ComputeDriver, HarnessKind, InferenceApi};

/// A field offered by the guided onboarding frontend.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
    choices: Vec<FieldValue>,
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

    /// Whether a frontend may submit a value outside the suggested choices.
    pub fn accepts_custom(&self) -> bool {
        self.accepts_custom
    }
}

impl Draft {
    /// Queries the guided fields from the current desired-state document.
    pub fn guided_fields(
        &self,
        capabilities: &Capabilities,
    ) -> Result<Vec<GuidedField>, Diagnostics> {
        let answers = self.guided_answers(capabilities)?;
        Ok(EditableField::GUIDED
            .into_iter()
            .filter(|field| {
                *field != EditableField::Endpoint
                    || capabilities
                        .scenario(
                            answers.harness,
                            answers.runtime,
                            answers.inference,
                            answers.api,
                        )
                        .is_some_and(Scenario::accepts_custom_endpoint)
            })
            .map(|field| field_state(capabilities, &answers, field))
            .collect())
    }

    /// Applies one guided edit atomically and retains the deployment UID.
    pub fn set_guided_field(
        &mut self,
        capabilities: &Capabilities,
        field: EditableField,
        value: FieldValue,
    ) -> Result<(), Diagnostics> {
        let mut answers = self.guided_answers(capabilities)?;
        set_value(capabilities, &mut answers, field, value, &[])?;
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
        accepts_custom: capabilities
            .scenario(
                answers.harness,
                answers.runtime,
                answers.inference,
                answers.api,
            )
            .is_some_and(|scenario| match field {
                EditableField::Model => scenario.accepts_custom_model(),
                EditableField::Endpoint => scenario.accepts_custom_endpoint(),
                _ => false,
            }),
    }
}

fn current_value(answers: &Answers, field: EditableField) -> FieldValue {
    match field {
        EditableField::Harness => FieldValue::Harness(answers.harness),
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
    let scenarios = matching_scenarios(capabilities, answers, field);
    let values = scenarios.iter().flat_map(|scenario| match field {
        EditableField::Harness => vec![FieldValue::Harness(scenario.harness())],
        EditableField::Runtime => vec![FieldValue::Runtime(scenario.runtime())],
        EditableField::Inference => vec![FieldValue::Inference(scenario.inference())],
        EditableField::Api => vec![FieldValue::Api(scenario.api())],
        EditableField::Model => scenario
            .default_model()
            .map(|model| vec![FieldValue::Model(model.into())])
            .unwrap_or_default(),
        _ => Vec::new(),
    });
    let mut unique = Vec::new();
    for value in values {
        if !unique.contains(&value) {
            unique.push(value);
        }
    }
    unique
}

fn matching_scenarios<'a>(
    capabilities: &'a Capabilities,
    answers: &Answers,
    field: EditableField,
) -> Vec<&'a Scenario> {
    capabilities
        .scenarios()
        .iter()
        .filter(|scenario| {
            (field == EditableField::Harness || scenario.harness() == answers.harness)
                && (matches!(field, EditableField::Harness | EditableField::Runtime)
                    || scenario.runtime() == answers.runtime)
                && (matches!(
                    field,
                    EditableField::Harness | EditableField::Runtime | EditableField::Inference
                ) || scenario.inference() == answers.inference)
                && (field != EditableField::Model || scenario.api() == answers.api)
        })
        .collect()
}

fn set_value(
    capabilities: &Capabilities,
    answers: &mut Answers,
    field: EditableField,
    value: FieldValue,
    accepted: &[EditableField],
) -> Result<(), Diagnostics> {
    if field == EditableField::Model
        && let FieldValue::Model(model) = &value
        && let Some(scenario) = capabilities.scenario(
            answers.harness,
            answers.runtime,
            answers.inference,
            answers.api,
        )
        && scenario.accepts_custom_model()
    {
        answers.model = model.clone();
        return Ok(());
    }
    if field.is_choice() {
        let scenarios = matching_scenarios(capabilities, answers, field);
        let selected = scenarios
            .into_iter()
            .filter(|scenario| match (&field, &value) {
                (EditableField::Harness, FieldValue::Harness(value)) => {
                    scenario.harness() == *value
                }
                (EditableField::Runtime, FieldValue::Runtime(value)) => {
                    scenario.runtime() == *value
                }
                (EditableField::Inference, FieldValue::Inference(value)) => {
                    scenario.inference() == *value
                }
                (EditableField::Api, FieldValue::Api(value)) => scenario.api() == *value,
                (EditableField::Model, FieldValue::Model(value)) => {
                    scenario.default_model() == Some(value.as_str())
                }
                _ => false,
            })
            .max_by_key(|scenario| {
                let candidate = scenario_answers(answers, scenario, field, &value);
                let preserved = accepted
                    .iter()
                    .filter(|other| {
                        **other != field
                            && current_value(answers, **other) == current_value(&candidate, **other)
                    })
                    .count();
                (preserved, compatibility_score(scenario, answers, field))
            });
        let Some(scenario) = selected else {
            return Err(diagnostic(
                field.diagnostic_name(),
                "value is not available for the current guided choices",
            ));
        };
        *answers = scenario_answers(answers, scenario, field, &value);
        return Ok(());
    }

    let FieldValue::Text(value) = value else {
        return Err(diagnostic(
            field.diagnostic_name(),
            "value has the wrong type for this field",
        ));
    };
    match field {
        EditableField::DeploymentName => answers.deployment_name = value,
        EditableField::SandboxName => answers.sandbox_name = value,
        EditableField::AgentName => answers.agent_name = value,
        EditableField::ProviderName => answers.provider_name = value,
        EditableField::Endpoint => answers.endpoint = value,
        EditableField::CredentialEnv => answers.credential_env = value,
        _ => unreachable!("choice fields returned above"),
    }
    Ok(())
}

fn compatibility_score(scenario: &Scenario, answers: &Answers, changed: EditableField) -> u8 {
    [
        (
            EditableField::Harness,
            scenario.harness() == answers.harness,
        ),
        (
            EditableField::Runtime,
            scenario.runtime() == answers.runtime,
        ),
        (
            EditableField::Inference,
            scenario.inference() == answers.inference,
        ),
        (EditableField::Api, scenario.api() == answers.api),
    ]
    .into_iter()
    .filter(|(field, matches)| *field != changed && *matches)
    .count() as u8
}

fn scenario_answers(
    answers: &Answers,
    scenario: &Scenario,
    field: EditableField,
    value: &FieldValue,
) -> Answers {
    let mut candidate = answers.clone().for_scenario(scenario);
    // Keep custom identifiers within a provider. When switching providers, use
    // its suggestion when available; the model question confirms the selection.
    if scenario.inference() == answers.inference
        && (scenario.default_model() == Some(answers.model.as_str())
            || (scenario.accepts_custom_model() && !answers.model.is_empty()))
    {
        candidate.model = answers.model.clone();
    }
    if scenario.accepts_custom_endpoint() && scenario.inference() == answers.inference {
        candidate.endpoint = answers.endpoint.clone();
    }
    if field == EditableField::Model
        && let FieldValue::Model(model) = value
    {
        candidate.model = model.clone();
    }
    candidate
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
        self.accepted.contains(&field)
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
        set_value(capabilities, &mut after, field, value, &self.accepted)?;
        let conflicts: Vec<_> = self
            .accepted
            .iter()
            .copied()
            .filter(|other| *other != field)
            .filter_map(|other| {
                let old = current_value(&before, other);
                let new = current_value(&after, other);
                // A model identifier must be reconfirmed when its interpretation changes.
                let needs_confirmation = other == EditableField::Model
                    && EditableField::GUIDED.iter().any(|dependency| {
                        crate::DependencyGraph.depends_on(other, *dependency)
                            && current_value(&before, *dependency)
                                != current_value(&after, *dependency)
                    });
                (old != new || needs_confirmation).then_some(AnswerChange {
                    field: other,
                    before: old,
                    after: new,
                })
            })
            .collect();
        let mut draft = self.clone();
        draft.replace_answers(capabilities, after)?;
        draft.accepted = self
            .accepted
            .iter()
            .copied()
            .filter(|other| {
                *other != field && !conflicts.iter().any(|change| change.field == *other)
            })
            .collect();
        draft.accepted.push(field);
        draft.delegated = self
            .delegated
            .iter()
            .copied()
            .filter(|other| *other != field && draft.accepted.contains(other))
            .collect();
        Ok(GuidedEdit { draft, conflicts })
    }
}
