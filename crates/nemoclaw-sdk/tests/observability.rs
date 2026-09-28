// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, compile, targets},
    config::Document,
};
use serde_json::{Value, json};

#[test]
fn native_telemetry_settings_are_opaque_and_do_not_implicitly_grant_network_access() {
    let mut input: Value =
        serde_saphyr::from_str(include_str!("fixtures/config/local.yaml")).unwrap();
    let settings = json!({"telemetry":{"future":null,"service":"agent ${fixture} %{literal}"}});
    input["spec"]["sandboxes"][0]["harness"]["settings"] = settings.clone();
    let document = Document::parse(input.to_string().as_bytes()).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let rows = targets(&document, &generations).unwrap();
    let config: Value = serde_json::from_str(
        &rows
            .iter()
            .find(|row| row.kind == "agent_configuration")
            .unwrap()
            .values["config_json"],
    )
    .unwrap();
    assert_eq!(config["harness"]["settings"], settings);
    let policy: Value = serde_json::from_str(
        &rows
            .iter()
            .find(|row| row.kind == "sandbox")
            .unwrap()
            .values["policy_json"],
    )
    .unwrap();
    assert!(
        !policy["network_policies"]
            .as_object()
            .unwrap()
            .contains_key("nemoclaw-otlp")
    );
    let graph = compile(&document, &generations, "0.1.0").unwrap();
    let encoded = graph["resource"]["nemoclaw_agent_configuration"]
        [&document.spec.sandboxes[0].name]["config_json"]
        .as_str()
        .unwrap();
    assert!(encoded.contains("agent $${fixture} %%{literal}"));
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document
    );
}
