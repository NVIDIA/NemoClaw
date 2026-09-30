// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl JourneyState {
    pub(super) fn collect_native_questions(
        &self,
        inspect_values: &Value,
        document: Option<&Document>,
        capabilities: &Capabilities,
        native_guidance: bool,
        work: &mut ResolutionWork,
    ) -> Result<(), Diagnostics> {
        let questions = &mut work.questions;
        let omitted = &mut work.omitted;
        let warnings = &mut work.warnings;
        let unverified = &mut work.unverified;
        {
            let mut active_native_ids = BTreeSet::new();
            for field in native_questions_for_values(
                inspect_values,
                document,
                capabilities,
                self.selected_route,
            )? {
                if field.path == "model:" {
                    unverified.push(
                        "selected native model configuration does not satisfy its Fabric schema"
                            .into(),
                    );
                    continue;
                }
                active_native_ids.insert(field.path.clone());
                let value = native_value(&self.values, self.selected_route, &field.path);
                let valid =
                    value.is_some_and(|value| schema_accepts(&field.schema, value) == Some(true));
                if self.definition.omit.contains(&field.path) {
                    if field.required {
                        return Err(diagnostic(
                            "journey",
                            &format!("required native setting '{}' cannot be omitted", field.path),
                        ));
                    }
                    if value.is_some() {
                        return Err(diagnostic(
                            "journey",
                            &format!("supplied native setting '{}' cannot be omitted", field.path),
                        ));
                    }
                    omitted.push(field.path);
                    continue;
                }
                let route_key = self.selected_route.map(|route| (route, field.path.clone()));
                let accepted = if field.path.starts_with("model:") {
                    route_key
                        .as_ref()
                        .is_some_and(|key| self.accepted_model_settings.contains(key))
                } else {
                    self.accepted.contains(&field.path)
                };
                let omitted_route = route_key
                    .as_ref()
                    .is_some_and(|key| self.omitted_model_settings.contains(key));
                if self.omitted.contains(&field.path) || omitted_route {
                    omitted.push(field.path);
                } else if (value.is_some() && !valid)
                    || (value.is_none() && field.required)
                    || ((self
                        .definition
                        .ask_scopes
                        .contains(&JourneyScope::NativeSettings)
                        || self.definition.ask.contains(&field.path))
                        && !accepted)
                {
                    questions.push(JourneyQuestion {
                        kind: JourneyQuestionKind::Field,
                        reopened_because: None,
                        id: field.path,
                        reason: if value.is_some() && !valid {
                            JourneyQuestionReason::InvalidSupplied
                        } else if value.is_some() {
                            JourneyQuestionReason::ExplicitAsk
                        } else {
                            JourneyQuestionReason::Missing
                        },
                        required: field.required,
                        choices: field.choices,
                        suggestion: field.suggestion,
                        schema: field.schema,
                    });
                }
            }
            if native_guidance {
                for field in self.definition.ask.union(&self.definition.omit) {
                    if native_field(field) && !active_native_ids.contains(field) {
                        warnings.push(format!(
                            "{field} is not applicable in the current native settings schema"
                        ));
                    }
                }
            }
        }
        Ok(())
    }
}

pub(super) fn native_questions_for_values(
    values: &Value,
    document: Option<&Document>,
    capabilities: &Capabilities,
    selected_route: Option<usize>,
) -> Result<Vec<SettingQuestion>, Diagnostics> {
    let Some(harness_path) = harness_path(values) else {
        return Ok(Vec::new());
    };
    let Some(harness_id) = values
        .pointer(&format!("{harness_path}/kind"))
        .and_then(Value::as_str)
    else {
        return Ok(Vec::new());
    };
    let workflow = values
        .pointer(&format!("{harness_path}/config/workflow"))
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let targets = capabilities
        .targets
        .iter()
        .map(|record| &record["descriptor"])
        .filter(|target| target["type"] == "workflow" && target["adapter_id"] == harness_id)
        .collect::<Vec<_>>();
    let workflow_required = capabilities
        .config_schemas
        .get(harness_id)
        .and_then(|schema| schema["required"].as_array())
        .is_some_and(|fields| fields.iter().any(|field| field == "workflow"));
    let mut fields = Vec::new();
    if !targets.is_empty() || workflow_required {
        let mut choices = targets
            .iter()
            .filter_map(|target| target["id"].as_str())
            .map(|id| Value::String(id.into()))
            .collect::<Vec<_>>();
        choices.sort_by(|left, right| left.as_str().cmp(&right.as_str()));
        choices.dedup();
        let mut schema = serde_json::json!({"type":"string","minLength":1});
        if !choices.is_empty() {
            schema["enum"] = Value::Array(choices.clone());
        }
        fields.push(SettingQuestion {
            path: "workflow:/target_id".into(),
            title: "Workflow target".into(),
            description: "Select a workflow target advertised by this Fabric adapter.".into(),
            required: workflow_required,
            schema,
            choices,
            suggestion: workflow.get("target_id").cloned(),
        });
        if let Some(target) = targets
            .iter()
            .find(|target| target["id"] == workflow["target_id"])
            && let Some(schema) = target["spec"].get("settings_schema")
        {
            let settings = workflow
                .get("settings")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            let mut native = Vec::new();
            crate::settings::collect(schema, schema, &settings, "", false, &mut native, 0)?;
            for mut field in native {
                field.path = format!("workflow:/settings{}", field.path);
                fields.push(field);
            }
        }
    }
    if let (Some(schema), Some(document)) = (capabilities.model_schemas.get(harness_id), document) {
        let sandbox = &document.spec.sandboxes[0];
        let inference = document
            .sandbox_inference(sandbox)
            .map_err(|error| diagnostic("journey", &error.to_string()))?;
        if let Some(route) = selected_route.and_then(|index| inference.routes.get(index)) {
            let config =
                nemoclaw_sdk::fabric_config::for_sandbox(document, sandbox).map_err(|_| {
                    diagnostic(
                        "journey",
                        "Cannot project the selected model configuration.",
                    )
                })?;
            let mut model = Vec::new();
            crate::settings::collect(
                schema,
                schema,
                &config["models"][&route.name],
                "",
                false,
                &mut model,
                0,
            )?;
            for mut field in model {
                if field.path.is_empty() {
                    field.path = "model:".into();
                    fields.push(field);
                    continue;
                }
                if field.path == "/settings" || field.path.starts_with("/settings/") {
                    field.path = format!("model:{}", &field.path["/settings".len()..]);
                    fields.push(field);
                }
            }
        }
    }
    Ok(fields)
}
