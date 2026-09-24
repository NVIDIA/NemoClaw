// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_authoring::{Capabilities, Draft, EditableField, FieldValue};
use nemoclaw_sdk::config::Document;

#[test]
fn selected_route_edits_preserve_other_routes_and_reference_scope() {
    let mut document =
        Document::parse(include_bytes!("../../../examples/multiple-providers.yaml").as_slice())
            .unwrap();
    document.spec.sandboxes.truncate(1);
    let original = document.clone();
    let mut draft = Draft::from_document(document).unwrap();
    let capabilities = Capabilities::available();
    assert_eq!(draft.current_route().unwrap(), "smart");
    assert_eq!(draft.route_names().unwrap(), ["smart", "fast"]);
    draft.select_route("fast").unwrap();
    assert_eq!(
        draft.guided_answers(&capabilities).unwrap().provider_name,
        "local"
    );
    draft
        .set_guided_field(
            &capabilities,
            EditableField::Model,
            FieldValue::Model("new-local-model".into()),
        )
        .unwrap();
    let mut expected = original;
    expected
        .spec
        .inferences
        .get_mut("smart-and-fast")
        .unwrap()
        .routes[1]
        .overrides
        .model = "new-local-model".into();
    assert_eq!(draft.document(), &expected);
    assert!(draft.discovery_key().unwrap().engine.is_empty());
    draft.select_route("smart").unwrap();
    assert_eq!(
        draft.guided_answers(&capabilities).unwrap().provider_name,
        "hosted"
    );
    let snapshot = draft.document().clone();
    assert!(draft.select_route("absent").is_err());
    assert_eq!(draft.document(), &snapshot);
}

#[test]
fn accepting_implicit_api_does_not_add_an_override() {
    let document =
        Document::parse(include_bytes!("../../../examples/explicit-policy.yaml").as_slice())
            .unwrap();
    let mut draft = Draft::from_document(document.clone()).unwrap();
    let capabilities = Capabilities::available();
    let api = draft.guided_answers(&capabilities).unwrap().api;
    draft
        .set_guided_field(&capabilities, EditableField::Api, FieldValue::Api(api))
        .unwrap();
    assert_eq!(draft.document(), &document);
}

#[test]
fn absent_optional_owner_defaults_remain_unset_suggestions() {
    let document =
        Document::parse(include_bytes!("../../../examples/explicit-policy.yaml").as_slice())
            .unwrap();
    let draft = Draft::from_document(document).unwrap();
    let capabilities = Capabilities::available();
    let questions = draft.setting_questions(&capabilities).unwrap();
    let question = questions
        .iter()
        .find(|question| question.path == "/cli")
        .unwrap();
    assert!(!question.required);
    assert_eq!(question.suggestion, None);
}

#[test]
fn managed_provider_discovery_uses_sdk_publication_without_rewriting_service() {
    let document =
        Document::parse(include_bytes!("../../../examples/managed-ollama.yaml").as_slice())
            .unwrap();
    let expected = document.inference_connection().unwrap();
    let draft = Draft::from_document(document.clone()).unwrap();
    let request = draft.inference_request(&Capabilities::available()).unwrap();
    assert_eq!(request.endpoint, expected.endpoint);
    request.validate().unwrap();
    assert_eq!(draft.document(), &document);
}

#[test]
fn native_questions_update_selected_referenced_harness_and_model_definitions() {
    let mut document =
        Document::parse(include_bytes!("../../../examples/multiple-models.yaml").as_slice())
            .unwrap();
    document.spec.sandboxes.truncate(1);
    let capabilities = Capabilities::available();
    let mut draft = Draft::from_document(document.clone()).unwrap();
    draft.select_route("fast").unwrap();
    draft
        .answer_setting(
            &capabilities,
            "model:/reasoning_effort",
            Some(serde_json::json!("low")),
        )
        .unwrap();
    draft
        .answer_setting(
            &capabilities,
            "/timeout_seconds",
            Some(serde_json::json!(301)),
        )
        .unwrap();
    document
        .spec
        .inferences
        .get_mut("smart-and-fast")
        .unwrap()
        .routes[1]
        .overrides
        .settings
        .as_mut()
        .unwrap()
        .insert("reasoning_effort".into(), serde_json::json!("low"));
    document
        .spec
        .harnesses
        .get_mut("assistant")
        .unwrap()
        .settings = Some(
        serde_json::json!({"timeout_seconds":301})
            .as_object()
            .unwrap()
            .clone(),
    );
    assert_eq!(draft.document(), &document);
    assert!(draft.document().spec.sandboxes[0].harness.is_none());
    assert!(draft.document().spec.sandboxes[0].agent.inference.is_none());
}
