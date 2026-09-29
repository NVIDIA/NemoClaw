// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{Capabilities, JourneyDefinition, JourneyScope, PartialDocument};
use nemoclaw_sdk::config::{Document, InferenceApi, InferenceProviderKind, NetworkPolicy};
use serde_json::{Value, json};

fn supplied() -> Value {
    serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml")).unwrap()
}

fn start(values: Value, capabilities: &Capabilities) -> nemoclaw_authoring::JourneyState {
    let base = PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap();
    JourneyDefinition::new("boundaries", base)
        .ask([JourneyScope::RouteModels])
        .start(capabilities)
        .unwrap()
}

#[test]
fn supplied_hosted_defaults_remain_an_sdk_valid_isolated_document() {
    let capabilities = Capabilities::available();
    let state = start(supplied(), &capabilities);
    let document = state
        .resolve(&capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    let sandbox = &document.spec.sandboxes[0];
    let provider = document.inference_provider().unwrap();
    assert_eq!(provider.provider, InferenceProviderKind::Openai);
    assert_eq!(provider.api, Some(InferenceApi::OpenaiCompletions));
    assert_eq!(provider.endpoint, "https://integrate.api.nvidia.com/v1");
    assert_eq!(document.credential_names(), ["NVIDIA_API_KEY"]);
    assert!(matches!(sandbox.network.policy, NetworkPolicy::Isolated));
}

#[test]
fn explicit_custom_provider_identity_survives_an_unrelated_model_answer() {
    let capabilities = Capabilities::available();
    let mut values = supplied();
    values["spec"]["inferenceProviders"][0]["name"] = json!("my-private-service");
    values["spec"]["inferenceProviders"][0]["endpoint"] =
        json!("https://models.private.example/v1");
    values["spec"]["inferenceProviders"][0]["credential"]["env"] = json!("PRIVATE_MODEL_TOKEN");
    values["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["providerRef"] =
        json!("my-private-service");
    let mut state = start(values, &capabilities);
    let model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    state
        .answer(&capabilities, model, Some(json!("custom/new-model")))
        .unwrap();
    let document = state
        .resolve(&capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    let provider = document.inference_provider().unwrap();
    assert_eq!(provider.name, "my-private-service");
    assert_eq!(provider.endpoint, "https://models.private.example/v1");
    assert_eq!(document.credential_names(), ["PRIVATE_MODEL_TOKEN"]);
    assert_eq!(
        document.spec.sandboxes[0]
            .agent
            .inference
            .as_ref()
            .unwrap()
            .routes[0]
            .overrides
            .model,
        "custom/new-model"
    );
}

#[test]
fn supplied_automation_values_survive_a_journey_without_reprojection() {
    let capabilities = Capabilities::available();
    let mut values = supplied();
    values["metadata"]["name"] = json!("automated-deployment");
    values["spec"]["sandboxes"][0]["name"] = json!("automated-sandbox");
    values["spec"]["sandboxes"][0]["agent"]["name"] = json!("automated-agent");
    values["spec"]["inferenceProviders"][0]["name"] = json!("automated-provider");
    values["spec"]["inferenceProviders"][0]["api"] = json!("openai-responses");
    values["spec"]["inferenceProviders"][0]["credential"]["env"] = json!("AUTOMATED_API_KEY");
    values["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["providerRef"] =
        json!("automated-provider");
    let state = start(values, &capabilities);
    let document = state
        .resolve(&capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    assert_eq!(document.metadata.name, "automated-deployment");
    assert_eq!(document.spec.sandboxes[0].name, "automated-sandbox");
    assert_eq!(document.spec.sandboxes[0].agent.name, "automated-agent");
    assert_eq!(
        document.inference_provider().unwrap().name,
        "automated-provider"
    );
    assert_eq!(
        document.inference_provider().unwrap().api,
        Some(InferenceApi::OpenaiResponses)
    );
    assert_eq!(document.credential_names(), ["AUTOMATED_API_KEY"]);
}

#[test]
fn a_complete_multi_sandbox_document_parses_but_is_outside_the_v1_journey_envelope() {
    let bytes = include_bytes!("../../../examples/multiple-sandboxes.yaml");
    let expected = Document::parse(&bytes[..]).unwrap();
    let partial = PartialDocument::from_yaml(bytes).unwrap();
    assert_eq!(partial.assess().document(), Some(&expected));
    assert!(
        JourneyDefinition::new("single-sandbox", partial)
            .start(&Capabilities::available())
            .is_err()
    );
}

#[test]
fn every_advertised_harness_preserves_the_isolated_network_boundary() {
    let capabilities = Capabilities::available();
    for harness in capabilities.harnesses() {
        let mut values = supplied();
        values["spec"]["sandboxes"][0]["harness"]["kind"] = json!(harness.as_str());
        let state = start(values, &capabilities);
        let document = state
            .resolve(&capabilities)
            .unwrap()
            .assessment()
            .document()
            .unwrap()
            .clone();
        let reopened = Document::parse(document.yaml().unwrap().as_bytes()).unwrap();
        assert_eq!(reopened, document);
        assert!(matches!(
            document.spec.sandboxes[0].network.policy,
            NetworkPolicy::Isolated
        ));
    }
}

#[test]
fn a_missing_fabric_catalog_does_not_rewrite_supplied_harness_intent() {
    let capabilities = Capabilities::from_harnesses([]);
    let mut values = supplied();
    values["spec"]["sandboxes"][0]["harness"]["kind"] = json!("nvidia.fabric.claude");
    let state = start(values, &capabilities);
    let resolution = state.resolve(&capabilities).unwrap();
    assert_eq!(
        state.values().pointer("/spec/sandboxes/0/harness/kind"),
        Some(&json!("nvidia.fabric.claude"))
    );
    assert!(!resolution.unverified().is_empty());
    assert!(resolution.materialized_document().is_none());
}

#[test]
fn unsupported_protocol_answer_is_rejected_without_mutating_the_document() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("protocol", base)
        .ask([JourneyScope::InferenceApi])
        .start(&capabilities)
        .unwrap();
    let before = state.values().clone();
    assert!(
        state
            .answer(
                &capabilities,
                "/spec/inferenceProviders/0/api",
                Some(json!("anthropic-messages"))
            )
            .is_err()
    );
    assert_eq!(state.values(), &before);
}
