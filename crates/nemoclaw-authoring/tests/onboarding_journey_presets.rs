// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    Capabilities, JourneyDefinition, JourneyScope, PartialDocument, ProviderPreset,
};
use nemoclaw_sdk::config::{Document, InferenceApi, InferenceProviderKind};
use serde_json::{Value, json};

fn guided() -> nemoclaw_authoring::JourneyState {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    JourneyDefinition::new("guided-presets", base)
        .ask(["/spec/sandboxes/0/harness/kind", "inference:preset"])
        .ask([JourneyScope::InferenceApi])
        .ask([JourneyScope::RouteModels])
        .start(&capabilities)
        .unwrap()
}

fn choose_preset(preset: ProviderPreset) -> nemoclaw_authoring::JourneyState {
    let capabilities = Capabilities::available();
    let mut state = guided();
    state
        .answer(&capabilities, "inference:preset", Some(json!(preset.id())))
        .unwrap();
    state
}

#[test]
fn the_journey_advertises_every_fabric_harness_and_curated_provider() {
    let capabilities = Capabilities::available();
    let state = guided();
    let resolution = state.resolve(&capabilities).unwrap();
    let harnesses = resolution
        .question("/spec/sandboxes/0/harness/kind")
        .unwrap();
    assert_eq!(
        harnesses.choices(),
        capabilities
            .harnesses()
            .iter()
            .map(|kind| json!(kind.as_str()))
            .collect::<Vec<_>>()
    );
    let presets = resolution.question("inference:preset").unwrap();
    assert_eq!(
        presets.choices(),
        ProviderPreset::ALL
            .iter()
            .map(|preset| json!(preset.id()))
            .collect::<Vec<_>>()
    );
}

#[test]
fn every_curated_preset_and_protocol_roundtrips_through_the_sdk() {
    let capabilities = Capabilities::available();
    for preset in ProviderPreset::ALL {
        for api in preset.apis() {
            let mut state = guided();
            state
                .answer(&capabilities, "inference:preset", Some(json!(preset.id())))
                .unwrap();
            let endpoint = "/spec/inferenceProviders/0/endpoint";
            if state
                .resolve(&capabilities)
                .unwrap()
                .question(endpoint)
                .is_some()
            {
                state
                    .answer(
                        &capabilities,
                        endpoint,
                        Some(json!("https://inference.example.com/v1")),
                    )
                    .unwrap();
            }
            let api_path = "/spec/inferenceProviders/0/api";
            state
                .answer(
                    &capabilities,
                    api_path,
                    Some(serde_json::to_value(api).unwrap()),
                )
                .unwrap();
            let model_path = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
            if state
                .resolve(&capabilities)
                .unwrap()
                .question(model_path)
                .is_some()
            {
                let suggestion = state
                    .resolve(&capabilities)
                    .unwrap()
                    .question(model_path)
                    .unwrap()
                    .suggestion()
                    .cloned()
                    .unwrap_or_else(|| json!("organization/selected-model"));
                state
                    .answer(&capabilities, model_path, Some(suggestion))
                    .unwrap();
            }
            let resolution = state.resolve(&capabilities).unwrap();
            let document = resolution
                .assessment()
                .document()
                .unwrap_or_else(|| panic!("{}", preset.id()));
            assert_eq!(document.inference_provider().unwrap().api, Some(*api));
            let reopened = Document::parse(document.yaml().unwrap().as_bytes()).unwrap();
            assert_eq!(reopened, *document);
        }
    }
}

