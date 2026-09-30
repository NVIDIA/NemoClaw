// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl JourneyState {
    pub(super) fn put_name(&mut self, value: Value) -> Result<(), Diagnostics> {
        let root = self
            .values
            .as_object_mut()
            .ok_or_else(|| diagnostic("journey", "The document root must be an object."))?;
        let metadata = root
            .entry("metadata")
            .or_insert_with(|| Value::Object(Map::new()));
        metadata
            .as_object_mut()
            .ok_or_else(|| diagnostic("journey", "Metadata must be an object."))?
            .insert("name".into(), value);
        Ok(())
    }

    pub(super) fn put_harness(&mut self, value: Value) -> Result<(), Diagnostics> {
        let next = value
            .as_str()
            .ok_or_else(|| diagnostic("journey", "Harness must be a string."))?
            .to_owned();
        let previous = harness_kind(&self.values).map(str::to_owned);
        if previous.as_deref() != Some(&next)
            && let Some(old) = &previous
            && let Some(settings) =
                settings_path(&self.values).and_then(|path| self.values.pointer(&path))
        {
            self.inactive_settings.insert(old.clone(), settings.clone());
        }
        let owner_path = harness_path(&self.values)
            .or_else(|| {
                self.selected_forms
                    .get("/spec/sandboxes/0")
                    .filter(|form| *form == "harness")
                    .map(|_| "/spec/sandboxes/0/harness".into())
            })
            .ok_or_else(|| diagnostic("journey", "Harness is unavailable."))?;
        let harness = if owner_path == "/spec/sandboxes/0/harness" {
            self.values
                .pointer_mut("/spec/sandboxes/0")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| {
                    diagnostic("journey", "The v1 journey requires one sandbox object.")
                })?
                .entry("harness")
                .or_insert_with(|| Value::Object(Map::new()))
        } else {
            self.values
                .pointer_mut(&owner_path)
                .ok_or_else(|| diagnostic("journey", "Referenced harness is unavailable."))?
        };
        let harness = harness
            .as_object_mut()
            .ok_or_else(|| diagnostic("journey", "Harness must be an object."))?;
        if previous.as_deref() != Some(&next) {
            harness.remove("settings");
            if let Some(settings) = self.inactive_settings.get(&next) {
                harness.insert("settings".into(), settings.clone());
            }
        }
        harness.insert("kind".into(), Value::String(next));
        Ok(())
    }

    pub(super) fn put_setting(
        &mut self,
        pointer: &str,
        value: Option<Value>,
    ) -> Result<(), Diagnostics> {
        let harness = self
            .values
            .pointer_mut(
                &harness_path(&self.values)
                    .ok_or_else(|| diagnostic("journey", "Harness is unavailable."))?,
            )
            .and_then(Value::as_object_mut)
            .ok_or_else(|| diagnostic("journey", "Harness must be an object."))?;
        let settings = harness
            .entry("settings")
            .or_insert_with(|| Value::Object(Map::new()));
        crate::settings::put(settings, pointer, value)
    }

    pub(super) fn put_native_field(
        &mut self,
        id: &str,
        value: Option<Value>,
    ) -> Result<(), Diagnostics> {
        let (root, path) = if let Some(path) = id.strip_prefix("workflow:") {
            (
                harness_path(&self.values)
                    .ok_or_else(|| diagnostic("journey", "Harness is unavailable."))?,
                path,
            )
        } else if let Some(path) = id.strip_prefix("model:") {
            (
                format!(
                    "{}/{}",
                    routes_path(&self.values).ok_or_else(|| diagnostic(
                        "journey",
                        "Inference routes are unavailable."
                    ))?,
                    self.selected_route.ok_or_else(|| diagnostic(
                        "journey",
                        "Select a route before model settings."
                    ))?
                ),
                path,
            )
        } else {
            return Err(diagnostic("journey", "Invalid native question path."));
        };
        let owner = self
            .values
            .pointer_mut(&root)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| diagnostic("journey", "The native setting owner is unavailable."))?;
        let settings = if id.starts_with("workflow:") {
            owner
                .entry("config")
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .ok_or_else(|| diagnostic("journey", "Harness config must be an object."))?
                .entry("workflow")
                .or_insert_with(|| Value::Object(Map::new()))
        } else {
            owner
                .entry("overrides")
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .ok_or_else(|| diagnostic("journey", "Route overrides must be an object."))?
                .entry("settings")
                .or_insert_with(|| Value::Object(Map::new()))
        };
        crate::settings::put(settings, path, value)
    }

    pub(super) fn reopen_models_for_provider(&mut self, provider: &str, cause: &str) {
        let Some(routes_path) = routes_path(&self.values) else {
            return;
        };
        let route_indexes = self
            .values
            .pointer(&routes_path)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
            .filter_map(|(index, route)| {
                (route.get("providerRef").and_then(Value::as_str) == Some(provider))
                    .then_some(index)
            })
            .collect::<Vec<_>>();
        for index in route_indexes {
            let model = format!("{routes_path}/{index}/overrides/model");
            self.reopen_accepted(&model, cause);
            self.completed_routes.remove(&index);
            self.accepted_model_settings
                .retain(|(route, _)| *route != index);
            self.omitted_model_settings
                .retain(|(route, _)| *route != index);
        }
    }

    pub(super) fn reopen_accepted(&mut self, field: &str, cause: &str) {
        if self.accepted.remove(field) || self.reopened_by.contains_key(field) {
            self.reopened_by.insert(field.into(), cause.into());
        }
    }

    pub(super) fn put_inference_preset(
        &mut self,
        preset: ProviderPreset,
    ) -> Result<(), Diagnostics> {
        let (route_index, provider_index) = self.route_provider().ok_or_else(|| {
            diagnostic(
                "journey",
                "Inference presets require a selected route using an external provider.",
            )
        })?;
        let provider_path = format!("/spec/inferenceProviders/{provider_index}");
        let route_path = format!(
            "{}/{route_index}",
            routes_path(&self.values)
                .ok_or_else(|| { diagnostic("journey", "Inference routes are unavailable.") })?
        );
        let api_path = format!("{provider_path}/api");
        let endpoint_path = format!("{provider_path}/endpoint");
        let model_path = format!("{route_path}/overrides/model");
        let previous_name = self
            .values
            .pointer(&format!("{provider_path}/name"))
            .and_then(Value::as_str)
            .ok_or_else(|| diagnostic("journey", "The shared provider needs a name."))?
            .to_owned();
        if self
            .values
            .pointer(&format!("{route_path}/providerRef"))
            .and_then(Value::as_str)
            != Some(&previous_name)
        {
            return Err(diagnostic(
                "journey",
                "The route must reference the shared provider.",
            ));
        }
        let previous = self.current_preset();
        if previous == Some(preset) {
            self.selected_presets.insert(route_index, preset);
            return Ok(());
        }
        let before_values = self.values.clone();
        let profile = preset.profile();
        let old_api = self
            .values
            .pointer(&api_path)
            .cloned()
            .and_then(|value| serde_json::from_value::<InferenceApi>(value).ok());
        let api = old_api
            .filter(|api| preset.apis().contains(api))
            .unwrap_or(preset.apis()[0]);
        let provider = self
            .values
            .pointer_mut(&provider_path)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| diagnostic("journey", "The shared provider must be an object."))?;
        provider.insert("name".into(), Value::String(profile.name.into()));
        provider.insert(
            "provider".into(),
            Value::String(profile.kind.as_str().into()),
        );
        provider.insert(
            "api".into(),
            serde_json::to_value(api).expect("SDK API serializes"),
        );
        provider.insert("endpoint".into(), Value::String(profile.endpoint.into()));
        provider.insert(
            "credential".into(),
            serde_json::json!({"env": profile.credential}),
        );
        let route = self
            .values
            .pointer_mut(&route_path)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| diagnostic("journey", "The route must be an object."))?;
        route.insert("providerRef".into(), Value::String(profile.name.into()));
        let overrides = route
            .get_mut("overrides")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| diagnostic("journey", "The route needs model overrides."))?;
        if let Some(model) = profile.default_model {
            overrides.insert("model".into(), Value::String(model.into()));
        } else {
            overrides.remove("model");
        }
        self.selected_presets.insert(route_index, preset);
        if previous != Some(preset) {
            for field in [
                api_path,
                model_path,
                endpoint_path,
                format!("{provider_path}/credential/env"),
            ] {
                self.reopen_accepted(&field, INFERENCE_PRESET);
                self.omitted.remove(&field);
            }
            for field in self.accepted.clone() {
                if field.starts_with('/')
                    && before_values.pointer(&field) != self.values.pointer(&field)
                {
                    self.reopen_accepted(&field, INFERENCE_PRESET);
                    self.omitted.remove(&field);
                }
            }
        }
        Ok(())
    }

    pub(super) fn put_sdk_field(
        &mut self,
        pointer: &str,
        value: Option<Value>,
    ) -> Result<(), Diagnostics> {
        let (parent, property) = pointer
            .rsplit_once('/')
            .ok_or_else(|| diagnostic("journey", "Invalid SDK field path."))?;
        let property = property.replace("~1", "/").replace("~0", "~");
        if value.is_none() && self.values.pointer(parent).is_none() {
            return Ok(());
        }
        let mut current = &mut self.values;
        for segment in parent.split('/').skip(1) {
            let key = segment.replace("~1", "/").replace("~0", "~");
            current = match current {
                Value::Array(items) => {
                    let index = key
                        .parse::<usize>()
                        .map_err(|_| diagnostic("journey", "Invalid SDK array index."))?;
                    items
                        .get_mut(index)
                        .ok_or_else(|| diagnostic("journey", "SDK array index is unavailable."))?
                }
                Value::Object(object) => object
                    .entry(key)
                    .or_insert_with(|| Value::Object(Map::new())),
                _ => {
                    return Err(diagnostic(
                        "journey",
                        "The SDK field's parent is not an object.",
                    ));
                }
            };
        }
        let object = current
            .as_object_mut()
            .ok_or_else(|| diagnostic("journey", "The SDK field's parent is not an object."))?;
        if let Some(value) = value {
            object.insert(property, value);
        } else {
            object.remove(&property);
        }
        Ok(())
    }

    pub(super) fn sync_gateway_engine_for_runtime(&mut self) -> Result<(), Diagnostics> {
        if self
            .values
            .pointer("/spec/gateway/management")
            .and_then(Value::as_str)
            != Some("managed")
        {
            return Ok(());
        }
        if self.values.pointer("/spec/gateway/engine").is_some() && !self.generated_gateway_engine {
            return Ok(());
        }
        let engine = match self
            .values
            .pointer(RUNTIME_PROVIDER)
            .and_then(Value::as_str)
        {
            Some("podman") => "unix:///run/user/1000/podman/podman.sock",
            Some("docker") => "unix:///var/run/docker.sock",
            _ => return Ok(()),
        };
        self.put_sdk_field("/spec/gateway/engine", Some(Value::String(engine.into())))?;
        self.generated_gateway_engine = true;
        Ok(())
    }
}
