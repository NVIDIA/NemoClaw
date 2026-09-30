// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl JourneyState {
    /// Accept or omit an active answer. Previously accepted fields may be
    /// revisited; invalid answers leave the state unchanged.
    pub fn answer(
        &mut self,
        capabilities: &Capabilities,
        id: &str,
        value: Option<Value>,
    ) -> Result<(), Diagnostics> {
        let resolution = self.resolve(capabilities)?;
        let question = if let Some(question) = resolution.question(id) {
            question.clone()
        } else if matches!(
            self.decision_status(id),
            DecisionStatus::Accepted | DecisionStatus::Omitted
        ) {
            self.revisitable_question(capabilities, id)?
        } else {
            return Err(diagnostic("journey", "This question is not active."));
        };
        if value.is_none() && question.required {
            return Err(diagnostic("journey", "This question is required."));
        }
        if question.target == QuestionTarget::Harness && question.choices.is_empty() {
            return Err(diagnostic(
                "journey",
                "No harness choices are advertised by the current Fabric catalog.",
            ));
        }
        if let Some(value) = &value
            && !question.choices.is_empty()
            && !question.choices.contains(value)
            && !question.allows_custom_answer()
        {
            return Err(diagnostic(
                "journey",
                "The answer is not an advertised choice.",
            ));
        }
        if let Some(value) = &value
            && schema_accepts(&question.schema, value) != Some(true)
        {
            return Err(diagnostic(
                "journey",
                "The answer does not satisfy its field schema.",
            ));
        }
        if matches!(
            question.target,
            QuestionTarget::SdkField {
                role: SdkFieldRole::ProviderEndpoint,
                ..
            }
        ) && let Some(endpoint) = value.as_ref().and_then(Value::as_str)
        {
            nemoclaw_sdk::config::validate_endpoint(endpoint, false)
                .map_err(|error| diagnostic("journey", &error.to_string()))?;
        }
        let mut candidate = self.clone();
        let omitted = value.is_none();
        match &question.target {
            QuestionTarget::DeploymentName => {
                candidate.authored.put_name(value.expect("required"))?;
                if PartialDocument::from_value(candidate.authored.values.clone())
                    .assess()
                    .issues()
                    .iter()
                    .any(|issue| issue.path() == NAME && issue.kind() == PartialIssueKind::Invalid)
                {
                    return Err(diagnostic(
                        "journey",
                        "The deployment name does not satisfy the SDK schema.",
                    ));
                }
            }
            QuestionTarget::Harness => {
                candidate
                    .authored
                    .put_harness(&candidate.position, value.expect("required"))?;
            }
            QuestionTarget::StructuralForm { path } => {
                let selected = value
                    .as_ref()
                    .and_then(Value::as_str)
                    .expect("advertised form")
                    .to_owned();
                for other in question
                    .choices()
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|other| *other != selected)
                {
                    let field = format!("{path}/{}", escape_pointer(other));
                    candidate.authored.put_sdk_field(&field, None)?;
                    candidate.decisions.accepted.remove(&field);
                }
                candidate
                    .position
                    .selected_forms
                    .insert(path.into(), selected);
            }
            QuestionTarget::RouteSelection { routes } => {
                let name = value
                    .as_ref()
                    .and_then(Value::as_str)
                    .expect("advertised route");
                let index = routes
                    .iter()
                    .find_map(|(route_name, index)| (route_name == name).then_some(*index))
                    .ok_or_else(|| diagnostic("journey", "The selected route is unavailable."))?;
                candidate.position.select_route(index);
            }
            QuestionTarget::InferencePreset { .. } => {
                let preset = ProviderPreset::from_id(
                    value
                        .as_ref()
                        .and_then(Value::as_str)
                        .expect("advertised preset"),
                )
                .expect("advertised preset");
                candidate.put_inference_preset(preset)?;
            }
            QuestionTarget::AdapterSetting { adapter, pointer } => {
                if harness_kind(&candidate.authored.values) != Some(adapter.as_str()) {
                    return Err(diagnostic("journey", "This adapter setting is not active."));
                }
                candidate.authored.put_setting(pointer, value.clone())?;
            }
            QuestionTarget::WorkflowSetting { pointer } => {
                candidate.authored.put_native_field(
                    NativeSettingOwner::Workflow,
                    pointer,
                    value.clone(),
                )?;
            }
            QuestionTarget::ModelSetting { route, pointer } => {
                candidate.authored.put_native_field(
                    NativeSettingOwner::Model(*route),
                    pointer,
                    value.clone(),
                )?;
            }
            QuestionTarget::SdkField { path, role } => {
                let previous = candidate.authored.values.pointer(path).cloned();
                let provider_for_dependency = if matches!(
                    role,
                    SdkFieldRole::ProviderApi | SdkFieldRole::ProviderEndpoint
                ) {
                    path.rsplit_once('/')
                        .and_then(|(base, _)| {
                            candidate.authored.values.pointer(&format!("{base}/name"))
                        })
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                } else {
                    None
                };
                candidate.authored.put_sdk_field(path, value.clone())?;
                if previous != candidate.authored.values.pointer(path).cloned()
                    && let Some(provider) = provider_for_dependency
                {
                    candidate.reopen_models_for_provider(&provider, path);
                }
                if *role == SdkFieldRole::GatewayEngine {
                    candidate.authored.generated_gateway_engine = false;
                }
                if *role == SdkFieldRole::RuntimeProvider {
                    candidate.authored.sync_gateway_engine_for_runtime()?;
                }
                if self
                    .definition
                    .ask_scopes
                    .contains(&JourneyScope::DeploymentFields)
                    && !self.definition.ask.contains(path)
                    && self.resolve(capabilities)?.question(id).is_some()
                    && PartialDocument::from_value(self.authored.values.clone())
                        .assess()
                        .document()
                        .is_some()
                    && PartialDocument::from_value(candidate.authored.values.clone())
                        .assess()
                        .document()
                        .is_none()
                {
                    return Err(diagnostic(
                        "journey",
                        "The deployment answer invalidates the SDK document.",
                    ));
                }
            }
        }
        candidate
            .decisions
            .record_answer(id, &question.target, omitted);
        *self = candidate;
        Ok(())
    }

    pub(super) fn revisitable_question(
        &self,
        capabilities: &Capabilities,
        id: &str,
    ) -> Result<JourneyQuestion, Diagnostics> {
        let mut previous = self.clone();
        let target = previous
            .decisions
            .targets
            .get(id)
            .cloned()
            .ok_or_else(|| diagnostic("journey", "This question is no longer applicable."))?;
        previous.decisions.accepted.remove(id);
        if let QuestionTarget::InferencePreset { route } = target {
            previous.decisions.accepted_presets.remove(&route);
        }
        previous.decisions.omitted.remove(id);
        let suggestion = match &target {
            QuestionTarget::DeploymentName => {
                let value = previous.authored.values.pointer(NAME).cloned();
                previous
                    .authored
                    .values
                    .pointer_mut("/metadata")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| diagnostic("journey", "Metadata must be an object."))?
                    .remove("name");
                value
            }
            QuestionTarget::Harness => {
                let owner_path = harness_path(&previous.authored.values)
                    .ok_or_else(|| diagnostic("journey", "Harness is unavailable."))?;
                let value = previous
                    .authored
                    .values
                    .pointer(&format!("{owner_path}/kind"))
                    .cloned();
                previous
                    .authored
                    .values
                    .pointer_mut(&owner_path)
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| diagnostic("journey", "Harness must be an object."))?
                    .remove("kind");
                value
            }
            QuestionTarget::AdapterSetting { adapter, pointer } => {
                if harness_kind(&previous.authored.values) != Some(adapter.as_str()) {
                    return Err(diagnostic(
                        "journey",
                        "This question is no longer applicable.",
                    ));
                }
                let value = previous
                    .authored
                    .values
                    .pointer(&format!(
                        "{}{pointer}",
                        settings_path(&previous.authored.values).ok_or_else(|| diagnostic(
                            "journey",
                            "Harness settings are unavailable."
                        ))?
                    ))
                    .cloned();
                previous.authored.put_setting(pointer, None)?;
                value
            }
            QuestionTarget::InferencePreset { .. } => self
                .current_preset()
                .map(|preset| Value::String(preset.id().into())),
            QuestionTarget::StructuralForm { path } => {
                let selected = previous
                    .position
                    .selected_forms
                    .remove(path)
                    .ok_or_else(|| {
                        diagnostic("journey", "This structural choice is no longer applicable.")
                    })?;
                previous
                    .authored
                    .put_sdk_field(&format!("{path}/{}", escape_pointer(&selected)), None)?;
                Some(Value::String(selected))
            }
            QuestionTarget::WorkflowSetting { .. } => {
                previous.definition.ask.insert(id.into());
                native_value(
                    &previous.authored.values,
                    previous.position.selected_route,
                    id,
                )
                .cloned()
            }
            QuestionTarget::ModelSetting { .. } => {
                let route = previous.position.selected_route.ok_or_else(|| {
                    diagnostic("journey", "Select a route before model settings.")
                })?;
                let key = (route, id.to_owned());
                previous.decisions.accepted_model_settings.remove(&key);
                previous.decisions.omitted_model_settings.remove(&key);
                previous.definition.ask.insert(id.into());
                native_value(&previous.authored.values, Some(route), id).cloned()
            }
            QuestionTarget::SdkField { path, .. }
                if sdk_field_schema_for(&self.authored.values, path).is_some()
                    || (self
                        .definition
                        .ask_scopes
                        .contains(&JourneyScope::DeploymentFields)
                        && self.authored.values.pointer(path).is_some()) =>
            {
                previous.authored.values.pointer(path).cloned()
            }
            _ => {
                return Err(diagnostic(
                    "journey",
                    "This question is no longer applicable.",
                ));
            }
        };
        let mut question = previous.resolve(capabilities)?.question(id).cloned();
        if question.is_none()
            && let QuestionTarget::SdkField { path, .. } = &target
        {
            // An implicit missing-field question disappears after its first
            // answer. Recreate the gap in this temporary copy to recover its
            // current schema without changing the accepted document.
            previous.authored.put_sdk_field(path, None)?;
            question = previous.resolve(capabilities)?.question(id).cloned();
        }
        let mut question = question
            .ok_or_else(|| diagnostic("journey", "This question is no longer applicable."))?;
        if suggestion.is_some() {
            question.suggestion = suggestion;
        }
        Ok(question)
    }
}