#[test]
fn custom_endpoint_questions_stay_user_facing_without_internal_provider_names() {
    let capabilities = Capabilities::available();
    let mut state = guided();
    state
        .answer(
            &capabilities,
            "inference:preset",
            Some(json!("openai-compatible")),
        )
        .unwrap();
    let endpoint = "/spec/inferenceProviders/0/endpoint";
    let resolution = state.resolve(&capabilities).unwrap();
    assert!(resolution.question(endpoint).is_some());
    assert!(
        resolution
            .question("/spec/inferenceProviders/0/name")
            .is_none()
    );
    assert!(
        resolution
            .question("/spec/inferenceProviders/0/credential/env")
            .is_none()
    );
    state
        .answer(
            &capabilities,
            endpoint,
            Some(json!("https://inference.example.com/v1")),
        )
        .unwrap();
    let model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    state
        .answer(&capabilities, model, Some(json!("example/reasoning-model")))
        .unwrap();
    let document = state
        .resolve(&capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    assert_eq!(
        document.inference_provider().unwrap().endpoint,
        "https://inference.example.com/v1"
    );
    assert_eq!(document.credential_names(), ["COMPATIBLE_API_KEY"]);
}

#[test]
fn switching_runtime_preserves_the_selected_model() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("runtime", base)
        .ask(["/spec/sandboxes/0/runtime/provider"])
        .start(&capabilities)
        .unwrap();
    let model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    let before: Value = state.values().pointer(model).unwrap().clone();
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/runtime/provider",
            Some(json!("podman")),
        )
        .unwrap();
    assert_eq!(state.values().pointer(model), Some(&before));
    assert_eq!(
        state.values().pointer("/spec/gateway/engine"),
        Some(&json!("unix:///run/user/1000/podman/podman.sock"))
    );
}

#[test]
fn provider_presets_offer_the_expected_connection_and_model_suggestions() {
    let capabilities = Capabilities::available();
    let model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    let cases = [
        (
            ProviderPreset::OpenAi,
            "https://api.openai.com/v1",
            "OPENAI_API_KEY",
            "gpt-5.4",
            InferenceProviderKind::Openai,
        ),
        (
            ProviderPreset::Anthropic,
            "https://api.anthropic.com",
            "ANTHROPIC_API_KEY",
            "claude-sonnet-4-6",
            InferenceProviderKind::Anthropic,
        ),
        (
            ProviderPreset::Gemini,
            "https://generativelanguage.googleapis.com/v1beta/openai/",
            "GEMINI_API_KEY",
            "gemini-3.6-flash",
            InferenceProviderKind::Openai,
        ),
        (
            ProviderPreset::Nous,
            "https://inference-api.nousresearch.com/v1",
            "OPENAI_API_KEY",
            "moonshotai/kimi-k2.6",
            InferenceProviderKind::Openai,
        ),
    ];
    for (preset, endpoint, credential, suggested_model, kind) in cases {
        let mut state = choose_preset(preset);
        let question = state
            .resolve(&capabilities)
            .unwrap()
            .question(model)
            .cloned()
            .unwrap();
        assert_eq!(
            question.suggestion(),
            Some(&json!(suggested_model)),
            "{}",
            preset.id()
        );
        state
            .answer(&capabilities, model, Some(json!(suggested_model)))
            .unwrap();
        let resolution = state.resolve(&capabilities).unwrap();
        let document = resolution.assessment().document().unwrap();
        let provider = document.inference_provider().unwrap();
        assert_eq!(provider.endpoint, endpoint, "{}", preset.id());
        assert_eq!(provider.provider, kind, "{}", preset.id());
        assert_eq!(document.credential_names(), [credential], "{}", preset.id());
    }
}

#[test]
fn a_hermes_author_can_select_nous_without_losing_the_selected_harness() {
    let capabilities = Capabilities::available();
    let mut state = guided();
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/harness/kind",
            Some(json!("nvidia.fabric.hermes")),
        )
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("inference:preset")
            .unwrap()
            .choices()
            .contains(&json!("nous"))
    );
    state
        .answer(&capabilities, "inference:preset", Some(json!("nous")))
        .unwrap();
    assert_eq!(
        state.values().pointer("/spec/sandboxes/0/harness/kind"),
        Some(&json!("nvidia.fabric.hermes"))
    );
    assert_eq!(
        state
            .values()
            .pointer("/spec/inferenceProviders/0/endpoint"),
        Some(&json!("https://inference-api.nousresearch.com/v1"))
    );
}

#[test]
fn a_pi_author_can_explicitly_choose_responses_api() {
    let capabilities = Capabilities::available();
    let mut state = guided();
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/harness/kind",
            Some(json!("nvidia.fabric.pi")),
        )
        .unwrap();
    state
        .answer(
            &capabilities,
            "inference:preset",
            Some(json!("nvidia-endpoints")),
        )
        .unwrap();
    let api = "/spec/inferenceProviders/0/api";
    state
        .answer(&capabilities, api, Some(json!("openai-responses")))
        .unwrap();
    let document = state
        .resolve(&capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    assert_eq!(
        document.inference_provider().unwrap().api,
        Some(InferenceApi::OpenaiResponses)
    );
}
