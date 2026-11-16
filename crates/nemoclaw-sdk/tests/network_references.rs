// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Deployment-level network policies and grants, selected by name.
use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::{ConfigError, Document, schema::input_schema},
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
/// The local fixture with a docs-only policy and a github grant defined, and
/// the assistant's network set to `network`.
fn input(network: Value) -> Value {
    let mut value = crate::support::fixture("local.yaml");
    value["spec"]["policies"] = json!({"docs-only": policy()});
    value["spec"]["grants"] = json!({"github": grant("api.github.com")});
    value["spec"]["sandboxes"]["assistant"]["network"] = network;
    value
}
fn parse(value: &Value) -> Result<Document, ConfigError> {
    Document::parse(value.to_string().as_bytes())
}
fn schema_accepts(value: &Value) -> bool {
    jsonschema::validator_for(&input_schema())
        .unwrap()
        .is_valid(value)
}
fn targets_of(value: &Value) -> Vec<nemoclaw_sdk::compile::Target> {
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    targets(&parse(value).unwrap(), &generations).unwrap()
}
/// The policy input the compiled graph sends to the sandbox.
fn sandbox_policy(value: &Value) -> Value {
    let rows = targets_of(value);
    let sandbox = rows.iter().find(|row| row.kind == "sandbox").unwrap();
    serde_json::from_str(&sandbox.values["policy_json"]).unwrap()
}
fn round_trips(value: &Value) {
    let document = parse(value).unwrap();
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document,
        "export keeps the authored references"
    );
}

#[test]
fn a_referenced_policy_produces_the_same_openshell_policy_as_the_inline_one() {
    let referenced = input(json!({"policyRef": "docs-only"}));
    assert!(schema_accepts(&referenced));
    assert_eq!(
        sandbox_policy(&referenced),
        sandbox_policy(&input(json!({"policy": {"explicit": policy()}})))
    );
    round_trips(&referenced);
}

#[test]
fn referenced_and_inline_grants_add_their_union_to_the_isolated_preset() {
    let value = input(json!({
        "tier": "isolated",
        "grants": {"docs": grant("docs.example.com")},
        "grantRefs": ["github"]
    }));
    assert!(schema_accepts(&value));
    let policy = sandbox_policy(&value);
    let names: Vec<_> = policy["managed"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|rule| rule["name"].as_str())
        .collect();
    for grant in ["docs", "github"] {
        assert!(names.contains(&grant), "{grant} in {names:?}");
    }
    round_trips(&value);
}

#[test]
fn conflicting_network_selections_fail() {
    for (selection, schema_rejects) in [
        (
            json!({"grants": {"github": grant("api.github.com")}, "grantRefs": ["github"]}),
            false,
        ),
        (
            json!({"policy": {"explicit": policy()}, "grantRefs": ["github"]}),
            true,
        ),
        (
            json!({"policyRef": "docs-only", "grantRefs": ["github"]}),
            true,
        ),
        (
            json!({"policyRef": "docs-only", "grants": {"docs": grant("docs.example.com")}}),
            true,
        ),
        (json!({"tier": "isolated", "policyRef": "docs-only"}), true),
        (
            json!({"policy": {"explicit": policy()}, "policyRef": "docs-only"}),
            true,
        ),
    ] {
        let value = input(selection.clone());
        assert!(parse(&value).is_err(), "{selection}");
        assert_eq!(!schema_accepts(&value), schema_rejects, "{selection}");
    }
}

#[test]
fn unknown_references_list_the_visible_definitions() {
    for (selection, field, visible) in [
        (json!({"policyRef": "missing"}), "policyRef", "docs-only"),
        (json!({"grantRefs": ["missing"]}), "grantRefs", "github"),
    ] {
        let error = parse(&input(selection)).unwrap_err().to_string();
        assert!(error.contains(field) && error.contains(visible), "{error}");
    }
}

#[test]
fn unused_policies_and_grants_are_validated_but_create_nothing() {
    let baseline = crate::support::fixture("local.yaml");
    let mut value = input(baseline["spec"]["sandboxes"]["assistant"]["network"].clone());
    assert_eq!(
        targets_of(&value),
        targets_of(&baseline),
        "unused definitions add no resources or grants"
    );
    value["spec"]["policies"]["docs-only"]["version"] = json!(0);
    assert!(
        parse(&value).is_err(),
        "an unused policy is still validated"
    );
    let mut value = input(json!({}));
    value["spec"]["grants"]["github"]["endpoints"][0]["port"] = json!(0);
    assert!(parse(&value).is_err(), "an unused grant is still validated");
}
