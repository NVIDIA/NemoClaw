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
fn a_vendor_offers_curated_models_without_endpoint_discovery() {
    let capabilities = Capabilities::available();
    let state = choose_preset(ProviderPreset::OpenAi);
    let resolution = state.resolve(&capabilities).unwrap();
    let question = resolution
        .question("/spec/sandboxes/0/agent/inference/routes/0/overrides/model")
        .unwrap();
    assert!(question.choices().contains(&json!("gpt-5.4")));
    assert!(question.choices().contains(&json!("gpt-5.4-mini")));
    assert!(question.allows_custom_answer());
}

#[test]
fn a_missing_catalog_key_keeps_offline_recommendations_without_verifying_access() {
    use nemoclaw_sdk::{
        discovery::{
            DiscoveryObservation, DiscoveryObservations, DiscoveryQuery, ObservationStatus,
        },
        inference_discovery::{AuthenticationStatus, EndpointObservation},
    };
    let capabilities = Capabilities::available();
    let state = choose_preset(ProviderPreset::OpenAi);
    let resolution = state.resolve(&capabilities).unwrap();
    let request = nemoclaw_authoring::inference_request_for_document(
        resolution.assessment().document().unwrap(),
        state.current_route(),
    )
    .unwrap()
    .unwrap();
    let observations = DiscoveryObservations::new().with(
        DiscoveryQuery::Inference(request),
        DiscoveryObservation::Inference(EndpointObservation {
            status: ObservationStatus::Unavailable,
            reachable: Some(true),
            authentication: AuthenticationStatus::Required,
            models: Vec::new(),
            reason: None,
            source: "fixture".into(),
            api_verified: false,
        }),
    );
    let resolution = state
        .resolve_with_observations(&capabilities, &observations)
        .unwrap();
    let question = resolution
        .question("/spec/sandboxes/0/agent/inference/routes/0/overrides/model")
        .unwrap();
    assert!(question.choices().contains(&json!("gpt-5.4-mini")));
    assert!(
        resolution
            .information()
            .iter()
            .any(|note| note.contains("Model catalog needs credential"))
    );
    assert!(
        state
            .delegate_remaining(&capabilities, &observations)
            .is_err()
    );
}

#[test]
fn catalog_membership_is_checked_without_blocking_or_echoing_custom_models() {
    let capabilities = Capabilities::available();
    let mut state = choose_preset(ProviderPreset::OpenAi);
    let path = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    for (model, outside) in [
        ("gpt-5.4-mini", false),
        ("PRIVATE_SENTINEL/custom-model", true),
    ] {
        state
            .answer(&capabilities, path, Some(json!(model)))
            .unwrap();
        let resolution = state.resolve(&capabilities).unwrap();
        let information = resolution.information().join(" ");
        assert_eq!(
            information.contains("outside the curated OpenAI catalog"),
            outside
        );
        assert!(!information.contains("PRIVATE_SENTINEL"));
        assert_eq!(state.values().pointer(path), Some(&json!(model)));
        assert!(resolution.assessment().document().is_some());
    }
}

#[test]
fn vendor_catalogs_follow_the_endpoint_and_preserve_an_unlisted_suggestion() {
    let capabilities = Capabilities::available();
    let model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("editable-endpoint", base)
        .ask(["inference:preset", "/spec/inferenceProviders/0/endpoint"])
        .ask([JourneyScope::RouteModels])
        .start(&capabilities)
        .unwrap();
    state
        .answer(&capabilities, "inference:preset", Some(json!("openai")))
        .unwrap();
    state
        .answer(&capabilities, model, Some(json!("custom/model")))
        .unwrap();
    // Revisit the accepted model through a fresh journey to check menu behavior.
    let state_with_supplied = JourneyDefinition::new(
        "supplied",
        PartialDocument::from_yaml(&serde_json::to_vec(state.values()).unwrap()).unwrap(),
    )
    .ask([JourneyScope::RouteModels])
    .start(&capabilities)
    .unwrap();
    let resolution = state_with_supplied.resolve(&capabilities).unwrap();
    let question = resolution.question(model).unwrap();
    assert_eq!(question.suggestion(), Some(&json!("custom/model")));
    assert!(question.choices().contains(&json!("custom/model")));
    assert!(question.choices().contains(&json!("gpt-5.4-mini")));
    state
        .answer(
            &capabilities,
            "/spec/inferenceProviders/0/endpoint",
            Some(json!("https://private.example/v1")),
        )
        .unwrap();
    let resolution = state.resolve(&capabilities).unwrap();
    assert!(resolution.question(model).unwrap().choices().is_empty());
    assert!(
        !resolution
            .information()
            .iter()
            .any(|note| note.contains("curated OpenAI"))
    );
}

