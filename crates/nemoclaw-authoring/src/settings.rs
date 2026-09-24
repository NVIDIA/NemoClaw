// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{Capabilities, Diagnostics, Draft, diagnostics::diagnostic};
use nemoclaw_sdk::fabric_capabilities::schema_accepts;
use serde_json::{Map, Value};

#[derive(Clone, Debug, PartialEq)]
pub struct SettingQuestion {
    pub path: String,
    pub title: String,
    pub description: String,
    pub required: bool,
    pub schema: Value,
    pub choices: Vec<Value>,
    pub suggestion: Option<Value>,
}
impl SettingQuestion {
    pub fn parse(&self, text: &str) -> Result<Value, Diagnostics> {
        if self.schema["type"] == "string" {
            return Ok(Value::String(text.into()));
        }
        serde_json::from_str(text)
            .map_err(|_| diagnostic("settings", "Enter a JSON value of the advertised type."))
    }
}
impl Draft {
    fn settings_schema<'a>(
        &self,
        capabilities: &'a Capabilities,
    ) -> Result<Option<&'a Value>, Diagnostics> {
        let key = self.discovery_key()?;
        let Some(alternatives) = capabilities.schemas.get(key.harness.as_str()) else {
            return Ok(None);
        };
        let Some((_, schema)) = alternatives.first() else {
            return Ok(None);
        };
        if alternatives.iter().any(|(_, other)| other != schema) {
            return Err(diagnostic(
                "settings",
                &format!(
                    "The selected harness matches multiple Fabric adapter schemas ({}). Select an unambiguous adapter descriptor before editing settings.",
                    alternatives
                        .iter()
                        .map(|(id, _)| id.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            ));
        }
        Ok(Some(schema))
    }
    fn settings_value(&self) -> Value {
        self.document.spec.sandboxes[0]
            .harness
            .as_ref()
            .and_then(|harness| harness.settings.clone())
            .map(Value::Object)
            .unwrap_or_else(|| Value::Object(Map::new()))
    }
    fn workflow_value(&self) -> Value {
        self.document.spec.sandboxes[0]
            .harness
            .as_ref()
            .and_then(|harness| harness.config.as_ref())
            .and_then(|config| config.get("workflow"))
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()))
    }
    fn model_settings_value(&self) -> Value {
        self.document.spec.sandboxes[0]
            .agent
            .inference
            .as_ref()
            .and_then(|inference| inference.routes.first())
            .and_then(|route| route.overrides.settings.clone())
            .map(Value::Object)
            .unwrap_or_else(|| serde_json::json!({}))
    }
    fn model_questions(
        &self,
        capabilities: &Capabilities,
    ) -> Result<Vec<SettingQuestion>, Diagnostics> {
        let key = self.discovery_key()?;
        let Some(schema) = capabilities.model_schemas.get(key.harness.as_str()) else {
            return Ok(Vec::new());
        };
        let config = nemoclaw_sdk::fabric_config::for_sandbox(
            self.document(),
            &self.document.spec.sandboxes[0],
        )
        .map_err(|_| diagnostic("model", "Cannot project the selected model configuration."))?;
        let mut fields = Vec::new();
        collect(
            schema,
            schema,
            &config["models"]["default"],
            "",
            false,
            &mut fields,
            0,
        )?;
        fields.retain(|field| field.path == "/settings" || field.path.starts_with("/settings/"));
        for field in &mut fields {
            field.path = format!("model:{}", &field.path["/settings".len()..]);
        }
        if let Some(native) = schema["properties"].get("settings") {
            let mut native = native.clone();
            if let Some(defs) = schema.get("$defs")
                && native.is_object()
            {
                native["$defs"] = defs.clone();
            }
            let settings = self.model_settings_value();
            let resolved = fields.iter().all(|field| {
                self.question_value(&field.path)
                    .as_ref()
                    .is_some_and(|value| schema_accepts(&field.schema, value) == Some(true))
                    || !field.required
            });
            if resolved && schema_accepts(&native, &settings) == Some(false) {
                fields.push(SettingQuestion {
                    path: "model:".into(),
                    title: "Model settings".into(),
                    description:
                        "Edit the JSON object to satisfy the adapter's model settings schema."
                            .into(),
                    required: true,
                    schema: native,
                    choices: Vec::new(),
                    suggestion: Some(settings),
                });
            }
        }
        Ok(fields)
    }
    fn question_value(&self, path: &str) -> Option<Value> {
        if let Some(pointer) = path.strip_prefix("model:") {
            self.model_settings_value().pointer(pointer).cloned()
        } else if let Some(pointer) = path.strip_prefix("workflow:") {
            self.workflow_value().pointer(pointer).cloned()
        } else {
            self.settings_value().pointer(path).cloned()
        }
    }
    fn workflow_questions(
        &self,
        capabilities: &Capabilities,
    ) -> Result<Vec<SettingQuestion>, Diagnostics> {
        let key = self.discovery_key()?;
        let targets: Vec<_> = capabilities
            .targets
            .iter()
            .map(|record| &record["descriptor"])
            .filter(|target| {
                target["type"] == "workflow" && target["adapter_id"] == key.harness.as_str()
            })
            .collect();
        let required = capabilities
            .config_schemas
            .get(key.harness.as_str())
            .and_then(|schema| schema["required"].as_array())
            .is_some_and(|fields| fields.iter().any(|field| field == "workflow"));
        if targets.is_empty() && !required {
            return Ok(Vec::new());
        }
        let mut choices: Vec<_> = targets
            .iter()
            .filter_map(|target| target["id"].as_str().map(|id| Value::String(id.into())))
            .collect();
        choices.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
        choices.dedup();
        let values = self.workflow_value();
        let mut schema = serde_json::json!({"type":"string","minLength":1});
        if !choices.is_empty() {
            schema["enum"] = choices.clone().into();
        }
        let mut fields = vec![SettingQuestion {
            path: "workflow:/target_id".into(),
            title: "Workflow target".into(),
            description: "Select a workflow target advertised by this Fabric adapter.".into(),
            required,
            schema,
            choices,
            suggestion: values.get("target_id").cloned(),
        }];
        if let Some(target) = targets
            .iter()
            .find(|target| target["id"] == values["target_id"])
            && let Some(schema) = target["spec"].get("settings_schema")
        {
            let settings = values
                .get("settings")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let mut native = Vec::new();
            collect(schema, schema, &settings, "", false, &mut native, 0)?;
            let resolved = native.iter().all(|field| {
                settings
                    .pointer(&field.path)
                    .is_some_and(|value| schema_accepts(&field.schema, value) == Some(true))
                    || !field.required
            });
            if resolved && schema_accepts(schema, &settings) != Some(true) {
                native.push(SettingQuestion {
                    path: String::new(),
                    title: "Workflow settings".into(),
                    description: "Edit the JSON object to satisfy the workflow target schema."
                        .into(),
                    required: true,
                    schema: schema.clone(),
                    choices: Vec::new(),
                    suggestion: Some(settings),
                });
            }
            for mut field in native {
                field.path = format!("workflow:/settings{}", field.path);
                fields.push(field);
            }
        }
        Ok(fields)
    }
    pub fn setting_questions(
        &self,
        capabilities: &Capabilities,
    ) -> Result<Vec<SettingQuestion>, Diagnostics> {
        let mut fields = Vec::new();
        if let Some(schema) = self.settings_schema(capabilities)? {
            let values = self.settings_value();
            collect(schema, schema, &values, "", false, &mut fields, 0)?;
            let resolved = fields.iter().all(|field| {
                values
                    .pointer(&field.path)
                    .is_some_and(|value| schema_accepts(&field.schema, value) == Some(true))
                    || (!field.required
                        && values.pointer(&field.path).is_none()
                        && self.skipped_settings.get(&field.path) == Some(&field.schema))
            });
            if resolved && schema_accepts(schema, &values) != Some(true) {
                fields.push(SettingQuestion { path: String::new(), title: "Adapter settings".into(), description: "Edit the JSON object to satisfy the current adapter schema; existing values are preserved until accepted.".into(), required: true, schema: schema.clone(), choices: Vec::new(), suggestion: Some(values) });
            }
        }
        fields.extend(self.workflow_questions(capabilities)?);
        fields.extend(self.model_questions(capabilities)?);
        fields.sort_by_key(|field| !field.required);
        Ok(fields)
    }
    pub fn next_setting(
        &self,
        capabilities: &Capabilities,
    ) -> Result<Option<SettingQuestion>, Diagnostics> {
        Ok(self
            .setting_questions(capabilities)?
            .into_iter()
            .find(|field| {
                let value = self.question_value(&field.path);
                if value
                    .as_ref()
                    .is_some_and(|value| schema_accepts(&field.schema, value) == Some(true))
                {
                    return false;
                }
                !(!field.required
                    && value.is_none()
                    && self.skipped_settings.get(&field.path) == Some(&field.schema))
            }))
    }
    pub fn validate_settings(&self, capabilities: &Capabilities) -> Result<(), Diagnostics> {
        if let Some(schema) = self.settings_schema(capabilities)?
            && schema_accepts(schema, &self.settings_value()) != Some(true)
        {
            return Err(diagnostic(
                "settings",
                "Adapter settings do not satisfy the current descriptor schema. Answer the remaining settings or correct the values.",
            ));
        }
        for field in self
            .workflow_questions(capabilities)?
            .into_iter()
            .chain(self.model_questions(capabilities)?)
        {
            if let Some(value) = self.question_value(&field.path) {
                if schema_accepts(&field.schema, &value) != Some(true) {
                    return Err(diagnostic(
                        "settings",
                        "Native settings do not satisfy the owner schema.",
                    ));
                }
            } else if field.required {
                return Err(diagnostic(
                    "settings",
                    "Answer the required native settings.",
                ));
            }
        }
        Ok(())
    }
    pub fn answer_setting(
        &mut self,
        capabilities: &Capabilities,
        path: &str,
        value: Option<Value>,
    ) -> Result<(), Diagnostics> {
        self.apply_setting(capabilities, path, value, true)
    }
    fn apply_setting(
        &mut self,
        capabilities: &Capabilities,
        path: &str,
        value: Option<Value>,
        explicit: bool,
    ) -> Result<(), Diagnostics> {
        let field = self
            .setting_questions(capabilities)?
            .into_iter()
            .find(|field| field.path == path)
            .ok_or_else(|| diagnostic("settings", "This setting is no longer active."))?;
        if value.is_none() && field.required {
            return Err(diagnostic("settings", "This setting is required."));
        }
        if let Some(value) = &value
            && schema_accepts(&field.schema, value) != Some(true)
        {
            return Err(diagnostic(
                "settings",
                "The value does not satisfy the advertised setting schema.",
            ));
        }
        if explicit && self.question_value(path).as_ref() != value.as_ref() {
            for delegated in std::mem::take(&mut self.delegated_settings) {
                if delegated != path {
                    self.write_setting(&delegated, None)?;
                }
            }
        }
        self.write_setting(path, value.clone())?;
        self.delegated_settings.retain(|name| name != path);
        if value.is_none() {
            self.skipped_settings.insert(path.into(), field.schema);
        } else {
            self.skipped_settings.remove(path);
        }
        Ok(())
    }
    fn write_setting(&mut self, path: &str, value: Option<Value>) -> Result<(), Diagnostics> {
        if let Some(pointer) = path.strip_prefix("model:") {
            let mut values = self.model_settings_value();
            put(&mut values, pointer, value)?;
            let route = self.document.spec.sandboxes[0]
                .agent
                .inference
                .as_mut()
                .and_then(|inference| inference.routes.first_mut())
                .ok_or_else(|| {
                    diagnostic("model", "Guided model settings require one inline route.")
                })?;
            route.overrides.settings = values
                .as_object()
                .filter(|settings| !settings.is_empty())
                .cloned();
            return Ok(());
        }
        let workflow = path.strip_prefix("workflow:");
        let mut values = if workflow.is_some() {
            self.workflow_value()
        } else {
            self.settings_value()
        };
        put(&mut values, workflow.unwrap_or(path), value)?;
        let harness = self.document.spec.sandboxes[0]
            .harness
            .as_mut()
            .ok_or_else(|| diagnostic("settings", "Guided settings require an inline harness."))?;
        if workflow.is_some() {
            let config = harness.config.get_or_insert_with(Map::new);
            if values.as_object().is_some_and(Map::is_empty) {
                config.remove("workflow");
            } else {
                config.insert("workflow".into(), values);
            }
            if config.is_empty() {
                harness.config = None;
            }
        } else {
            harness.settings = values.as_object().cloned();
        }
        Ok(())
    }
    pub(crate) fn revoke_setting_delegation(&mut self) {
        for path in std::mem::take(&mut self.delegated_settings) {
            let _ = self.write_setting(&path, None);
            self.skipped_settings.remove(&path);
        }
    }
    pub(crate) fn delegate_setting_defaults(
        &mut self,
        capabilities: &Capabilities,
    ) -> Result<(), Diagnostics> {
        for _ in 0..256 {
            let Some(field) = self.next_setting(capabilities)? else {
                return self.validate_settings(capabilities);
            };
            if field.required && field.suggestion.is_none() {
                return Err(diagnostic(
                    "settings",
                    "A required adapter setting has no suggested value; answer it before delegating.",
                ));
            }
            self.apply_setting(capabilities, &field.path, field.suggestion, false)?;
            self.delegated_settings.push(field.path);
        }
        Err(diagnostic(
            "settings",
            "Adapter settings exceed the supported interview size.",
        ))
    }
}
fn put(root: &mut Value, path: &str, value: Option<Value>) -> Result<(), Diagnostics> {
    if path.is_empty() {
        *root = value.unwrap_or_else(|| Value::Object(Map::new()));
        return Ok(());
    }

    let parts: Vec<_> = path
        .split('/')
        .skip(1)
        .map(|part| part.replace("~1", "/").replace("~0", "~"))
        .collect();
    let mut current = root;
    for part in &parts[..parts.len().saturating_sub(1)] {
        current = current
            .as_object_mut()
            .ok_or_else(|| diagnostic("settings", "Expected an object setting."))?
            .entry(part)
            .or_insert_with(|| Value::Object(Map::new()));
    }
    let key = parts
        .last()
        .ok_or_else(|| diagnostic("settings", "Invalid setting path."))?;
    let object = current
        .as_object_mut()
        .ok_or_else(|| diagnostic("settings", "Expected an object setting."))?;
    if let Some(value) = value {
        object.insert(key.clone(), value);
    } else {
        object.remove(key);
    }
    Ok(())
}
fn collect(
    root: &Value,
    schema: &Value,
    values: &Value,
    path: &str,
    required: bool,
    fields: &mut Vec<SettingQuestion>,
    depth: usize,
) -> Result<(), Diagnostics> {
    if depth > 32 || fields.len() > 256 {
        return Err(diagnostic(
            "settings",
            "Adapter schema exceeds supported interview depth or size.",
        ));
    }
    if let Some(reference) = schema["$ref"].as_str() {
        let resolved = reference
            .strip_prefix('#')
            .and_then(|reference| root.pointer(reference))
            .ok_or_else(|| {
                diagnostic("settings", "Adapter schema reference cannot be resolved.")
            })?;
        return collect(root, resolved, values, path, required, fields, depth + 1);
    }
    let mut effective = schema.clone();
    let mut branches = schema["allOf"].as_array().cloned().unwrap_or_default();
    if let Some(condition) = schema.get("if") {
        let branch = match schema_accepts(condition, values) {
            Some(true) => schema.get("then"),
            Some(false) => schema.get("else"),
            None => {
                return Err(diagnostic(
                    "settings",
                    "Conditional adapter schema could not be evaluated.",
                ));
            }
        };
        branches.extend(branch.cloned());
    }
    for keyword in ["oneOf", "anyOf"] {
        if let Some(alternatives) = schema[keyword].as_array() {
            let compatible: Vec<_> = alternatives
                .iter()
                .filter(|branch| {
                    if let Some(properties) = branch["properties"].as_object() {
                        !properties.iter().any(|(key, constraint)| {
                            values.get(key).is_some_and(|value| {
                                schema_accepts(constraint, value) == Some(false)
                            })
                        })
                    } else {
                        schema_accepts(branch, values) != Some(false)
                    }
                })
                .cloned()
                .collect();
            if compatible.len() == 1 {
                branches.extend(compatible);
            } else if !path.is_empty() {
                // Ambiguous unions stay one typed JSON question; never guess a branch.
                fields.push(SettingQuestion {
                    path: path.into(),
                    title: schema["title"].as_str().unwrap_or(path).into(),
                    description: schema["description"]
                        .as_str()
                        .unwrap_or("Enter a JSON value matching one advertised alternative.")
                        .into(),
                    required,
                    schema: schema.clone(),
                    choices: Vec::new(),
                    suggestion: schema.get("default").cloned(),
                });
                return Ok(());
            } else if let Some(first) = compatible.first() {
                // Ask discriminators shared across alternatives before selecting a branch.
                let mut shared = Map::new();
                if let Some(properties) = first["properties"].as_object() {
                    for (name, constraint) in properties {
                        let alternatives: Vec<_> = compatible
                            .iter()
                            .filter_map(|branch| branch["properties"].get(name))
                            .collect();
                        if alternatives.len() == compatible.len() {
                            let mut choices = Vec::new();
                            for alternative in alternatives {
                                if let Some(value) = alternative.get("const")
                                    && !choices.contains(value)
                                {
                                    choices.push(value.clone());
                                }
                                if let Some(values) = alternative["enum"].as_array() {
                                    for value in values {
                                        if !choices.contains(value) {
                                            choices.push(value.clone());
                                        }
                                    }
                                }
                            }
                            if !choices.is_empty() {
                                let mut field = constraint.clone();
                                field.as_object_mut().unwrap().remove("const");
                                field["enum"] = Value::Array(choices);
                                shared.insert(name.clone(), field);
                            }
                        }
                    }
                }
                if shared.is_empty() {
                    fields.push(SettingQuestion {
                        path: String::new(),
                        title: "Adapter settings".into(),
                        description:
                            "Enter a JSON object matching the adapter's advertised alternatives."
                                .into(),
                        required: true,
                        schema: schema.clone(),
                        choices: Vec::new(),
                        suggestion: schema.get("default").cloned(),
                    });
                    return Ok(());
                }
                let required: Vec<_> = shared.keys().cloned().map(Value::String).collect();
                branches.push(serde_json::json!({"properties":shared,"required":required}));
            }
        }
    }
    for branch in branches {
        for key in ["type", "enum", "default", "title", "description", "const"] {
            if effective.get(key).is_none()
                && let Some(value) = branch.get(key)
            {
                effective[key] = value.clone();
            }
        }
        for key in ["properties", "$defs"] {
            if let Some(properties) = branch[key].as_object() {
                let object = effective
                    .as_object_mut()
                    .ok_or_else(|| diagnostic("settings", "Expected an object schema."))?
                    .entry(key)
                    .or_insert_with(|| Value::Object(Map::new()));
                for (name, value) in properties {
                    let fields = object.as_object_mut().unwrap();
                    if let Some(previous) = fields.get(name) {
                        fields.insert(name.clone(), serde_json::json!({"allOf":[previous,value]}));
                    } else {
                        fields.insert(name.clone(), value.clone());
                    }
                }
            }
        }
        if let Some(required) = branch["required"].as_array() {
            effective
                .as_object_mut()
                .unwrap()
                .entry("required")
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .unwrap()
                .extend(required.clone());
        }
    }
    if let Some(properties) = effective["properties"]
        .as_object()
        .filter(|_| path.is_empty() || required || !values.is_null())
    {
        for (name, child) in properties {
            let child_path = format!("{path}/{}", name.replace('~', "~0").replace('/', "~1"));
            let child_required = effective["required"]
                .as_array()
                .is_some_and(|names| names.iter().any(|value| value.as_str() == Some(name)));
            collect(
                root,
                child,
                values.get(name).unwrap_or(&Value::Null),
                &child_path,
                child_required,
                fields,
                depth + 1,
            )?;
        }
    } else if !path.is_empty() {
        let mut field_schema = schema.clone();
        for key in ["type", "title", "description"] {
            if field_schema.get(key).is_none()
                && let Some(value) = effective.get(key)
            {
                field_schema[key] = value.clone();
            }
        }
        if let Some(definitions) = root.get("$defs")
            && let Some(object) = field_schema.as_object_mut()
        {
            object.insert("$defs".into(), definitions.clone());
        }
        let suggestion = if !values.is_null() && schema_accepts(&field_schema, values) == Some(true)
        {
            Some(values.clone())
        } else {
            effective
                .get("default")
                .filter(|value| schema_accepts(&field_schema, value) == Some(true))
                .cloned()
        };
        let choices = effective["enum"]
            .as_array()
            .cloned()
            .or_else(|| effective.get("const").map(|value| vec![value.clone()]))
            .unwrap_or_else(|| {
                if effective["type"] == "boolean" {
                    vec![Value::Bool(false), Value::Bool(true)]
                } else {
                    Vec::new()
                }
            });
        let choices = choices
            .into_iter()
            .filter(|value| schema_accepts(&field_schema, value) == Some(true))
            .collect();
        fields.push(SettingQuestion {
            path: path.into(),
            title: effective["title"].as_str().unwrap_or(path).into(),
            description: effective["description"]
                .as_str()
                .unwrap_or("Enter the adapter setting.")
                .into(),
            required,
            schema: field_schema,
            choices,
            suggestion,
        });
    }
    Ok(())
}
