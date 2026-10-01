// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    Capabilities, DecisionStatus, JourneyDefinition, JourneyQuestionKind, JourneyQuestionReason,
    JourneyScope, PartialDocument,
};
use nemoclaw_sdk::fabric_catalog::{BridgeCapabilities, FabricCatalog};
use serde_json::json;

/// Observed images must advertise the Fabric bridge to be compatible.
fn installed_catalog() -> FabricCatalog {
    let mut catalog = FabricCatalog::bundled();
    catalog.bridge = Some(BridgeCapabilities {
        interface_version: 1,
        operations: [
            "validate",
            "prepare",
            "configure",
            "check",
            "invoke",
            "serve",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
        health_checks: Vec::new(),
    });
    catalog
}

fn minimum() -> PartialDocument {
    PartialDocument::from_yaml(
        b"apiVersion: nemoclaw.nvidia.com/v1alpha1\nkind: NemoClawConfig\nspec:\n  sandboxes:\n    - {}\n",
    )
    .unwrap()
}

#[test]
fn empty_sandbox_asks_for_harness_form_before_inline_harness_kind() {
    let capabilities = Capabilities::available();
    let mut inline = JourneyDefinition::new("inline-form", minimum())
        .start(&capabilities)
        .unwrap();
    let form = "form:/spec/sandboxes/0";
    let initial = inline.resolve(&capabilities).unwrap();
    let question = initial.question(form).expect("sandbox form question");
    assert_eq!(question.choices(), &[json!("harness"), json!("harnessRef")]);
    assert!(initial.question("/spec/sandboxes/0/harness/kind").is_none());
    inline
        .answer(&capabilities, form, Some(json!("harness")))
        .unwrap();
    let inline_questions = inline.resolve(&capabilities).unwrap();
    let harness = inline_questions
        .question("/spec/sandboxes/0/harness/kind")
        .expect("inline harness kind");
    assert!(!harness.choices().is_empty());
    assert_eq!(
        inline_questions
            .questions()
            .iter()
            .filter(|question| question.id() == "/spec/sandboxes/0/harness/kind")
            .count(),
        1
    );

    let mut referenced = JourneyDefinition::new("reference-form", minimum())
        .start(&capabilities)
        .unwrap();
    referenced
        .answer(&capabilities, form, Some(json!("harnessRef")))
        .unwrap();
    let reference = referenced.resolve(&capabilities).unwrap();
    assert!(reference.question("/spec/sandboxes/0/harnessRef").is_some());
    assert!(
        reference
            .question("/spec/sandboxes/0/harness/kind")
            .is_none()
    );
}

#[test]
fn omitted_optional_sdk_field_stays_absent_even_when_its_scope_is_asked() {
    let capabilities = Capabilities::available();
    let mut supplied: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    supplied["spec"]["inferenceProviders"][0]
        .as_object_mut()
        .unwrap()
        .remove("api");
    let base = PartialDocument::from_yaml(supplied.to_string().as_bytes()).unwrap();
    let path = "/spec/inferenceProviders/0/api";
    let state = JourneyDefinition::new("omit-sdk-api", base)
        .ask([JourneyScope::InferenceApi])
        .omit([
            path,
            "adapter:nvidia.fabric.openclaw:/agent_name",
            "adapter:nvidia.fabric.openclaw:/cli",
            "adapter:nvidia.fabric.openclaw:/home",
            "adapter:nvidia.fabric.openclaw:/native_config",
            "adapter:nvidia.fabric.openclaw:/timeout_seconds",
        ])
        .start(&capabilities)
        .unwrap();

    let resolution = state.resolve(&capabilities).unwrap();
    assert!(resolution.question(path).is_none());
    assert!(resolution.omitted().iter().any(|field| field == path));
    assert!(
        resolution.materialized_document().is_some(),
        "questions={:?} unverified={:?} issues={:?}",
        resolution.questions(),
        resolution.unverified(),
        resolution.assessment().issues()
    );
    assert!(state.values().pointer(path).is_none());
}

#[test]
fn exact_and_scope_guidance_share_one_inference_api_question() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let path = "/spec/inferenceProviders/0/api";
    let mut state = JourneyDefinition::new("same-api-decision", base)
        .ask([path])
        .ask([JourneyScope::InferenceApi])
        .start(&capabilities)
        .unwrap();

    let resolution = state.resolve(&capabilities).unwrap();
    assert_eq!(
        resolution
            .questions()
            .iter()
            .filter(|question| question.id() == path)
            .count(),
        1,
        "one SDK field must be one decision even with two selectors"
    );
    state
        .answer(&capabilities, path, Some(json!("openai-completions")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(path)
            .is_none()
    );
}

#[test]
fn exact_and_scope_guidance_keep_route_model_question_kind() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let path = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    let state = JourneyDefinition::new("same-model-decision", base)
        .ask([path])
        .ask([JourneyScope::RouteModels])
        .start(&capabilities)
        .unwrap();

    let resolution = state.resolve(&capabilities).unwrap();
    let matches = resolution
        .questions()
        .iter()
        .filter(|question| question.id() == path)
        .collect::<Vec<_>>();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].kind(), JourneyQuestionKind::InferenceModel);
    assert!(matches[0].allows_custom_answer());
}

#[test]
fn asked_inference_api_precedes_route_model_in_question_order() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("api-before-model", base)
        .ask([JourneyScope::InferenceApi, JourneyScope::RouteModels])
        .start(&capabilities)
        .unwrap();
    let api_path = "/spec/inferenceProviders/0/api";
    let model_path = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";

    let first = state.resolve(&capabilities).unwrap();
    let api = first.question(api_path).expect("asked API");
    assert!(first.question(model_path).is_some());
    assert_eq!(first.next_question().unwrap().id(), api_path);
    state
        .answer(
            &capabilities,
            api_path,
            Some(api.suggestion().expect("supplied API").clone()),
        )
        .unwrap();
    let next = state.resolve(&capabilities).unwrap();
    assert_eq!(
        next.question(model_path).expect("model after API").kind(),
        JourneyQuestionKind::InferenceModel
    );
}

#[test]
fn omit_guidance_rejects_required_or_supplied_sdk_fields() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    assert!(
        JourneyDefinition::new("required", base.clone())
            .omit(["/metadata/name"])
            .start(&capabilities)
            .is_err()
    );
    assert!(
        JourneyDefinition::new("supplied", base)
            .omit(["/spec/inferenceProviders/0/api"])
            .start(&capabilities)
            .is_err()
    );
}

#[test]
fn missing_required_sdk_leaf_values_become_questions_without_guidance() {
    let capabilities = Capabilities::available();
    let mut values: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    values["metadata"].as_object_mut().unwrap().remove("name");
    values["spec"]["sandboxes"][0]
        .as_object_mut()
        .unwrap()
        .remove("name");
    values["spec"]["sandboxes"][0]["agent"]
        .as_object_mut()
        .unwrap()
        .remove("name");
    values["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]
        .as_object_mut()
        .unwrap()
        .remove("name");
    values["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["overrides"]
        .as_object_mut()
        .unwrap()
        .remove("model");
    let base = PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap();
    let mut state = JourneyDefinition::new("missing-leaves", base)
        .start(&capabilities)
        .unwrap();
    for (path, value) in [
        ("/metadata/name", "deployment"),
        ("/spec/sandboxes/0/name", "sandbox"),
        ("/spec/sandboxes/0/agent/name", "agent"),
        ("/spec/sandboxes/0/agent/inference/routes/0/name", "primary"),
        (
            "/spec/sandboxes/0/agent/inference/routes/0/overrides/model",
            "nvidia/selected-model",
        ),
    ] {
        let resolution = state.resolve(&capabilities).unwrap();
        let question = resolution
            .question(path)
            .unwrap_or_else(|| panic!("missing {path}"));
        assert_eq!(question.reason(), JourneyQuestionReason::Missing);
        state
            .answer(&capabilities, path, Some(json!(value)))
            .unwrap();
    }
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .assessment()
            .document()
            .is_some()
    );
}

#[test]
fn exclusive_sdk_forms_become_choices_then_ask_for_the_selected_field() {
    let capabilities = Capabilities::available();
    let mut agent_values: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    agent_values["spec"]["sandboxes"][0]["agent"]
        .as_object_mut()
        .unwrap()
        .remove("inference");
    let agent_base = PartialDocument::from_yaml(agent_values.to_string().as_bytes()).unwrap();
    let mut agent = JourneyDefinition::new("agent-form", agent_base)
        .start(&capabilities)
        .unwrap();
    let agent_form = "form:/spec/sandboxes/0/agent";
    let question = agent
        .resolve(&capabilities)
        .unwrap()
        .question(agent_form)
        .cloned()
        .unwrap();
    assert_eq!(
        question.choices(),
        &[json!("inference"), json!("inferenceRef")]
    );
    assert!(question.required());
    assert_eq!(question.kind(), JourneyQuestionKind::StructuralForm);
    agent
        .answer(&capabilities, agent_form, Some(json!("inferenceRef")))
        .unwrap();
    let selected = agent.resolve(&capabilities).unwrap();
    assert!(selected.question(agent_form).is_none());
    assert!(
        selected
            .question("/spec/sandboxes/0/agent/inferenceRef")
            .is_some()
    );
    assert!(
        agent
            .values()
            .pointer("/spec/sandboxes/0/agent/inferenceRef")
            .is_none()
    );
    agent
        .answer(
            &capabilities,
            "/spec/sandboxes/0/agent/inferenceRef",
            Some(json!("shared")),
        )
        .unwrap();
    agent
        .answer(&capabilities, agent_form, Some(json!("inference")))
        .unwrap();
    assert!(
        agent
            .values()
            .pointer("/spec/sandboxes/0/agent/inferenceRef")
            .is_none(),
        "switching forms must remove the incompatible supplied branch"
    );

    let mut route_values: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    route_values["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]
        .as_object_mut()
        .unwrap()
        .remove("providerRef");
    let route_base = PartialDocument::from_yaml(route_values.to_string().as_bytes()).unwrap();
    let mut route = JourneyDefinition::new("route-form", route_base)
        .start(&capabilities)
        .unwrap();
    let route_form = "form:/spec/sandboxes/0/agent/inference/routes/0";
    let question = route
        .resolve(&capabilities)
        .unwrap()
        .question(route_form)
        .cloned()
        .unwrap();
    assert_eq!(
        question.choices(),
        &[json!("provider"), json!("providerRef")]
    );
    route
        .answer(&capabilities, route_form, Some(json!("providerRef")))
        .unwrap();
    assert!(
        route
            .resolve(&capabilities)
            .unwrap()
            .question("/spec/sandboxes/0/agent/inference/routes/0/providerRef")
            .is_some()
    );
}

#[test]
fn missing_object_parent_exposes_its_unconditional_required_fields() {
    let capabilities = Capabilities::available();
    let mut values: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    values["spec"]["sandboxes"][0]
        .as_object_mut()
        .unwrap()
        .remove("agent");
    let base = PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap();
    let mut state = JourneyDefinition::new("missing-agent", base)
        .start(&capabilities)
        .unwrap();
    let name = "/spec/sandboxes/0/agent/name";
    assert_eq!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(name)
            .unwrap()
            .reason(),
        JourneyQuestionReason::Missing
    );
    state
        .answer(&capabilities, name, Some(json!("primary")))
        .unwrap();
    assert_eq!(state.values().pointer(name), Some(&json!("primary")));
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .assessment()
            .document()
            .is_none()
    );
}

