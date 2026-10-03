// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl QuestionResolver<'_> {
    pub(super) fn collect_adapter_questions(
        &self,
        capabilities: &Capabilities,
        work: &mut ResolutionWork,
    ) -> Result<(), Diagnostics> {
        let questions = &mut work.questions;
        let omitted = &mut work.omitted;
        let warnings = &mut work.warnings;
        let unverified = &mut work.unverified;
        let active_harness = harness_path(&self.authored.values).or_else(|| {
            (self
                .position
                .selected_forms
                .get("/spec/sandboxes/0")
                .is_some_and(|form| form == "harness"))
            .then(|| "/spec/sandboxes/0/harness".into())
        });
        let chosen = active_harness
            .as_ref()
            .and_then(|path| self.authored.values.pointer(&format!("{path}/kind")))
            .and_then(Value::as_str);
        let harness_open = active_harness.is_some()
            && (chosen.is_none()
                || (self.definition.ask.contains(HARNESS)
                    && !self.decisions.accepted.contains(HARNESS)));
        let reachable: Vec<&str> = if harness_open {
            capabilities
                .harnesses()
                .iter()
                .map(|harness| harness.as_str())
                .collect()
        } else {
            chosen.into_iter().collect()
        };
        for field in self.definition.ask.union(&self.definition.omit) {
            if let Some((adapter, _)) = adapter_field(field)
                && !reachable.contains(&adapter)
            {
                let reason = if harness_open {
                    "available harness choices".to_owned()
                } else if let Some(harness) = chosen {
                    format!("selected harness '{harness}'")
                } else {
                    "the unresolved harness form".to_owned()
                };
                warnings.push(format!("{field} is not reachable from {reason}"));
            }
        }
        if harness_open {
            // Fabric supplies the active harness choices; replace the generic
            // SDK leaf question if sparse traversal found the same field.
            questions.retain(|question| question.id != HARNESS);
            if let Some(harness) = chosen
                && adapter_schema(capabilities, harness)?.is_none()
            {
                unverified.push(format!("adapter schema unverified for '{harness}'"));
            }
            if capabilities.harnesses().is_empty() {
                unverified
                    .push("no harness choices are advertised by the current Fabric catalog".into());
            }
            questions.push(JourneyQuestion {
                target: QuestionTarget::Harness,
                kind: JourneyQuestionKind::Field,
                reopened_because: None,
                id: HARNESS.into(),
                reason: if chosen.is_none() {
                    JourneyQuestionReason::Missing
                } else {
                    JourneyQuestionReason::ExplicitAsk
                },
                required: true,
                choices: capabilities
                    .harnesses()
                    .iter()
                    .map(|harness| Value::String(harness.as_str().into()))
                    .collect(),
                suggestion: chosen.map(|kind| Value::String(kind.into())),
                schema: serde_json::json!({"type":"string"}),
                title: None,
                description: None,
            });
        } else if let Some(harness) = chosen {
            if let Some(schema) = adapter_schema(capabilities, harness)? {
                let settings_path = format!(
                    "{}/settings",
                    active_harness
                        .as_deref()
                        .expect("chosen harness has an owner")
                );
                let supplied_settings = self.authored.values.pointer(&settings_path);
                let settings = supplied_settings
                    .cloned()
                    .unwrap_or_else(|| Value::Object(Map::new()));
                let mut fields = Vec::new();
                crate::settings::collect(schema, schema, &settings, "", false, &mut fields, 0)?;
                let root_id = format!("adapter:{harness}:");
                if self.definition.ask.contains(&root_id)
                    && !self.decisions.accepted.contains(&root_id)
                    && !fields.iter().any(|field| field.path.is_empty())
                {
                    fields.clear();
                    fields.push(SettingQuestion {
                        path: String::new(),
                        title: Some("Adapter settings".into()),
                        description: Some("Review the adapter settings object.".into()),
                        required: true,
                        schema: schema.clone(),
                        choices: Vec::new(),
                        suggestion: (schema_accepts(schema, &settings) == Some(true))
                            .then_some(settings.clone()),
                    });
                }
                let active_setting_ids = fields
                    .iter()
                    .map(|field| format!("adapter:{harness}:{}", field.path))
                    .collect::<BTreeSet<_>>();
                for field in fields {
                    let id = format!("adapter:{harness}:{}", field.path);
                    let value = if field.path.is_empty() && supplied_settings.is_none() {
                        None
                    } else {
                        settings.pointer(&field.path)
                    };
                    if self.definition.omit.contains(&id) || self.decisions.omitted.contains(&id) {
                        if field.required {
                            return Err(diagnostic(
                                "journey",
                                &format!("required setting '{id}' cannot be omitted"),
                            ));
                        }
                        if value.is_some() {
                            return Err(diagnostic(
                                "journey",
                                &format!("supplied setting '{id}' cannot be omitted"),
                            ));
                        }
                        omitted.push(id);
                        continue;
                    }
                    if value.is_none()
                        && !field.required
                        && !self.definition.ask.contains(&id)
                        && self
                            .definition
                            .omit_scopes
                            .contains(&JourneyScope::ActiveAdapterSettings)
                    {
                        omitted.push(id);
                        continue;
                    }
                    let valid = value
                        .is_some_and(|value| schema_accepts(&field.schema, value) == Some(true));
                    if value.is_none()
                        || !valid
                        || ((self
                            .definition
                            .ask_scopes
                            .contains(&JourneyScope::ActiveAdapterSettings)
                            || self.definition.ask.contains(&id))
                            && !self.decisions.accepted.contains(&id))
                    {
                        questions.push(JourneyQuestion {
                            target: QuestionTarget::AdapterSetting {
                                adapter: harness.into(),
                                pointer: field.path.clone(),
                            },
                            kind: JourneyQuestionKind::Field,
                            reopened_because: None,
                            id,
                            reason: if value.is_some() && !valid {
                                JourneyQuestionReason::InvalidSupplied
                            } else if value.is_none() {
                                JourneyQuestionReason::Missing
                            } else {
                                JourneyQuestionReason::ExplicitAsk
                            },
                            required: field.required,
                            choices: field.choices,
                            suggestion: field.suggestion,
                            schema: field.schema,
                            title: field.title,
                            description: field.description,
                        });
                    }
                }
                for selector in self.definition.ask.union(&self.definition.omit) {
                    if adapter_field(selector).is_some_and(|(adapter, _)| adapter == harness)
                        && !active_setting_ids.contains(selector)
                    {
                        warnings.push(format!(
                            "{selector} is not applicable in the current adapter settings schema"
                        ));
                    }
                }
                if questions
                    .iter()
                    .all(|question| !question.id.starts_with("adapter:"))
                    && schema_accepts(schema, &settings) != Some(true)
                {
                    unverified.push(format!(
                        "adapter '{harness}' settings do not satisfy the complete Fabric schema"
                    ));
                }
            } else {
                unverified.push(format!("adapter schema unverified for '{harness}'"));
            }
        }
        Ok(())
    }
}
