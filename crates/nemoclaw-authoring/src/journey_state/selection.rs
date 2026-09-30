// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// Read-only interpretation of the current route and its provider.
struct SelectionView<'a> {
    values: &'a Value,
    decisions: &'a DecisionRecord,
    position: &'a JourneyPosition,
}

impl SelectionView<'_> {
    fn route_model_path(&self) -> Option<String> {
        let index = self.position.selected_route?;
        Some(format!(
            "{}/{index}/overrides/model",
            routes_path(self.values)?
        ))
    }

    fn route_provider(&self) -> Option<(usize, usize)> {
        let route = self.position.selected_route?;
        let reference = self
            .values
            .pointer(&format!(
                "{}/{route}/providerRef",
                routes_path(self.values)?
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

    fn provider_path(&self) -> Option<String> {
        self.route_provider()
            .map(|(_, provider)| format!("/spec/inferenceProviders/{provider}"))
    }

    fn current_preset(&self) -> Option<ProviderPreset> {
        let (route, provider_index) = self.route_provider()?;
        if let Some(preset) = self.decisions.selected_presets.get(&route).copied() {
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

impl JourneyState {
    fn selection(&self) -> SelectionView<'_> {
        SelectionView {
            values: &self.authored.values,
            decisions: &self.decisions,
            position: &self.position,
        }
    }
    pub(super) fn route_model_path(&self) -> Option<String> {
        self.selection().route_model_path()
    }
    pub(super) fn route_provider(&self) -> Option<(usize, usize)> {
        self.selection().route_provider()
    }
    pub(super) fn current_preset(&self) -> Option<ProviderPreset> {
        self.selection().current_preset()
    }
}

impl super::resolver::QuestionResolver<'_> {
    fn selection(&self) -> SelectionView<'_> {
        SelectionView {
            values: &self.authored.values,
            decisions: self.decisions,
            position: self.position,
        }
    }
    pub(super) fn route_model_path(&self) -> Option<String> {
        self.selection().route_model_path()
    }
    pub(super) fn route_provider(&self) -> Option<(usize, usize)> {
        self.selection().route_provider()
    }
    pub(super) fn provider_path(&self) -> Option<String> {
        self.selection().provider_path()
    }
    pub(super) fn current_preset(&self) -> Option<ProviderPreset> {
        self.selection().current_preset()
    }
}