#[test]
fn invalid_supplied_sdk_leaf_is_an_editable_question_without_guidance() {
    let capabilities = Capabilities::available();
    let mut values: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    values["spec"]["sandboxes"][0]["name"] = json!("Bad Name");
    let base = PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap();
    let mut state = JourneyDefinition::new("repair", base)
        .start(&capabilities)
        .unwrap();
    let path = "/spec/sandboxes/0/name";
    assert_eq!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(path)
            .unwrap()
            .reason(),
        JourneyQuestionReason::InvalidSupplied
    );
    state
        .answer(&capabilities, path, Some(json!("valid-name")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .assessment()
            .document()
            .is_some()
    );
}

#[test]
fn invalid_optional_sdk_leaf_can_be_omitted_without_guidance() {
    let capabilities = Capabilities::available();
    let mut values: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    values["spec"]["sandboxes"][0]["runtime"]["provider"] = json!("unsupported");
    let base = PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap();
    let mut state = JourneyDefinition::new("repair-optional", base)
        .start(&capabilities)
        .unwrap();
    let path = "/spec/sandboxes/0/runtime/provider";
    let question = state
        .resolve(&capabilities)
        .unwrap()
        .question(path)
        .cloned()
        .unwrap();
    assert_eq!(question.reason(), JourneyQuestionReason::InvalidSupplied);
    assert!(!question.required());
    state.answer(&capabilities, path, None).unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .assessment()
            .document()
            .is_some()
    );
}

#[test]
fn sparse_journey_follows_nested_fabric_conditionals() {
    let mut catalog = FabricCatalog::bundled();
    let mut adapter = catalog.adapters[0].clone();
    adapter.descriptor["adapter_id"] = json!("fixture-schema-agent");
    adapter.descriptor["settings_schema"] = json!({
        "type":"object", "properties":{"mode":{"type":"string","enum":["basic","remote"],"default":"basic"}}, "required":["mode"],
        "if":{"properties":{"mode":{"const":"remote"}},"required":["mode"]},
        "then":{"properties":{"region":{"type":"string","enum":["west","east"]}},"required":["region"]}
    });
    catalog.adapters = vec![adapter];
    let capabilities = Capabilities::from_catalog(&catalog);
    let mut base: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    base["spec"]["sandboxes"][0]["harness"]["kind"] = json!("fixture-schema-agent");
    let mut state = JourneyDefinition::new(
        "conditional",
        PartialDocument::from_yaml(base.to_string().as_bytes()).unwrap(),
    )
    .start(&capabilities)
    .unwrap();
    let mode = "adapter:fixture-schema-agent:/mode";
    let region = "adapter:fixture-schema-agent:/region";
    let mode_question = state
        .resolve(&capabilities)
        .unwrap()
        .question(mode)
        .cloned()
        .unwrap();
    assert_eq!(mode_question.suggestion(), Some(&json!("basic")));
    assert_eq!(mode_question.choices(), &[json!("basic"), json!("remote")]);
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(region)
            .is_none()
    );
    state
        .answer(&capabilities, mode, Some(json!("remote")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(region)
            .is_some()
    );
    assert!(
        state
            .answer(&capabilities, region, Some(json!("invalid")))
            .is_err()
    );
    state
        .answer(&capabilities, region, Some(json!("west")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .materialized_document()
            .is_some()
    );
}

#[test]
fn nested_adapter_guidance_asks_omits_and_warns_from_the_active_schema() {
    let mut catalog = FabricCatalog::bundled();
    let mut adapter = catalog.adapters[0].clone();
    adapter.descriptor["adapter_id"] = json!("fixture.nested-guidance");
    adapter.descriptor["settings_schema"] = json!({
        "type":"object",
        "properties":{
            "native":{
                "type":"object",
                "properties":{
                    "region":{"type":"string","enum":["west","east"]},
                    "flavor":{"type":"string"}
                },
                "required":["region"]
            }
        }
    });
    catalog.adapters = vec![adapter];
    let capabilities = Capabilities::from_catalog(&catalog);
    let mut base: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    base["spec"]["sandboxes"][0]["harness"] = json!({
        "kind":"fixture.nested-guidance",
        "settings":{"native":{"region":"west"}}
    });
    let state = JourneyDefinition::new(
        "nested-guidance",
        PartialDocument::from_yaml(base.to_string().as_bytes()).unwrap(),
    )
    .ask([
        "adapter:fixture.nested-guidance:/native/region",
        "adapter:fixture.nested-guidance:/native/typo",
    ])
    .omit(["adapter:fixture.nested-guidance:/native/flavor"])
    .start(&capabilities)
    .unwrap();
    let resolution = state.resolve(&capabilities).unwrap();
    let region = resolution
        .question("adapter:fixture.nested-guidance:/native/region")
        .expect("supplied nested setting is asked");
    assert_eq!(region.reason(), JourneyQuestionReason::ExplicitAsk);
    assert_eq!(region.suggestion(), Some(&json!("west")));
    assert!(
        resolution
            .omitted()
            .contains(&"adapter:fixture.nested-guidance:/native/flavor".to_owned())
    );
    assert!(
        resolution
            .warnings()
            .iter()
            .any(|warning| warning.contains("adapter:fixture.nested-guidance:/native/typo"))
    );

    base["spec"]["sandboxes"][0]["harness"]["settings"]["native"] = json!({});
    let required_omit = JourneyDefinition::new(
        "required-nested-omit",
        PartialDocument::from_yaml(base.to_string().as_bytes()).unwrap(),
    )
    .omit(["adapter:fixture.nested-guidance:/native/region"])
    .start(&capabilities)
    .unwrap();
    assert!(
        required_omit
            .resolve(&capabilities)
            .unwrap_err()
            .to_string()
            .contains("required setting")
    );
}

#[test]
fn root_fabric_alternatives_are_answered_through_the_journey() {
    let mut catalog = FabricCatalog::bundled();
    let mut adapter = catalog.adapters[0].clone();
    adapter.descriptor["adapter_id"] = json!("fixture-root-agent");
    adapter.descriptor["settings_schema"] = json!({
        "oneOf": [
            {"type":"object", "properties":{"token":{"type":"string"}}, "required":["token"], "additionalProperties":false},
            {"type":"object", "properties":{"port":{"type":"integer"}}, "required":["port"], "additionalProperties":false}
        ]
    });
    catalog.adapters = vec![adapter];
    let capabilities = Capabilities::from_catalog(&catalog);
    let mut base: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    base["spec"]["sandboxes"][0]["harness"]["kind"] = json!("fixture-root-agent");
    base["spec"]["sandboxes"][0]["harness"]
        .as_object_mut()
        .unwrap()
        .remove("settings");
    let mut state = JourneyDefinition::new(
        "root-alternatives",
        PartialDocument::from_yaml(base.to_string().as_bytes()).unwrap(),
    )
    .start(&capabilities)
    .unwrap();

    let root = "adapter:fixture-root-agent:";
    let resolution = state.resolve(&capabilities).unwrap();
    let question = resolution.question(root).expect("root settings question");
    assert!(question.required());
    assert_eq!(question.reason(), JourneyQuestionReason::Missing);
    assert!(question.suggestion().is_none());
    assert!(
        state
            .answer(&capabilities, root, Some(json!({"port":"bad"})))
            .is_err()
    );
    state
        .answer(&capabilities, root, Some(json!({"port":443})))
        .unwrap();
    assert_eq!(
        state.values().pointer("/spec/sandboxes/0/harness/settings"),
        Some(&json!({"port":443}))
    );
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .materialized_document()
            .is_some()
    );

    let supplied = PartialDocument::from_yaml(state.values().to_string().as_bytes()).unwrap();
    let review = JourneyDefinition::new("review-root", supplied)
        .ask([root])
        .start(&capabilities)
        .unwrap()
        .resolve(&capabilities)
        .unwrap();
    let question = review
        .question(root)
        .expect("supplied root is deliberately asked");
    assert_eq!(question.reason(), JourneyQuestionReason::ExplicitAsk);
    assert_eq!(question.suggestion(), Some(&json!({"port":443})));
}

#[test]
fn changed_adapter_schema_reopens_an_invalid_answer_without_rewriting_it() {
    let mut catalog = FabricCatalog::bundled();
    let mut adapter = catalog.adapters[0].clone();
    adapter.descriptor["adapter_id"] = json!("fixture-schema-agent");
    adapter.descriptor["settings_schema"] = json!({
        "type":"object", "properties":{"mode":{"type":"string","enum":["basic"]}}, "required":["mode"]
    });
    catalog.adapters = vec![adapter.clone()];
    let capabilities = Capabilities::from_catalog(&catalog);
    let mut value: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    value["spec"]["sandboxes"][0]["harness"]["kind"] = json!("fixture-schema-agent");
    let base = PartialDocument::from_yaml(value.to_string().as_bytes()).unwrap();
    let mut state = JourneyDefinition::new("changed-descriptor", base)
        .start(&capabilities)
        .unwrap();
    let field = "adapter:fixture-schema-agent:/mode";
    state
        .answer(&capabilities, field, Some(json!("basic")))
        .unwrap();
    let before = state.values().clone();
    adapter.descriptor["settings_schema"] = json!({
        "type":"object", "properties":{"mode":{"type":"string","enum":["revised"],"default":"revised"}}, "required":["mode"]
    });
    catalog.adapters = vec![adapter];
    let changed = Capabilities::from_catalog(&catalog);
    let question = state
        .resolve(&changed)
        .unwrap()
        .question(field)
        .cloned()
        .unwrap();
    assert_eq!(question.reason(), JourneyQuestionReason::InvalidSupplied);
    assert_eq!(question.choices(), &[json!("revised")]);
    assert_eq!(state.values(), &before);
    state
        .answer(&changed, field, Some(json!("revised")))
        .unwrap();
    assert_eq!(
        state
            .values()
            .pointer("/spec/sandboxes/0/harness/settings/mode"),
        Some(&json!("revised"))
    );
}

#[test]
fn conflicting_adapter_descriptors_do_not_select_a_schema_by_catalog_order() {
    let mut catalog = FabricCatalog::bundled();
    let mut first = catalog.adapters[0].clone();
    first.descriptor["adapter_id"] = json!("fixture-schema-agent");
    first.descriptor["settings_schema"] =
        json!({"type":"object","properties":{"a":{"type":"string"}}});
    let mut second = first.clone();
    second.descriptor["settings_schema"] =
        json!({"type":"object","properties":{"b":{"type":"boolean"}}});
    catalog.adapters = vec![first, second];
    let capabilities = Capabilities::from_catalog(&catalog);
    let mut value: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    value["spec"]["sandboxes"][0]["harness"]["kind"] = json!("fixture-schema-agent");
    let base = PartialDocument::from_yaml(value.to_string().as_bytes()).unwrap();
    let state = JourneyDefinition::new("conflicting-descriptors", base)
        .start(&capabilities)
        .unwrap();
    let error = state.resolve(&capabilities).unwrap_err();
    assert!(
        error.to_string().contains("ambiguous setting schemas"),
        "{error}"
    );
}

