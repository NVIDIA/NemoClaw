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
    value["spec"]["sandboxes"][0]["agent"]["integrationRefs"] = json!(["search"]);
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
        .find(|r| {
            r.kind == "provider" && r.values.get("provider_type").is_some_and(|v| v == "brave")
        })
        .unwrap();
    assert_eq!(search.values["credential_env"], "SEARCH_KEY");
    assert_eq!(search.values["provider_type"], "brave");
    let graph = compile(&doc, &generations, "0.1.0").unwrap();
    assert!(graph["resource"]["nemoclaw_provider"]["inference_local"].is_object());
    assert_eq!(
        graph["resource"]["nemoclaw_provider"][search.address.split_once('.').unwrap().1]["depends_on"],
        json!([
            "nemoclaw_provider_profile.web_search",
            "data.nemoclaw_gateway_capabilities.apply"
        ])
    );
    assert_eq!(
        graph["resource"]["nemoclaw_sandbox"]["assistant"]["depends_on"],
        json!([
            "nemoclaw_provider.inference_local",
            search.address,
            "data.nemoclaw_gateway_capabilities.apply"
        ])
    );
}
#[test]
fn search_rejects_unknown_or_restricted_agents() {
    for refs in [json!(["missing"]), json!(["search", "search"])] {
        let mut value = input();
        value["spec"]["sandboxes"][0]["agent"]["integrationRefs"] = refs;
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
    }
    let mut value = input();
    value["spec"]["sandboxes"][0]["agent"]["tools"] = json!({"allow":["read"]});
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
    let mut writer = value["spec"]["sandboxes"][0].clone();
    writer["name"] = json!("writer");
    writer["agent"]["name"] = json!("writer");
    let mut reader = writer.clone();
    reader["name"] = json!("reader");
    reader["agent"]["name"] = json!("reader");
    reader["agent"]
        .as_object_mut()
        .unwrap()
        .remove("integrationRefs");
    value["spec"]["sandboxes"]
        .as_array_mut()
        .unwrap()
        .extend([writer, reader]);
    for index in [0, 1] {
        value["spec"]["sandboxes"][index]["agent"]["integrationRefs"] = json!(["search"]);
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
            .filter(|row| row.address == "nemoclaw_provider_profile.web_search")
            .count(),
        1
    );
    for row in rows.iter().filter(|row| row.kind == "sandbox") {
        let settings: Value = serde_json::from_str(&row.values["inference_json"]).unwrap();
        match row.values["name"].as_str() {
            "assistant" => assert_eq!(settings["webSearch"]["agentRefs"], json!(["main"])),
            "writer" => assert_eq!(settings["webSearch"]["agentRefs"], json!(["writer"])),
            "reader" => {
                assert!(settings["webSearch"].is_null());
                let policy: Value = serde_json::from_str(&row.values["policy_json"]).unwrap();
                assert!(policy["network_policies"]["nemoclaw-brave"].is_null());
            }
            name => panic!("unexpected sandbox {name}"),
        }
    }
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
            value["spec"]["sandboxes"][0]["agent"]
                .as_object_mut()
                .unwrap()
                .remove("integrationRefs");
            value["spec"]["sandboxes"][0]["agent"]["integrations"] = definitions;
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
    value["spec"]["sandboxes"][0]["agent"]["integrationRefs"] = json!([]);
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
fn integration_scopes_reject_shadowing_and_sibling_sandbox_references() {
    let original = input();
    let definitions = original["spec"]["sandboxes"][0]["integrations"].clone();
    let mut shared_collision = original.clone();
    shared_collision["spec"]["integrations"] = definitions.clone();
    let mut local_collision = original.clone();
    local_collision["spec"]["sandboxes"][0]["agent"]["integrations"] = definitions.clone();
    let mut global_collision = original.clone();
    global_collision["spec"]["sandboxes"][0]
        .as_object_mut()
        .unwrap()
        .remove("integrations");
    global_collision["spec"]["integrations"] = definitions.clone();
    global_collision["spec"]["sandboxes"][0]["agent"]["integrations"] = definitions.clone();
    let mut sibling = original;
    sibling["spec"]["sandboxes"][0]
        .as_object_mut()
        .unwrap()
        .remove("integrations");
    let mut other = sibling["spec"]["sandboxes"][0].clone();
    other["name"] = json!("other");
    other["agent"]
        .as_object_mut()
        .unwrap()
        .remove("integrationRefs");
    other["agent"]["integrations"] = definitions;
    sibling["spec"]["sandboxes"]
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
    value["spec"]["sandboxes"][0]["agent"]["integrationRefs"] = json!(["search", "other"]);
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

#[test]
fn sandboxes_share_search_registration_only_for_the_same_credential() {
    let mut value = input();
    let mut other = value["spec"]["sandboxes"][0].clone();
    other["name"] = json!("other");
    value["spec"]["sandboxes"]
        .as_array_mut()
        .unwrap()
        .push(other);
    let doc = Document::parse(value.to_string().as_bytes()).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let resources = targets(&doc, &generations).unwrap();
    assert_eq!(
        resources
            .iter()
            .filter(|row| row.kind == "provider"
                && row
                    .values
                    .get("provider_type")
                    .is_some_and(|v| v == "brave"))
            .count(),
        1
    );
    assert_eq!(doc.credential_names(), vec!["SEARCH_KEY"]);
    value["spec"]["sandboxes"][1]["integrations"]["search"]["credential"]["env"] =
        json!("OTHER_KEY");
    let doc = Document::parse(value.to_string().as_bytes()).unwrap();
    let resources = targets(&doc, &generations).unwrap();
    let search: Vec<_> = resources
        .iter()
        .filter(|r| {
            r.kind == "provider" && r.values.get("provider_type").is_some_and(|v| v == "brave")
        })
        .collect();
    assert_eq!(search.len(), 2);
    assert_ne!(search[0].values["name"], search[1].values["name"]);
    assert_ne!(
        search[0].values["credential_env"],
        search[1].values["credential_env"]
    );
    let exported = Document::parse(doc.yaml().unwrap().as_bytes()).unwrap();
    assert_eq!(exported, doc);
}

#[test]
fn deep_agents_search_preserves_explicit_grants_and_rejects_read_only_agents() {
    let mut value = input();
    value["spec"]["sandboxes"][0]["harness"]["kind"] = json!("deepagents");
    let document = Document::parse(value.to_string().as_bytes()).expect("Deep Agents search");
    let generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let rows = targets(&document, &generations).unwrap();
    let settings: Value = serde_json::from_str(
        &rows
            .iter()
            .find(|row| row.kind == "sandbox")
            .unwrap()
            .values["inference_json"],
    )
    .unwrap();
    assert_eq!(settings["webSearch"]["agentRefs"], json!(["main"]));
    value["spec"]["sandboxes"][0]["agent"]["tools"] = json!({"allow":["read"]});
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
}
