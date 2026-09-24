// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_authoring::{Answers, Capabilities, Draft, Session};
use nemoclaw_sdk::fabric_catalog::FabricCatalog;
use serde_json::json;

fn fixture() -> (Capabilities, Draft) {
    let mut catalog = FabricCatalog::bundled();
    let mut adapter = catalog.adapters[0].clone();

    adapter.descriptor["adapter_id"] = "fixture-schema-agent".into();
    adapter.descriptor["settings_schema"] = json!({
        "type":"object", "properties":{"mode":{"type":"string","enum":["basic","remote"],"default":"basic"}}, "required":["mode"],
        "if":{"properties":{"mode":{"const":"remote"}},"required":["mode"]},
        "then":{"properties":{"region":{"type":"string","enum":["west","east"]}},"required":["region"]}
    });
    catalog.adapters = vec![adapter];
    let caps = Capabilities::from_catalog(&catalog);
    let mut answers = Answers::onboarding_defaults();
    answers.harness = "fixture-schema-agent".parse().unwrap();
    let doc = Session::new().unwrap().project(&caps, &answers).unwrap();
    (caps, Draft::from_document(doc.document().clone()).unwrap())
}

#[test]
fn descriptor_fields_defaults_and_conditionals_drive_the_interview() {
    let (caps, mut draft) = fixture();
    let mode = draft.next_setting(&caps).unwrap().unwrap();
    assert_eq!(mode.path, "/mode");
    assert_eq!(mode.suggestion, Some(json!("basic")));
    draft
        .answer_setting(&caps, &mode.path, Some(json!("remote")))
        .unwrap();
    let region = draft.next_setting(&caps).unwrap().unwrap();
    assert_eq!(region.path, "/region");
    assert_eq!(region.choices, vec![json!("west"), json!("east")]);
    assert!(
        draft
            .answer_setting(&caps, &region.path, Some(json!("invalid")))
            .is_err()
    );
    draft
        .answer_setting(&caps, &region.path, Some(json!("west")))
        .unwrap();
    assert!(draft.next_setting(&caps).unwrap().is_none());
    draft.validate_settings(&caps).unwrap();
    let yaml = draft.review().unwrap().yaml().to_owned();
    let reopened = Draft::from_yaml(yaml.as_bytes()).unwrap();
    assert_eq!(reopened.document(), draft.document());
    assert!(reopened.next_setting(&caps).unwrap().is_none());
}

#[test]
fn changed_descriptor_domains_reopen_invalid_answers_without_rewriting_them() {
    let (caps, mut draft) = fixture();
    draft
        .answer_setting(&caps, "/mode", Some(json!("basic")))
        .unwrap();
    let mut catalog = FabricCatalog::bundled();
    let mut adapter = catalog.adapters[0].clone();

    adapter.descriptor["adapter_id"] = "fixture-schema-agent".into();
    adapter.descriptor["settings_schema"] = json!({
        "type":"object","properties":{"mode":{"type":"string","enum":["revised"],"default":"revised"}},"required":["mode"]
    });
    catalog.adapters = vec![adapter];
    let changed = Capabilities::from_catalog(&catalog);
    let before = draft.document().clone();
    let question = draft.next_setting(&changed).unwrap().unwrap();
    assert_eq!(question.choices, vec![json!("revised")]);
    assert_eq!(question.suggestion, Some(json!("revised")));
    assert_eq!(draft.document(), &before);
    assert!(draft.validate_settings(&changed).is_err());
    draft
        .answer_setting(&changed, &question.path, question.suggestion)
        .unwrap();
    draft.validate_settings(&changed).unwrap();
}

#[test]
fn delegation_never_writes_settings_without_authority_or_invents_required_answers() {
    let (caps, mut draft) = fixture();
    let before = draft.document().clone();
    assert!(
        draft
            .delegate_remaining(&caps, None, &Default::default())
            .is_err()
    );
    assert_eq!(draft.document(), &before);
    draft
        .answer_setting(&caps, "/mode", Some(json!("remote")))
        .unwrap();
    let before = draft.document().clone();
    assert!(
        draft
            .delegate_remaining(&caps, None, &Default::default())
            .unwrap_err()
            .to_string()
            .contains("required adapter setting")
    );
    assert_eq!(draft.document(), &before);
}

#[test]
fn conflicting_descriptors_do_not_choose_a_schema_by_catalog_order() {
    let (_, draft) = fixture();
    let mut catalog = FabricCatalog::bundled();
    let mut first = catalog.adapters[0].clone();

    first.descriptor["adapter_id"] = "fixture-schema-agent".into();
    first.descriptor["settings_schema"] =
        json!({"type":"object","properties":{"a":{"type":"string"}}});
    let mut second = first.clone();
    second.descriptor["settings_schema"] =
        json!({"type":"object","properties":{"b":{"type":"boolean"}}});
    catalog.adapters = vec![first, second];
    let caps = Capabilities::from_catalog(&catalog);
    assert!(
        draft
            .next_setting(&caps)
            .unwrap_err()
            .to_string()
            .contains("multiple Fabric adapter schemas")
    );
}

#[test]
fn missing_settings_schema_does_not_invent_native_questions() {
    let caps = Capabilities::from_harnesses([]);
    let authored = Session::new()
        .unwrap()
        .project(&caps, &Answers::onboarding_defaults())
        .unwrap();
    let draft = Draft::from_document(authored.document().clone()).unwrap();
    assert!(draft.next_setting(&caps).unwrap().is_none());
}

