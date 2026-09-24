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
fn example_configurations_pass_the_canonical_fabric_planner() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let catalog = nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled();
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
    let mut failures = Vec::new();
    for path in examples::yaml_files(&root.join("examples")) {
        let document = Document::parse(std::fs::File::open(&path).unwrap()).unwrap();
        let _rows = targets(&document, &generations).unwrap();
        for definition in &document.spec.sandboxes {
            let configuration =
                nemoclaw_sdk::fabric_config::for_sandbox(&document, definition).unwrap();
            let descriptors = catalog
                .adapters
                .iter()
                .map(|adapter| {
                    serde_json::from_value(serde_json::to_value(adapter).unwrap()).unwrap()
                })
                .collect::<Vec<_>>();
            let targets = catalog
                .targets
                .iter()
                .map(|target| serde_json::from_value(target.clone()).unwrap())
                .collect::<Vec<_>>();
            if let Err(error) = nemo_fabric_core::resolve_run_plan_from_descriptors(
                serde_json::from_value(configuration).unwrap(),
                nemo_fabric_core::ResolveContext::new("/sandbox"),
                &descriptors,
                &targets,
            ) {
                failures.push(format!("{} / {}: {error}", path.display(), definition.name));
            }
            checked += 1;
        }
    }
    assert!(checked > 0);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
