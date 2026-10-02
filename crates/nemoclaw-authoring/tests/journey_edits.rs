// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    Capabilities, DecisionStatus, JourneyDefinition, JourneyScope, PartialDocument,
};
use nemoclaw_sdk::fabric_catalog::FabricCatalog;
use serde_json::{Value, json};

fn base_values() -> Value {
    serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml")).unwrap()
}

fn partial(values: &Value) -> PartialDocument {
    PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap()
}

#[test]
fn preset_keeps_shared_provider_identity_and_reopens_every_dependent_route() {
    let capabilities = Capabilities::available();
    let mut values = base_values();
    let routes = values["spec"]["sandboxes"][0]["agent"]["inference"]["routes"]
        .as_array_mut()
        .unwrap();
    let mut second = routes[0].clone();
    second["name"] = json!("second");
    routes.push(second);
    values["spec"]["sandboxes"][0]["agent"]["inference"]["default"] =
        values["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["name"].clone();
    let provider_name = values["spec"]["inferenceProviders"][0]["name"].clone();
    let first_name =
        values["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["name"].clone();
    let mut state = JourneyDefinition::new("shared-provider", partial(&values))
        .ask([JourneyScope::RouteModels])
        .ask(["inference:preset"])
        .start(&capabilities)
        .unwrap();
    state
        .answer(&capabilities, "route:selection", Some(first_name))
        .unwrap();
    state
        .answer(
            &capabilities,
            "inference:preset",
            Some(json!("nvidia-endpoints")),
        )
        .unwrap();
    let first_model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    state
        .answer(&capabilities, first_model, Some(json!("first-model")))
        .unwrap();
    state
        .answer(&capabilities, "route:selection", Some(json!("second")))
        .unwrap();
    state
        .answer(
            &capabilities,
            "inference:preset",
            Some(json!("nvidia-endpoints")),
        )
        .unwrap();
    let second_model = "/spec/sandboxes/0/agent/inference/routes/1/overrides/model";
    state
        .answer(&capabilities, second_model, Some(json!("second-model")))
        .unwrap();
    state
        .answer(&capabilities, "inference:preset", Some(json!("openai")))
        .unwrap();

    assert_eq!(
        state.values()["spec"]["inferenceProviders"][0]["name"],
        provider_name
    );
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .assessment()
            .document()
            .is_some()
    );
    assert!(matches!(
        state.decision_status(first_model),
        DecisionStatus::Reopened { .. }
    ));
    assert!(matches!(
        state.decision_status(second_model),
        DecisionStatus::Reopened { .. }
    ));
    state
        .answer(
            &capabilities,
            second_model,
            Some(json!("updated-second-model")),
        )
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("route:selection")
            .is_some()
    );
}

#[test]
fn accepted_and_omitted_native_settings_can_be_revisited() {
    let mut catalog = FabricCatalog::bundled();
    let mut adapter = catalog.adapters[0].clone();
    adapter.descriptor["adapter_id"] = json!("fixture.native-edit");
    adapter.descriptor["settings_schema"] = json!({"type":"object", "properties":{}});
    adapter.descriptor["config"]["schema"] = json!({"type":"object","required":["workflow"]});
    adapter.descriptor["model_schema"] = json!({"type":"object","properties":{"settings":{"type":"object","properties":{"variant":{"type":"string","enum":["quick","thorough"]}}}}});
    catalog.adapters = vec![adapter];
    catalog.targets = vec![json!({"descriptor":{
        "type":"workflow", "id":"fixture.target", "adapter_id":"fixture.native-edit",
        "spec":{"settings_schema":{"type":"object","properties":{"region":{"type":"string","enum":["west","east"]}},"required":["region"]}}
    },"provenance":[]})];
    let capabilities = Capabilities::from_catalog(&catalog);
    let mut values = base_values();
    values["spec"]["sandboxes"][0]["harness"]["kind"] = json!("fixture.native-edit");
    let mut state = JourneyDefinition::new("native-edits", partial(&values))
        .ask([JourneyScope::NativeSettings])
        .start(&capabilities)
        .unwrap();
    state
        .answer(
            &capabilities,
            "workflow:/target_id",
            Some(json!("fixture.target")),
        )
        .unwrap();
    state
        .answer(
            &capabilities,
            "workflow:/settings/region",
            Some(json!("west")),
        )
        .unwrap();
    state
        .answer(
            &capabilities,
            "workflow:/settings/region",
            Some(json!("east")),
        )
        .unwrap();
    state
        .answer(&capabilities, "model:/variant", Some(json!("quick")))
        .unwrap();
    state.answer(&capabilities, "model:/variant", None).unwrap();
    state
        .answer(&capabilities, "model:/variant", Some(json!("thorough")))
        .unwrap();
    assert_eq!(
        state
            .values()
            .pointer("/spec/sandboxes/0/harness/config/workflow/settings/region"),
        Some(&json!("east"))
    );
    assert_eq!(
        state
            .values()
            .pointer("/spec/sandboxes/0/agent/inference/routes/0/overrides/settings/variant"),
        Some(&json!("thorough"))
    );
    let before = state.values().clone();
    assert!(
        state
            .answer(&capabilities, "model:/variant", Some(json!("invalid")))
            .is_err()
    );
    assert_eq!(state.values(), &before);
}

#[test]
fn exact_and_scope_api_guidance_use_the_same_selected_provider_policy() {
    let capabilities = Capabilities::available();
    let values: Value = serde_saphyr::from_slice(include_bytes!(
        "../../../examples/spark/local-and-hosted.yaml"
    ))
    .unwrap();
    let api = "/spec/inferenceProviders/1/api";
    for scopes in [
        vec![JourneyScope::RouteModels],
        vec![JourneyScope::RouteModels, JourneyScope::InferenceApi],
    ] {
        let mut state = JourneyDefinition::new("provider-api-policy", partial(&values))
            .ask([api, "inference:preset"])
            .ask(scopes)
            .start(&capabilities)
            .unwrap();
        state
            .answer(&capabilities, "route:selection", Some(json!("hosted")))
            .unwrap();
        assert!(
            state
                .resolve(&capabilities)
                .unwrap()
                .question(api)
                .is_none()
        );
        state
            .answer(&capabilities, "inference:preset", Some(json!("anthropic")))
            .unwrap();
        let resolution = state.resolve(&capabilities).unwrap();
        let questions = resolution.questions();
        let api_index = questions.iter().position(|q| q.id() == api).unwrap();
        assert_eq!(
            questions[api_index].choices(),
            &[json!("anthropic-messages")]
        );
        let model_index = questions
            .iter()
            .position(|q| q.id() == "/spec/sandboxes/0/agent/inference/routes/1/overrides/model")
            .unwrap();
        assert!(api_index < model_index);
        assert!(
            state
                .answer(&capabilities, api, Some(json!("openai-completions")))
                .is_err()
        );
    }
}
