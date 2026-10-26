// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The openshell provider's contract fixtures are the OpenShell resources the
//! SDK compiles for each example with an external gateway. This test fails
//! when they differ; set NEMOCLAW_REGENERATE_FIXTURES=1 to rewrite them.

use nemoclaw_sdk::{compile, config::Document};
use serde_json::{Map, Value, json};
use std::{collections::BTreeMap, fs, path::Path};

const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../openshell-provider/tests/contract/fixtures"
);

/// The fixture for `document`, or `None` when its OpenShell resources need
/// more than the fake gateway: a managed gateway, Kubernetes, or a credential
/// read from a managed service's container.
fn fixture(mut document: Document) -> Option<String> {
    if document.spec.gateway.as_managed().is_some()
        || document.spec.gateway.as_kubernetes().is_some()
    {
        return None;
    }
    document.defaults();
    let generations: compile::Generations = ["workspace", "provider", "sandbox"]
        .map(|kind| (kind.into(), "a".repeat(32)))
        .into();
    let graph = compile::compile(&document, &generations, "0.1.0").ok()?;
    // Fabric capabilities supply each sandbox's runtime binding; the fixture
    // states the binding the fake images declare.
    let mut encoded = serde_json::to_string(&graph["resource"]).unwrap();
    if encoded.contains("managedService") {
        return None;
    }
    for (index, sandbox) in document.spec.sandboxes.values().enumerate() {
        let kind = sandbox.harness.as_ref().map_or_else(
            || "nvidia.fabric.openclaw".to_owned(),
            |harness| harness.kind.to_string(),
        );
        let binding = nemoclaw_e2e::image_runtime::binding(&kind);
        let launch = serde_json::to_string(
            &serde_json::to_string(&binding.launch(&sandbox.agent.name)).unwrap(),
        )
        .unwrap();
        // On Docker the sandbox takes them from the read after its image pull.
        for read in [
            format!("sandbox_{index}"),
            format!("sandbox_{index}_acquired"),
        ] {
            encoded = encoded
                .replace(
                    &format!("\"${{jsondecode(data.fabric_harnesses.{read}.binaries_json)}}\""),
                    &serde_json::to_string(&binding.binaries()).unwrap(),
                )
                .replace(
                    &format!("\"${{data.fabric_harnesses.{read}.launch_json}}\""),
                    &launch.replace("${", "$${"),
                );
        }
    }
    let mut resources = Map::new();
    let compiled: Value = serde_json::from_str(&encoded).unwrap();
    for (kind, bodies) in compiled.as_object().unwrap() {
        // OpenShell objects, and the agent configurations that replace their
        // sandboxes; the gateway installation types have their own contract
        // tests.
        if !(kind.starts_with("openshell_") || kind == "terraform_data")
            || nemoclaw_openshell::installation_type(nemoclaw_openshell::object_kind(kind))
                .is_some()
        {
            continue;
        }
        let mut bodies = bodies.clone();
        for body in bodies.as_object_mut().unwrap().values_mut() {
            // The contract test tears down as the SDK does, without the
            // deployment's protection against accidental destroy.
            if let Some(lifecycle) = body.get_mut("lifecycle").and_then(Value::as_object_mut) {
                lifecycle.remove("prevent_destroy");
            }
            if let Some(depends) = body.get_mut("depends_on").and_then(Value::as_array_mut) {
                depends.retain(|address| {
                    address.as_str().is_some_and(|address| {
                        let kind = address
                            .trim_start_matches("data.")
                            .split('.')
                            .next()
                            .unwrap_or_default();
                        kind.starts_with("openshell_")
                            && nemoclaw_openshell::installation_type(
                                nemoclaw_openshell::object_kind(kind),
                            )
                            .is_none()
                    })
                });
                if depends.is_empty() {
                    body.as_object_mut().unwrap().remove("depends_on");
                }
            }
        }
        resources.insert(kind.clone(), bodies);
    }
    // Objects carry the gateway's ref literally; they reach the same fake
    // gateway, which takes no credentials.
    let mut resources = Value::Object(resources);
    for bodies in resources.as_object_mut().unwrap().values_mut() {
        for body in bodies.as_object_mut().unwrap().values_mut() {
            if let Some(gateway) = body
                .get_mut("gateway")
                .filter(|gateway| gateway["type"] == "openshell_gateway")
            {
                for attribute in [
                    "credential_env",
                    "tls_ca_env",
                    "tls_certificate_env",
                    "tls_key_env",
                    "kubernetes",
                ] {
                    gateway[attribute] = json!("");
                }
                gateway["endpoint"] = json!("${var.endpoint}");
            }
        }
    }
    let text = resources.to_string();
    assert!(
        !text.contains("data.fabric_") && !text.contains("nemoclaw_"),
        "the fixture references types the openshell provider does not serve: {text}"
    );
    // The fake gateway takes no credentials; fixtures reach it at var.endpoint.
    let mut gateway_reads = graph["data"]["openshell_gateway"].clone();
    for read in gateway_reads.as_object_mut().unwrap().values_mut() {
        let read = read.as_object_mut().unwrap();
        for attribute in [
            "endpoint",
            "credential_env",
            "tls_ca_env",
            "tls_certificate_env",
            "tls_key_env",
            "kubernetes",
        ] {
            read.remove(attribute);
        }
        read.insert("endpoint".into(), json!("${var.endpoint}"));
    }
    let mut openshell = graph["terraform"]["required_providers"]["openshell"].clone();
    openshell.as_object_mut().unwrap().remove("version");
    let fixture = json!({
        "terraform": {
            "required_providers": {"openshell": openshell},
        },
        "variable": {"endpoint": {"type": "string"}, "destroying": {"default": false}},
        "provider": {"openshell": {"destroy": "${var.destroying}"}},
        "data": {"openshell_gateway": gateway_reads},
        "resource": resources,
    });
    Some(serde_json::to_string_pretty(&fixture).unwrap() + "\n")
}

#[test]
fn openshell_contract_fixtures_match_what_the_sdk_compiles() {
    let examples = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples");
    let mut expected = BTreeMap::new();
    for entry in fs::read_dir(examples).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|extension| extension != "yaml") {
            continue;
        }
        let document = Document::parse(fs::read(&path).unwrap().as_slice()).unwrap();
        if let Some(fixture) = fixture(document) {
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            expected.insert(format!("{name}.tf.json"), fixture);
        }
    }
    if std::env::var_os("NEMOCLAW_REGENERATE_FIXTURES").is_some() {
        fs::remove_dir_all(FIXTURES).ok();
        fs::create_dir_all(FIXTURES).unwrap();
        for (name, fixture) in &expected {
            fs::write(Path::new(FIXTURES).join(name), fixture).unwrap();
        }
    }
    let actual: BTreeMap<String, String> = fs::read_dir(FIXTURES)
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            (
                path.file_name().unwrap().to_string_lossy().into_owned(),
                fs::read_to_string(&path).unwrap(),
            )
        })
        .collect();
    assert_eq!(
        actual.keys().collect::<Vec<_>>(),
        expected.keys().collect::<Vec<_>>(),
        "regenerate with NEMOCLAW_REGENERATE_FIXTURES=1"
    );
    for (name, fixture) in &expected {
        assert!(
            actual[name] == *fixture,
            "{name} is stale; regenerate with NEMOCLAW_REGENERATE_FIXTURES=1"
        );
    }
}
