// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// Questions and diagnostics accumulated by one resolution pass.
#[derive(Default)]
pub(super) struct ResolutionWork {
    pub(super) questions: Vec<JourneyQuestion>,
    pub(super) omitted: Vec<String>,
    pub(super) warnings: Vec<String>,
    pub(super) unverified: Vec<String>,
}

impl JourneyState {
    /// Resolve identity, harness, guided SDK field guidance, and top-level adapter
    /// settings. Unasked SDK requirements and conditional Fabric branches remain explicit.
    pub fn resolve(&self, capabilities: &Capabilities) -> Result<JourneyResolution, Diagnostics> {
        self.definition.validate_guidance(capabilities)?;
        for field in &self.definition.omit {
            if field.starts_with('/')
                && sdk_field_schema_for(&self.values, field).is_some_and(|(_, required)| required)
            {
                return Err(diagnostic(
                    "journey",
                    &format!("required SDK field '{field}' cannot be omitted"),
                ));
            }
        }
        let assessment = PartialDocument::from_value(self.values.clone()).assess();
        let mut work = ResolutionWork::default();
        self.collect_sdk_questions(&assessment, &mut work);
        self.collect_inference_questions(&mut work);
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
        let inspect_values = inspect_values.as_ref().unwrap_or(&self.values);
        self.collect_deployment_questions(inspect_values, &mut work)?;
        self.collect_native_questions(
            inspect_values,
            assessment.document(),
            capabilities,
            native_guidance,
            &mut work,
        )?;

        Ok(self.resolution(
            work.questions,
            work.omitted,
            work.warnings,
            work.unverified,
            assessment,
        ))
    }

    pub(super) fn resolution(
        &self,
        mut questions: Vec<JourneyQuestion>,
        mut omitted: Vec<String>,
        warnings: Vec<String>,
        unverified: Vec<String>,
        assessment: PartialAssessment,
    ) -> JourneyResolution {
        for field in &self.definition.omit {
            if field.starts_with('/') && sdk_field_schema_for(&self.values, field).is_some() {
                omitted.push(field.clone());
            }
        }
        questions.retain(|question| !self.definition.omit.contains(question.id()));
        omitted.sort();
        omitted.dedup();
        if self.definition.ask.contains(INFERENCE_PRESET)
            && self.route_provider().is_some()
            && !self
                .selected_route
                .is_some_and(|route| self.accepted_presets.contains(&route))
        {
            let provider = self.provider_path().expect("external provider");
            let model = self.route_model_path().expect("selected route");
            questions.retain(|question| {
                !question.id.starts_with(&format!("{provider}/")) && question.id != model
            });
        } else if self
            .selected_route
            .and_then(|route| self.selected_presets.get(&route))
            .is_some_and(|preset| preset.profile().custom_endpoint)
            && self
                .provider_path()
                .is_some_and(|path| !self.accepted.contains(&format!("{path}/endpoint")))
            && let Some(model) = self.route_model_path()
        {
            questions.retain(|question| question.id != model);
        }
        for question in &mut questions {
            question.reopened_because = self.reopened_by.get(question.id()).cloned();
        }
        questions.sort_by_key(|question| {
            (
                question.id == ROUTE_SELECTION,
                self.definition
                    .ask_order
                    .iter()
                    .position(|id| id == question.id())
                    .unwrap_or(usize::MAX),
            )
        });
        if let (Some(provider), Some(model)) = (self.provider_path(), self.route_model_path()) {
            let api = format!("{provider}/api");
            if let (Some(api_index), Some(model_index)) = (
                questions.iter().position(|question| question.id == api),
                questions.iter().position(|question| question.id == model),
            ) && api_index > model_index
            {
                let api_question = questions.remove(api_index);
                questions.insert(model_index, api_question);
            }
        }
        JourneyResolution {
            questions,
            omitted,
            warnings,
            unverified,
            assessment,
            target_required: !self.definition.target_prerequisites.is_empty(),
            target_assessment: (!self.definition.target_prerequisites.is_empty()).then(|| {
                DiscoveryAssessment {
                    status: CompatibilityStatus::Unverified,
                    reasons: vec![
                        "Target compatibility has not been observed for this desired state.".into(),
                    ],
                    pending: Vec::new(),
                }
            }),
        }
    }
}
