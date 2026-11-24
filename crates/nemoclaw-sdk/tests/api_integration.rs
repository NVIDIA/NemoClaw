// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, compile, targets},
    config::Document,
};
use serde_json::{Value, json};

fn generations() -> Generations {
    ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into()
}

fn input(api: Value, attached: bool) -> Value {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/agents/openclaw.yaml")).unwrap();
    value["spec"]["sandboxes"]["assistant"]["integrations"] = json!({ "bookings": api });
    if attached {
        value["spec"]["sandboxes"]["assistant"]["agent"]["integrationRefs"] = json!(["bookings"]);
    }
    value
}

fn bookings() -> Value {
    json!({
        "kind": "api",
        "endpoints": ["https://bookings.example.com/mcp"],
        "credential": {"env": "BOOKINGS_API_KEY"}
    })
}

#[test]
fn an_attached_api_registers_its_credential_for_the_sandbox() {
    let doc = Document::parse(input(bookings(), true).to_string().as_bytes())
        .expect("api integration must parse");
    assert_eq!(
        Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
        doc
    );
    let rows = targets(&doc, &generations()).unwrap();
    let api = rows
        .iter()
        .find(|r| r.kind == "api")
        .expect("an api target");
    assert_eq!(
        api.values["endpoints_json"],
        r#"["https://bookings.example.com/mcp"]"#
    );
    assert_eq!(api.values["credential_env"], "BOOKINGS_API_KEY");
    assert!(!api.values.contains_key("auth_style"));

    let graph = compile(&doc, &generations(), "0.1.0").unwrap();
    let (_, name) = api.address.split_once('.').unwrap();
    let resource = &graph["resource"]["openshell_api"][name];
    // Its executables come from the sandbox's harness.
    assert_eq!(
        resource["binaries"],
        json!("${jsondecode(data.fabric_harnesses.sandbox_assistant.binaries_json)}")
    );
    // The sandbox attaches its registration and waits for it.
    let sandbox = &graph["resource"]["openshell_sandbox"]["assistant"];
    assert!(
        sandbox["depends_on"]
            .as_array()
            .unwrap()
            .contains(&json!(api.address)),
        "{sandbox}"
    );
    assert!(
        sandbox["providers"].to_string().contains(&api.address),
        "{}",
        sandbox["providers"]
    );
}

#[test]
fn an_api_can_send_its_key_in_a_named_header() {
    let mut api = bookings();
    api["authStyle"] = json!("header");
    api["headerName"] = json!("X-Api-Key");
    let doc = Document::parse(input(api, true).to_string().as_bytes()).unwrap();
    let rows = targets(&doc, &generations()).unwrap();
    let api = rows.iter().find(|r| r.kind == "api").unwrap();
    assert_eq!(api.values["auth_style"], "header");
    assert_eq!(api.values["header_name"], "X-Api-Key");
}

#[test]
fn one_api_sends_its_key_to_every_endpoint_under_the_chosen_variable() {
    let mut api = bookings();
    api["endpoints"] = json!([
        "https://integrate.api.nvidia.com/v1",
        "https://ai.api.nvidia.com/v1"
    ]);
    api["sandboxEnv"] = json!("NVIDIA_API_KEY");
    let doc = Document::parse(input(api, true).to_string().as_bytes())
        .expect("several endpoints and sandboxEnv must parse");
    let rows = targets(&doc, &generations()).unwrap();
    let api = rows.iter().find(|r| r.kind == "api").unwrap();
    let graph = compile(&doc, &generations(), "0.1.0").unwrap();
    let (_, name) = api.address.split_once('.').unwrap();
    let resource = &graph["resource"]["openshell_api"][name];
    assert_eq!(
        resource["endpoints"],
        json!([
            "https://integrate.api.nvidia.com/v1",
            "https://ai.api.nvidia.com/v1"
        ]),
        "one registration must cover every endpoint"
    );
    assert_eq!(resource["sandbox_env"], "NVIDIA_API_KEY");
}

#[test]
fn an_api_names_at_least_one_endpoint_and_a_valid_variable() {
    let mut legacy = bookings();
    legacy.as_object_mut().unwrap().remove("endpoints");
    legacy["endpoint"] = json!("https://bookings.example.com/mcp");
    let mut empty = bookings();
    empty["endpoints"] = json!([]);
    let mut bad_name = bookings();
    bad_name["sandboxEnv"] = json!("not a name");
    for (case, api) in [
        ("endpoint", legacy),
        ("no endpoints", empty),
        ("sandboxEnv", bad_name),
    ] {
        assert!(
            Document::parse(input(api, true).to_string().as_bytes()).is_err(),
            "{case} must be rejected"
        );
    }
}

#[test]
fn an_unattached_api_creates_nothing() {
    let doc = Document::parse(input(bookings(), false).to_string().as_bytes()).unwrap();
    let rows = targets(&doc, &generations()).unwrap();
    assert!(rows.iter().all(|r| r.kind != "api"));
}
