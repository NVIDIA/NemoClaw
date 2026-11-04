// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Prompt dependencies and presentation order for one resolution pass.

use super::*;

/// Collectors discover candidates from schemas. This policy owns which candidates
/// may be presented together and how guided inference decisions constrain them.
pub(super) struct QuestionPolicy<'a> {
    definition: &'a JourneyDefinition,
    decisions: &'a DecisionRecord,
    provider: Option<String>,
    model: Option<String>,
    preset: Option<ProviderPreset>,
    preset_pending: bool,
    endpoint_pending: Option<String>,
}

impl<'a> QuestionPolicy<'a> {
    pub(super) fn new(resolver: &QuestionResolver<'a>) -> Self {
        let provider = resolver.provider_path();
        let preset_pending = resolver.definition.ask.contains(INFERENCE_PRESET)
            && provider.is_some()
            && !resolver
                .position
                .selected_route
                .is_some_and(|route| resolver.decisions.accepted_presets.contains(&route));
        let endpoint_pending = resolver
            .position
            .selected_route
            .and_then(|route| resolver.decisions.selected_presets.get(&route))
            .filter(|preset| preset.profile().custom_endpoint)
            .and(provider.as_ref())
            .map(|path| format!("{path}/endpoint"))
            .filter(|path| !resolver.decisions.accepted.contains(path));
        Self {
            definition: resolver.definition,
            decisions: resolver.decisions,
            provider,
            model: resolver.route_model_path(),
            preset: resolver.current_preset(),
            preset_pending,
            endpoint_pending,
        }
    }

    pub(super) fn preset_pending(&self) -> bool {
        self.preset_pending
    }

    pub(super) fn endpoint_pending(&self) -> Option<&str> {
        self.endpoint_pending.as_deref()
    }

    /// Exact selectors and scope selectors share the same provider API choices.
    pub(super) fn sdk_schema(&self, path: &str, mut schema: Value) -> Value {
        if self
            .provider
            .as_ref()
            .is_some_and(|provider| path == format!("{provider}/api"))
            && let Some(preset) = self.preset
        {
            schema["enum"] = Value::Array(
                preset
                    .apis()
                    .iter()
                    .map(|api| serde_json::to_value(api).expect("SDK API serializes"))
                    .collect(),
            );
        }
        schema
    }

    fn is_current_model(&self, target: &QuestionTarget) -> bool {
        matches!(target, QuestionTarget::SdkField { path, .. } if self.model.as_ref() == Some(path))
    }

    fn is_current_api(&self, target: &QuestionTarget) -> bool {
        matches!(target, QuestionTarget::SdkField { path, role: SdkFieldRole::ProviderApi }
            if self.provider.as_ref().is_some_and(|provider| path == &format!("{provider}/api")))
    }

    fn allows(&self, target: &QuestionTarget, model_pending: bool) -> bool {
        if matches!(target, QuestionTarget::RouteSelection { .. }) && model_pending {
            return false;
        }
        if self.preset_pending {
            if let QuestionTarget::SdkField { path, .. } = target
                && self
                    .provider
                    .as_ref()
                    .is_some_and(|provider| path.starts_with(&format!("{provider}/")))
            {
                return false;
            }
            if self.is_current_model(target) {
                return false;
            }
        }
        self.endpoint_pending.is_none() || !self.is_current_model(target)
    }

    pub(super) fn apply(&self, values: &Value, work: &mut ResolutionWork) {
        let model_pending = work
            .questions
            .iter()
            .any(|question| self.is_current_model(&question.target));
        // Omission keeps a valid supplied value and leaves an absent optional
        // one unset; it cannot answer a missing requirement or an invalid value.
        let omits = |question: &JourneyQuestion| {
            self.definition.omit.contains(question.id())
                && question.reason != JourneyQuestionReason::InvalidSupplied
                && !(question.required && question.reason == JourneyQuestionReason::Missing)
        };
        let base = self.definition.base.supplied();
        for field in self
            .definition
            .omit
            .iter()
            .filter(|field| field.starts_with('/'))
        {
            match values.pointer(field) {
                None if sdk_field_schema_for(values, field)
                    .is_some_and(|(_, required)| !required) =>
                {
                    work.omitted.push(field.clone());
                }
                // A question omission does not remove, such as an invalid
                // value, is still asked even when another gate holds it back.
                Some(value)
                    if !work
                        .questions
                        .iter()
                        .any(|question| question.id() == field && !omits(question)) =>
                {
                    keep_supplied(
                        &mut work.kept,
                        field.clone(),
                        value,
                        base.pointer(field),
                        self.decisions.accepted.contains(field),
                    );
                }
                _ => {}
            }
        }
        work.questions
            .retain(|question| !omits(question) && self.allows(&question.target, model_pending));
        work.omitted.sort();
        work.omitted.dedup();
        for question in &mut work.questions {
            question.reopened_because = match &question.target {
                QuestionTarget::ModelSetting { route, .. } => self
                    .decisions
                    .reopened_model_settings
                    .get(&(*route, question.id().to_owned())),
                _ => self.decisions.reopened_by.get(question.id()),
            }
            .cloned();
        }
        work.questions.sort_by_key(|question| {
            (
                matches!(question.target, QuestionTarget::RouteSelection { .. }),
                self.definition
                    .ask_order
                    .iter()
                    .position(|id| id == question.id())
                    .unwrap_or(usize::MAX),
            )
        });
        // Preserve authored order for independent questions. The current API
        // must precede its model even when guidance lists the model first.
        if let (Some(api), Some(model)) = (
            work.questions
                .iter()
                .position(|q| self.is_current_api(&q.target)),
            work.questions
                .iter()
                .position(|q| self.is_current_model(&q.target)),
        ) && api > model
        {
            let question = work.questions.remove(api);
            work.questions.insert(model, question);
        }
        // Keep exact guidance order among independent questions, but a setting
        // must follow its condition's inputs even when guidance names it first.
        let mut pending = std::mem::take(&mut work.questions);
        while !pending.is_empty() {
            let next = pending
                .iter()
                .position(|question| {
                    work.setting_dependencies.iter().all(|(before, after)| {
                        after != question.id()
                            || !pending.iter().any(|candidate| candidate.id() == before)
                    })
                })
                .expect("schema traversal produces acyclic setting dependencies");
            work.questions.push(pending.remove(next));
        }
    }
}