#[test]
fn omitting_a_nested_optional_setting_does_not_create_its_parent_object() {
    let mut catalog = FabricCatalog::bundled();
    catalog.adapters.truncate(1);
    catalog.adapters[0].descriptor["adapter_id"] = json!("test.optional-settings");
    catalog.adapters[0].descriptor["settings_schema"] = json!({
        "type":"object", "properties":{"native":{"type":"object", "properties":{"enabled":{"type":"boolean"}}}}
    });
    let capabilities = Capabilities::from_catalog(&catalog);
    let mut value: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    value["spec"]["sandboxes"][0]["harness"]["kind"] = json!("test.optional-settings");
    let base = PartialDocument::from_yaml(value.to_string().as_bytes()).unwrap();
    let mut state = JourneyDefinition::new("nested-optional", base)
        .start(&capabilities)
        .unwrap();
    let field = "adapter:test.optional-settings:/native";
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(field)
            .is_some()
    );
    state.answer(&capabilities, field, None).unwrap();
    assert!(
        state
            .values()
            .pointer("/spec/sandboxes/0/harness/settings/native")
            .is_none()
    );
}

#[test]
fn conditional_native_model_settings_survive_a_model_change_and_sdk_roundtrip() {
    let mut catalog = FabricCatalog::bundled();
    let mut adapter = catalog.adapters[0].clone();
    adapter.descriptor["adapter_id"] = json!("fixture.model-owner");
    adapter.descriptor["settings_schema"] = json!({"type":"object","properties":{}});
    adapter.descriptor["model_schema"] = json!({
        "type":"object","properties":{"settings":{"type":"object",
            "properties":{"variant":{"type":"string","enum":["quick","thorough"],"default":"quick"}},
            "required":["variant"],
            "if":{"properties":{"variant":{"const":"thorough"}},"required":["variant"]},
            "then":{"properties":{"budget":{"type":"integer","minimum":1}},"required":["budget"]}
        }}
    });
    catalog.adapters = vec![adapter];
    let capabilities = Capabilities::from_catalog(&catalog);
    let mut value: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    value["spec"]["sandboxes"][0]["harness"]["kind"] = json!("fixture.model-owner");
    let base = PartialDocument::from_yaml(value.to_string().as_bytes()).unwrap();
    let mut state = JourneyDefinition::new("conditional-native", base)
        .ask([JourneyScope::NativeSettings])
        .ask([JourneyScope::RouteModels])
        .start(&capabilities)
        .unwrap();
    let variant = "model:/variant";
    let budget = "model:/budget";
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(variant)
            .is_some()
    );
    state
        .answer(&capabilities, variant, Some(json!("thorough")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(budget)
            .is_some()
    );
    assert!(state.answer(&capabilities, budget, Some(json!(0))).is_err());
    state.answer(&capabilities, budget, Some(json!(3))).unwrap();
    let model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    state
        .answer(&capabilities, model, Some(json!("different-model")))
        .unwrap();
    assert_eq!(
        state
            .values()
            .pointer("/spec/sandboxes/0/agent/inference/routes/0/overrides/settings"),
        Some(&json!({"variant":"thorough","budget":3}))
    );
    let document = state
        .resolve(&capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    let reopened =
        nemoclaw_sdk::config::Document::parse(document.yaml().unwrap().as_bytes()).unwrap();
    assert_eq!(reopened, document);
}

#[test]
fn sparse_journey_asks_existing_deployment_fields_and_checks_complete_sdk_edits() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/spark/remote-vllm.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("deployment", base)
        .ask([JourneyScope::DeploymentFields])
        .start(&capabilities)
        .unwrap();
    let path = "/spec/services/qwen/serving/contextTokens";
    let resolution = state.resolve(&capabilities).unwrap();
    assert!(resolution.question(path).is_some());
    let before = state.values().clone();
    assert!(state.answer(&capabilities, path, Some(json!(-1))).is_err());
    assert_eq!(state.values(), &before);
    state
        .answer(&capabilities, path, Some(json!(16384)))
        .unwrap();
    assert_eq!(state.values().pointer(path), Some(&json!(16384)));
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(path)
            .is_none()
    );
}

#[test]
fn sparse_journey_uses_workflow_and_model_owner_schemas() {
    let mut catalog = FabricCatalog::bundled();
    let mut adapter = catalog.adapters[0].clone();
    adapter.descriptor["adapter_id"] = json!("fixture.native-owner");
    adapter.descriptor["settings_schema"] = json!({"type":"object","properties":{}});
    adapter.descriptor["config"]["schema"] = json!({"type":"object","required":["workflow"]});
    adapter.descriptor["model_schema"] = json!({"type":"object","properties":{"settings":{"type":"object","properties":{"variant":{"type":"string","enum":["quick","thorough"]}},"required":["variant"]}}});
    catalog.adapters = vec![adapter];
    catalog.targets = vec![json!({"descriptor":{
        "type":"workflow","id":"fixture.target","adapter_id":"fixture.native-owner",
        "spec":{"settings_schema":{"type":"object","properties":{"region":{"type":"string","enum":["west","east"]}},"required":["region"]}}
    },"provenance":[]})];
    let capabilities = Capabilities::from_catalog(&catalog);
    let mut partial: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("fixtures/minimum-inline.yaml")).unwrap();
    partial["spec"]["sandboxes"][0]["harness"]["kind"] = json!("fixture.native-owner");
    let mut sparse = JourneyDefinition::new(
        "sparse-native",
        PartialDocument::from_yaml(partial.to_string().as_bytes()).unwrap(),
    )
    .ask([JourneyScope::NativeSettings])
    .start(&capabilities)
    .unwrap();
    let pending = sparse.resolve(&capabilities).unwrap();
    assert!(pending.assessment().document().is_none());
    assert!(pending.question("workflow:/target_id").is_some());
    sparse
        .answer(
            &capabilities,
            "workflow:/target_id",
            Some(json!("fixture.target")),
        )
        .unwrap();
    assert!(
        sparse
            .resolve(&capabilities)
            .unwrap()
            .question("workflow:/settings/region")
            .is_some()
    );
    sparse
        .answer(
            &capabilities,
            "workflow:/settings/region",
            Some(json!("west")),
        )
        .unwrap();
    assert_eq!(
        sparse
            .values()
            .pointer("/spec/sandboxes/0/harness/config/workflow/settings/region"),
        Some(&json!("west"))
    );
    let mut base: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    base["spec"]["sandboxes"][0]["harness"]["kind"] = json!("fixture.native-owner");
    let mut state = JourneyDefinition::new(
        "native",
        PartialDocument::from_yaml(base.to_string().as_bytes()).unwrap(),
    )
    .ask([JourneyScope::NativeSettings])
    .start(&capabilities)
    .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("workflow:/target_id")
            .is_some()
    );
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("model:/variant")
            .is_some()
    );
    state
        .answer(
            &capabilities,
            "workflow:/target_id",
            Some(json!("fixture.target")),
        )
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("workflow:/settings/region")
            .is_some()
    );
    state
        .answer(
            &capabilities,
            "workflow:/settings/region",
            Some(json!("west")),
        )
        .unwrap();
    state
        .answer(&capabilities, "model:/variant", Some(json!("quick")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .materialized_document()
            .is_some()
    );
}

#[test]
fn exact_native_guidance_uses_active_fabric_fields_without_asking_the_whole_scope() {
    let mut catalog = FabricCatalog::bundled();
    let mut adapter = catalog.adapters[0].clone();
    adapter.descriptor["adapter_id"] = json!("fixture.exact-native");
    adapter.descriptor["settings_schema"] = json!({"type":"object","properties":{}});
    adapter.descriptor["config"]["schema"] = json!({"type":"object","required":["workflow"]});
    adapter.descriptor["model_schema"] = json!({"type":"object","properties":{"settings":{"type":"object","properties":{
        "variant":{"type":"string","enum":["quick","thorough"]},
        "temperature":{"type":"number"}
    }}}});
    catalog.adapters = vec![adapter];
    catalog.targets = vec![json!({"descriptor":{
        "type":"workflow","id":"fixture.target","adapter_id":"fixture.exact-native",
        "spec":{"settings_schema":{"type":"object","properties":{
            "region":{"type":"string","enum":["west","east"]}
        }}}
    },"provenance":[]})];
    let capabilities = Capabilities::from_catalog(&catalog);
    let mut supplied: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    supplied["spec"]["sandboxes"][0]["harness"]["kind"] = json!("fixture.exact-native");
    let base = PartialDocument::from_yaml(supplied.to_string().as_bytes()).unwrap();
    let mut state = JourneyDefinition::new("exact-native", base.clone())
        .ask(["workflow:/target_id", "model:/variant"])
        .omit(["workflow:/settings/region"])
        .start(&capabilities)
        .unwrap();

    let first = state.resolve(&capabilities).unwrap();
    assert!(first.question("workflow:/target_id").is_some());
    assert!(first.question("model:/variant").is_some());
    assert!(first.question("model:/temperature").is_none());
    state
        .answer(
            &capabilities,
            "workflow:/target_id",
            Some(json!("fixture.target")),
        )
        .unwrap();
    let next = state.resolve(&capabilities).unwrap();
    assert!(next.question("workflow:/settings/region").is_none());
    assert!(next.omitted().contains(&"workflow:/settings/region".into()));
    state
        .answer(&capabilities, "model:/variant", Some(json!("quick")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("model:/variant")
            .is_none()
    );

    let mut with_supplied = supplied;
    with_supplied["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["overrides"]["settings"] =
        json!({"variant":"quick"});
    let supplied_model = PartialDocument::from_yaml(with_supplied.to_string().as_bytes()).unwrap();
    let invalid_omission = JourneyDefinition::new("supplied-model", supplied_model)
        .omit(["model:/variant"])
        .start(&capabilities)
        .unwrap();
    assert!(
        invalid_omission
            .resolve(&capabilities)
            .unwrap_err()
            .to_string()
            .contains("supplied native setting")
    );

    let mut required_catalog = catalog;
    required_catalog.targets[0]["descriptor"]["spec"]["settings_schema"]["required"] =
        json!(["region"]);
    let required_capabilities = Capabilities::from_catalog(&required_catalog);
    let mut required_omission = JourneyDefinition::new("required-region", base.clone())
        .ask(["workflow:/target_id"])
        .omit(["workflow:/settings/region"])
        .start(&required_capabilities)
        .unwrap();
    let before = required_omission.values().clone();
    assert!(
        required_omission
            .answer(
                &required_capabilities,
                "workflow:/target_id",
                Some(json!("fixture.target")),
            )
            .unwrap_err()
            .to_string()
            .contains("required native setting")
    );
    assert_eq!(required_omission.values(), &before);
    assert!(required_omission.resolve(&required_capabilities).is_ok());
    let unreachable = JourneyDefinition::new("future-native-field", base)
        .ask(["model:/future_setting"])
        .start(&capabilities)
        .unwrap()
        .resolve(&capabilities)
        .unwrap();
    assert!(unreachable.question("model:/future_setting").is_none());
    assert!(
        unreachable
            .warnings()
            .iter()
            .any(|warning| warning.contains("model:/future_setting")),
        "warnings={:?}",
        unreachable.warnings()
    );
}

#[test]
fn invalid_complete_native_model_settings_cannot_reach_review() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("native-validation", base)
        .ask([JourneyScope::NativeSettings])
        .omit([
            "adapter:nvidia.fabric.openclaw:/agent_name",
            "adapter:nvidia.fabric.openclaw:/cli",
            "adapter:nvidia.fabric.openclaw:/home",
            "adapter:nvidia.fabric.openclaw:/native_config",
            "adapter:nvidia.fabric.openclaw:/timeout_seconds",
        ])
        .start(&capabilities)
        .unwrap();
    state
        .answer(
            &capabilities,
            "model:/api",
            Some(json!("openai-completions")),
        )
        .unwrap();
    let result = state.resolve(&capabilities).unwrap();
    assert!(
        !result.unverified().is_empty(),
        "invalid native model config must be reported"
    );
    assert!(result.materialized_document().is_none());
}

#[test]
fn invalid_native_settings_block_review_without_native_prompt_guidance() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut guided = JourneyDefinition::new("make-invalid-native", base)
        .ask([JourneyScope::NativeSettings])
        .start(&capabilities)
        .unwrap();
    guided
        .answer(
            &capabilities,
            "model:/api",
            Some(json!("openai-completions")),
        )
        .unwrap();
    let invalid_base = PartialDocument::from_yaml(guided.values().to_string().as_bytes()).unwrap();
    let resolution = JourneyDefinition::new("express-invalid-native", invalid_base)
        .omit([
            "adapter:nvidia.fabric.openclaw:/agent_name",
            "adapter:nvidia.fabric.openclaw:/cli",
            "adapter:nvidia.fabric.openclaw:/home",
            "adapter:nvidia.fabric.openclaw:/native_config",
            "adapter:nvidia.fabric.openclaw:/timeout_seconds",
        ])
        .start(&capabilities)
        .unwrap()
        .resolve(&capabilities)
        .unwrap();

    assert!(resolution.assessment().document().is_some());
    assert!(resolution.materialized_document().is_none());
    assert!(
        resolution.question("model:/api").is_some() || !resolution.unverified().is_empty(),
        "invalid Fabric configuration must remain visible without prompt guidance"
    );
}

