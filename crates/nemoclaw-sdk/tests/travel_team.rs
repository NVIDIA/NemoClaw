// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The YAML travel team expresses what the hand-written HCL example in
//! examples/hcl/travel-team declares, sandbox by sandbox.
use nemoclaw_sdk::compile::{Generations, targets};
use nemoclaw_sdk::config::Document;
use serde_json::{Value, json};

const RESEARCHERS: [&str; 4] = ["flights", "stays", "transport", "attractions"];

fn document() -> Document {
    Document::parse(include_bytes!("../../../examples/travel-team.yaml").as_slice())
        .expect("the travel team parses")
}

/// The HCL example's settings for each role: its inference provider, model
/// limits, Fabric toolsets, and turns.
fn expected(role: &str) -> (&'static str, f64, u64, Value, u64) {
    match role {
        "scheduler" => ("frontier", 0.3, 8192, json!(["delegation"]), 12),
        "buyer" => ("frontier", 0.0, 4096, json!(["bookings"]), 24),
        _ => ("local", 0.2, 2048, json!(["web"]), 16),
    }
}

#[test]
fn each_agent_matches_the_hcl_example() {
    let doc = document();
    let mut names: Vec<_> = doc.spec.sandboxes.iter().map(|s| s.name.as_str()).collect();
    names.sort();
    assert_eq!(
        names,
        [
            "attractions",
            "buyer",
            "flights",
            "scheduler",
            "stays",
            "transport"
        ]
    );
    for sandbox in &doc.spec.sandboxes {
        let (provider, temperature, max_tokens, tools, max_turns) = expected(&sandbox.name);
        let config = nemoclaw_sdk::fabric_config::for_sandbox(&doc, sandbox).unwrap();
        let model = &config["models"]["default"];
        assert_eq!(model["provider"], "custom", "{}: {model}", sandbox.name);
        assert_eq!(
            model["temperature"].as_f64(),
            Some(temperature),
            "{}",
            sandbox.name
        );
        assert_eq!(model["max_tokens"], max_tokens, "{}", sandbox.name);
        let local = provider == "local";
        assert_eq!(
            model["model"],
            if local {
                "nemotron-3-nano:30b"
            } else {
                "nvidia/nemotron-3.5-super-vl-120b-a12b"
            },
            "{}",
            sandbox.name
        );
        assert_eq!(config["tools"]["enabled"], tools, "{}", sandbox.name);
        assert_eq!(
            config["runtime"]["max_turns"], max_turns,
            "{}",
            sandbox.name
        );
        assert!(
            config["instructions"]["system"]["content"]
                .as_str()
                .is_some_and(|text| !text.is_empty()),
            "{}",
            sandbox.name
        );
    }
}

#[test]
fn each_sandbox_attaches_only_its_providers_and_grants() {
    let doc = document();
    let generations: Generations = ["workspace", "provider", "sandbox", "inference_service"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let rows = targets(&doc, &generations).unwrap();
    let sandbox = |name: &str| {
        rows.iter()
            .find(|r| r.kind == "sandbox" && r.values["name"] == name)
            .unwrap_or_else(|| panic!("sandbox {name}"))
    };
    let providers = |name: &str| -> Vec<String> {
        serde_json::from_str(&sandbox(name).values["provider_names_json"]).unwrap()
    };
    let search = rows
        .iter()
        .find(|r| r.kind == "web_search")
        .expect("one web search");
    assert_eq!(search.values["sandbox_env"], "BRAVE_SEARCH_API_KEY");
    let api = rows
        .iter()
        .find(|r| r.kind == "api")
        .expect("one booking API");
    assert_eq!(api.values["endpoint"], "https://bookings.example.com/mcp");
    let search_registration =
        nemoclaw_openshell::registration_name(&search.kind, &search.values).unwrap();
    let api_registration = nemoclaw_openshell::registration_name(&api.kind, &api.values).unwrap();

    for name in RESEARCHERS {
        let attached = providers(name);
        assert!(
            attached.iter().any(|n| n.starts_with("local-")),
            "{name}: {attached:?}"
        );
        assert!(
            attached.contains(&search_registration),
            "{name}: {attached:?}"
        );
        assert!(
            !attached.contains(&api_registration),
            "{name}: {attached:?}"
        );
    }
    let scheduler = providers("scheduler");
    assert!(
        scheduler.len() == 1 && scheduler[0].starts_with("frontier-"),
        "{scheduler:?}"
    );
    let buyer = providers("buyer");
    assert!(
        buyer.iter().any(|n| n.starts_with("frontier-")) && buyer.contains(&api_registration),
        "{buyer:?}"
    );
    assert!(!buyer.contains(&search_registration));

    // Only the buyer has an authored grant: the booking service's setup,
    // discovery, and two tools.
    for name in [
        "flights",
        "stays",
        "transport",
        "attractions",
        "scheduler",
        "buyer",
    ] {
        let input: Value = serde_json::from_str(&sandbox(name).values["policy_json"]).unwrap();
        let grant: Vec<_> = input["managed"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|rule| rule["name"] == "bookings")
            .collect();
        if name != "buyer" {
            assert!(grant.is_empty(), "{name}");
            continue;
        }
        let tools: Vec<_> = grant[0]["endpoints"][0]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|rule| rule["allow"]["method"] == "tools/call")
            .map(|rule| rule["allow"]["tool"].clone())
            .collect();
        assert_eq!(tools, [json!("get_quote"), json!("book_option")]);
    }
}
