// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, compile, targets},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};

fn input() -> Value {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric-openclaw.yaml")).unwrap();
    value["spec"]["sandboxes"][0]["integrations"] =
        json!({"search":{"kind":"webSearch","provider":"brave","credential":{"env":"SEARCH_KEY"}}});
    value["spec"]["sandboxes"][0]["agents"][0]["integrationRefs"] = json!(["search"]);
    value
}
#[test]
fn search_uses_owned_profile_and_provider_without_exporting_secrets() {
    let value = input();
    let doc = Document::parse(value.to_string().as_bytes()).expect("web search must parse");
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
    assert_eq!(
        Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
        doc
    );
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let rows = targets(&doc, &generations).unwrap();
    assert_eq!(rows.len(), 6);
    let search = rows
        .iter()
        .find(|r| r.address == "nemoclaw_provider.web_search")
        .unwrap();
    assert_eq!(search.values["credential_env"], "SEARCH_KEY");
    assert_eq!(search.values["provider_type"], "brave");
    let graph = compile(&doc, &generations, "0.1.0").unwrap();
    assert!(graph["resource"]["nemoclaw_provider"]["inference"].is_object());
    assert_eq!(
        graph["resource"]["nemoclaw_provider"]["web_search"]["depends_on"],
        json!(["nemoclaw_provider_profile.web_search"])
    );
    assert_eq!(
        graph["resource"]["nemoclaw_sandbox"]["agent"]["depends_on"],
        json!(["nemoclaw_route.primary", "nemoclaw_provider.web_search"])
    );
}
#[test]
fn search_rejects_unknown_or_restricted_agents() {
    for refs in [json!(["missing"]), json!(["search", "search"])] {
        let mut value = input();
        value["spec"]["sandboxes"][0]["agents"][0]["integrationRefs"] = refs;
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
    }
    let mut value = input();
    value["spec"]["sandboxes"][0]["agents"][0]["tools"] = json!({"allow":["read"]});
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
}

#[test]
fn shared_integration_references_grant_only_the_selected_agents() {
    let mut value = input();
    value["spec"]["sandboxes"][0]
        .as_object_mut()
        .unwrap()
        .remove("integrations");
    value["spec"]["integrations"] = json!({"search": {
        "kind": "webSearch", "provider": "brave", "credential": {"env": "SEARCH_KEY"}
    }});
    let mut writer = value["spec"]["sandboxes"][0]["agents"][0].clone();
    writer["name"] = json!("writer");
    let mut reader = writer.clone();
    reader["name"] = json!("reader");
    reader.as_object_mut().unwrap().remove("integrationRefs");
    value["spec"]["sandboxes"][0]["agents"]
        .as_array_mut()
        .unwrap()
        .extend([writer, reader]);
    for index in [0, 1] {
        value["spec"]["sandboxes"][0]["agents"][index]["integrationRefs"] = json!(["search"]);
    }
    let doc = Document::parse(value.to_string().as_bytes()).expect("shared definitions must parse");
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
    let generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let rows = targets(&doc, &generations).unwrap();
    assert_eq!(
        rows.iter()
            .filter(|row| row.kind == "provider_profile")
            .count(),
        1
    );
    let sandbox = rows.iter().find(|row| row.kind == "sandbox").unwrap();
    let inference: Value = serde_json::from_str(&sandbox.values["inference_json"]).unwrap();
    assert_eq!(
        inference["webSearch"]["agentRefs"],
        json!(["main", "writer"])
    );
    assert_eq!(
        doc.credential_names()
            .iter()
            .filter(|name| **name == "SEARCH_KEY")
            .count(),
        1
    );
    assert_eq!(
        Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
        doc
    );
}

