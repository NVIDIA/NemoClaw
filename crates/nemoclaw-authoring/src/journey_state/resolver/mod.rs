// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use schema_questions::collect_required_leaf_questions;

mod adapter_questions;
mod deployment_questions;
mod inference_questions;
mod native_questions;
mod policy;
mod schema_questions;
mod sdk_questions;

use policy::QuestionPolicy;

/// Questions and diagnostics accumulated by one resolution pass.
#[derive(Default)]
pub(super) struct ResolutionWork {
    pub(super) questions: Vec<JourneyQuestion>,
    pub(super) omitted: Vec<String>,
    pub(super) warnings: Vec<String>,
    pub(super) unverified: Vec<String>,
}

/// Pure interpretation of one session snapshot against a catalog snapshot.
/// It cannot accept answers or mutate authored values.
pub(super) struct QuestionResolver<'a> {
    pub(super) definition: &'a JourneyDefinition,
    pub(super) authored: &'a AuthoredValues,
    pub(super) decisions: &'a DecisionRecord,
    pub(super) position: &'a JourneyPosition,
    capabilities: &'a Capabilities,
}

impl<'a> QuestionResolver<'a> {
    pub(super) fn new(state: &'a JourneyState, capabilities: &'a Capabilities) -> Self {
        Self {
            definition: &state.definition,
            authored: &state.authored,
            decisions: &state.decisions,
            position: &state.position,
            capabilities,
        }
    }

    pub(super) fn resolve(&self) -> Result<JourneyResolution, Diagnostics> {
        let capabilities = self.capabilities;
        self.definition.validate_guidance(capabilities)?;
        for field in &self.definition.omit {
            if field.starts_with('/')
                && sdk_field_schema_for(&self.authored.values, field)
                    .is_some_and(|(_, required)| required)
            {
                return Err(diagnostic(
                    "journey",
                    &format!("required SDK field '{field}' cannot be omitted"),
                ));
            }
        }
        let assessment = PartialDocument::from_value(self.authored.values.clone()).assess();
        let mut work = ResolutionWork::default();
        let policy = QuestionPolicy::new(self);
        self.collect_sdk_questions(&assessment, &policy, &mut work);
        self.collect_inference_questions(&policy, &mut work);
        self.collect_adapter_questions(capabilities, &mut work)?;
        let native_guidance = self
            .definition
            .ask_scopes
            .contains(&JourneyScope::NativeSettings)
            || self.definition.ask.iter().any(|field| native_field(field))
            || self.definition.omit.iter().any(|field| native_field(field));
        let inspect_values = assessment
            .document()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|_| diagnostic("journey", "Cannot read deployment configuration."))?;
        let inspect_values = inspect_values.as_ref().unwrap_or(&self.authored.values);
        self.collect_deployment_questions(inspect_values, &mut work)?;
        self.collect_native_questions(
            inspect_values,
            assessment.document(),
            capabilities,
            native_guidance,
            &mut work,
        )?;

        policy.apply(&self.authored.values, &mut work);
        Ok(self.resolution(work, assessment))
    }

    fn resolution(&self, work: ResolutionWork, assessment: PartialAssessment) -> JourneyResolution {
        JourneyResolution {
            questions: work.questions,
            omitted: work.omitted,
            warnings: work.warnings,
            unverified: work.unverified,
            assessment,
            target_required: !self.definition.target_prerequisites.is_empty(),
            target_assessment: (!self.definition.target_prerequisites.is_empty()).then(|| {
                DiscoveryAssessment {
                    status: CompatibilityStatus::Unverified,
                    reasons: vec![
                        "Target compatibility has not been observed for this desired state.".into(),
                    ],
                }
            }),
        }
    }
}