#[test]
fn discovered_models_extend_the_current_route_question_without_restricting_custom_answers() {
    use nemoclaw_authoring::{AuthoringFacts, EndpointEvidence, inference_request_for_document};
    use nemoclaw_sdk::{
        discovery::ObservationStatus,
        inference_discovery::{AuthenticationStatus, EndpointObservation},
    };
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("discovered", base)
        .ask([JourneyScope::RouteModels])
        .start(&capabilities)
        .unwrap();
    let document = state
        .resolve(&capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    let facts = AuthoringFacts {
        endpoint: Some(EndpointEvidence {
            request: inference_request_for_document(&document, state.current_route()).unwrap(),
            observation: EndpointObservation {
                status: ObservationStatus::Available,
                reason: None,
                source: "fixture".into(),
                reachable: Some(true),
                authentication: AuthenticationStatus::Accepted,
                models: vec!["vendor/discovered-model".into()],
                api_verified: false,
            },
        }),
        ..Default::default()
    };
    let model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    let discovered = state
        .resolve_with_evidence(&capabilities, &facts, None)
        .unwrap();
    let question = discovered.question(model).unwrap();
    assert!(
        question
            .choices()
            .contains(&json!("vendor/discovered-model"))
    );
    assert!(question.allows_custom_answer());
    assert_eq!(question.kind(), JourneyQuestionKind::InferenceModel);
    let preset = JourneyDefinition::new(
        "preset",
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap(),
    )
    .ask(["inference:preset"])
    .start(&capabilities)
    .unwrap()
    .resolve(&capabilities)
    .unwrap();
    assert!(
        !preset
            .question("inference:preset")
            .unwrap()
            .allows_custom_answer()
    );
    let mut stale = facts.clone();
    stale.endpoint.as_mut().unwrap().request.endpoint = "https://other.example/v1".into();
    assert!(
        !state
            .resolve_with_evidence(&capabilities, &stale, None)
            .unwrap()
            .question(model)
            .unwrap()
            .choices()
            .contains(&json!("vendor/discovered-model"))
    );
    stale.endpoint.as_mut().unwrap().request = facts.endpoint.as_ref().unwrap().request.clone();
    stale.endpoint.as_mut().unwrap().observation.status = ObservationStatus::Unknown;
    assert!(
        !state
            .resolve_with_evidence(&capabilities, &stale, None)
            .unwrap()
            .question(model)
            .unwrap()
            .choices()
            .contains(&json!("vendor/discovered-model"))
    );
    state
        .answer(&capabilities, model, Some(json!("private/custom")))
        .unwrap();
    assert_eq!(
        state.values().pointer(model),
        Some(&json!("private/custom"))
    );
}

#[test]
fn runtime_question_uses_finite_sdk_schema_choices() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let state = JourneyDefinition::new("runtime", base)
        .ask(["/spec/sandboxes/0/runtime/provider"])
        .start(&capabilities)
        .unwrap();
    let question = state
        .resolve(&capabilities)
        .unwrap()
        .question("/spec/sandboxes/0/runtime/provider")
        .unwrap()
        .clone();
    assert!(question.choices().contains(&json!("docker")));
    assert!(question.choices().contains(&json!("podman")));
}

#[test]
fn choosing_podman_updates_the_matching_managed_gateway_default() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("runtime", base)
        .ask(["/spec/sandboxes/0/runtime/provider"])
        .start(&capabilities)
        .unwrap();
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/runtime/provider",
            Some(json!("podman")),
        )
        .unwrap();
    assert_eq!(
        state.values().pointer("/spec/gateway/engine"),
        Some(&json!("unix:///run/user/1000/podman/podman.sock"))
    );
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .assessment()
            .document()
            .is_some()
    );
}

#[test]
fn sparse_journey_delegation_requires_current_target_evidence() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("delegate", base)
        .ask(["/spec/sandboxes/0/harness/kind", "/metadata/name"])
        .start(&capabilities)
        .unwrap();
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/harness/kind",
            Some(json!("nvidia.fabric.openclaw")),
        )
        .unwrap();
    assert!(
        state
            .delegate_remaining(&capabilities, None, &Default::default())
            .is_err()
    );
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("/metadata/name")
            .is_some()
    );
}

#[test]
fn sparse_journey_delegates_suggestions_with_compatible_current_evidence() {
    use nemoclaw_authoring::{
        AuthoringFacts, DiscoveryEvidence, EndpointEvidence, discovery_key_for_document,
        inference_request_for_document,
    };
    use nemoclaw_sdk::{
        discovery::{EngineObservation, FabricObservation, ObservationStatus},
        fabric_capabilities::ImageMetadata,
        inference_discovery::{AuthenticationStatus, CredentialObservation, EndpointObservation},
    };
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("delegate", base)
        .ask([
            "/spec/sandboxes/0/harness/kind",
            "/metadata/name",
            "inference:preset",
        ])
        .ask([JourneyScope::RouteModels])
        .ask([JourneyScope::InferenceApi])
        .ask([JourneyScope::ActiveAdapterSettings])
        .ask([JourneyScope::NativeSettings])
        .ask([JourneyScope::DeploymentFields])
        .start(&capabilities)
        .unwrap();
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/harness/kind",
            Some(json!("nvidia.fabric.openclaw")),
        )
        .unwrap();
    let document = state
        .resolve(&capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    let key = discovery_key_for_document(&document).unwrap();
    let evidence = DiscoveryEvidence {
        key: key.clone(),
        engine: Some(EngineObservation {
            status: ObservationStatus::Available,
            reason: None,
            source: "fixture".into(),
            server_version: Some("1".into()),
            architecture: Some("aarch64".into()),
            operating_system: Some("linux".into()),
            memory_bytes: None,
            cpus: None,
        }),
        fabric: Some(FabricObservation {
            status: ObservationStatus::Available,
            reason: None,
            source: "fixture".into(),
            image_id: Some("sha256:observed".into()),
            catalog: Some(installed_catalog()),
            image: ImageMetadata {
                architecture: Some("arm64".into()),
                operating_system: Some("linux".into()),
                repo_digests: vec![key.image],
                ..Default::default()
            },
            compatibility: None,
        }),
    };
    let facts = AuthoringFacts {
        endpoint: Some(EndpointEvidence {
            request: inference_request_for_document(&document, state.current_route()).unwrap(),
            observation: EndpointObservation {
                status: ObservationStatus::Available,
                reason: None,
                source: "fixture".into(),
                reachable: Some(true),
                authentication: AuthenticationStatus::Accepted,
                models: vec![
                    document.spec.sandboxes[0]
                        .agent
                        .inference
                        .as_ref()
                        .unwrap()
                        .routes[0]
                        .overrides
                        .model
                        .clone(),
                ],
                api_verified: false,
            },
        }),
        credentials: document
            .credential_names()
            .into_iter()
            .map(|reference| CredentialObservation {
                reference: reference.into(),
                status: ObservationStatus::Available,
                reason: None,
            })
            .collect(),
        ..Default::default()
    };
    let delegated = state
        .delegate_remaining(&capabilities, Some(&evidence), &facts)
        .unwrap();
    assert!(
        delegated
            .resolve(&capabilities)
            .unwrap()
            .materialized_document()
            .is_some()
    );
    assert_eq!(
        delegated.values().pointer("/metadata/name"),
        state.values().pointer("/metadata/name")
    );
}

#[test]
fn sparse_journey_visits_each_route_and_keeps_its_model_answers_separate() {
    let capabilities = Capabilities::available();
    let base = PartialDocument::from_yaml(include_bytes!(
        "../../../examples/spark/local-and-hosted.yaml"
    ))
    .unwrap();
    let mut state = JourneyDefinition::new("routes", base)
        .ask([JourneyScope::RouteModels])
        .omit([
            "adapter:nvidia.fabric.openclaw:/agent_name",
            "adapter:nvidia.fabric.openclaw:/cli",
            "adapter:nvidia.fabric.openclaw:/home",
            "adapter:nvidia.fabric.openclaw:/native_config",
            "adapter:nvidia.fabric.openclaw:/timeout_seconds",
        ])
        .start(&capabilities)
        .unwrap();
    let route = "route:selection";
    let hosted_model = "/spec/sandboxes/0/agent/inference/routes/1/overrides/model";
    let local_model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    let first = state.resolve(&capabilities).unwrap();
    assert_eq!(
        first.question(route).unwrap().choices(),
        &[json!("local"), json!("hosted")]
    );
    assert!(first.question(hosted_model).is_none());
    state
        .answer(&capabilities, route, Some(json!("hosted")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(hosted_model)
            .is_some()
    );
    state
        .answer(
            &capabilities,
            hosted_model,
            Some(json!("replacement-model")),
        )
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(route)
            .is_some()
    );
    state
        .answer(&capabilities, route, Some(json!("local")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(local_model)
            .is_some()
    );
    state
        .answer(
            &capabilities,
            local_model,
            Some(json!("nvidia/Qwen3.8-27B-NVFP4")),
        )
        .unwrap();
    let resolved = state.resolve(&capabilities).unwrap();
    assert!(resolved.question(route).is_none());
    assert_eq!(
        state.values().pointer(hosted_model),
        Some(&json!("replacement-model"))
    );
    assert!(resolved.materialized_document().is_some());
}

#[test]
fn referenced_inference_routes_are_selected_and_edited_through_the_same_journey() {
    let capabilities = Capabilities::available();
    let mut document = nemoclaw_sdk::config::Document::parse(
        &include_bytes!("../../../examples/multiple-providers.yaml")[..],
    )
    .unwrap();
    document.spec.sandboxes.truncate(1);
    let base =
        PartialDocument::from_yaml(serde_json::to_vec(&document).unwrap().as_slice()).unwrap();
    let mut state = JourneyDefinition::new("referenced-routes", base)
        .ask([JourneyScope::RouteModels])
        .start(&capabilities)
        .unwrap();
    let path = "/spec/inferences/smart-and-fast/routes/1/overrides/model";
    let original = state.values().clone();
    assert_eq!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("route:selection")
            .unwrap()
            .choices(),
        &[json!("smart"), json!("fast")]
    );
    state
        .answer(&capabilities, "route:selection", Some(json!("fast")))
        .unwrap();
    assert_eq!(state.current_route(), Some("fast"));
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(path)
            .is_some()
    );
    state
        .answer(&capabilities, path, Some(json!("new-local-model")))
        .unwrap();
    assert_eq!(
        state.values().pointer(path),
        Some(&json!("new-local-model"))
    );
    assert_eq!(
        state
            .values()
            .pointer("/spec/inferences/smart-and-fast/routes/0"),
        original.pointer("/spec/inferences/smart-and-fast/routes/0")
    );
    let before_invalid = state.values().clone();
    assert!(
        state
            .answer(&capabilities, "route:selection", Some(json!("absent")))
            .is_err()
    );
    assert_eq!(state.values(), &before_invalid);
    document
        .spec
        .inferences
        .get_mut("smart-and-fast")
        .unwrap()
        .routes[1]
        .overrides
        .model = "new-local-model".into();
    assert_eq!(
        state
            .resolve(&capabilities)
            .unwrap()
            .assessment()
            .document()
            .unwrap(),
        &document
    );
}

