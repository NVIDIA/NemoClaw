// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::Document;
use serde_json::{Value, json};

fn input(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples")
        .join(name);
    serde_saphyr::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn parse(value: &Value) -> Result<Document, nemoclaw_sdk::config::ConfigError> {
    Document::parse(value.to_string().as_bytes())
}

#[test]
fn maintained_examples_parse_without_connecting_to_services() {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples");
    let mut count = 0;
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|extension| extension != "yaml") {
            continue;
        }
        let bytes = std::fs::read(&path).unwrap();
        Document::parse(bytes.as_slice()).unwrap_or_else(|error| {
            panic!("{}: {error}", path.display());
        });
        count += 1;
    }
    assert!(count > 0, "the maintained example corpus must not be empty");
}

#[test]
fn omitted_empty_and_zero_values_produce_the_same_defaults() {
    let mut omitted = input("spark-inline.yaml");
    for key in ["endpoint", "engine", "image", "networkCIDR"] {
        omitted["spec"]["gateway"]
            .as_object_mut()
            .unwrap()
            .remove(key);
    }
    for key in ["image", "runtime", "network"] {
        omitted["spec"]["sandboxes"][0]
            .as_object_mut()
            .unwrap()
            .remove(key);
    }
    for key in ["serving", "memory"] {
        omitted["spec"]["inferenceProviders"][0]["service"]
            .as_object_mut()
            .unwrap()
            .remove(key);
    }
    let expected = parse(&omitted).unwrap();
    let mut explicit = omitted.clone();
    for key in ["endpoint", "engine", "image", "networkCIDR"] {
        explicit["spec"]["gateway"][key] = json!("");
    }
    explicit["spec"]["sandboxes"][0]["image"] = json!({"ref": ""});
    explicit["spec"]["sandboxes"][0]["runtime"] = json!({"provider": ""});
    explicit["spec"]["sandboxes"][0]["network"] = json!({"tier": ""});
    explicit["spec"]["inferenceProviders"][0]["service"]["serving"] = json!({
        "port": 0, "contextTokens": 0, "maxSequences": 0, "batchTokens": 0,
        "startupTimeoutSeconds": 0, "speculativeTokens": 0,
        "toolParser": "", "reasoningParser": ""
    });
    explicit["spec"]["inferenceProviders"][0]["service"]["memory"] = json!({
        "hostReserveGiB": 0, "kvCacheGiB": 0, "minAvailableGiB": 0,
        "minFreeGiB": 0, "freeGateGiB": 0, "consecutiveSamples": 0,
        "gpuMemoryGiB": 0
    });
    assert_eq!(parse(&explicit).unwrap(), expected);
    assert_eq!(parse(&explicit).unwrap().digest(), expected.digest());
    for path in [
        "/spec/gateway/endpoint",
        "/spec/sandboxes/0/image",
        "/spec/inferenceProviders/0/service/serving/port",
    ] {
        let mut invalid = explicit.clone();
        *invalid.pointer_mut(path).unwrap() = Value::Null;
        assert!(parse(&invalid).is_err(), "{path}");
    }
}

#[test]
fn required_fields_and_mutually_exclusive_provider_forms_are_rejected() {
    let baseline = input("local.yaml");
    for path in [
        "/apiVersion",
        "/kind",
        "/metadata/name",
        "/metadata/uid",
        "/spec/gateway/management",
        "/spec/gateway/endpoint",
        "/spec/inferenceProviders/0/name",
        "/spec/inferenceProviders/0/provider",
        "/spec/sandboxes/0/agents/0/harness",
    ] {
        let mut invalid = baseline.clone();
        let (parent, key) = path.rsplit_once('/').unwrap();
        invalid
            .pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(key);
        assert!(parse(&invalid).is_err(), "{path}");
    }
    for field in ["endpoint", "credential", "ollama"] {
        let mut invalid = input("spark-inline.yaml");
        invalid["spec"]["inferenceProviders"][0][field] = match field {
            "endpoint" => json!("https://inference.example.com/v1"),
            "credential" => json!({"env": "MODEL_TOKEN"}),
            _ => json!({}),
        };
        assert!(parse(&invalid).is_err(), "{field}");
    }
}

#[test]
fn only_pi_metadata_permits_nested_null_values() {
    let mut value = input("fabric-pi.yaml");
    let pointer = "/spec/sandboxes/0/agents/0/inference/routes/0/overrides/piModel";
    *value.pointer_mut(pointer).unwrap() = json!({"future": [null, {"nested": null}]});
    parse(&value).unwrap();
    *value.pointer_mut(pointer).unwrap() = Value::Null;
    assert!(parse(&value).is_err());
}

#[test]
fn voiceclaw_intent_selects_one_openclaw_agent_without_internal_settings() {
    let value = input("voiceclaw-r0.yaml");
    let document = parse(&value).unwrap();
    let integration = &document.spec.integrations[0];
    assert_eq!(integration.name, "voice");
    assert_eq!(integration.kind, "voiceclaw");
    assert_eq!(integration.agent_ref, "assistant");

    for (path, replacement) in [
        ("/spec/integrations/0/kind", json!("unknown")),
        ("/spec/integrations/0/agentRef", json!("missing")),
        ("/spec/sandboxes/0/agents/0/harness", json!("hermes")),
    ] {
        let mut invalid = value.clone();
        *invalid.pointer_mut(path).unwrap() = replacement;
        assert!(parse(&invalid).is_err(), "{path}");
    }

    let mut internal = value;
    internal["spec"]["integrations"][0]["credential"] = json!("secret");
    assert!(parse(&internal).is_err());
}
