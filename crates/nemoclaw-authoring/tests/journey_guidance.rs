// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    Capabilities, JourneyDefinition, JourneyQuestionReason, JourneyScope, PartialDocument,
    ProviderPreset, inference_request_for_document,
};
use nemoclaw_sdk::config::{Document, InferenceApi};
use nemoclaw_sdk::fabric_catalog::FabricCatalog;
use serde_json::{Value, json};

fn supplied() -> Value {
    serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml")).unwrap()
}

fn journey(values: Value, capabilities: &Capabilities) -> nemoclaw_authoring::JourneyState {
    JourneyDefinition::new(
        "guided",
        PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap(),
    )
    .ask([
        "/metadata/name",
        "/spec/sandboxes/0/harness/kind",
        "inference:preset",
    ])
    .ask([JourneyScope::InferenceApi, JourneyScope::RouteModels])
    .start(capabilities)
    .unwrap()
}

#[test]
fn supplied_values_are_suggestions_for_finite_and_free_text_questions() {
    let capabilities = Capabilities::available();
    let state = journey(supplied(), &capabilities);
    let resolved = state.resolve(&capabilities).unwrap();
    let name = resolved.question("/metadata/name").unwrap();
    assert_eq!(name.reason(), JourneyQuestionReason::ExplicitAsk);
    assert_eq!(name.suggestion(), Some(&json!("openclaw-nvidia-hosted")));
    assert!(name.choices().is_empty());
    let harness = resolved.question("/spec/sandboxes/0/harness/kind").unwrap();
    assert_eq!(harness.suggestion(), Some(&json!("nvidia.fabric.openclaw")));
    assert_eq!(harness.choices().len(), capabilities.harnesses().len());
}