#[test]
fn referenced_harness_settings_are_owned_by_the_referenced_definition() {
    let capabilities = Capabilities::available();
    let mut document = nemoclaw_sdk::config::Document::parse(
        &include_bytes!("../../../examples/multiple-models.yaml")[..],
    )
    .unwrap();
    document.spec.sandboxes.truncate(1);
    let base =
        PartialDocument::from_yaml(serde_json::to_vec(&document).unwrap().as_slice()).unwrap();
    let mut state = JourneyDefinition::new("referenced-harness", base)
        .ask([JourneyScope::ActiveAdapterSettings])
        .start(&capabilities)
        .unwrap();
    let field = "adapter:nvidia.fabric.openclaw:/timeout_seconds";
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(field)
            .is_some()
    );
    state
        .answer(&capabilities, field, Some(json!(301)))
        .unwrap();
    assert_eq!(
        state
            .values()
            .pointer("/spec/harnesses/assistant/settings/timeout_seconds"),
        Some(&json!(301))
    );
    assert!(
        state
            .values()
            .pointer("/spec/sandboxes/0/harness")
            .is_none()
    );
}

#[test]
fn revisiting_a_referenced_harness_choice_does_not_create_an_inline_harness() {
    let capabilities = Capabilities::available();
    let mut document = nemoclaw_sdk::config::Document::parse(
        &include_bytes!("../../../examples/multiple-models.yaml")[..],
    )
    .unwrap();
    document.spec.sandboxes.truncate(1);
    let base =
        PartialDocument::from_yaml(serde_json::to_vec(&document).unwrap().as_slice()).unwrap();
    let mut state = JourneyDefinition::new("referenced-harness-choice", base)
        .ask(["/spec/sandboxes/0/harness/kind"])
        .start(&capabilities)
        .unwrap();
    let field = "/spec/sandboxes/0/harness/kind";
    state
        .answer(&capabilities, field, Some(json!("nvidia.fabric.openclaw")))
        .unwrap();
    state
        .answer(&capabilities, field, Some(json!("nvidia.fabric.hermes")))
        .unwrap();
    assert_eq!(
        state.values().pointer("/spec/harnesses/assistant/kind"),
        Some(&json!("nvidia.fabric.hermes"))
    );
    assert!(
        state
            .values()
            .pointer("/spec/sandboxes/0/harness")
            .is_none()
    );
}

#[test]
fn referenced_model_settings_are_written_to_the_selected_route() {
    let capabilities = Capabilities::available();
    let mut document = nemoclaw_sdk::config::Document::parse(
        &include_bytes!("../../../examples/multiple-models.yaml")[..],
    )
    .unwrap();
    document.spec.sandboxes.truncate(1);
    let base =
        PartialDocument::from_yaml(serde_json::to_vec(&document).unwrap().as_slice()).unwrap();
    let mut state = JourneyDefinition::new("referenced-model", base)
        .ask([JourneyScope::RouteModels])
        .ask([JourneyScope::NativeSettings])
        .start(&capabilities)
        .unwrap();
    state
        .answer(&capabilities, "route:selection", Some(json!("fast")))
        .unwrap();
    let field = "model:/reasoning_effort";
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(field)
            .is_some()
    );
    state
        .answer(&capabilities, field, Some(json!("low")))
        .unwrap();
    assert_eq!(
        state.values().pointer(
            "/spec/inferences/smart-and-fast/routes/1/overrides/settings/reasoning_effort"
        ),
        Some(&json!("low"))
    );
    assert!(
        state
            .values()
            .pointer("/spec/sandboxes/0/agent/inference")
            .is_none()
    );
}

#[test]
fn referenced_workflow_answers_keep_the_named_harness_as_the_owner() {
    let mut catalog = FabricCatalog::bundled();
    let mut adapter = catalog.adapters[0].clone();
    adapter.descriptor["adapter_id"] = json!("fixture.workflow-owner");
    adapter.descriptor["settings_schema"] = json!({"type":"object","properties":{}});
    adapter.descriptor["config"]["schema"] = json!({"type":"object","required":["workflow"]});
    catalog.adapters = vec![adapter];
    catalog.targets = vec![json!({"descriptor":{
        "type":"workflow","id":"fixture.target","adapter_id":"fixture.workflow-owner",
        "spec":{"settings_schema":{"type":"object","properties":{}}}
    },"provenance":[]})];
    let capabilities = Capabilities::from_catalog(&catalog);
    let mut document = nemoclaw_sdk::config::Document::parse(
        &include_bytes!("../../../examples/multiple-models.yaml")[..],
    )
    .unwrap();
    document.spec.sandboxes.truncate(1);
    let mut value = serde_json::to_value(&document).unwrap();
    value["spec"]["harnesses"]["assistant"]["kind"] = json!("fixture.workflow-owner");
    let base = PartialDocument::from_yaml(value.to_string().as_bytes()).unwrap();
    let mut state = JourneyDefinition::new("referenced-workflow", base)
        .ask([JourneyScope::NativeSettings])
        .start(&capabilities)
        .unwrap();
    let field = "workflow:/target_id";
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(field)
            .is_some()
    );
    state
        .answer(&capabilities, field, Some(json!("fixture.target")))
        .unwrap();
    assert_eq!(
        state
            .values()
            .pointer("/spec/harnesses/assistant/config/workflow/target_id"),
        Some(&json!("fixture.target"))
    );
    assert!(
        state
            .values()
            .pointer("/spec/sandboxes/0/harness")
            .is_none()
    );
}

#[test]
fn omitting_an_implicit_api_keeps_the_sdk_default_without_writing_an_override() {
    let capabilities = Capabilities::available();
    let bytes = include_bytes!("../../../examples/explicit-policy.yaml");
    let original = nemoclaw_sdk::config::Document::parse(&bytes[..]).unwrap();
    let base = PartialDocument::from_yaml(bytes).unwrap();
    let mut state = JourneyDefinition::new("implicit-api", base)
        .ask([JourneyScope::InferenceApi])
        .start(&capabilities)
        .unwrap();
    let path = "/spec/inferenceProviders/0/api";
    let question = state
        .resolve(&capabilities)
        .unwrap()
        .question(path)
        .cloned()
        .unwrap();
    assert!(!question.required());
    assert!(question.suggestion().is_none());
    state.answer(&capabilities, path, None).unwrap();
    assert!(state.values().pointer(path).is_none());
    assert_eq!(
        state
            .resolve(&capabilities)
            .unwrap()
            .assessment()
            .document()
            .unwrap(),
        &original
    );
}

#[test]
fn absent_optional_adapter_settings_remain_unsupplied_until_answered() {
    let capabilities = Capabilities::available();
    let base = PartialDocument::from_yaml(include_bytes!("../../../examples/explicit-policy.yaml"))
        .unwrap();
    let mut state = JourneyDefinition::new("optional-adapter", base)
        .ask([JourneyScope::ActiveAdapterSettings])
        .start(&capabilities)
        .unwrap();
    let field = "adapter:nvidia.fabric.openclaw:/cli";
    let question = state
        .resolve(&capabilities)
        .unwrap()
        .question(field)
        .cloned()
        .unwrap();
    assert!(!question.required());
    assert!(question.suggestion().is_none());
    state.answer(&capabilities, field, None).unwrap();
    assert!(
        state
            .values()
            .pointer("/spec/sandboxes/0/harness/settings/cli")
            .is_none()
    );
}

#[test]
fn editing_a_route_model_preserves_explicit_credential_references() {
    let capabilities = Capabilities::available();
    let yaml = include_str!("../../../examples/onboarding/openclaw.yaml")
        .replace("NVIDIA_API_KEY", "NVIDIA_INFERENCE_API_KEY");
    let base = PartialDocument::from_yaml(yaml.as_bytes()).unwrap();
    let mut state = JourneyDefinition::new("credential-reference", base)
        .ask([JourneyScope::RouteModels])
        .start(&capabilities)
        .unwrap();
    let model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    state
        .answer(
            &capabilities,
            model,
            Some(json!("organization/selected-model")),
        )
        .unwrap();
    let resolution = state.resolve(&capabilities).unwrap();
    let document = resolution.assessment().document().unwrap();
    assert_eq!(document.credential_names(), ["NVIDIA_INFERENCE_API_KEY"]);
    assert_eq!(
        document.inference_provider().unwrap().endpoint,
        "https://integrate.api.nvidia.com/v1"
    );
}

#[test]
fn route_preset_changes_only_the_selected_external_provider() {
    let capabilities = Capabilities::available();
    let base = PartialDocument::from_yaml(include_bytes!(
        "../../../examples/spark/local-and-hosted.yaml"
    ))
    .unwrap();
    let mut state = JourneyDefinition::new("route-presets", base)
        .ask([JourneyScope::RouteModels])
        .ask(["inference:preset"])
        .start(&capabilities)
        .unwrap();
    let before = state.values().clone();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("inference:preset")
            .is_none()
    );
    state
        .answer(&capabilities, "route:selection", Some(json!("local")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("inference:preset")
            .is_none()
    );
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/agent/inference/routes/0/overrides/model",
            Some(json!("nvidia/Qwen3.8-27B-NVFP4")),
        )
        .unwrap();
    state
        .answer(&capabilities, "route:selection", Some(json!("hosted")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("inference:preset")
            .is_some()
    );
    state
        .answer(&capabilities, "inference:preset", Some(json!("openai")))
        .unwrap();
    assert_eq!(
        state.values().pointer("/spec/inferenceProviders/0"),
        before.pointer("/spec/inferenceProviders/0")
    );
    assert_eq!(
        state.values().pointer("/spec/inferenceProviders/1/name"),
        Some(&json!("hosted"))
    );
    assert_eq!(
        state
            .values()
            .pointer("/spec/sandboxes/0/agent/inference/routes/1/providerRef"),
        Some(&json!("hosted"))
    );
    assert_eq!(
        state
            .values()
            .pointer("/spec/sandboxes/0/agent/inference/routes/0/overrides/model"),
        before.pointer("/spec/sandboxes/0/agent/inference/routes/0/overrides/model")
    );
}

