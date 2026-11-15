// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, compile, targets},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};

#[test]
fn shell_restriction_changes_only_the_allow_list_and_restores_the_baseline_graph() {
    // The adapter owns these names and file settings; the SDK must not interpret them.
    let shell = "fixture.shell-launch";
    let other_tools = json!(["fixture.file-read", "fixture.lookup"]);
    let mut baseline = input(2);
    let sandbox = &mut baseline["spec"]["sandboxes"]["sandbox-0"];
    sandbox["agent"]["tools"] = json!({"allow":["fixture.file-read", shell, "fixture.lookup"]});
    sandbox["harness"]["kind"] = json!("org.fixture.adapter");
    sandbox["harness"]["settings"] = json!({
        "files": {"instructions": "/sandbox/workspace/AGENTS.md"}
    });
    sandbox["harness"]["config"] = json!({
        "skills": {"paths": ["/sandbox/workspace/skills/probe"]},
        "relay": {"plugins": {"dynamic": [{
            "manifest": "/sandbox/workspace/plugins/probe/relay-plugin.toml",
            "config": {"mode": "observe"}
        }]}},
        "runtime": {"keep_state": true, "max_turns": 7}
    });
    sandbox["driverConfig"] = json!({"docker": {"mounts": [
        {"type": "volume", "source": "workspace", "target": "/sandbox/workspace", "read_only": false},
        {"type": "volume", "source": "artifacts", "target": "/sandbox/artifacts", "read_only": false}
    ]}});
    let generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let compile_input = |value: &Value| {
        let document = parse(value).unwrap();
        let rows = targets(&document, &generations).unwrap();
        let agent = rows
            .iter()
            .find(|row| row.address == "fabric_agent.sandbox-0")
            .unwrap();
        (
            nemoclaw_fabric::agent::compose(&agent.values).unwrap(),
            compile(&document, &generations, "0.1.0").unwrap(),
        )
    };
    let (baseline_settings, baseline_graph) = compile_input(&baseline);
    let mut restricted = baseline.clone();
    restricted["spec"]["sandboxes"]["sandbox-0"]["agent"]["tools"]["allow"] = other_tools.clone();
    let (restricted_settings, restricted_graph) = compile_input(&restricted);
    assert_eq!(
        restricted_settings["tools"]["enabled"], other_tools,
        "restriction must remove only the adapter's shell tool"
    );
    let mut expected_settings = baseline_settings;
    expected_settings["tools"]["enabled"] = other_tools.clone();
    assert_eq!(
        restricted_settings, expected_settings,
        "shell restriction must preserve every other Fabric setting"
    );

    // Agent inputs and read-only harness discovery carry the same configuration.
    // The sandbox declaration stays unchanged; its configuration trigger replaces it.
    let mut expected_graph = baseline_graph.clone();
    expected_graph["resource"]["terraform_data"]["agent_sandbox-0"]["input"] =
        json!(expected_settings.to_string());
    expected_graph["resource"]["fabric_agent"]["sandbox-0"]["tools"]["enabled"] = other_tools;
    for read in ["sandbox_sandbox-0", "sandbox_sandbox-0_acquired"] {
        if let Some(discovery) = expected_graph["data"]["fabric_harnesses"].get_mut(read) {
            discovery["config_json"] = json!(expected_settings.to_string());
        }
    }
    assert_ne!(
        restricted_graph["resource"]["terraform_data"]["agent_sandbox-0"],
        baseline_graph["resource"]["terraform_data"]["agent_sandbox-0"],
        "restriction must change the sandbox's configuration trigger"
    );
    assert_eq!(
        restricted_graph, expected_graph,
        "restriction must leave the rest of the graph unchanged, including the other agent"
    );
    assert_eq!(
        restricted_graph["resource"]["openshell_sandbox"]["sandbox-0"]["lifecycle"]["replace_triggered_by"],
        json!(["terraform_data.agent_sandbox-0"]),
        "the changed configuration must replace its sandbox"
    );

    restricted["spec"]["sandboxes"]["sandbox-0"]["agent"]["tools"] =
        baseline["spec"]["sandboxes"]["sandbox-0"]["agent"]["tools"].clone();
    let (_, restored_graph) = compile_input(&restricted);
    assert_eq!(
        restored_graph, baseline_graph,
        "restore must reproduce the entire baseline graph"
    );
}

