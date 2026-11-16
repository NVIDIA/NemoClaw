// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Fabric sections authored on the agent or the harness reach each agent's
//! Fabric configuration unchanged.
use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};

fn input() -> Value {
    crate::support::fixture("local.yaml")
}
fn parse(value: &Value) -> Result<Document, nemoclaw_sdk::config::ConfigError> {
    Document::parse(value.to_string().as_bytes())
}
fn schema_accepts(value: &Value) -> bool {
    jsonschema::validator_for(&input_schema())
        .unwrap()
        .is_valid(value)
}
/// The Fabric configuration the compiled graph sends to each sandbox's agent.
fn fabric(document: &Document, sandbox: &str) -> Value {
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let rows = targets(document, &generations).unwrap();
    let row = rows
        .iter()
        .find(|row| row.kind == "agent" && row.values["sandbox"] == sandbox)
        .unwrap();
    nemoclaw_fabric::agent::compose(&row.values).unwrap()
}

#[test]
fn agents_sharing_a_harness_definition_keep_their_own_instructions() {
    let mut value = input();
    let mut writer = value["spec"]["sandboxes"]["assistant"].clone();
    writer["agent"]["name"] = json!("writer");
    value["spec"]["sandboxes"]["writer"] = writer;
    value["spec"]["harnesses"] =
        json!({"shared": {"kind": "nvidia.fabric.openclaw", "runtime": {"max_turns": 9}}});
    for (sandbox, text) in [("assistant", "Research."), ("writer", "Write.")] {
        let entry = value["spec"]["sandboxes"][sandbox].as_object_mut().unwrap();
        entry.remove("harness");
        entry.insert("harnessRef".into(), json!("shared"));
        entry["agent"]["instructions"] = json!({"system": {"mode": "replace", "content": text}});
    }
    assert!(
        schema_accepts(&value),
        "the editor schema accepts agent instructions"
    );
    let document = parse(&value).expect("agent instructions parse");
    for (sandbox, text) in [("assistant", "Research."), ("writer", "Write.")] {
        let config = fabric(&document, sandbox);
        assert_eq!(
            config["instructions"]["system"]["content"], text,
            "{sandbox} receives its own instructions"
        );
        assert_eq!(
            config["runtime"]["max_turns"], 9,
            "{sandbox} receives the shared harness runtime"
        );
    }
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document,
        "export keeps the shared harness and each agent's instructions"
    );
}

#[test]
fn harness_runtime_timeout_reaches_fabric_and_execution_is_rejected() {
    let mut value = input();
    value["spec"]["sandboxes"]["assistant"]["harness"]["runtime"] = json!({"timeout_seconds": 900});
    let document = parse(&value).expect("harness runtime parses");
    let config = fabric(&document, "assistant");
    assert_eq!(config["runtime"]["timeout_seconds"], 900);
    assert_eq!(
        config["runtime"]["artifacts"], "/sandbox/artifacts",
        "the deployment still sets the artifacts folder"
    );

    let mut removed = input();
    removed["spec"]["sandboxes"]["assistant"]["harness"]["execution"] =
        json!({"timeoutSeconds": 900});
    let error = parse(&removed).expect_err("execution is no longer a harness field");
    assert!(
        error
            .to_string()
            .contains("spec.sandboxes.assistant.harness"),
        "{error}"
    );
    assert!(!schema_accepts(&removed));
}

#[test]
fn a_harness_runtime_value_that_conflicts_with_the_deployment_fails() {
    let mut value = input();
    value["spec"]["sandboxes"]["assistant"]["harness"]["runtime"] =
        json!({"artifacts": "/elsewhere"});
    let document = parse(&value).unwrap();
    let error =
        nemoclaw_sdk::fabric_config::for_sandbox(&document, document.sandbox("assistant").unwrap())
            .expect_err("the deployment owns runtime.artifacts");
    assert!(error.to_string().contains("deployment-owned"), "{error}");
}

#[test]
fn agent_tools_reach_fabric_unchanged() {
    let mut value = input();
    let tools = json!({"enabled": ["read", "write"], "blocked": ["exec"]});
    value["spec"]["sandboxes"]["assistant"]["agent"]["tools"] = tools.clone();
    assert!(schema_accepts(&value));
    let document = parse(&value).expect("Fabric's tools section parses");
    assert_eq!(fabric(&document, "assistant")["tools"], tools);

    let mut removed = input();
    removed["spec"]["sandboxes"]["assistant"]["agent"]["tools"] = json!({"allow": ["read"]});
    let error = parse(&removed).expect_err("the removed allow list would restrict nothing");
    assert!(error.to_string().contains("tools.enabled"), "{error}");
    assert!(!schema_accepts(&removed));
}

#[test]
fn harness_telemetry_and_relay_reach_fabric() {
    let mut value = input();
    let harness = &mut value["spec"]["sandboxes"]["assistant"]["harness"];
    harness["kind"] = json!("nvidia.fabric.hermes");
    harness["telemetry"] = json!({"providers": {"relay": {}}});
    harness["relay"] = json!({"project": "travel"});
    assert!(schema_accepts(&value));
    let document = parse(&value).expect("harness telemetry and relay parse");
    let config = fabric(&document, "assistant");
    assert_eq!(config["telemetry"], json!({"providers": {"relay": {}}}));
    assert_eq!(config["relay"]["project"], "travel");
}

#[test]
fn agent_skills_and_mcp_reach_fabric_and_harness_config_is_rejected() {
    let mut value = input();
    let skills = json!({"directories": [{"folder": "/sandbox/skills"}], "duplicates": "reject"});
    let mcp = json!({"servers": {"docs": {
        "transport": "streamable-http",
        "url": "https://docs.example.com/mcp",
        "exposure": "harness_native"
    }}});
    let agent = &mut value["spec"]["sandboxes"]["assistant"]["agent"];
    agent["skills"] = skills.clone();
    agent["mcp"] = mcp.clone();
    assert!(schema_accepts(&value));
    let document = parse(&value).expect("agent skills and mcp parse");
    let config = fabric(&document, "assistant");
    assert_eq!(config["skills"], skills);
    assert_eq!(config["mcp"], mcp);

    let mut removed = input();
    removed["spec"]["sandboxes"]["assistant"]["harness"]["config"] = json!({"skills": skills});
    assert!(
        parse(&removed).is_err(),
        "harness.config is no longer a field"
    );
    assert!(!schema_accepts(&removed));
}