#[test]
fn partial_journey_recomputes_questions_after_answers_and_omissions() {
    let capabilities = Capabilities::available();
    let definition = JourneyDefinition::new("minimum", minimum());
    let mut state = definition.start(&capabilities).unwrap();
    let questions = state.resolve(&capabilities).unwrap();
    assert!(questions.question("/metadata/name").is_some());
    assert!(questions.question("form:/spec/sandboxes/0").is_some());
    assert!(
        questions
            .question("/spec/sandboxes/0/harness/kind")
            .is_none()
    );
    assert!(
        questions
            .question("adapter:nvidia.fabric.openclaw:/cli")
            .is_none()
    );

    state
        .answer(
            &capabilities,
            "/metadata/name",
            Some(json!("my-deployment")),
        )
        .unwrap();
    state
        .answer(
            &capabilities,
            "form:/spec/sandboxes/0",
            Some(json!("harness")),
        )
        .unwrap();
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/harness/kind",
            Some(json!("nvidia.fabric.openclaw")),
        )
        .unwrap();
    let questions = state.resolve(&capabilities).unwrap();
    assert!(questions.question("/metadata/name").is_none());
    assert!(
        questions
            .question("adapter:nvidia.fabric.openclaw:/cli")
            .is_some()
    );

    state
        .answer(&capabilities, "adapter:nvidia.fabric.openclaw:/cli", None)
        .unwrap();
    let questions = state.resolve(&capabilities).unwrap();
    assert!(
        questions
            .question("adapter:nvidia.fabric.openclaw:/cli")
            .is_none()
    );
    assert!(
        questions
            .omitted()
            .contains(&"adapter:nvidia.fabric.openclaw:/cli".to_owned())
    );
    assert!(questions.assessment().document().is_none());
}

#[test]
fn accepting_a_supplied_suggestion_resolves_an_explicit_ask() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let definition = JourneyDefinition::new("guided", base).ask(["/metadata/name"]);
    let mut state = definition.start(&capabilities).unwrap();
    let suggested = state
        .resolve(&capabilities)
        .unwrap()
        .question("/metadata/name")
        .unwrap()
        .suggestion()
        .cloned()
        .unwrap();

    state
        .answer(&capabilities, "/metadata/name", Some(suggested))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("/metadata/name")
            .is_none()
    );
}

#[test]
fn existing_onboarding_fields_resolve_and_materialize_without_a_draft() {
    let capabilities = Capabilities::available();
    let mut sparse: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    sparse
        .pointer_mut("/spec/sandboxes/0/agent/inference/routes/0/overrides")
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("model");
    let base = PartialDocument::from_yaml(sparse.to_string().as_bytes()).unwrap();
    let fields = [
        "/metadata/name",
        "/spec/sandboxes/0/harness/kind",
        "/spec/sandboxes/0/runtime/provider",
        "/spec/inferenceProviders/0/provider",
        "/spec/inferenceProviders/0/api",
        "/spec/sandboxes/0/agent/inference/routes/0/overrides/model",
    ];
    let definition = JourneyDefinition::new("guided", base).ask(fields).omit([
        "adapter:nvidia.fabric.openclaw:/agent_name",
        "adapter:nvidia.fabric.openclaw:/cli",
        "adapter:nvidia.fabric.openclaw:/home",
        "adapter:nvidia.fabric.openclaw:/native_config",
        "adapter:nvidia.fabric.openclaw:/timeout_seconds",
    ]);
    let mut state = definition.start(&capabilities).unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .assessment()
            .document()
            .is_none()
    );
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .materialized_document()
            .is_none()
    );
    for field in fields {
        assert!(
            state
                .resolve(&capabilities)
                .unwrap()
                .question(field)
                .is_some(),
            "{field}"
        );
    }
    let mut seen = Vec::new();
    for _ in fields {
        let question = state
            .resolve(&capabilities)
            .unwrap()
            .next_question()
            .cloned()
            .unwrap();
        let field = question.id();
        seen.push(field.to_owned());
        let value = match field {
            "/metadata/name" => json!("new-deployment"),
            "/spec/sandboxes/0/agent/inference/routes/0/overrides/model" => {
                let before = state.values().clone();
                assert!(
                    state
                        .answer(&capabilities, field, Some(json!("bad model")))
                        .is_err()
                );
                assert_eq!(state.values(), &before);
                json!("nvidia/another-model")
            }
            _ => question.suggestion().cloned().unwrap(),
        };
        state.answer(&capabilities, field, Some(value)).unwrap();
    }
    assert_eq!(seen, fields);
    let resolved = state.resolve(&capabilities).unwrap();
    assert!(
        resolved.questions().is_empty(),
        "{:?}",
        resolved.questions()
    );
    assert!(
        resolved.unverified().is_empty(),
        "{:?}",
        resolved.unverified()
    );
    let document = resolved.materialized_document().unwrap();
    assert_eq!(document.metadata.name, "new-deployment");
    assert_eq!(
        state
            .values()
            .pointer("/spec/sandboxes/0/agent/inference/routes/0/overrides/model"),
        Some(&json!("nvidia/another-model"))
    );
}

#[test]
fn inference_preset_updates_sparse_values_and_reopens_dependent_answers() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let preset = "inference:preset";
    let api = "/spec/inferenceProviders/0/api";
    let provider_name = "/spec/inferenceProviders/0/name";
    let model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    let name = "/metadata/name";
    let mut state = JourneyDefinition::new("preset", base)
        .ask([name, preset, api, model, provider_name])
        .omit([
            "adapter:nvidia.fabric.openclaw:/agent_name",
            "adapter:nvidia.fabric.openclaw:/cli",
            "adapter:nvidia.fabric.openclaw:/home",
            "adapter:nvidia.fabric.openclaw:/native_config",
            "adapter:nvidia.fabric.openclaw:/timeout_seconds",
        ])
        .start(&capabilities)
        .unwrap();

    assert_eq!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(preset)
            .unwrap()
            .suggestion(),
        Some(&json!("nvidia-endpoints"))
    );
    state
        .answer(&capabilities, name, Some(json!("my-deployment")))
        .unwrap();
    state
        .answer(&capabilities, preset, Some(json!("nvidia-endpoints")))
        .unwrap();
    state
        .answer(&capabilities, api, Some(json!("openai-completions")))
        .unwrap();
    state
        .answer(&capabilities, model, Some(json!("nvidia/my-model")))
        .unwrap();
    state
        .answer(&capabilities, provider_name, Some(json!("nvidia-prod")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .materialized_document()
            .is_some()
    );

    let before = state.values().clone();
    assert!(
        state
            .answer(&capabilities, preset, Some(json!("unknown")))
            .is_err()
    );
    assert_eq!(state.values(), &before);
    state
        .answer(&capabilities, preset, Some(json!("anthropic")))
        .unwrap();
    let reopened = state.resolve(&capabilities).unwrap();
    assert_eq!(
        reopened.question(model).unwrap().reopened_because(),
        Some(preset)
    );
    assert_eq!(
        reopened.question(api).unwrap().reopened_because(),
        Some(preset)
    );
    assert_eq!(
        state
            .values()
            .pointer("/spec/inferenceProviders/0/provider"),
        Some(&json!("anthropic"))
    );
    assert_eq!(
        state.values().pointer("/spec/inferenceProviders/0/name"),
        Some(&json!("nvidia-prod"))
    );
    assert_eq!(
        state.values().pointer("/spec/inferenceProviders/0/api"),
        Some(&json!("anthropic-messages"))
    );
    assert_eq!(
        state
            .values()
            .pointer("/spec/inferenceProviders/0/endpoint"),
        Some(&json!("https://api.anthropic.com"))
    );
    assert_eq!(
        state
            .values()
            .pointer("/spec/inferenceProviders/0/credential/env"),
        Some(&json!("ANTHROPIC_API_KEY"))
    );
    assert_eq!(
        state
            .values()
            .pointer("/spec/sandboxes/0/agent/inference/routes/0/providerRef"),
        Some(&json!("nvidia-prod"))
    );
    assert_eq!(
        state.values().pointer(model),
        Some(&json!("claude-sonnet-4-6"))
    );
    let resolved = state.resolve(&capabilities).unwrap();
    assert!(resolved.question(name).is_none());
    assert!(resolved.question(api).is_some());
    assert!(resolved.question(provider_name).is_none());
    assert!(resolved.question(model).is_some());
    assert!(resolved.materialized_document().is_none());
    assert!(
        state
            .answer(&capabilities, api, Some(json!("openai-completions")))
            .is_err()
    );
    state
        .answer(&capabilities, api, Some(json!("anthropic-messages")))
        .unwrap();
    state
        .answer(&capabilities, model, Some(json!("claude-sonnet-4-6")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .materialized_document()
            .is_some()
    );
}

#[test]
fn compatible_inference_preset_requires_an_endpoint_answer() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("custom", base)
        .ask([
            "inference:preset",
            "/spec/sandboxes/0/agent/inference/routes/0/overrides/model",
        ])
        .start(&capabilities)
        .unwrap();
    state
        .answer(
            &capabilities,
            "inference:preset",
            Some(json!("openai-compatible")),
        )
        .unwrap();
    let resolved = state.resolve(&capabilities).unwrap();
    assert!(
        resolved
            .question("/spec/inferenceProviders/0/endpoint")
            .is_some()
    );
    assert!(
        resolved
            .question("/spec/sandboxes/0/agent/inference/routes/0/overrides/model")
            .is_none()
    );
    assert!(
        state
            .values()
            .pointer("/spec/sandboxes/0/agent/inference/routes/0/overrides/model")
            .is_none()
    );
    assert!(resolved.materialized_document().is_none());
    let endpoint = "/spec/inferenceProviders/0/endpoint";
    let before = state.values().clone();
    assert!(
        state
            .answer(&capabilities, endpoint, Some(json!("file:///tmp/model")))
            .is_err()
    );
    assert_eq!(state.values(), &before);
    state
        .answer(
            &capabilities,
            endpoint,
            Some(json!("https://inference.internal.example/v1")),
        )
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("/spec/sandboxes/0/agent/inference/routes/0/overrides/model")
            .is_some()
    );
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/agent/inference/routes/0/overrides/model",
            Some(json!("org/model")),
        )
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(endpoint)
            .is_none()
    );
}

#[test]
fn inference_dependencies_wait_for_preset_and_custom_endpoint() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let api = "/spec/inferenceProviders/0/api";
    let model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    let endpoint = "/spec/inferenceProviders/0/endpoint";
    let preset = "inference:preset";
    let mut state = JourneyDefinition::new("order", base)
        .ask([api, model, preset])
        .start(&capabilities)
        .unwrap();
    let before = state.resolve(&capabilities).unwrap();
    assert_eq!(before.next_question().unwrap().id(), preset);
    assert!(before.question(api).is_none());
    assert!(before.question(model).is_none());

    state
        .answer(&capabilities, preset, Some(json!("openai-compatible")))
        .unwrap();
    let after = state.resolve(&capabilities).unwrap();
    assert!(after.question(api).is_some());
    assert!(after.question(endpoint).is_some());
    assert!(after.question(model).is_none());
    state
        .answer(
            &capabilities,
            endpoint,
            Some(json!("https://inference.internal.example/v1")),
        )
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(model)
            .is_some()
    );
}