fn input(count: usize) -> Value {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric-openclaw.yaml")).unwrap();
    let primary = value["spec"]["sandboxes"]["assistant"].clone();
    value["spec"]["sandboxes"] = Value::Object(
        (0..count)
            .map(|n| {
                let mut sandbox = primary.clone();
                sandbox["agent"]["name"] = json!(format!("agent-{n}"));
                if n != 0 {
                    sandbox["agent"]["tools"] = json!({"allow":["read"]});
                }
                (format!("sandbox-{n}"), sandbox)
            })
            .collect(),
    );
    value
}
fn parse(v: &Value) -> Result<Document, nemoclaw_sdk::config::ConfigError> {
    Document::parse(v.to_string().as_bytes())
}
#[test]
fn separate_sandboxes_preserve_each_agents_restrictions_in_launch_and_yaml() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    for count in [1, 3, 12] {
        let v = input(count);
        let d = parse(&v).expect("one agent per sandbox must parse");
        assert!(schema.is_valid(&v));
        assert_eq!(Document::parse(d.yaml().unwrap().as_bytes()).unwrap(), d);
        let g: Generations = ["workspace", "provider", "sandbox"]
            .map(|k| (k.into(), format!("{k}-generation")))
            .into();
        let rows = targets(&d, &g).unwrap();
        let sandboxes: Vec<_> = rows.iter().filter(|row| row.kind == "agent").collect();
        assert_eq!(sandboxes.len(), count);
        for sandbox in sandboxes {
            let settings: Value = nemoclaw_fabric::agent::compose(&sandbox.values).unwrap();
            assert!(!settings["metadata"]["name"].as_str().unwrap().is_empty());
            if sandbox.values["sandbox"] != "sandbox-0" {
                assert_eq!(settings["tools"], json!({"enabled":["read"]}));
            }
        }
    }
    let mut v = input(1);
    v["spec"]["sandboxes"]["sandbox-0"]["agent"]["tools"] = json!({"allow":["read"]});
    assert!(parse(&v).is_ok());
    assert!(schema.is_valid(&v));
}
#[test]
fn invalid_sandboxes_and_permissions_fail_before_planning() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    assert!(parse(&input(0)).is_err());
    assert!(!schema.is_valid(&input(0)));
    for tools in [
        json!({}),
        json!({"allow":[]}),
        json!({"allow":["read","read"]}),
        json!({"allow":["read"],"alsoAllow":["exec"]}),
        json!(null),
    ] {
        let mut v = input(3);
        v["spec"]["sandboxes"]["sandbox-1"]["agent"]["tools"] = tools;
        assert!(parse(&v).is_err());
        assert!(!schema.is_valid(&v));
    }
    // Names are keys, so a repeated name is a duplicate YAML key.
    let repeated = serde_saphyr::to_string(&input(3))
        .unwrap()
        .replace("sandbox-1:", "sandbox-0:");
    assert!(Document::parse(repeated.as_bytes()).is_err());
    let mut v = input(3);
    v["spec"]["sandboxes"]["sandbox-1"]["agent"]["harness"]["kind"] = json!("hermes");
    assert!(parse(&v).is_err());
    assert!(!schema.is_valid(&v));
}

#[test]
fn disclosure_belongs_to_opaque_native_settings() {
    let mut value = input(2);
    for (i, mode) in ["progressive", "direct"].iter().enumerate() {
        value["spec"]["sandboxes"][format!("sandbox-{i}")]["harness"]["settings"] =
            json!({"disclosure":mode});
    }
    let doc = parse(&value).unwrap();
    for (i, mode) in ["progressive", "direct"].iter().enumerate() {
        let config = nemoclaw_sdk::fabric_config::for_sandbox(
            &doc,
            doc.sandbox(&format!("sandbox-{i}")).unwrap(),
        )
        .unwrap();
        assert_eq!(config["harness"]["settings"]["disclosure"], *mode);
    }
    value["spec"]["sandboxes"]["sandbox-0"]["agent"]["tools"] = json!({"disclosure":"direct"});
    assert!(parse(&value).is_err());
}

#[test]
fn tool_choices_are_preserved_independently_of_harness_identity() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    for harness in ["deepagents", "pi"] {
        let mut value = input(1);
        value["spec"]["sandboxes"]["sandbox-0"]["harness"]["kind"] = json!(harness);
        value["spec"]["sandboxes"]["sandbox-0"]["agent"]["tools"] = json!({"allow":["read"]});
        let document = parse(&value).expect("native read tool policy");
        assert!(schema.is_valid(&value));
        let generations = ["workspace", "provider", "sandbox"]
            .map(|key| (key.into(), "a".repeat(32)))
            .into();
        let rows = targets(&document, &generations).unwrap();
        let settings: Value = nemoclaw_fabric::agent::compose(
            &rows.iter().find(|row| row.kind == "agent").unwrap().values,
        )
        .unwrap();
        assert_eq!(settings["tools"], json!({"enabled":["read"]}));
        for disclosure in ["direct", "progressive"] {
            value["spec"]["sandboxes"]["sandbox-0"]["agent"]["tools"] =
                json!({"disclosure":disclosure});
            assert!(parse(&value).is_err());
            // Native disclosure belongs to harness.settings.
            assert!(!schema.is_valid(&value));
        }
    }
}

#[test]
fn deep_agents_use_separate_sandboxes_with_stable_names_and_independent_models() {
    let mut value = input(2);
    for sandbox in value["spec"]["sandboxes"]
        .as_object_mut()
        .unwrap()
        .values_mut()
    {
        sandbox["harness"]["kind"] = json!("deepagents");
    }
    value["spec"]["sandboxes"]["sandbox-1"]["agent"]["inference"]["routes"][0]["overrides"]["model"] =
        json!("other-model");
    let doc = parse(&value).expect("one native Deep Agents instance per sandbox");
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
    let generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let rows = targets(&doc, &generations).unwrap();
    let sandbox = rows
        .iter()
        .find(|row| row.kind == "agent" && row.values["sandbox"] == "sandbox-1")
        .unwrap();
    let configuration: Value = nemoclaw_fabric::agent::compose(&sandbox.values).unwrap();
    assert_eq!(configuration["metadata"]["name"], "agent-1");
    let settings: Value = nemoclaw_fabric::agent::compose(&sandbox.values).unwrap();
    assert_eq!(settings["models"]["default"]["model"], "other-model");
}