#[test]
fn vendor_catalogs_are_not_applied_to_generic_endpoints() {
    let capabilities = Capabilities::available();
    for preset in [
        ProviderPreset::OpenAiCompatible,
        ProviderPreset::AnthropicCompatible,
    ] {
        let mut state = choose_preset(preset);
        state
            .answer(
                &capabilities,
                "/spec/inferenceProviders/0/endpoint",
                Some(json!("https://private.example/v1")),
            )
            .unwrap();
        let model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
        let resolution = state.resolve(&capabilities).unwrap();
        assert!(resolution.question(model).unwrap().choices().is_empty());
        state
            .answer(&capabilities, model, Some(json!("private/custom")))
            .unwrap();
        assert!(
            !state
                .resolve(&capabilities)
                .unwrap()
                .information()
                .iter()
                .any(|note| note.contains("curated"))
        );
    }
}

#[test]
fn every_named_vendor_offers_its_default_and_catalog_alternatives() {
    let capabilities = Capabilities::available();
    for preset in ProviderPreset::ALL
        .into_iter()
        .filter(|preset| !preset.recommended_models().is_empty())
    {
        let state = choose_preset(preset);
        let resolution = state.resolve(&capabilities).unwrap();
        let question = resolution
            .question("/spec/sandboxes/0/agent/inference/routes/0/overrides/model")
            .unwrap();
        assert!(question.choices().len() > 1, "{}", preset.id());
        assert!(question.choices().contains(question.suggestion().unwrap()));
        for model in preset.recommended_models() {
            assert!(
                question.choices().contains(&json!(model)),
                "{}",
                preset.id()
            );
        }
        let unique = question
            .choices()
            .iter()
            .map(Value::to_string)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(unique.len(), question.choices().len());
    }
}

#[test]
fn endpoint_discovery_supplements_the_curated_menu_without_duplicates() {
    use nemoclaw_sdk::{
        discovery::{
            DiscoveryObservation, DiscoveryObservations, DiscoveryQuery, ObservationStatus,
        },
        inference_discovery::{AuthenticationStatus, EndpointObservation},
    };
    let capabilities = Capabilities::available();
    let state = choose_preset(ProviderPreset::OpenAi);
    let resolution = state.resolve(&capabilities).unwrap();
    let request = nemoclaw_authoring::inference_request_for_document(
        resolution.assessment().document().unwrap(),
        state.current_route(),
    )
    .unwrap()
    .unwrap();
    let observations = DiscoveryObservations::new().with(
        DiscoveryQuery::Inference(request),
        DiscoveryObservation::Inference(EndpointObservation {
            status: ObservationStatus::Available,
            reachable: Some(true),
            authentication: AuthenticationStatus::Accepted,
            models: vec!["gpt-5.4-mini".into(), "vendor/new-model".into()],
            reason: None,
            source: "fixture".into(),
            api_verified: false,
        }),
    );
    let resolution = state
        .resolve_with_observations(&capabilities, &observations)
        .unwrap();
    let question = resolution
        .question("/spec/sandboxes/0/agent/inference/routes/0/overrides/model")
        .unwrap();
    assert!(question.choices().contains(&json!("gpt-5.4-nano")));
    assert!(question.choices().contains(&json!("vendor/new-model")));
    let unique = question
        .choices()
        .iter()
        .map(Value::to_string)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(unique.len(), question.choices().len());
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
        .ask(["/spec/gateway/runtime/provider"])
        .start(&capabilities)
        .unwrap();
    let model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    let before: Value = state.values().pointer(model).unwrap().clone();
    let podman = "unix:///run/user/501/podman/podman.sock";
    crate::support::found_local_engines(
        &mut state,
        &[(podman, nemoclaw_sdk::config::ComputeDriver::Podman)],
    );
    state
        .answer(
            &capabilities,
            "/spec/gateway/runtime/provider",
            Some(json!("podman")),
        )
        .unwrap();
    assert_eq!(state.values().pointer(model), Some(&before));
    assert_eq!(
        state.values().pointer("/spec/gateway/engine"),
        Some(&json!(podman))
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
