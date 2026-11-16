// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Deployment-level network policies and grants, selected by name.
use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};

fn policy() -> Value {
    json!({
        "version": 1,
        "filesystem_policy": {"include_workdir": false, "read_only": ["/usr", "/opt", "/app"], "read_write": ["/sandbox", "/tmp"]},
        "landlock": {"compatibility": "best_effort"},
        "process": {"run_as_user": "10001", "run_as_group": "10001"},
        "network_policies": {"docs": {"name": "docs", "endpoints": [{"host": "docs.example.com", "port": 443}], "binaries": [{"path": "/usr/bin/curl"}]}}
    })
}
fn grant(host: &str) -> Value {
    json!({"endpoints": [{"host": host, "port": 443}]})
}
fn input() -> Value {
    crate::support::fixture("local.yaml")
}
fn network(value: &mut Value) -> &mut Value {
    &mut value["spec"]["sandboxes"]["assistant"]["network"]
}
fn parse(value: &Value) -> Result<Document, nemoclaw_sdk::config::ConfigError> {
    Document::parse(value.to_string().as_bytes())
}
fn schema_accepts(value: &Value) -> bool {
    jsonschema::validator_for(&input_schema())
        .unwrap()
        .is_valid(value)
}
fn generations() -> Generations {
    ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into()
}
/// The policy input the compiled graph sends to the sandbox.
fn sandbox_policy(value: &Value) -> Value {
    let document = parse(value).unwrap();
    let rows = targets(&document, &generations()).unwrap();
    let sandbox = rows.iter().find(|row| row.kind == "sandbox").unwrap();
    serde_json::from_str(&sandbox.values["policy_json"]).unwrap()
}
fn rule_names(policy: &Value) -> Vec<String> {
    policy["managed"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|rule| rule["name"].as_str())
        .map(str::to_owned)
        .collect()
}

#[test]
fn a_referenced_policy_produces_the_same_openshell_policy_as_the_inline_one() {
    let mut inline = input();
    *network(&mut inline) = json!({"policy": {"explicit": policy()}});
    let mut referenced = input();
    referenced["spec"]["policies"] = json!({"docs-only": policy()});
    *network(&mut referenced) = json!({"policyRef": "docs-only"});
    assert!(
        schema_accepts(&referenced),
        "the editor schema accepts policyRef"
    );
    assert_eq!(sandbox_policy(&referenced), sandbox_policy(&inline));
    let document = parse(&referenced).unwrap();
    let exported = document.yaml().unwrap();
    assert!(
        exported.contains("policyRef: docs-only"),
        "export keeps the reference"
    );
    assert_eq!(Document::parse(exported.as_bytes()).unwrap(), document);
}

#[test]
fn referenced_and_inline_grants_add_their_union_to_the_isolated_preset() {
    let mut value = input();
    value["spec"]["grants"] = json!({"github": grant("api.github.com")});
    *network(&mut value) = json!({
        "tier": "isolated",
        "grants": {"docs": grant("docs.example.com")},
        "grantRefs": ["github"]
    });
    assert!(
        schema_accepts(&value),
        "the editor schema accepts grantRefs"
    );
    let names = rule_names(&sandbox_policy(&value));
    for grant in ["docs", "github"] {
        assert!(
            names.iter().any(|name| name == grant),
            "{grant} in {names:?}"
        );
    }
    let document = parse(&value).unwrap();
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document,
        "export keeps inline and referenced grants apart"
    );
}

#[test]
fn a_grant_name_used_inline_and_by_reference_fails() {
    let mut value = input();
    value["spec"]["grants"] = json!({"docs": grant("docs.example.com")});
    *network(&mut value) = json!({
        "grants": {"docs": grant("docs.example.org")},
        "grantRefs": ["docs"]
    });
    let error = parse(&value).expect_err("grant names are unique across grants and grantRefs");
    assert!(error.to_string().contains("docs"), "{error}");
}

#[test]
fn grant_references_with_an_explicit_policy_fail() {
    for selection in [
        json!({"policy": {"explicit": policy()}, "grantRefs": ["github"]}),
        json!({"policyRef": "docs-only", "grantRefs": ["github"]}),
        json!({"policyRef": "docs-only", "grants": {"docs": grant("docs.example.com")}}),
    ] {
        let mut value = input();
        value["spec"]["policies"] = json!({"docs-only": policy()});
        value["spec"]["grants"] = json!({"github": grant("api.github.com")});
        *network(&mut value) = selection.clone();
        assert!(parse(&value).is_err(), "{selection}");
    }
}

#[test]
fn a_network_selects_at_most_one_of_tier_policy_and_policy_reference() {
    for selection in [
        json!({"tier": "isolated", "policyRef": "docs-only"}),
        json!({"policy": {"explicit": policy()}, "policyRef": "docs-only"}),
    ] {
        let mut value = input();
        value["spec"]["policies"] = json!({"docs-only": policy()});
        *network(&mut value) = selection.clone();
        assert!(parse(&value).is_err(), "{selection}");
        assert!(!schema_accepts(&value), "{selection}");
    }
}

#[test]
fn unknown_policy_and_grant_references_list_the_visible_definitions() {
    let mut value = input();
    value["spec"]["policies"] = json!({"docs-only": policy()});
    value["spec"]["grants"] = json!({"github": grant("api.github.com")});
    *network(&mut value) = json!({"policyRef": "missing"});
    let error = parse(&value).unwrap_err().to_string();
    assert!(error.contains("policyRef"), "{error}");
    assert!(error.contains("docs-only"), "{error}");

    *network(&mut value) = json!({"grantRefs": ["missing"]});
    let error = parse(&value).unwrap_err().to_string();
    assert!(error.contains("grantRefs"), "{error}");
    assert!(error.contains("github"), "{error}");
}

#[test]
fn unused_policies_and_grants_are_validated_but_create_nothing() {
    let baseline = input();
    let mut value = input();
    value["spec"]["policies"] = json!({"docs-only": policy()});
    value["spec"]["grants"] = json!({"github": grant("api.github.com")});
    let document = parse(&value).expect("unused definitions parse");
    assert_eq!(
        targets(&document, &generations()).unwrap(),
        targets(&parse(&baseline).unwrap(), &generations()).unwrap(),
        "unused definitions add no resources or grants"
    );
    value["spec"]["policies"]["docs-only"]["version"] = json!(0);
    assert!(
        parse(&value).is_err(),
        "an unused policy is still validated"
    );
    let mut value = input();
    value["spec"]["grants"] =
        json!({"github": {"endpoints": [{"host": "api.github.com", "port": 0}]}});
    assert!(parse(&value).is_err(), "an unused grant is still validated");
}