#[test]
fn generated_yaml_reopens_as_the_same_supplied_intent() {
    let capabilities = Capabilities::available();
    let mut state = journey(supplied(), &capabilities);
    state
        .answer(
            &capabilities,
            "inference:preset",
            Some(json!("nvidia-endpoints")),
        )
        .unwrap();
    state
        .answer(
            &capabilities,
            "/spec/inferenceProviders/0/api",
            Some(json!("openai-responses")),
        )
        .unwrap();
    let document = state
        .resolve(&capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    let yaml = document.yaml().unwrap();
    let reopened = Document::parse(yaml.as_bytes()).unwrap();
    let again = journey(
        serde_saphyr::from_slice(yaml.as_bytes()).unwrap(),
        &capabilities,
    );
    assert_eq!(reopened, document);
    assert_eq!(
        again.values().pointer("/metadata/uid"),
        state.values().pointer("/metadata/uid")
    );
    assert_eq!(
        again.values().pointer("/spec/inferenceProviders/0/api"),
        Some(&json!("openai-responses"))
    );
    assert_eq!(
        again
            .values()
            .pointer("/spec/sandboxes/0/agent/inference/routes/0/overrides/model"),
        state
            .values()
            .pointer("/spec/sandboxes/0/agent/inference/routes/0/overrides/model")
    );
}

#[test]
fn every_advertised_harness_keeps_provider_protocol_choices() {
    let capabilities = Capabilities::available();
    for harness in capabilities.harnesses() {
        for preset in ProviderPreset::ALL {
            let mut state = journey(supplied(), &capabilities);
            state
                .answer(
                    &capabilities,
                    "/spec/sandboxes/0/harness/kind",
                    Some(json!(harness.as_str())),
                )
                .unwrap();
            state
                .answer(&capabilities, "inference:preset", Some(json!(preset.id())))
                .unwrap();
            let api = state
                .resolve(&capabilities)
                .unwrap()
                .question("/spec/inferenceProviders/0/api")
                .cloned()
                .unwrap();
            assert_eq!(
                api.choices(),
                preset
                    .apis()
                    .iter()
                    .map(|choice| serde_json::to_value(choice).unwrap())
                    .collect::<Vec<_>>(),
                "{} {}",
                harness.as_str(),
                preset.id()
            );
        }
    }
}

#[test]
fn changing_a_model_preserves_an_explicit_target_engine() {
    let capabilities = Capabilities::available();
    let mut values = supplied();
    values["spec"]["gateway"]["engine"] = json!("unix:///tmp/owned-discovery-fixture.sock");
    let mut state = journey(values, &capabilities);
    state
        .answer(
            &capabilities,
            "inference:preset",
            Some(json!("nvidia-endpoints")),
        )
        .unwrap();
    let model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    state
        .answer(&capabilities, model, Some(json!("updated-model")))
        .unwrap();
    assert_eq!(
        state.values().pointer("/spec/gateway/engine"),
        Some(&json!("unix:///tmp/owned-discovery-fixture.sock"))
    );
}

#[test]
fn an_anonymous_local_provider_is_lossless_without_a_credential_reference() {
    let capabilities = Capabilities::available();
    let mut values = supplied();
    values["spec"]["inferenceProviders"][0]["endpoint"] = json!("http://127.0.0.1:11434/v1");
    values["spec"]["inferenceProviders"][0]
        .as_object_mut()
        .unwrap()
        .remove("credential");
    values["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["overrides"]["model"] =
        json!("local-model");
    let mut state = journey(values, &capabilities);
    state
        .answer(
            &capabilities,
            "inference:preset",
            Some(json!("openai-compatible")),
        )
        .unwrap();
    state
        .answer(
            &capabilities,
            "/spec/inferenceProviders/0/endpoint",
            Some(json!("http://127.0.0.1:11434/v1")),
        )
        .unwrap();
    let model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    state
        .answer(&capabilities, model, Some(json!("local-model")))
        .unwrap();
    let document = state
        .resolve(&capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    assert!(document.inference_provider().unwrap().credential.is_none());
    let reopened = Document::parse(document.yaml().unwrap().as_bytes()).unwrap();
    assert_eq!(reopened, document);
    assert_eq!(
        inference_request_for_document(&document, None).unwrap().api,
        InferenceApi::OpenaiCompletions
    );
    assert!(
        inference_request_for_document(&document, None)
            .unwrap()
            .credential_env
            .is_none()
    );
}

#[test]
fn newly_advertised_fabric_harness_is_a_choice_without_code_registration() {
    let mut catalog = FabricCatalog::bundled();
    let mut adapter = catalog.adapters[0].clone();
    adapter.descriptor["adapter_id"] = json!("test.fixture.new-agent");
    catalog.adapters.push(adapter);
    let capabilities = Capabilities::from_catalog(&catalog);
    let mut state = journey(supplied(), &capabilities);
    let harness = "/spec/sandboxes/0/harness/kind";
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(harness)
            .unwrap()
            .choices()
            .contains(&json!("test.fixture.new-agent"))
    );
    state
        .answer(
            &capabilities,
            harness,
            Some(json!("test.fixture.new-agent")),
        )
        .unwrap();
    assert_eq!(
        state.values().pointer(harness),
        Some(&json!("test.fixture.new-agent"))
    );
    let document = state
        .resolve(&capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    assert_eq!(
        document.spec.sandboxes[0]
            .harness
            .as_ref()
            .unwrap()
            .kind
            .as_str(),
        "test.fixture.new-agent"
    );
}

#[test]
fn offline_catalog_absence_does_not_prevent_an_independent_rename() {
    let capabilities = Capabilities::from_harnesses([]);
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("offline-rename", base)
        .ask(["/metadata/name"])
        .start(&capabilities)
        .unwrap();
    let before = state.values().pointer("/spec").cloned().unwrap();
    state
        .answer(
            &capabilities,
            "/metadata/name",
            Some(json!("offline-rename")),
        )
        .unwrap();
    assert_eq!(state.values().pointer("/spec"), Some(&before));
    assert_eq!(
        state.values().pointer("/metadata/name"),
        Some(&json!("offline-rename"))
    );
    assert!(
        !state
            .resolve(&capabilities)
            .unwrap()
            .unverified()
            .is_empty()
    );
}
