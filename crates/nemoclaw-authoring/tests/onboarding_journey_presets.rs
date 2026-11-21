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
        .ask(["/spec/sandboxes/assistant/harness/kind", "inference:preset"])
        // Exact guidance asks the API even where the vendor's preset decides it.
        .ask(["/spec/inferenceProviders/nvidia-prod/api"])
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
        .question("/spec/sandboxes/assistant/agent/inference/routes/0/overrides/model")
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
        .question("/spec/sandboxes/assistant/agent/inference/routes/0/overrides/model")
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
    let path = "/spec/sandboxes/assistant/agent/inference/routes/0/overrides/model";
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
    let model = "/spec/sandboxes/assistant/agent/inference/routes/0/overrides/model";
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("editable-endpoint", base)
        .ask([
            "inference:preset",
            "/spec/inferenceProviders/nvidia-prod/endpoint",
        ])
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
            "/spec/inferenceProviders/nvidia-prod/endpoint",
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
                "/spec/inferenceProviders/nvidia-prod/endpoint",
                Some(json!("https://private.example/v1")),
            )
            .unwrap();
        let model = "/spec/sandboxes/assistant/agent/inference/routes/0/overrides/model";
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
            .question("/spec/sandboxes/assistant/agent/inference/routes/0/overrides/model")
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

const MODEL: &str = "/spec/sandboxes/assistant/agent/inference/routes/0/overrides/model";

/// The state's observations of an endpoint that answered with `models`.
fn listing(
    state: &nemoclaw_authoring::JourneyState,
    models: &[&str],
) -> nemoclaw_sdk::discovery::DiscoveryObservations {
    use nemoclaw_sdk::{
        discovery::{
            DiscoveryObservation, DiscoveryObservations, DiscoveryQuery, ObservationStatus,
        },
        inference_discovery::{AuthenticationStatus, EndpointObservation},
    };
    let resolution = state.resolve(&Capabilities::available()).unwrap();
    let request = nemoclaw_authoring::inference_request_for_document(
        resolution.assessment().document().unwrap(),
        state.current_route(),
    )
    .unwrap()
    .unwrap();
    DiscoveryObservations::new().with(
        DiscoveryQuery::Inference(request),
        DiscoveryObservation::Inference(EndpointObservation {
            status: ObservationStatus::Available,
            reachable: Some(true),
            authentication: AuthenticationStatus::Accepted,
            models: models.iter().map(|model| (*model).into()).collect(),
            reason: None,
            source: "fixture".into(),
            api_verified: false,
        }),
    )
}

#[test]
fn a_vendor_offers_only_its_recommended_models_from_the_endpoint_list() {
    let capabilities = Capabilities::available();
    let state = choose_preset(ProviderPreset::NvidiaEndpoints);
    // The endpoint lists the whole catalog, models that cannot drive an agent
    // included, and leaves out one recommended model.
    let observations = listing(
        &state,
        &[
            "adept/fuyu-8b",
            "bigcode/starcoder2-15b",
            "google/deplot",
            "nvidia/nemotron-3-ultra-550b-a55b",
            "nvidia/nemotron-3.5-super-vl-120b-a12b",
        ],
    );
    let resolution = state
        .resolve_with_observations(&capabilities, &observations)
        .unwrap();
    let question = resolution.question(MODEL).unwrap();
    assert_eq!(
        question.choices(),
        [
            json!("nvidia/nemotron-3.5-super-vl-120b-a12b"),
            json!("nvidia/nemotron-3-ultra-550b-a55b"),
        ]
    );
    assert!(question.allows_custom_answer());
}

#[test]
fn a_recommended_default_the_endpoint_does_not_list_is_not_suggested() {
    let capabilities = Capabilities::available();
    let state = choose_preset(ProviderPreset::NvidiaEndpoints);
    let observations = listing(&state, &["nvidia/nemotron-3-ultra-550b-a55b"]);
    let resolution = state
        .resolve_with_observations(&capabilities, &observations)
        .unwrap();
    let question = resolution.question(MODEL).unwrap();
    assert_eq!(
        question.choices(),
        [json!("nvidia/nemotron-3-ultra-550b-a55b")]
    );
    assert_eq!(
        question.suggestion(),
        Some(&json!("nvidia/nemotron-3-ultra-550b-a55b"))
    );
}

