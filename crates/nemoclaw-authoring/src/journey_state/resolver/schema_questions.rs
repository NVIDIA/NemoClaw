// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// Walk unconditional required leaves and the schema's recognized finite
/// alternatives. Other structural alternatives remain deferred.
pub(super) fn collect_required_leaf_questions(
    values: &Value,
    path: &str,
    schema: &Value,
    selected_forms: &BTreeMap<String, String>,
    questions: &mut Vec<JourneyQuestion>,
    depth: usize,
) {
    if depth >= 16 {
        return;
    }
    if let Some((discriminator, _)) = sdk_discriminator(schema) {
        let escaped = discriminator.replace('~', "~0").replace('/', "~1");
        let choice_path = format!("{path}/{escaped}");
        if let Some((choice_schema, _)) = sdk_field_schema_for(values, &choice_path) {
            let supplied = values.pointer(&choice_path);
            if !supplied.is_some_and(|value| schema_accepts(&choice_schema, value) == Some(true)) {
                if !questions.iter().any(|question| question.id == choice_path) {
                    questions.push(JourneyQuestion {
                        kind: JourneyQuestionKind::Field,
                        reopened_because: None,
                        id: choice_path,
                        reason: if supplied.is_some() {
                            JourneyQuestionReason::InvalidSupplied
                        } else {
                            JourneyQuestionReason::Missing
                        },
                        required: true,
                        choices: finite_choices(&choice_schema),
                        suggestion: supplied.cloned(),
                        schema: choice_schema,
                    });
                }
                return;
            }
        }
        if let Some(branch) = values
            .pointer(path)
            .and_then(|supplied| sdk_selected_branch(schema, supplied))
        {
            collect_required_leaf_questions(
                values,
                path,
                branch,
                selected_forms,
                questions,
                depth + 1,
            );
        }
        return;
    }
    if let Some(fields) = sdk_exclusive_required_fields(schema) {
        let present = fields
            .iter()
            .filter(|name| {
                values
                    .pointer(&format!("{path}/{}", escape_pointer(name)))
                    .is_some()
            })
            .collect::<Vec<_>>();
        if present.len() > 1 {
            return;
        }
        let selected = present
            .first()
            .map(|name| name.as_str())
            .or_else(|| selected_forms.get(path).map(String::as_str));
        if let Some(selected) = selected {
            let child_path = format!("{path}/{}", escape_pointer(selected));
            if let Some((child_schema, _)) = sdk_field_schema_for(values, &child_path) {
                let supplied = values.pointer(&child_path);
                if !supplied.is_some_and(|value| schema_accepts(&child_schema, value) == Some(true))
                    && !questions.iter().any(|question| question.id == child_path)
                {
                    let choices = finite_choices(&child_schema);
                    if scalar_question(&child_schema, &choices) {
                        questions.push(JourneyQuestion {
                            kind: JourneyQuestionKind::Field,
                            reopened_because: None,
                            id: child_path,
                            reason: if supplied.is_some() {
                                JourneyQuestionReason::InvalidSupplied
                            } else {
                                JourneyQuestionReason::Missing
                            },
                            required: true,
                            choices,
                            suggestion: supplied.cloned(),
                            schema: child_schema,
                        });
                    } else {
                        collect_required_leaf_questions(
                            values,
                            &child_path,
                            &child_schema,
                            selected_forms,
                            questions,
                            depth + 1,
                        );
                    }
                }
            }
        } else {
            let id = format!("form:{path}");
            if !questions.iter().any(|question| question.id == id) {
                questions.push(JourneyQuestion {
                    kind: JourneyQuestionKind::StructuralForm,
                    reopened_because: None,
                    id,
                    reason: JourneyQuestionReason::Missing,
                    required: true,
                    choices: fields
                        .iter()
                        .map(|field| Value::String(field.clone()))
                        .collect(),
                    suggestion: None,
                    schema: serde_json::json!({"type": "string", "enum": fields}),
                });
            }
        }
    }
    let Some(required) = schema["required"].as_array() else {
        return;
    };
    for name in required.iter().filter_map(Value::as_str) {
        let escaped = name.replace('~', "~0").replace('/', "~1");
        let child_path = format!("{path}/{escaped}");
        if questions.iter().any(|question| question.id == child_path) {
            continue;
        }
        let Some((child_schema, _)) = sdk_field_schema_for(values, &child_path) else {
            continue;
        };
        let supplied = values.pointer(&child_path);
        if supplied.is_some_and(|value| schema_accepts(&child_schema, value) == Some(true)) {
            continue;
        }
        let choices = finite_choices(&child_schema);
        if scalar_question(&child_schema, &choices) {
            questions.push(JourneyQuestion {
                kind: JourneyQuestionKind::Field,
                reopened_because: None,
                id: child_path,
                reason: if supplied.is_some() {
                    JourneyQuestionReason::InvalidSupplied
                } else {
                    JourneyQuestionReason::Missing
                },
                required: true,
                choices,
                suggestion: supplied
                    .cloned()
                    .or_else(|| child_schema.get("default").cloned()),
                schema: child_schema,
            });
        } else {
            collect_required_leaf_questions(
                values,
                &child_path,
                &child_schema,
                selected_forms,
                questions,
                depth + 1,
            );
        }
    }
}
