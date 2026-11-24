// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::provider_scope;
use nemoclaw_sdk::{
    compile::{Generations, compile, targets},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};

/// The OpenShell registration a web search target registers.
fn registration(target: &nemoclaw_sdk::compile::Target) -> String {
    nemoclaw_openshell::registration_name(&target.kind, &target.values).unwrap()
}

/// Whether a target is the `openshell_api` resource a web search compiles to.
fn is_search(target: &nemoclaw_sdk::compile::Target) -> bool {
    target.kind == "api"
        && ["brave-search-", "tavily-search-"]
            .iter()
            .any(|prefix| target.values["name"].starts_with(prefix))
}

/// Whether a sandbox's managed policy grants a search API itself.
fn grants_search_in_sandbox_policy(policy: &Value) -> bool {
    policy["managed"].as_array().unwrap().iter().any(|rule| {
        rule["endpoints"]
            .as_array()
            .unwrap()
            .iter()
            .any(|endpoint| {
                ["api.search.brave.com", "api.tavily.com"]
                    .contains(&endpoint["host"].as_str().unwrap())
            })
    })
}

fn input() -> Value {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric-openclaw.yaml")).unwrap();
    value["spec"]["sandboxes"]["assistant"]["integrations"] =
        json!({"search":{"kind":"webSearch","provider":"brave","credential":{"env":"SEARCH_KEY"}}});
    value["spec"]["sandboxes"]["assistant"]["agent"]["integrationRefs"] = json!(["search"]);
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
    // Search compiles to an API credential: Brave's host, its key header, the
    // one request it serves, and the variable Brave's tools read.
    let search = rows.iter().find(|r| is_search(r)).unwrap();
    assert_eq!(search.values["credential_env"], "SEARCH_KEY");
    assert_eq!(
        search.values["endpoints_json"],
        r#"["https://api.search.brave.com"]"#
    );
    assert_eq!(search.values["auth_style"], "header");
    assert_eq!(search.values["header_name"], "X-Subscription-Token");
    assert_eq!(search.values["sandbox_env"], "BRAVE_API_KEY");
    assert_eq!(
        serde_json::from_str::<Value>(&search.values["rest_json"]).unwrap(),
        json!({"rules":[{"allow":{"method":"GET","path":"/res/v1/web/search"}}]})
    );
    assert!(search.address.starts_with("openshell_api.brave_search_"));
    let graph = compile(&doc, &generations, "0.1.0").unwrap();
    assert!(graph["resource"].get("openshell_web_search").is_none());
    assert!(
        provider_scope::resource(&graph["resource"]["openshell_inference"], "local").is_object()
    );
    // One resource owns the search profile and registration. Its executables
    // come from the sandbox's harness, and its owner from its workspace.
    let resource = &graph["resource"]["openshell_api"][search.address.split_once('.').unwrap().1];
    assert_eq!(
        resource["rest"],
        json!({"rules":[{"allow":{"method":"GET","path":"/res/v1/web/search"}}]})
    );
    assert_eq!(
        resource["binaries"],
        json!("${jsondecode(data.fabric_harnesses.sandbox_assistant.binaries_json)}")
    );
    assert!(resource.get("owner").is_none());
    assert_eq!(
        graph["resource"]["openshell_sandbox"]["assistant"]["depends_on"],
        json!([
            provider_scope::address(
                &graph["resource"]["openshell_inference"],
                "inference",
                "local"
            ),
            search.address,
            "data.openshell_gateway.apply"
        ])
    );
}
#[test]
fn search_rejects_unknown_and_duplicate_references() {
    for refs in [json!(["missing"]), json!(["search", "search"])] {
        let mut value = input();
        value["spec"]["sandboxes"]["assistant"]["agent"]["integrationRefs"] = refs;
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
    }
    let mut value = input();
    value["spec"]["sandboxes"]["assistant"]["agent"]["tools"] = json!({"enabled":["read"]});
    assert!(Document::parse(value.to_string().as_bytes()).is_ok());
}

