// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[path = "support/examples.rs"]
mod examples;

#[path = "support/provider_scope.rs"]
mod provider_scope;
use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::Document,
};
use serde_json::{Value, json};

#[test]
fn declaration_scope_combinations_preserve_runtime_and_authored_intent() {
    let input: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric-openclaw.yaml")).unwrap();
    let generations: Generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
        "ollama",
        "ollama_proxy",
    ]
    .map(|key| (key.into(), "a".repeat(32)))
    .into();
    let expected = targets(
        &Document::parse(input.to_string().as_bytes()).unwrap(),
        &generations,
    )
    .unwrap();
    for provider_scope in 0..3 {
        for inference_scope in 0..3 {
            for harness_scope in 0..3 {
                let mut value = input.clone();
                let provider = value["spec"]
                    .as_object_mut()
                    .unwrap()
                    .remove("inferenceProviders")
                    .unwrap()[0]
                    .clone();
                if provider_scope == 2 {
                    let route =
                        &mut value["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0];
                    route.as_object_mut().unwrap().remove("providerRef");
                    route["provider"] = provider;
                } else {
                    let scope = if provider_scope == 0 {
                        &mut value["spec"]
                    } else {
                        &mut value["spec"]["sandboxes"][0]
                    };
                    scope["inferenceProviders"] = json!([provider]);
                }
                if inference_scope != 0 {
                    let agent = &mut value["spec"]["sandboxes"][0]["agent"];
                    let inference = agent.as_object_mut().unwrap().remove("inference").unwrap();
                    agent["inferenceRef"] = json!("chat");
                    let scope = if inference_scope == 1 {
                        &mut value["spec"]
                    } else {
                        &mut value["spec"]["sandboxes"][0]
                    };
                    scope["inferences"] = json!({"chat": inference});
                }
                if harness_scope != 0 {
                    let sandbox = &mut value["spec"]["sandboxes"][0];
                    let harness = sandbox.as_object_mut().unwrap().remove("harness").unwrap();
                    sandbox["harnessRef"] = json!("shared");
                    let scope = if harness_scope == 1 {
                        &mut value["spec"]
                    } else {
                        &mut value["spec"]["sandboxes"][0]
                    };
                    scope["harnesses"] = json!({"shared": harness});
                }
                let parsed = Document::parse(value.to_string().as_bytes());
                if provider_scope == 1 && inference_scope == 1 {
                    assert!(
                        parsed.is_err(),
                        "deployment definitions cannot see sandbox providers"
                    );
                    continue;
                }
                let document = parsed.unwrap();
                let authored = document.clone();
                assert_eq!(
                    provider_scope::normalized(targets(&document, &generations).unwrap()),
                    expected
                );
                assert_eq!(document, authored);
                assert_eq!(
                    Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
                    authored
                );
            }
        }
    }
}

#[test]
fn example_settings_satisfy_the_maintained_fabric_adapter_contracts() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let contracts: std::collections::BTreeMap<_, _> = ["openclaw", "hermes"]
        .into_iter()
        .map(|kind| {
            let descriptor: Value = serde_json::from_slice(
                &std::fs::read(root.join(format!("image/fabric/{kind}.fabric-adapter.json")))
                    .unwrap(),
            )
            .unwrap();
            (
                kind,
                jsonschema::validator_for(&descriptor["settings_schema"]).unwrap(),
            )
        })
        .collect();
    let generations: Generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
        "ollama",
        "ollama_proxy",
    ]
    .map(|key| (key.into(), "a".repeat(32)))
    .into();
    let mut checked = 0;
    for path in examples::yaml_files(&root.join("examples")) {
        let document = Document::parse(std::fs::File::open(&path).unwrap()).unwrap();
        let rows = targets(&document, &generations).unwrap();
        for definition in &document.spec.sandboxes {
            let kind = &document.sandbox_harness(definition).unwrap().kind;
            let Some(contract) = contracts.get(kind.as_str()) else {
                continue;
            };
            let sandbox = rows
                .iter()
                .find(|row| row.kind == "sandbox" && row.values["name"] == definition.name)
                .unwrap();
            let settings = json!({"agent_name": sandbox.values["agent_name"], "inference": serde_json::from_str::<Value>(&sandbox.values["inference_json"]).unwrap()});
            contract.validate(&settings).unwrap_or_else(|error| {
                panic!("{} / {}: {error}", path.display(), definition.name)
            });
            checked += 1;
        }
    }
    assert!(checked > 0);
}
