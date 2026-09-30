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
        } else if self.decisions.accepted.contains(id) {
            self.revisitable_question(capabilities, id)?
        } else {
            return Err(diagnostic("journey", "This question is not active."));
        };
        if value.is_none() && question.required {
            return Err(diagnostic("journey", "This question is required."));
        }
        if id == HARNESS && question.choices.is_empty() {
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
        if self
            .provider_path()
            .is_some_and(|path| id == format!("{path}/endpoint"))
            && let Some(endpoint) = value.as_ref().and_then(Value::as_str)
        {
            nemoclaw_sdk::config::validate_endpoint(endpoint, false)
                .map_err(|error| diagnostic("journey", &error.to_string()))?;
        }
        let mut candidate = self.clone();
        let omitted = value.is_none();
        if id == NAME {
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
        } else if id == HARNESS {
            candidate
                .authored
                .put_harness(&candidate.position, value.expect("required"))?;
        } else if let Some(path) = id.strip_prefix("form:") {
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
        } else if id == ROUTE_SELECTION {
            let name = value
                .as_ref()
                .and_then(Value::as_str)
                .expect("advertised route");
            let routes =
                candidate
                    .authored
                    .values
                    .pointer(&routes_path(&candidate.authored.values).ok_or_else(|| {
                        diagnostic("journey", "Inference routes are unavailable.")
                    })?)
                    .and_then(Value::as_array)
                    .ok_or_else(|| diagnostic("journey", "Inference routes are unavailable."))?;
            let index = routes
                .iter()
                .position(|route| route["name"] == name)
                .ok_or_else(|| diagnostic("journey", "The selected route is unavailable."))?;
            candidate.position.select_route(index);
        } else if id == INFERENCE_PRESET {
            let preset = ProviderPreset::from_id(
                value
                    .as_ref()
                    .and_then(Value::as_str)
                    .expect("advertised preset"),
            )
            .expect("advertised preset");
            candidate.put_inference_preset(preset)?;
        } else if let Some((adapter, pointer)) = adapter_field(id) {
            if harness_kind(&candidate.authored.values) != Some(adapter) {
                return Err(diagnostic("journey", "This adapter setting is not active."));
            }
            candidate.authored.put_setting(pointer, value.clone())?;
        } else if native_field(id) {
            candidate
                .authored
                .put_native_field(&candidate.position, id, value.clone())?;
        } else if id.starts_with('/') {
            let previous = candidate.authored.values.pointer(id).cloned();
            let provider_for_dependency = candidate.provider_path().and_then(|path| {
                (id == format!("{path}/api") || id == format!("{path}/endpoint"))
                    .then(|| candidate.authored.values.pointer(&format!("{path}/name")))
                    .flatten()
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            candidate.authored.put_sdk_field(id, value.clone())?;
            if previous != candidate.authored.values.pointer(id).cloned()
                && let Some(provider) = provider_for_dependency
            {
                candidate.reopen_models_for_provider(&provider, id);
            }
            if id == "/spec/gateway/engine" {
                candidate.authored.generated_gateway_engine = false;
            }
            if id == RUNTIME_PROVIDER {
                candidate.authored.sync_gateway_engine_for_runtime()?;
            }
            if self
                .definition
                .ask_scopes
                .contains(&JourneyScope::DeploymentFields)
                && !self.definition.ask.contains(id)
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
        } else {
            return Err(diagnostic("journey", "This question is not supported."));
        }
        candidate
            .decisions
            .record_answer(id, omitted, candidate.position.selected_route);
        *self = candidate;
        Ok(())
    }

    pub(super) fn revisitable_question(
        &self,
        capabilities: &Capabilities,
        id: &str,
    ) -> Result<JourneyQuestion, Diagnostics> {
        let mut previous = self.clone();
        previous.decisions.accepted.remove(id);
        if id == INFERENCE_PRESET
            && let Some(route) = previous.position.selected_route
        {
            previous.decisions.accepted_presets.remove(&route);
        }
        previous.decisions.omitted.remove(id);
        let suggestion = if id == NAME {
            let value = previous.authored.values.pointer(id).cloned();
            previous
                .authored
                .values
                .pointer_mut("/metadata")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| diagnostic("journey", "Metadata must be an object."))?
                .remove("name");
            value
        } else if id == HARNESS {
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
        } else if let Some((adapter, pointer)) = adapter_field(id) {
            if harness_kind(&previous.authored.values) != Some(adapter) {
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
        } else if id == INFERENCE_PRESET {
            self.current_preset()
                .map(|preset| Value::String(preset.id().into()))
        } else if let Some(path) = id.strip_prefix("form:") {
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
        } else if sdk_field_schema_for(&self.authored.values, id).is_some()
            || (self
                .definition
                .ask_scopes
                .contains(&JourneyScope::DeploymentFields)
                && self.authored.values.pointer(id).is_some())
        {
            previous.authored.values.pointer(id).cloned()
        } else {
            return Err(diagnostic(
                "journey",
                "This question is no longer applicable.",
            ));
        };
        let mut question = previous.resolve(capabilities)?.question(id).cloned();
        if question.is_none() && id.starts_with('/') {
            // An implicit missing-field question disappears after its first
            // answer. Recreate the gap in this temporary copy to recover its
            // current schema without changing the accepted document.
            previous.authored.put_sdk_field(id, None)?;
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