#[test]
fn shared_integration_references_grant_only_the_selected_agents() {
    let mut value = input();
    value["spec"]["sandboxes"]["assistant"]
        .as_object_mut()
        .unwrap()
        .remove("integrations");
    value["spec"]["integrations"] = json!({"search": {
        "kind": "webSearch", "provider": "brave", "credential": {"env": "SEARCH_KEY"}
    }});
    let mut writer = value["spec"]["sandboxes"]["assistant"].clone();
    writer["agent"]["name"] = json!("writer");
    let mut reader = writer.clone();
    reader["agent"]["name"] = json!("reader");
    reader["agent"]
        .as_object_mut()
        .unwrap()
        .remove("integrationRefs");
    value["spec"]["sandboxes"]["writer"] = writer;
    value["spec"]["sandboxes"]["reader"] = reader;
    for name in ["assistant", "writer"] {
        value["spec"]["sandboxes"][name]["agent"]["integrationRefs"] = json!(["search"]);
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
    let graph = compile(&doc, &generations, "0.1.0").unwrap();
    assert_eq!(
        graph["resource"]["openshell_sandbox"]["reader"]["depends_on"],
        json!([
            provider_scope::address(
                &graph["resource"]["openshell_inference"],
                "inference",
                "local"
            ),
            "data.openshell_gateway.apply"
        ])
    );
    let rows = targets(&doc, &generations).unwrap();
    assert_eq!(rows.iter().filter(|row| is_search(row)).count(), 1);
    for row in rows.iter().filter(|row| row.kind == "sandbox") {
        let policy: Value = serde_json::from_str(&row.values["policy_json"]).unwrap();
        let providers: Vec<String> =
            serde_json::from_str(&row.values["provider_names_json"]).unwrap();
        // The registration's profile grants the search API; the sandbox's
        // policy does not.
        assert!(!grants_search_in_sandbox_policy(&policy));
        if row.values["name"] == "reader" {
            assert!(
                !providers
                    .iter()
                    .any(|name| name.starts_with("brave-search-"))
            );
        } else {
            assert!(
                providers
                    .iter()
                    .any(|name| name.starts_with("brave-search-"))
            );
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
        let definitions = value["spec"]["sandboxes"]["assistant"]
            .as_object_mut()
            .unwrap()
            .remove("integrations")
            .unwrap();
        if scope == "deployment" {
            value["spec"]["integrations"] = definitions;
        } else {
            value["spec"]["sandboxes"]["assistant"]["agent"]
                .as_object_mut()
                .unwrap()
                .remove("integrationRefs");
            value["spec"]["sandboxes"]["assistant"]["agent"]["integrations"] = definitions;
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
    value["spec"]["sandboxes"]["assistant"]["agent"]["integrationRefs"] = json!([]);
    let doc = Document::parse(value.to_string().as_bytes()).unwrap();
    let generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let rows = targets(&doc, &generations).unwrap();
    assert_eq!(rows.len(), 5);
    assert!(!serde_json::to_string(&rows).unwrap().contains("brave"));
    assert!(!doc.credential_names().contains(&"SEARCH_KEY"));
    assert!(doc.yaml().unwrap().contains("SEARCH_KEY"));
}

#[test]
fn integration_scopes_reject_shadowing_and_sibling_sandbox_references() {
    let original = input();
    let definitions = original["spec"]["sandboxes"]["assistant"]["integrations"].clone();
    let mut shared_collision = original.clone();
    shared_collision["spec"]["integrations"] = definitions.clone();
    let mut local_collision = original.clone();
    local_collision["spec"]["sandboxes"]["assistant"]["agent"]["integrations"] =
        definitions.clone();
    let mut global_collision = original.clone();
    global_collision["spec"]["sandboxes"]["assistant"]
        .as_object_mut()
        .unwrap()
        .remove("integrations");
    global_collision["spec"]["integrations"] = definitions.clone();
    global_collision["spec"]["sandboxes"]["assistant"]["agent"]["integrations"] =
        definitions.clone();
    let mut sibling = original;
    sibling["spec"]["sandboxes"]["assistant"]
        .as_object_mut()
        .unwrap()
        .remove("integrations");
    let mut other = sibling["spec"]["sandboxes"]["assistant"].clone();
    other["agent"]
        .as_object_mut()
        .unwrap()
        .remove("integrationRefs");
    other["agent"]["integrations"] = definitions;
    sibling["spec"]["sandboxes"]["other"] = other;
    for value in [shared_collision, local_collision, global_collision, sibling] {
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
    }
}

#[test]
fn distinct_search_definitions_are_not_silently_merged_by_value() {
    let mut value = input();
    let second = value["spec"]["sandboxes"]["assistant"]["integrations"]["search"].clone();
    value["spec"]["sandboxes"]["assistant"]["integrations"]["other"] = second;
    value["spec"]["sandboxes"]["assistant"]["agent"]["integrationRefs"] =
        json!(["search", "other"]);
    let error = Document::parse(value.to_string().as_bytes()).unwrap_err();
    let [diagnostic] = error.diagnostics() else {
        panic!("{error}")
    };
    assert_eq!(
        (diagnostic.path.as_deref(), diagnostic.message.as_str()),
        (
            Some("spec.sandboxes.assistant"),
            "a sandbox supports only one attached web search definition"
        )
    );
}

#[test]
fn schema_and_parser_reject_unsupported_integration_shapes() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let definition = input()["spec"]["sandboxes"]["assistant"]["integrations"]["search"].clone();
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
        value["spec"]["sandboxes"]["assistant"]["integrations"] = definitions;
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
        assert!(!validator.is_valid(&value));
    }
}

#[test]
fn sandboxes_share_search_registration_only_for_the_same_credential() {
    let mut value = input();
    let other = value["spec"]["sandboxes"]["assistant"].clone();
    value["spec"]["sandboxes"]["other"] = other;
    let doc = Document::parse(value.to_string().as_bytes()).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let resources = targets(&doc, &generations).unwrap();
    assert_eq!(resources.iter().filter(|row| is_search(row)).count(), 1);
    assert_eq!(doc.credential_names(), vec!["SEARCH_KEY"]);
    value["spec"]["sandboxes"]["other"]["integrations"]["search"]["credential"]["env"] =
        json!("OTHER_KEY");
    let doc = Document::parse(value.to_string().as_bytes()).unwrap();
    let resources = targets(&doc, &generations).unwrap();
    let search: Vec<_> = resources.iter().filter(|r| is_search(r)).collect();
    assert_eq!(search.len(), 2);
    let graph = compile(&doc, &generations, "0.1.0").unwrap();
    for (sandbox, credential) in [("assistant", "SEARCH_KEY"), ("other", "OTHER_KEY")] {
        let selected = search
            .iter()
            .find(|provider| provider.values["credential_env"] == credential)
            .unwrap();
        assert_eq!(
            graph["resource"]["openshell_sandbox"][sandbox]["depends_on"],
            json!([
                provider_scope::address(
                    &graph["resource"]["openshell_inference"],
                    "inference",
                    "local"
                ),
                selected.address,
                "data.openshell_gateway.apply"
            ])
        );
    }
    assert_ne!(registration(search[0]), registration(search[1]));
    assert_ne!(
        search[0].values["credential_env"],
        search[1].values["credential_env"]
    );
    let exported = Document::parse(doc.yaml().unwrap().as_bytes()).unwrap();
    assert_eq!(exported, doc);
}

#[test]
fn native_search_preserves_explicit_grants_and_tool_configuration() {
    let mut value = input();
    value["spec"]["sandboxes"]["assistant"]["harness"]["kind"] =
        json!("nvidia.fabric.langchain.deepagents");
    let document = Document::parse(value.to_string().as_bytes()).expect("Deep Agents search");
    let generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let rows = targets(&document, &generations).unwrap();
    let sandbox = rows.iter().find(|row| row.kind == "sandbox").unwrap();
    let providers: Vec<String> =
        serde_json::from_str(&sandbox.values["provider_names_json"]).unwrap();
    assert!(
        providers
            .iter()
            .any(|name| name.starts_with("brave-search-"))
    );
    value["spec"]["sandboxes"]["assistant"]["agent"]["tools"] = json!({"enabled":["read"]});
    assert!(Document::parse(value.to_string().as_bytes()).is_ok());
}

#[test]
fn tavily_preserves_openclaw_and_hermes_intent_and_credential_references() {
    for harness in ["nvidia.fabric.openclaw", "nvidia.fabric.hermes"] {
        let mut value = input();
        value["spec"]["sandboxes"]["assistant"]["harness"]["kind"] = json!(harness);
        value["spec"]["sandboxes"]["assistant"]["integrations"]["search"]["provider"] =
            json!("tavily");
        let doc = Document::parse(value.to_string().as_bytes()).expect("Tavily must parse");
        assert!(
            jsonschema::validator_for(&input_schema())
                .unwrap()
                .is_valid(&value)
        );
        assert_eq!(doc.credential_names(), vec!["SEARCH_KEY"]);
        assert_eq!(
            Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
            doc
        );

        let generations = ["workspace", "provider", "sandbox"]
            .map(|key| (key.into(), "a".repeat(32)))
            .into();
        let rows = targets(&doc, &generations).unwrap();
        let provider = rows.iter().find(|row| is_search(row)).unwrap();
        assert_eq!(provider.values["credential_env"], "SEARCH_KEY");
        assert!(registration(provider).starts_with("tavily-search-"));
        // Tavily takes its key as a bearer token, for search and extract only.
        assert_eq!(
            provider.values["endpoints_json"],
            r#"["https://api.tavily.com"]"#
        );
        assert_eq!(provider.values["auth_style"], "bearer");
        assert!(!provider.values.contains_key("header_name"));
        assert_eq!(provider.values["sandbox_env"], "TAVILY_API_KEY");
        assert_eq!(
            serde_json::from_str::<Value>(&provider.values["rest_json"]).unwrap(),
            json!({"rules":[
                {"allow":{"method":"POST","path":"/search"}},
                {"allow":{"method":"POST","path":"/extract"}}
            ]})
        );
        let sandbox = rows.iter().find(|row| row.kind == "sandbox").unwrap();
        let providers: Vec<String> =
            serde_json::from_str(&sandbox.values["provider_names_json"]).unwrap();
        assert!(providers.contains(&registration(provider)));
        let policy: Value = serde_json::from_str(&sandbox.values["policy_json"]).unwrap();
        assert!(!grants_search_in_sandbox_policy(&policy));
        let graph = compile(&doc, &generations, "0.1.0").unwrap();
        assert!(
            graph["resource"]["openshell_api"][provider.address.split_once('.').unwrap().1]
                .is_object()
        );
    }
}

#[test]
fn unused_tavily_definition_does_not_add_credentials_resources_or_agent_grants() {
    let mut value = input();
    let baseline = Document::parse(value.to_string().as_bytes()).unwrap();
    value["spec"]["integrations"] = json!({"unused": {
        "kind":"webSearch", "provider":"tavily", "credential":{"env":"UNUSED_KEY"}
    }});
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    assert_eq!(
        targets(&document, &generations).unwrap(),
        targets(&baseline, &generations).unwrap()
    );
    assert_eq!(document.credential_names(), baseline.credential_names());
}

#[test]
fn different_search_providers_keep_distinct_bindings_for_the_same_credential_reference() {
    let mut value = input();
    let generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let existing = targets(
        &Document::parse(value.to_string().as_bytes()).unwrap(),
        &generations,
    )
    .unwrap();
    let mut tavily = value["spec"]["sandboxes"]["assistant"].clone();
    tavily["integrations"]["search"]["provider"] = json!("tavily");
    value["spec"]["sandboxes"]["tavily-assistant"] = tavily;
    let doc = Document::parse(value.to_string().as_bytes()).unwrap();
    let rows = targets(&doc, &generations).unwrap();
    for row in existing {
        assert_eq!(
            rows.iter()
                .find(|candidate| candidate.address == row.address),
            Some(&row)
        );
    }
    let providers: Vec<_> = rows
        .iter()
        .filter(|row| is_search(row) && row.values["credential_env"] == "SEARCH_KEY")
        .collect();
    assert_eq!(providers.len(), 2);
    assert_ne!(providers[0].address, providers[1].address);
    assert_ne!(registration(providers[0]), registration(providers[1]));
    assert_eq!(doc.credential_names(), vec!["SEARCH_KEY"]);
}

#[test]
fn native_search_constraints_are_forwarded_for_fabric_validation() {
    for harness in ["deepagents", "pi"] {
        let mut value = input();
        value["spec"]["sandboxes"]["assistant"]["harness"]["kind"] = json!(harness);
        value["spec"]["sandboxes"]["assistant"]["integrations"]["search"]["provider"] =
            json!("tavily");
        assert!(Document::parse(value.to_string().as_bytes()).is_ok());
    }
    let mut value = input();
    value["spec"]["sandboxes"]["assistant"]["integrations"]["search"]["provider"] = json!("tavily");
    value["spec"]["sandboxes"]["assistant"]["agent"]["tools"] = json!({"enabled":["read"]});
    assert!(Document::parse(value.to_string().as_bytes()).is_ok());
}

#[test]
fn search_registration_names_stay_reserved_and_policy_names_are_free() {
    for name in ["tavily-search", "tavily-search-custom"] {
        let mut value = input();
        value["spec"]["sandboxes"]["assistant"]["integrations"]["search"]["provider"] =
            json!("tavily");
        let providers = value["spec"]["inferenceProviders"].as_object_mut().unwrap();
        let provider = providers.remove("local").unwrap();
        providers.insert(name.into(), provider);
        value["spec"]["sandboxes"]["assistant"]["agent"]["inference"]["routes"][0]["providerRef"] =
            json!(name);
        let error = Document::parse(value.to_string().as_bytes()).unwrap_err();
        assert!(
            error.to_string().contains("reserved for web search"),
            "{error}"
        );
    }
    let mut value = input();
    value["spec"]["sandboxes"]["assistant"]["integrations"]["search"]["provider"] = json!("tavily");
    let manifest: serde_json::Value =
        serde_json::from_str(include_str!("../../../image/fabric/runtime.json")).unwrap();
    let mut policy = manifest["policy"].clone();
    policy["network_policies"] = json!({"custom-search": {
            "name":"custom-search",
            "endpoints":[{"host":"search.example.com","port":443}],
            "binaries":[{"path":"/usr/local/bin/node"}]
    }});
    value["spec"]["sandboxes"]["assistant"]["network"] = json!({"policy": {"explicit": policy}});
    Document::parse(value.to_string().as_bytes()).expect("non-colliding policy must be valid");
    // The search grant lives in its registration's profile, so no policy
    // rule name is reserved for it.
    let rules = value["spec"]["sandboxes"]["assistant"]["network"]["policy"]["explicit"]["network_policies"]
        .as_object_mut()
        .unwrap();
    let mut rule = rules.remove("custom-search").unwrap();
    rule["name"] = json!("nemoclaw-tavily");
    rules.insert("nemoclaw-tavily".into(), rule);
    Document::parse(value.to_string().as_bytes()).expect("policy names are not reserved");
}

#[test]
fn attaching_brave_and_tavily_to_one_agent_does_not_discard_either_intent() {
    let mut value = input();
    let mut other = value["spec"]["sandboxes"]["assistant"]["integrations"]["search"].clone();
    other["provider"] = json!("tavily");
    value["spec"]["sandboxes"]["assistant"]["integrations"]["other"] = other;
    value["spec"]["sandboxes"]["assistant"]["agent"]["integrationRefs"] =
        json!(["search", "other"]);
    let error = Document::parse(value.to_string().as_bytes()).unwrap_err();
    assert_eq!(
        error.diagnostics()[0].message,
        "a sandbox supports only one attached web search definition",
        "{error}"
    );
}

#[test]
fn search_sets_the_key_variable_the_sandbox_sees() {
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    // Without sandboxEnv, the sandbox sees the provider's own variable.
    let doc = Document::parse(input().to_string().as_bytes()).unwrap();
    let rows = targets(&doc, &generations).unwrap();
    let search = rows.iter().find(|r| is_search(r)).unwrap();
    assert_eq!(search.values["sandbox_env"], "BRAVE_API_KEY");

    let mut value = input();
    value["spec"]["sandboxes"]["assistant"]["integrations"]["search"]["sandboxEnv"] =
        json!("BRAVE_SEARCH_API_KEY");
    let doc = Document::parse(value.to_string().as_bytes()).expect("sandboxEnv must parse");
    let rows = targets(&doc, &generations).unwrap();
    let search = rows.iter().find(|r| is_search(r)).unwrap();
    assert_eq!(search.values["sandbox_env"], "BRAVE_SEARCH_API_KEY");
    assert_eq!(search.values["credential_env"], "SEARCH_KEY");
    let graph = compile(&doc, &generations, "0.1.0").unwrap();
    let resource = &graph["resource"]["openshell_api"][search.address.split_once('.').unwrap().1];
    assert_eq!(resource["sandbox_env"], "BRAVE_SEARCH_API_KEY");

    // The name must be an environment variable name.
    value["spec"]["sandboxes"]["assistant"]["integrations"]["search"]["sandboxEnv"] =
        json!("not a name");
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
}

#[test]
fn api_integrations_cannot_take_a_search_registration_name() {
    let api = |name: &str| {
        let mut value = input();
        value["spec"]["sandboxes"]["assistant"]["agent"]["integrationRefs"] = json!([name]);
        value["spec"]["sandboxes"]["assistant"]["integrations"] = json!({name: {
            "kind": "api",
            "endpoints": ["https://api.example.com"],
            "credential": {"env": "EXAMPLE_KEY"}
        }});
        Document::parse(value.to_string().as_bytes())
    };
    for name in [
        "brave-search",
        "brave-search-x",
        "tavily-search",
        "tavily-search-x",
    ] {
        let error = api(name).unwrap_err();
        assert!(
            error.to_string().contains("reserved for web search"),
            "{name}: {error}"
        );
    }
    for name in ["brave-searcher", "search", "tavily"] {
        api(name).unwrap_or_else(|error| panic!("{name}: {error}"));
    }
}