#[test]
fn skipping_nested_optional_settings_does_not_create_native_configuration() {
    let (mut catalog, answers) = (
        FabricCatalog::bundled(),
        Answers {
            harness: "test.optional-settings".parse().unwrap(),
            ..Answers::onboarding_defaults()
        },
    );
    catalog.adapters.truncate(1);
    catalog.adapters[0].descriptor["adapter_id"] = "test.optional-settings".into();
    catalog.adapters[0].descriptor["settings_schema"] = json!({
        "type":"object", "properties":{"native":{"type":"object", "properties":{"enabled":{"type":"boolean"}}}}
    });
    let caps = Capabilities::from_catalog(&catalog);
    let authored = Session::new().unwrap().project(&caps, &answers).unwrap();
    let mut draft = Draft::from_document(authored.document().clone()).unwrap();
    let question = draft.next_setting(&caps).unwrap().unwrap();
    assert_eq!(question.path, "/native");
    draft.answer_setting(&caps, &question.path, None).unwrap();
    let settings = draft.document().spec.sandboxes[0]
        .harness
        .as_ref()
        .unwrap()
        .settings
        .as_ref();
    assert!(
        settings.is_none_or(|settings| !settings.contains_key("native")),
        "declining an unset option must not configure its parent object"
    );
}

#[test]
fn discovered_workflow_target_and_owner_settings_author_public_config() {
    let mut catalog = FabricCatalog::bundled();
    let mut adapter = catalog.adapters[0].clone();
    adapter.descriptor["adapter_id"] = json!("fixture.workflow-owner");
    adapter.descriptor["settings_schema"] = json!({"type":"object","properties":{}});
    adapter.descriptor["config"]["schema"] = json!({"type":"object","required":["workflow"]});
    catalog.adapters = vec![adapter];
    catalog.targets = vec![json!({"descriptor":{
        "type":"workflow","id":"fixture.workflow-target","adapter_id":"fixture.workflow-owner",
        "spec":{"settings_schema":{"type":"object","properties":{"region":{"type":"string","enum":["west","east"]}},"required":["region"],"additionalProperties":false}}
    },"provenance":[]})];
    let caps = Capabilities::from_catalog(&catalog);
    let mut answers = Answers::onboarding_defaults();
    answers.harness = "fixture.workflow-owner".parse().unwrap();
    let authored = Session::new().unwrap().project(&caps, &answers).unwrap();
    let mut draft = Draft::from_document(authored.document().clone()).unwrap();
    let target = draft
        .next_setting(&caps)
        .unwrap()
        .expect("owner requires discovered workflow");
    assert_eq!(target.path, "workflow:/target_id");
    assert!(target.required);
    assert_eq!(target.choices, [json!("fixture.workflow-target")]);
    draft
        .answer_setting(&caps, &target.path, Some(json!("fixture.workflow-target")))
        .unwrap();
    let region = draft.next_setting(&caps).unwrap().unwrap();
    assert_eq!(region.path, "workflow:/settings/region");
    draft
        .answer_setting(&caps, &region.path, Some(json!("west")))
        .unwrap();
    draft.validate_settings(&caps).unwrap();
    let config = draft.document().spec.sandboxes[0]
        .harness
        .as_ref()
        .unwrap()
        .config
        .as_ref()
        .unwrap();
    assert_eq!(
        config["workflow"],
        json!({"target_id":"fixture.workflow-target","settings":{"region":"west"}})
    );
    let reopened = Draft::from_yaml(draft.review().unwrap().yaml().as_bytes()).unwrap();
    assert_eq!(reopened.document(), draft.document());
    assert!(reopened.next_setting(&caps).unwrap().is_none());
}

#[test]
fn model_settings_follow_owner_schema_and_survive_guided_edits() {
    let mut catalog = FabricCatalog::bundled();
    let mut adapter = catalog.adapters[0].clone();
    adapter.descriptor["adapter_id"] = json!("fixture.model-owner");
    adapter.descriptor["settings_schema"] = json!({"type":"object","properties":{}});
    adapter.descriptor["model_schema"] = json!({"type":"object","properties":{"settings":{"type":"object","properties":{"variant":{"type":"string","enum":["quick","thorough"],"default":"quick"}},"required":["variant"],"if":{"properties":{"variant":{"const":"thorough"}},"required":["variant"]},"then":{"properties":{"budget":{"type":"integer","minimum":1}},"required":["budget"]}}}});
    catalog.adapters = vec![adapter];
    let caps = Capabilities::from_catalog(&catalog);
    let mut answers = Answers::onboarding_defaults();
    answers.harness = "fixture.model-owner".parse().unwrap();
    let authored = Session::new().unwrap().project(&caps, &answers).unwrap();
    let mut draft = Draft::from_document(authored.document().clone()).unwrap();
    let variant = draft
        .next_setting(&caps)
        .unwrap()
        .expect("owner model settings question");
    assert_eq!(variant.path, "model:/variant");
    draft
        .answer_setting(&caps, &variant.path, Some(json!("thorough")))
        .unwrap();
    let budget = draft.next_setting(&caps).unwrap().unwrap();
    assert_eq!(budget.path, "model:/budget");
    draft
        .answer_setting(&caps, &budget.path, Some(json!(3)))
        .unwrap();
    draft.validate_settings(&caps).unwrap();
    draft
        .set_guided_field(
            &caps,
            nemoclaw_authoring::EditableField::Model,
            nemoclaw_authoring::FieldValue::Model("different-model".into()),
        )
        .unwrap();
    let route = &draft.document().spec.sandboxes[0]
        .agent
        .inference
        .as_ref()
        .unwrap()
        .routes[0];
    assert_eq!(
        route.overrides.settings.as_ref().unwrap(),
        json!({"variant":"thorough","budget":3})
            .as_object()
            .unwrap()
    );
    let reopened = Draft::from_yaml(draft.review().unwrap().yaml().as_bytes()).unwrap();
    assert_eq!(reopened.document(), draft.document());
}
