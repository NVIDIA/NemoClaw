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
        } else if self.accepted.contains(id) {
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
        if id == NAME {
            candidate.put_name(value.expect("required"))?;
            if PartialDocument::from_value(candidate.values.clone())
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
            candidate.put_harness(value.expect("required"))?;
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
                candidate.put_sdk_field(&field, None)?;
                candidate.accepted.remove(&field);
            }
            candidate.selected_forms.insert(path.into(), selected);
        } else if id == ROUTE_SELECTION {
            let name = value
                .as_ref()
                .and_then(Value::as_str)
                .expect("advertised route");
            let routes =
                candidate
                    .values
                    .pointer(&routes_path(&candidate.values).ok_or_else(|| {
                        diagnostic("journey", "Inference routes are unavailable.")
                    })?)
                    .and_then(Value::as_array)
                    .ok_or_else(|| diagnostic("journey", "Inference routes are unavailable."))?;
            let index = routes
                .iter()
                .position(|route| route["name"] == name)
                .ok_or_else(|| diagnostic("journey", "The selected route is unavailable."))?;
            if let Some(current) = candidate.selected_route {
                candidate.completed_routes.insert(current);
            }
            candidate.selected_route = Some(index);
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
            if harness_kind(&candidate.values) != Some(adapter) {
                return Err(diagnostic("journey", "This adapter setting is not active."));
            }
            candidate.put_setting(pointer, value.clone())?;
            if value.is_none() {
                candidate.omitted.insert(id.into());
            } else {
                candidate.omitted.remove(id);
            }
        } else if native_field(id) {
            candidate.put_native_field(id, value.clone())?;
            if id.starts_with("model:") {
                let route = candidate.selected_route.ok_or_else(|| {
                    diagnostic("journey", "Select a route before model settings.")
                })?;
                let key = (route, id.to_owned());
                if value.is_none() {
                    candidate.omitted_model_settings.insert(key.clone());
                } else {
                    candidate.omitted_model_settings.remove(&key);
                }
                candidate.accepted_model_settings.insert(key);
            } else if value.is_none() {
                candidate.omitted.insert(id.into());
            } else {
                candidate.omitted.remove(id);
            }
        } else if id.starts_with('/') {
            let previous = candidate.values.pointer(id).cloned();
            let provider_for_dependency = candidate.provider_path().and_then(|path| {
                (id == format!("{path}/api") || id == format!("{path}/endpoint"))
                    .then(|| candidate.values.pointer(&format!("{path}/name")))
                    .flatten()
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            candidate.put_sdk_field(id, value.clone())?;
            if previous != candidate.values.pointer(id).cloned()
                && let Some(provider) = provider_for_dependency
            {
                candidate.reopen_models_for_provider(&provider, id);
            }
            if id == "/spec/gateway/engine" {
                candidate.generated_gateway_engine = false;
            }
            if id == RUNTIME_PROVIDER {
                candidate.sync_gateway_engine_for_runtime()?;
            }
            if self
                .definition
                .ask_scopes
                .contains(&JourneyScope::DeploymentFields)
                && !self.definition.ask.contains(id)
                && self.resolve(capabilities)?.question(id).is_some()
                && PartialDocument::from_value(self.values.clone())
                    .assess()
                    .document()
                    .is_some()
                && PartialDocument::from_value(candidate.values.clone())
                    .assess()
                    .document()
                    .is_none()
            {
                return Err(diagnostic(
                    "journey",
                    "The deployment answer invalidates the SDK document.",
                ));
            }
            if value.is_none() {
                candidate.omitted.insert(id.into());
            } else {
                candidate.omitted.remove(id);
            }
        } else {
            return Err(diagnostic("journey", "This question is not supported."));
        }
        candidate.accepted.insert(id.into());
        candidate.reopened_by.remove(id);
        if id == INFERENCE_PRESET
            && let Some(route) = candidate.selected_route
        {
            candidate.accepted_presets.insert(route);
        }
        *self = candidate;
        Ok(())
    }

    pub(super) fn revisitable_question(
        &self,
        capabilities: &Capabilities,
        id: &str,
    ) -> Result<JourneyQuestion, Diagnostics> {
        let mut previous = self.clone();
        previous.accepted.remove(id);
        if id == INFERENCE_PRESET
            && let Some(route) = previous.selected_route
        {
            previous.accepted_presets.remove(&route);
        }
        previous.omitted.remove(id);
        let suggestion = if id == NAME {
            let value = previous.values.pointer(id).cloned();
            previous
                .values
                .pointer_mut("/metadata")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| diagnostic("journey", "Metadata must be an object."))?
                .remove("name");
            value
        } else if id == HARNESS {
            let owner_path = harness_path(&previous.values)
                .ok_or_else(|| diagnostic("journey", "Harness is unavailable."))?;
            let value = previous
                .values
                .pointer(&format!("{owner_path}/kind"))
                .cloned();
            previous
                .values
                .pointer_mut(&owner_path)
                .and_then(Value::as_object_mut)
                .ok_or_else(|| diagnostic("journey", "Harness must be an object."))?
                .remove("kind");
            value
        } else if let Some((adapter, pointer)) = adapter_field(id) {
            if harness_kind(&previous.values) != Some(adapter) {
                return Err(diagnostic(
                    "journey",
                    "This question is no longer applicable.",
                ));
            }
            let value = previous
                .values
                .pointer(&format!(
                    "{}{pointer}",
                    settings_path(&previous.values).ok_or_else(|| diagnostic(
                        "journey",
                        "Harness settings are unavailable."
                    ))?
                ))
                .cloned();
            previous.put_setting(pointer, None)?;
            value
        } else if id == INFERENCE_PRESET {
            self.current_preset()
                .map(|preset| Value::String(preset.id().into()))
        } else if let Some(path) = id.strip_prefix("form:") {
            let selected = previous.selected_forms.remove(path).ok_or_else(|| {
                diagnostic("journey", "This structural choice is no longer applicable.")
            })?;
            previous.put_sdk_field(&format!("{path}/{}", escape_pointer(&selected)), None)?;
            Some(Value::String(selected))
        } else if sdk_field_schema_for(&self.values, id).is_some()
            || (self
                .definition
                .ask_scopes
                .contains(&JourneyScope::DeploymentFields)
                && self.values.pointer(id).is_some())
        {
            previous.values.pointer(id).cloned()
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
            previous.put_sdk_field(id, None)?;
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