#[test]
fn agent_inline_and_enclosing_definitions_compile_to_the_same_search_grants() {
    let generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let value = input();
    let expected = targets(
        &Document::parse(value.to_string().as_bytes()).unwrap(),
        &generations,
    )
    .unwrap();
    for scope in ["deployment", "agent"] {
        let mut value = value.clone();
        let definitions = value["spec"]["sandboxes"][0]
            .as_object_mut()
            .unwrap()
            .remove("integrations")
            .unwrap();
        if scope == "deployment" {
            value["spec"]["integrations"] = definitions;
        } else {
            value["spec"]["sandboxes"][0]["agents"][0]
                .as_object_mut()
                .unwrap()
                .remove("integrationRefs");
            value["spec"]["sandboxes"][0]["agents"][0]["integrations"] = definitions;
        }
        let doc = Document::parse(value.to_string().as_bytes())
            .expect("inline and shared definitions must parse");
        assert!(
            jsonschema::validator_for(&input_schema())
                .unwrap()
                .is_valid(&value)
        );
        assert_eq!(targets(&doc, &generations).unwrap(), expected);
        assert_eq!(
            Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
            doc
        );
    }
}

#[test]
fn unused_definitions_create_no_search_resources_policy_or_secret_requirements() {
    let mut value = input();
    value["spec"]["sandboxes"][0]["agents"][0]["integrationRefs"] = json!([]);
    let doc = Document::parse(value.to_string().as_bytes()).unwrap();
    let generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let rows = targets(&doc, &generations).unwrap();
    assert_eq!(rows.len(), 4);
    assert!(!serde_json::to_string(&rows).unwrap().contains("brave"));
    assert!(!doc.credential_names().contains(&"SEARCH_KEY"));
    assert!(doc.yaml().unwrap().contains("SEARCH_KEY"));
}

#[test]
fn integration_scopes_reject_shadowing_and_sibling_agent_references() {
    let original = input();
    let definitions = original["spec"]["sandboxes"][0]["integrations"].clone();
    let mut shared_collision = original.clone();
    shared_collision["spec"]["integrations"] = definitions.clone();
    let mut local_collision = original.clone();
    local_collision["spec"]["sandboxes"][0]["agents"][0]["integrations"] = definitions.clone();
    let mut global_collision = original.clone();
    global_collision["spec"]["sandboxes"][0]
        .as_object_mut()
        .unwrap()
        .remove("integrations");
    global_collision["spec"]["integrations"] = definitions.clone();
    global_collision["spec"]["sandboxes"][0]["agents"][0]["integrations"] = definitions.clone();
    let mut sibling = original;
    sibling["spec"]["sandboxes"][0]
        .as_object_mut()
        .unwrap()
        .remove("integrations");
    let mut other = sibling["spec"]["sandboxes"][0]["agents"][0].clone();
    other["name"] = json!("other");
    other.as_object_mut().unwrap().remove("integrationRefs");
    other["integrations"] = definitions;
    sibling["spec"]["sandboxes"][0]["agents"]
        .as_array_mut()
        .unwrap()
        .push(other);
    for value in [shared_collision, local_collision, global_collision, sibling] {
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
    }
}

#[test]
fn distinct_search_definitions_are_not_silently_merged_by_value() {
    let mut value = input();
    let second = value["spec"]["sandboxes"][0]["integrations"]["search"].clone();
    value["spec"]["sandboxes"][0]["integrations"]["other"] = second;
    value["spec"]["sandboxes"][0]["agents"][0]["integrationRefs"] = json!(["search", "other"]);
    let error = Document::parse(value.to_string().as_bytes()).unwrap_err();
    assert_eq!(
        error.0,
        "a sandbox supports only one attached web search definition"
    );
}

#[test]
fn schema_and_parser_reject_unsupported_integration_shapes() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let definition = input()["spec"]["sandboxes"][0]["integrations"]["search"].clone();
    let mut cases = Vec::new();
    for patch in [
        json!({"kind":"voiceclaw"}),
        json!({"provider":"other"}),
        json!({"agentRefs":["main"]}),
        json!({"credential":{"env":"invalid-secret-name"}}),
    ] {
        let mut changed = definition.clone();
        changed
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        cases.push(json!({"search":changed}));
    }
    cases.push(json!({"Bad Name":definition}));
    cases.push(json!({"webSearch":{"provider":"brave","agentRefs":["main"],"credential":{"env":"SEARCH_KEY"}}}));
    for definitions in cases {
        let mut value = input();
        value["spec"]["sandboxes"][0]["integrations"] = definitions;
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
        assert!(!validator.is_valid(&value));
    }
}