#[test]
fn a_list_that_names_no_recommended_model_offers_the_models_it_lists() {
    let capabilities = Capabilities::available();
    for preset in [ProviderPreset::OpenAi, ProviderPreset::Nous] {
        let state = choose_preset(preset);
        let observations = listing(&state, &["vendor/alpha", "vendor/beta"]);
        let resolution = state
            .resolve_with_observations(&capabilities, &observations)
            .unwrap();
        let question = resolution.question(MODEL).unwrap();
        assert_eq!(
            question.choices(),
            [json!("vendor/alpha"), json!("vendor/beta")],
            "{}",
            preset.id()
        );
        assert_eq!(question.suggestion(), None, "{}", preset.id());
        assert!(question.allows_custom_answer());
    }
}

#[test]
fn an_empty_endpoint_list_does_not_remove_the_recommendations() {
    let capabilities = Capabilities::available();
    let state = choose_preset(ProviderPreset::OpenAi);
    let observations = listing(&state, &[]);
    let resolution = state
        .resolve_with_observations(&capabilities, &observations)
        .unwrap();
    let question = resolution.question(MODEL).unwrap();
    for model in ProviderPreset::OpenAi.recommended_models() {
        assert!(question.choices().contains(&json!(model)), "{model}");
    }
    assert!(resolution.information().is_empty());
}

#[test]
fn a_supplied_custom_model_stays_offered_beside_the_recommended_ones() {
    let capabilities = Capabilities::available();
    let mut state = choose_preset(ProviderPreset::OpenAi);
    state
        .answer(&capabilities, MODEL, Some(json!("custom/model")))
        .unwrap();
    let supplied = nemoclaw_authoring::JourneyDefinition::new(
        "supplied",
        PartialDocument::from_yaml(&serde_json::to_vec(state.values()).unwrap()).unwrap(),
    )
    .ask([JourneyScope::RouteModels])
    .start(&capabilities)
    .unwrap();
    let observations = listing(&supplied, &["gpt-5.4-mini", "vendor/new-model"]);
    let resolution = supplied
        .resolve_with_observations(&capabilities, &observations)
        .unwrap();
    let question = resolution.question(MODEL).unwrap();
    assert_eq!(question.suggestion(), Some(&json!("custom/model")));
    assert_eq!(
        question.choices(),
        [json!("custom/model"), json!("gpt-5.4-mini")]
    );
}

#[test]
fn generic_endpoints_keep_offering_the_models_they_list() {
    let capabilities = Capabilities::available();
    for preset in [
        ProviderPreset::OpenAiCompatible,
        ProviderPreset::AnthropicCompatible,
    ] {
        let mut state = choose_preset(preset);
        state
            .answer(
                &capabilities,
                "/spec/inferenceProviders/nvidia-prod/endpoint",
                Some(json!("https://private.example/v1")),
            )
            .unwrap();
        state
            .answer(&capabilities, MODEL, Some(json!("private/custom")))
            .unwrap();
        // Reopen the model question on the authored document.
        let supplied = nemoclaw_authoring::JourneyDefinition::new(
            "supplied",
            PartialDocument::from_yaml(&serde_json::to_vec(state.values()).unwrap()).unwrap(),
        )
        .ask([JourneyScope::RouteModels])
        .start(&capabilities)
        .unwrap();
        let observations = listing(&supplied, &["private/alpha", "private/beta"]);
        let resolution = supplied
            .resolve_with_observations(&capabilities, &observations)
            .unwrap();
        assert_eq!(
            resolution.question(MODEL).unwrap().choices(),
            [
                json!("private/custom"),
                json!("private/alpha"),
                json!("private/beta")
            ],
            "{}",
            preset.id()
        );
    }
}

#[test]
fn a_model_the_endpoint_does_not_list_is_reported_without_echoing_it() {
    let capabilities = Capabilities::available();
    let mut state = choose_preset(ProviderPreset::OpenAi);
    let observations = listing(&state, &["gpt-5.4", "gpt-5.4-mini"]);
    let pending = state
        .resolve_with_observations(&capabilities, &observations)
        .unwrap();
    // The model is still being asked, so nothing is reported yet.
    assert!(pending.question(MODEL).is_some());
    assert!(pending.information().is_empty());
    for (model, reported) in [
        ("gpt-5.4-mini", false),
        ("PRIVATE_SENTINEL/typed-model", true),
    ] {
        state
            .answer(&capabilities, MODEL, Some(json!(model)))
            .unwrap();
        let resolution = state
            .resolve_with_observations(&capabilities, &observations)
            .unwrap();
        let information = resolution.information().join(" ");
        assert_eq!(
            information.contains("does not include the selected model"),
            reported,
            "{information}"
        );
        assert!(!information.contains("PRIVATE_SENTINEL"));
        assert_eq!(state.values().pointer(MODEL), Some(&json!(model)));
    }
}

