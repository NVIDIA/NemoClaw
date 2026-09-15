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
    value["spec"]["sandboxes"][0]["integrations"] = json!({"webSearch":{"provider":"brave","agentRefs":["main"],"credential":{"env":"SEARCH_KEY"}}});
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
    for refs in [json!([]), json!(["missing"]), json!(["main", "main"])] {
        let mut value = input();
        value["spec"]["sandboxes"][0]["integrations"]["webSearch"]["agentRefs"] = refs;
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
    }
    let mut value = input();
    value["spec"]["sandboxes"][0]["agents"][0]["tools"] = json!({"allow":["read"]});
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
}