#[test]
fn changing_inference_api_reopens_the_accepted_model_but_keeps_identity() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("api-dependency", base)
        .ask(["/metadata/name", "/spec/inferenceProviders/0/endpoint"])
        .ask([JourneyScope::InferenceApi, JourneyScope::RouteModels])
        .start(&capabilities)
        .unwrap();
    let name = "/metadata/name";
    let api = "/spec/inferenceProviders/0/api";
    let model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    let endpoint = "/spec/inferenceProviders/0/endpoint";
    state
        .answer(&capabilities, name, Some(json!("my-project")))
        .unwrap();
    state
        .answer(&capabilities, model, Some(json!("nvidia/selected-model")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(model)
            .is_none()
    );
    state
        .answer(&capabilities, api, Some(json!("openai-responses")))
        .unwrap();
    let resolved = state.resolve(&capabilities).unwrap();
    assert_eq!(
        resolved.question(model).unwrap().reopened_because(),
        Some(api)
    );
    assert_eq!(
        state.decision_status(model),
        DecisionStatus::Reopened {
            because: api.into()
        }
    );
    assert_eq!(state.decision_status(name), DecisionStatus::Accepted);
    assert!(resolved.question(name).is_none());
    assert_eq!(
        state.values().pointer(model),
        Some(&json!("nvidia/selected-model"))
    );
    state
        .answer(&capabilities, model, Some(json!("nvidia/selected-model")))
        .unwrap();
    state
        .answer(
            &capabilities,
            endpoint,
            Some(json!("https://new.example.com/v1")),
        )
        .unwrap();
    assert_eq!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(model)
            .unwrap()
            .reopened_because(),
        Some(endpoint)
    );
}

#[test]
fn changing_the_second_provider_api_reopens_its_route_model() {
    let capabilities = Capabilities::available();
    let base = PartialDocument::from_yaml(include_bytes!(
        "../../../examples/spark/local-and-hosted.yaml"
    ))
    .unwrap();
    let mut state = JourneyDefinition::new("second-provider-api", base)
        .ask([JourneyScope::RouteModels])
        .ask(["/spec/inferenceProviders/1/api"])
        .start(&capabilities)
        .unwrap();
    let api = "/spec/inferenceProviders/1/api";
    let model = "/spec/sandboxes/0/agent/inference/routes/1/overrides/model";
    state
        .answer(&capabilities, "route:selection", Some(json!("hosted")))
        .unwrap();
    state
        .answer(&capabilities, model, Some(json!("vendor/selected-model")))
        .unwrap();
    state
        .answer(&capabilities, api, Some(json!("openai-responses")))
        .unwrap();
    assert_eq!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(model)
            .unwrap()
            .reopened_because(),
        Some(api)
    );
}

#[test]
fn optional_sdk_question_can_be_deliberately_omitted() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("optional-api", base)
        .ask(["/spec/inferenceProviders/0/api"])
        .omit([
            "adapter:nvidia.fabric.openclaw:/agent_name",
            "adapter:nvidia.fabric.openclaw:/cli",
            "adapter:nvidia.fabric.openclaw:/home",
            "adapter:nvidia.fabric.openclaw:/native_config",
            "adapter:nvidia.fabric.openclaw:/timeout_seconds",
        ])
        .start(&capabilities)
        .unwrap();
    let question = state
        .resolve(&capabilities)
        .unwrap()
        .next_question()
        .cloned()
        .unwrap();
    assert!(!question.required());
    state.answer(&capabilities, question.id(), None).unwrap();
    let resolved = state.resolve(&capabilities).unwrap();
    assert!(resolved.omitted().contains(&question.id().to_owned()));
    assert!(resolved.materialized_document().is_some());
}

#[test]
fn invalid_answer_does_not_mutate_a_sparse_journey() {
    let capabilities = Capabilities::available();
    let mut state = JourneyDefinition::new("minimum", minimum())
        .start(&capabilities)
        .unwrap();
    assert!(
        state
            .answer(&capabilities, "/metadata/name", Some(json!("Bad Name")))
            .is_err()
    );
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("/metadata/name")
            .is_some()
    );
}

#[test]
fn switching_harness_reopens_the_active_adapter_without_losing_its_values() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let definition = JourneyDefinition::new("switch", base).ask(["/spec/sandboxes/0/harness/kind"]);
    let mut state = definition.start(&capabilities).unwrap();
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/harness/kind",
            Some(json!("nvidia.fabric.openclaw")),
        )
        .unwrap();
    state
        .answer(
            &capabilities,
            "adapter:nvidia.fabric.openclaw:/agent_name",
            Some(json!("kept-agent")),
        )
        .unwrap();
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
            .question("adapter:nvidia.fabric.hermes:/mode")
            .is_some()
    );
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/harness/kind",
            Some(json!("nvidia.fabric.openclaw")),
        )
        .unwrap();
    assert_eq!(
        state
            .values()
            .pointer("/spec/sandboxes/0/harness/settings/agent_name"),
        Some(&json!("kept-agent"))
    );
}

#[test]
fn accepted_answers_can_be_revisited_without_losing_other_values() {
    let capabilities = Capabilities::available();
    let mut state = JourneyDefinition::new("minimum", minimum())
        .start(&capabilities)
        .unwrap();
    state
        .answer(&capabilities, "/metadata/name", Some(json!("first")))
        .unwrap();
    state
        .answer(&capabilities, "/metadata/name", Some(json!("second")))
        .unwrap();
    state
        .answer(
            &capabilities,
            "form:/spec/sandboxes/0",
            Some(json!("harness")),
        )
        .unwrap();
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/harness/kind",
            Some(json!("nvidia.fabric.openclaw")),
        )
        .unwrap();
    state
        .answer(
            &capabilities,
            "adapter:nvidia.fabric.openclaw:/agent_name",
            Some(json!("alpha")),
        )
        .unwrap();
    state
        .answer(
            &capabilities,
            "adapter:nvidia.fabric.openclaw:/agent_name",
            Some(json!("beta")),
        )
        .unwrap();

    assert_eq!(
        state.values().pointer("/metadata/name"),
        Some(&json!("second"))
    );
    assert_eq!(
        state
            .values()
            .pointer("/spec/sandboxes/0/harness/settings/agent_name"),
        Some(&json!("beta"))
    );
}

#[test]
fn fabric_invalid_value_reopens_a_question_even_when_sdk_document_is_valid() {
    let capabilities = Capabilities::available();
    let mut base: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    base["spec"]["sandboxes"][0]["harness"]["settings"] = json!({"cli": 42});
    let base = PartialDocument::from_yaml(base.to_string().as_bytes()).unwrap();
    let mut state = JourneyDefinition::new("fabric-invalid", base)
        .start(&capabilities)
        .unwrap();
    let resolved = state.resolve(&capabilities).unwrap();
    assert!(resolved.assessment().document().is_some());
    assert_eq!(
        resolved
            .question("adapter:nvidia.fabric.openclaw:/cli")
            .unwrap()
            .reason(),
        JourneyQuestionReason::InvalidSupplied
    );

    state
        .answer(
            &capabilities,
            "adapter:nvidia.fabric.openclaw:/cli",
            Some(json!("openclaw")),
        )
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("adapter:nvidia.fabric.openclaw:/cli")
            .is_none()
    );
}

#[test]
fn fully_supplied_express_definition_has_no_current_questions() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let definition = JourneyDefinition::new("express", base).omit([
        "adapter:nvidia.fabric.openclaw:/agent_name",
        "adapter:nvidia.fabric.openclaw:/cli",
        "adapter:nvidia.fabric.openclaw:/home",
        "adapter:nvidia.fabric.openclaw:/native_config",
        "adapter:nvidia.fabric.openclaw:/timeout_seconds",
    ]);

    let resolved = definition
        .start(&capabilities)
        .unwrap()
        .resolve(&capabilities)
        .unwrap();
    assert!(resolved.questions().is_empty());
    assert!(resolved.assessment().document().is_some());
    assert!(resolved.unverified().is_empty());
}

#[test]
fn missing_catalog_schema_keeps_unreachable_guidance_as_a_warning() {
    let capabilities = Capabilities::from_harnesses(["nvidia.fabric.openclaw".parse().unwrap()]);
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let definition =
        JourneyDefinition::new("catalog-gap", base).ask(["adapter:nvidia.fabric.hermes:/mode"]);

    let resolved = definition
        .start(&capabilities)
        .unwrap()
        .resolve(&capabilities)
        .unwrap();
    assert!(
        resolved
            .warnings()
            .iter()
            .any(|warning| warning.contains("adapter:nvidia.fabric.hermes:/mode"))
    );
    assert!(!resolved.unverified().is_empty());
}

#[test]
fn supplied_template_can_finish_a_guided_journey_through_one_resolver() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let definition = JourneyDefinition::new("guided-complete", base)
        .ask(["/metadata/name", "/spec/sandboxes/0/harness/kind"])
        .omit([
            "adapter:nvidia.fabric.openclaw:/agent_name",
            "adapter:nvidia.fabric.openclaw:/cli",
            "adapter:nvidia.fabric.openclaw:/home",
            "adapter:nvidia.fabric.openclaw:/native_config",
            "adapter:nvidia.fabric.openclaw:/timeout_seconds",
        ]);
    let mut state = definition.start(&capabilities).unwrap();
    assert_eq!(state.resolve(&capabilities).unwrap().questions().len(), 2);
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .assessment()
            .document()
            .is_some()
    );
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .materialized_document()
            .is_none()
    );

    state
        .answer(
            &capabilities,
            "/metadata/name",
            Some(json!("guided-complete")),
        )
        .unwrap();
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/harness/kind",
            Some(json!("nvidia.fabric.openclaw")),
        )
        .unwrap();
    let resolved = state.resolve(&capabilities).unwrap();

    assert!(resolved.questions().is_empty());
    assert!(resolved.unverified().is_empty());
    assert!(resolved.materialized_document().is_some());
    assert_eq!(
        resolved.assessment().document().unwrap().metadata.name,
        "guided-complete"
    );
}

#[test]
fn absent_harness_catalog_cannot_silently_accept_an_unadvertised_choice() {
    let capabilities = Capabilities::from_harnesses([]);
    let mut state = JourneyDefinition::new("empty-catalog", minimum())
        .start(&capabilities)
        .unwrap();
    let resolved = state.resolve(&capabilities).unwrap();
    assert!(resolved.question("form:/spec/sandboxes/0").is_some());
    state
        .answer(
            &capabilities,
            "form:/spec/sandboxes/0",
            Some(json!("harness")),
        )
        .unwrap();
    let resolved = state.resolve(&capabilities).unwrap();
    assert!(
        resolved
            .question("/spec/sandboxes/0/harness/kind")
            .is_some()
    );
    assert!(!resolved.unverified().is_empty());
    assert!(
        state
            .answer(
                &capabilities,
                "/spec/sandboxes/0/harness/kind",
                Some(json!("nvidia.fabric.openclaw"))
            )
            .is_err()
    );
}

#[test]
fn missing_gateway_asks_for_the_schema_discriminator() {
    let base = PartialDocument::from_yaml(
        b"apiVersion: nemoclaw.nvidia.com/v1alpha1\nkind: NemoClawConfig\nspec:\n  sandboxes:\n    - {}\n",
    )
    .unwrap();
    let capabilities = Capabilities::available();
    let mut journey = JourneyDefinition::new("gateway", base)
        .start(&capabilities)
        .unwrap();
    let question = journey
        .resolve(&capabilities)
        .unwrap()
        .question("/spec/gateway/management")
        .cloned()
        .expect("gateway discriminator from SDK schema");
    assert!(question.required());
    assert_eq!(question.choices(), &[json!("managed"), json!("external")]);
    journey
        .answer(&capabilities, question.id(), Some(json!("managed")))
        .unwrap();
    assert_eq!(
        journey.values().pointer("/spec/gateway/management"),
        Some(&json!("managed"))
    );
    assert!(
        journey
            .resolve(&capabilities)
            .unwrap()
            .question("/spec/gateway/management")
            .is_none()
    );
}

