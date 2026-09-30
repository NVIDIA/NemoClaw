// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl JourneyState {
    pub(super) fn route_model_path(&self) -> Option<String> {
        let index = self.selected_route?;
        Some(format!(
            "{}/{index}/overrides/model",
            routes_path(&self.values)?
        ))
    }

    pub(super) fn route_provider(&self) -> Option<(usize, usize)> {
        let route = self.selected_route?;
        let reference = self
            .values
            .pointer(&format!(
                "{}/{route}/providerRef",
                routes_path(&self.values)?
            ))?
            .as_str()?;
        let providers = self
            .values
            .pointer("/spec/inferenceProviders")?
            .as_array()?;
        let provider = providers
            .iter()
            .position(|item| item.get("name").and_then(Value::as_str) == Some(reference))?;
        (providers[provider].get("serviceRef").is_none()).then_some((route, provider))
    }

    pub(super) fn provider_path(&self) -> Option<String> {
        self.route_provider()
            .map(|(_, provider)| format!("/spec/inferenceProviders/{provider}"))
    }

    pub(super) fn current_preset(&self) -> Option<ProviderPreset> {
        let (route, provider_index) = self.route_provider()?;
        if let Some(preset) = self.selected_presets.get(&route).copied() {
            return Some(preset);
        }
        let provider = self
            .values
            .pointer(&format!("/spec/inferenceProviders/{provider_index}"))?;
        let kind: InferenceProviderKind =
            serde_json::from_value(provider.get("provider")?.clone()).ok()?;
        let endpoint = provider.get("endpoint")?.as_str()?;
        ProviderPreset::ALL
            .into_iter()
            .find(|preset| preset.profile().kind == kind && preset.profile().endpoint == endpoint)
            .or_else(|| {
                ProviderPreset::ALL.into_iter().find(|preset| {
                    preset.profile().kind == kind && preset.profile().custom_endpoint
                })
            })
    }
}
