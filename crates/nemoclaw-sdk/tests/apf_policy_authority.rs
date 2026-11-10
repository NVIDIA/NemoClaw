// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A gateway whose sandbox policy APF authors.
use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};

fn example(source: &str) -> Value {
    serde_saphyr::from_str(source).unwrap()
}

fn governed(mut value: Value) -> Value {
    value["spec"]["gateway"]["policyAuthority"] = json!({"apf": {}});
    value
}

fn parse(value: &Value) -> Result<Document, nemoclaw_sdk::config::ConfigError> {
    Document::parse(value.to_string().as_bytes())
}

fn values(document: &Document, kind: &str) -> std::collections::BTreeMap<String, String> {
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), format!("{k}-generation")))
        .into();
    targets(document, &generations)
        .unwrap()
        .into_iter()
        .find(|row| row.kind == kind)
        .unwrap()
        .values
}

fn sandbox_values(document: &Document) -> std::collections::BTreeMap<String, String> {
    values(document, "sandbox")
}

#[test]
fn either_gateway_mode_accepts_apf_as_the_policy_authority() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for source in [
        include_str!("../../../examples/local.yaml"),
        include_str!("../../../examples/managed-hermes.yaml"),
    ] {
        let value = governed(example(source));
        assert!(validator.is_valid(&value), "{value}");
        let document = parse(&value).unwrap();
        assert_eq!(document.validate().map_err(|e| e.to_string()), Ok(()));
        assert_eq!(parse(&json!(document)).unwrap(), document);
        assert_eq!(sandbox_values(&document)["policy_authority"], "apf");
        // APF also serves the credential profiles.
        assert_eq!(values(&document, "inference")["policy_authority"], "apf");
    }
}

#[test]
fn apf_serves_every_credential_profile_on_a_governed_gateway() {
    let source = include_str!("../../../examples/travel-team.yaml");
    let kinds = ["inference", "web_search", "api"];
    let document = parse(&governed(example(source))).unwrap();
    for kind in kinds {
        assert_eq!(values(&document, kind)["policy_authority"], "apf", "{kind}");
    }
    let document = parse(&example(source)).unwrap();
    for kind in kinds {
        assert!(
            !values(&document, kind).contains_key("policy_authority"),
            "{kind}"
        );
    }
}

#[test]
fn without_a_policy_authority_nemoclaw_authors_the_policy() {
    let document = parse(&example(include_str!("../../../examples/local.yaml"))).unwrap();
    assert!(!sandbox_values(&document).contains_key("policy_authority"));
    assert!(!values(&document, "inference").contains_key("policy_authority"));
}

#[test]
fn an_unknown_policy_authority_is_rejected() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let mut value = example(include_str!("../../../examples/local.yaml"));
    value["spec"]["gateway"]["policyAuthority"] = json!({"other": {}});
    assert!(!validator.is_valid(&value));
    assert!(parse(&value).is_err());
    value["spec"]["gateway"]["policyAuthority"] = json!({"apf": {"unknown": true}});
    assert!(!validator.is_valid(&value));
    assert!(parse(&value).is_err());
}

#[test]
fn an_apf_governed_sandbox_cannot_author_its_own_policy() {
    let mut value = governed(example(include_str!("../../../examples/local.yaml")));
    value["spec"]["sandboxes"]["assistant"]["network"] = json!({"policy": {"explicit": {
        "version": 1,
        "filesystem_policy": {"include_workdir": false, "read_only": ["/usr"], "read_write": ["/tmp"]},
        "landlock": {"compatibility": "best_effort"},
        "process": {"run_as_user": "10001", "run_as_group": "10001"},
        "network_policies": {}
    }}});
    let error = parse(&value).unwrap_err();
    assert!(error.to_string().contains("policyAuthority"), "{error}");
    value["spec"]["gateway"]
        .as_object_mut()
        .unwrap()
        .remove("policyAuthority");
    parse(&value).expect("without APF, the sandbox may author its policy");
}