#[test]
fn external_gateway_choice_reveals_its_required_endpoint() {
    let mut values: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    values["spec"]["gateway"] = json!({});
    let base = PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap();
    let capabilities = Capabilities::available();
    let mut journey = JourneyDefinition::new("external-gateway", base)
        .omit([
            "adapter:nvidia.fabric.openclaw:/agent_name",
            "adapter:nvidia.fabric.openclaw:/cli",
            "adapter:nvidia.fabric.openclaw:/home",
            "adapter:nvidia.fabric.openclaw:/native_config",
            "adapter:nvidia.fabric.openclaw:/timeout_seconds",
        ])
        .start(&capabilities)
        .unwrap();
    assert!(
        journey
            .resolve(&capabilities)
            .unwrap()
            .question("/spec/gateway/management")
            .is_some()
    );
    journey
        .answer(
            &capabilities,
            "/spec/gateway/management",
            Some(json!("external")),
        )
        .unwrap();
    let endpoint = journey
        .resolve(&capabilities)
        .unwrap()
        .question("/spec/gateway/endpoint")
        .cloned()
        .expect("external gateway endpoint");
    assert!(endpoint.required());
    journey
        .answer(
            &capabilities,
            endpoint.id(),
            Some(json!("https://gateway.example.com")),
        )
        .unwrap();
    let resolution = journey.resolve(&capabilities).unwrap();
    assert!(
        resolution.materialized_document().is_some(),
        "questions={:?} unverified={:?} issues={:?}",
        resolution.questions(),
        resolution.unverified(),
        resolution.assessment().issues()
    );
}

#[test]
fn supplied_gateway_discriminator_can_be_deliberately_asked() {
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let capabilities = Capabilities::available();
    let journey = JourneyDefinition::new("gateway-choice", base)
        .ask(["/spec/gateway/management"])
        .start(&capabilities)
        .unwrap();
    let question = journey
        .resolve(&capabilities)
        .unwrap()
        .question("/spec/gateway/management")
        .cloned()
        .expect("explicit gateway question");
    assert_eq!(question.suggestion(), Some(&json!("managed")));
    assert_eq!(question.choices(), &[json!("managed"), json!("external")]);
}

#[test]
fn sdk_guidance_can_name_a_field_in_a_later_gateway_branch() {
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let capabilities = Capabilities::available();
    let mut journey = JourneyDefinition::new("future-gateway-field", base)
        .ask(["/spec/gateway/management", "/spec/gateway/tls"])
        .start(&capabilities)
        .unwrap();
    let before = journey.resolve(&capabilities).unwrap();
    assert!(before.question("/spec/gateway/tls").is_none());
    assert!(
        before
            .warnings()
            .iter()
            .any(|warning| warning.contains("/spec/gateway/tls"))
    );
    journey
        .answer(
            &capabilities,
            "/spec/gateway/management",
            Some(json!("external")),
        )
        .unwrap();
    let after = journey.resolve(&capabilities).unwrap();
    assert!(after.question("/spec/gateway/tls").is_some());

    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut omitted = JourneyDefinition::new("omit-future-gateway-field", base)
        .ask(["/spec/gateway/management"])
        .omit(["/spec/gateway/tls"])
        .start(&capabilities)
        .unwrap();
    omitted
        .answer(
            &capabilities,
            "/spec/gateway/management",
            Some(json!("external")),
        )
        .unwrap();
    assert!(
        omitted
            .resolve(&capabilities)
            .unwrap()
            .omitted()
            .contains(&"/spec/gateway/tls".to_owned())
    );
}

#[test]
fn invalid_supplied_gateway_discriminator_is_a_repair_question() {
    let mut values: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    values["spec"]["gateway"]["management"] = json!("unknown");
    let base = PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap();
    let capabilities = Capabilities::available();
    let mut journey = JourneyDefinition::new("repair-gateway", base)
        .start(&capabilities)
        .unwrap();
    let question = journey
        .resolve(&capabilities)
        .unwrap()
        .question("/spec/gateway/management")
        .cloned()
        .expect("invalid discriminator is editable");
    assert_eq!(question.reason(), JourneyQuestionReason::InvalidSupplied);
    journey
        .answer(&capabilities, question.id(), Some(json!("managed")))
        .unwrap();
    assert!(
        journey
            .resolve(&capabilities)
            .unwrap()
            .question("/spec/gateway/management")
            .is_none()
    );
}

#[test]
fn accepted_implicit_gateway_choice_can_be_revisited() {
    let mut values: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    values["spec"]["gateway"] = json!({});
    let base = PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap();
    let capabilities = Capabilities::available();
    let mut journey = JourneyDefinition::new("revisit-gateway", base)
        .start(&capabilities)
        .unwrap();
    journey
        .answer(
            &capabilities,
            "/spec/gateway/management",
            Some(json!("managed")),
        )
        .unwrap();
    journey
        .answer(
            &capabilities,
            "/spec/gateway/management",
            Some(json!("external")),
        )
        .unwrap();
    assert!(
        journey
            .resolve(&capabilities)
            .unwrap()
            .question("/spec/gateway/endpoint")
            .is_some()
    );
}

#[test]
fn switching_gateway_management_drops_fields_from_the_previous_branch() {
    let mut values: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    // `networkCIDR` is defined only for managed gateways; `engine` is defined
    // for both forms.
    values["spec"]["gateway"]["networkCIDR"] = json!("10.200.0.0/24");
    let base = PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap();
    let capabilities = Capabilities::available();
    let mut journey = JourneyDefinition::new("switch-gateway", base)
        .ask([
            "/spec/sandboxes/0/runtime/provider",
            "/spec/gateway/management",
        ])
        .omit([
            "adapter:nvidia.fabric.openclaw:/agent_name",
            "adapter:nvidia.fabric.openclaw:/cli",
            "adapter:nvidia.fabric.openclaw:/home",
            "adapter:nvidia.fabric.openclaw:/native_config",
            "adapter:nvidia.fabric.openclaw:/timeout_seconds",
        ])
        .start(&capabilities)
        .unwrap();
    let podman = json!("unix:///run/user/1000/podman/podman.sock");
    journey
        .answer(
            &capabilities,
            "/spec/sandboxes/0/runtime/provider",
            Some(json!("podman")),
        )
        .unwrap();
    assert_eq!(
        journey.values().pointer("/spec/gateway/engine"),
        Some(&podman)
    );
    journey
        .answer(
            &capabilities,
            "/spec/gateway/management",
            Some(json!("external")),
        )
        .unwrap();
    assert_eq!(journey.values().pointer("/spec/gateway/networkCIDR"), None);
    assert_eq!(
        journey.values().pointer("/spec/gateway/engine"),
        Some(&podman)
    );
    journey
        .answer(
            &capabilities,
            "/spec/gateway/endpoint",
            Some(json!("https://gateway.example.com")),
        )
        .unwrap();
    let resolution = journey.resolve(&capabilities).unwrap();
    assert!(
        resolution.materialized_document().is_some(),
        "questions={:?} issues={:?}",
        resolution.questions(),
        resolution.assessment().issues()
    );
    journey
        .answer(
            &capabilities,
            "/spec/gateway/management",
            Some(json!("managed")),
        )
        .unwrap();
    assert_eq!(
        journey.values().pointer("/spec/gateway/engine"),
        Some(&podman)
    );
    assert!(journey.resolve(&capabilities).is_ok());
}

#[test]
fn answer_that_leaves_the_journey_unresolvable_is_rejected() {
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let capabilities = Capabilities::available();
    let mut journey = JourneyDefinition::new("unresolvable-answer", base)
        .ask(["/spec/gateway/management"])
        .omit(["/spec/gateway/endpoint"])
        .start(&capabilities)
        .unwrap();
    let before = journey.values().clone();
    assert!(
        journey
            .answer(
                &capabilities,
                "/spec/gateway/management",
                Some(json!("external")),
            )
            .is_err()
    );
    assert_eq!(journey.values(), &before);
    assert!(journey.resolve(&capabilities).is_ok());
}

#[test]
fn adapter_setting_questions_carry_fabric_descriptions() {
    let mut values: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    values["spec"]["sandboxes"][0]["harness"] = json!({"kind": "nvidia.fabric.hermes"});
    let base = PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap();
    let capabilities = Capabilities::available();
    let resolution = JourneyDefinition::new("described-settings", base)
        .ask([
            "adapter:nvidia.fabric.hermes:/api_mode",
            "adapter:nvidia.fabric.hermes:/mode",
        ])
        .start(&capabilities)
        .unwrap()
        .resolve(&capabilities)
        .unwrap();
    let described = resolution
        .question("adapter:nvidia.fabric.hermes:/api_mode")
        .expect("described setting");
    assert_eq!(
        described.description(),
        Some("Explicit native Hermes wire protocol.")
    );
    // Fabric does not describe `mode`; no generic text stands in for it.
    let undescribed = resolution
        .question("adapter:nvidia.fabric.hermes:/mode")
        .expect("undescribed setting");
    assert_eq!(undescribed.title(), None);
    assert_eq!(undescribed.description(), None);
}

#[test]
fn minimally_supplied_inline_envelope_materializes_through_one_resolver() {
    let base = PartialDocument::from_yaml(include_bytes!("fixtures/minimum-inline.yaml")).unwrap();
    let capabilities = Capabilities::available();
    let mut journey = JourneyDefinition::new("minimum-inline", base)
        .omit([
            "adapter:nvidia.fabric.openclaw:/agent_name",
            "adapter:nvidia.fabric.openclaw:/cli",
            "adapter:nvidia.fabric.openclaw:/home",
            "adapter:nvidia.fabric.openclaw:/native_config",
            "adapter:nvidia.fabric.openclaw:/timeout_seconds",
        ])
        .start(&capabilities)
        .unwrap();
    let answers = [
        ("/metadata/name", json!("minimum-inline")),
        (
            "/metadata/uid",
            json!("12345678-1234-4234-9234-123456789abc"),
        ),
        ("/spec/gateway/management", json!("managed")),
        ("/spec/inferenceProviders/0/provider", json!("openai")),
        ("/spec/sandboxes/0/name", json!("assistant")),
        (
            "/spec/sandboxes/0/harness/kind",
            json!("nvidia.fabric.openclaw"),
        ),
        ("/spec/sandboxes/0/agent/name", json!("primary")),
        (
            "/spec/sandboxes/0/agent/inference/routes/0/name",
            json!("primary"),
        ),
        (
            "/spec/sandboxes/0/agent/inference/routes/0/overrides/model",
            json!("nvidia/nemotron-3-super-120b-a12b"),
        ),
    ];
    for (id, answer) in answers {
        let resolution = journey.resolve(&capabilities).unwrap();
        assert!(
            resolution.question(id).is_some(),
            "missing question {id}: {:?}",
            resolution.assessment().issues()
        );
        journey.answer(&capabilities, id, Some(answer)).unwrap();
    }
    let resolution = journey.resolve(&capabilities).unwrap();
    assert!(
        resolution.materialized_document().is_some(),
        "questions={:?} issues={:?} unverified={:?}",
        resolution.questions(),
        resolution.assessment().issues(),
        resolution.unverified(),
    );
}
