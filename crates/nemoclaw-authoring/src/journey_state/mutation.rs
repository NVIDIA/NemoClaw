// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl JourneyState {
    pub(super) fn reopen_models_for_provider(&mut self, provider: &str, cause: &str) {
        for index in self.routes_for_provider(provider) {
            let model = format!(
                "{}/{index}/overrides/model",
                routes_path(&self.authored.values).expect("provider routes")
            );
            self.decisions.reopen(&model, cause);
            self.position.completed_routes.remove(&index);
            self.decisions.forget_model_settings(index);
        }
    }

    fn routes_for_provider(&self, provider: &str) -> Vec<usize> {
        routes_path(&self.authored.values)
            .and_then(|path| self.authored.values.pointer(&path))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
            .filter_map(|(index, route)| {
                (route.get("providerRef").and_then(Value::as_str) == Some(provider))
                    .then_some(index)
            })
            .collect()
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
            routes_path(&self.authored.values)
                .ok_or_else(|| { diagnostic("journey", "Inference routes are unavailable.") })?
        );
        let api_path = format!("{provider_path}/api");
        let endpoint_path = format!("{provider_path}/endpoint");
        let previous_name = self
            .authored
            .values
            .pointer(&format!("{provider_path}/name"))
            .and_then(Value::as_str)
            .ok_or_else(|| diagnostic("journey", "The shared provider needs a name."))?
            .to_owned();
        let previous = self.current_preset();
        if previous == Some(preset) {
            self.decisions.selected_presets.insert(route_index, preset);
            return Ok(());
        }
        let before_values = self.authored.values.clone();
        let profile = preset.profile();
        let old_api = self
            .authored
            .values
            .pointer(&api_path)
            .cloned()
            .and_then(|value| serde_json::from_value::<InferenceApi>(value).ok());
        let api = old_api
            .filter(|api| preset.apis().contains(api))
            .unwrap_or(preset.apis()[0]);
        let provider = self
            .authored
            .values
            .pointer_mut(&provider_path)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| diagnostic("journey", "The shared provider must be an object."))?;
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
            .authored
            .values
            .pointer_mut(&route_path)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| diagnostic("journey", "The route must be an object."))?;
        let overrides = route
            .get_mut("overrides")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| diagnostic("journey", "The route needs model overrides."))?;
        if let Some(model) = profile.default_model {
            overrides.insert("model".into(), Value::String(model.into()));
        } else {
            overrides.remove("model");
        }
        for route in self.routes_for_provider(&previous_name) {
            self.decisions.selected_presets.remove(&route);
            self.decisions.accepted_presets.remove(&route);
        }
        self.reopen_models_for_provider(&previous_name, INFERENCE_PRESET);
        self.decisions.selected_presets.insert(route_index, preset);
        for field in [
            api_path,
            endpoint_path,
            format!("{provider_path}/credential/env"),
        ] {
            self.decisions.reopen(&field, INFERENCE_PRESET);
            self.decisions.omitted.remove(&field);
        }
        for field in self.decisions.accepted.clone() {
            if field.starts_with('/')
                && before_values.pointer(&field) != self.authored.values.pointer(&field)
            {
                self.decisions.reopen(&field, INFERENCE_PRESET);
                self.decisions.omitted.remove(&field);
            }
        }
        Ok(())
    }
}