#[test]
fn every_vendor_default_is_one_of_its_recommended_models() {
    for preset in ProviderPreset::ALL
        .into_iter()
        .filter(|preset| !preset.recommended_models().is_empty())
    {
        let state = choose_preset(preset);
        let model = state
            .values()
            .pointer(MODEL)
            .and_then(Value::as_str)
            .unwrap();
        assert!(
            preset.recommended_models().contains(&model),
            "{}",
            preset.id()
        );
        assert_eq!(preset.recommended_models()[0], model, "{}", preset.id());
    }
}

#[test]
fn the_journey_advertises_every_fabric_harness_and_curated_provider() {
    let capabilities = Capabilities::available();
    let state = guided();
    let resolution = state.resolve(&capabilities).unwrap();
    let harnesses = resolution
        .question("/spec/sandboxes/assistant/harness/kind")
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
            let endpoint = "/spec/inferenceProviders/nvidia-prod/endpoint";
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
            let api_path = "/spec/inferenceProviders/nvidia-prod/api";
            state
                .answer(
                    &capabilities,
                    api_path,
                    Some(serde_json::to_value(api).unwrap()),
                )
                .unwrap();
            let model_path = "/spec/sandboxes/assistant/agent/inference/routes/0/overrides/model";
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
    let endpoint = "/spec/inferenceProviders/nvidia-prod/endpoint";
    let resolution = state.resolve(&capabilities).unwrap();
    assert!(resolution.question(endpoint).is_some());
    assert!(
        resolution
            .question("/spec/inferenceProviders/nvidia-prod/credential/env")
            .is_none()
    );
    state
        .answer(
            &capabilities,
            endpoint,
            Some(json!("https://inference.example.com/v1")),
        )
        .unwrap();
    let model = "/spec/sandboxes/assistant/agent/inference/routes/0/overrides/model";
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
    // The provider keeps the template's internal name, its key; no question asks for one.
    assert_eq!(
        document.spec.inference_providers.keys().collect::<Vec<_>>(),
        ["nvidia-prod"]
    );
}

#[test]
fn switching_runtime_preserves_the_selected_model() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("runtime", base)
        .ask(["/spec/gateway/target"])
        .start(&capabilities)
        .unwrap();
    let model = "/spec/sandboxes/assistant/agent/inference/routes/0/overrides/model";
    let before: Value = state.values().pointer(model).unwrap().clone();
    let podman = "unix:///run/user/501/podman/podman.sock";
    crate::support::found_local_engines(
        &mut state,
        &[(podman, nemoclaw_sdk::config::ComputeDriver::Podman)],
    );
    state
        .answer(&capabilities, "/spec/gateway/target", Some(json!("podman")))
        .unwrap();
    assert_eq!(state.values().pointer(model), Some(&before));
    assert_eq!(
        state.values().pointer("/spec/gateway/target/podman/engine"),
        Some(&json!(podman))
    );
}

#[test]
fn provider_presets_offer_the_expected_connection_and_model_suggestions() {
    let capabilities = Capabilities::available();
    let model = "/spec/sandboxes/assistant/agent/inference/routes/0/overrides/model";
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
            "NOUS_API_KEY",
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
            "/spec/sandboxes/assistant/harness/kind",
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
        state
            .values()
            .pointer("/spec/sandboxes/assistant/harness/kind"),
        Some(&json!("nvidia.fabric.hermes"))
    );
    assert_eq!(
        state
            .values()
            .pointer("/spec/inferenceProviders/nvidia-prod/endpoint"),
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
            "/spec/sandboxes/assistant/harness/kind",
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
    let api = "/spec/inferenceProviders/nvidia-prod/api";
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

#[test]
fn a_vendor_endpoint_names_its_preset_and_a_custom_endpoint_names_none() {
    let openai = InferenceProviderKind::Openai;
    let nvidia = "https://integrate.api.nvidia.com/v1";
    assert_eq!(
        ProviderPreset::for_endpoint(openai, nvidia),
        Some(ProviderPreset::NvidiaEndpoints)
    );
    // The preset is also the API it speaks there.
    assert_eq!(
        ProviderPreset::for_endpoint(InferenceProviderKind::Anthropic, nvidia),
        None
    );
    for endpoint in [
        "https://inference.example.com/v1",
        "http://172.20.0.1:11446/v1",
    ] {
        assert_eq!(ProviderPreset::for_endpoint(openai, endpoint), None);
    }
}
