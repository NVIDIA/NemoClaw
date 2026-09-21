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
fn application_references_do_not_enable_yaml_anchors_aliases_or_merges() {
    let original = include_str!("../../../examples/fabric-openclaw.yaml");
    for replacement in [
        "metadata: &metadata",
        "metadata: *metadata",
        "metadata:\n  <<: {name: merged}",
    ] {
        let yaml = original.replacen("metadata:", replacement, 1);
        assert!(Document::parse(yaml.as_bytes()).is_err());
    }
}

#[test]
fn omitted_empty_and_zero_values_produce_the_same_defaults() {
    let mut omitted = input("spark/spark-inline.yaml");
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
        omitted["spec"]["services"]["qwen"]
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
    explicit["spec"]["services"]["qwen"]["serving"] = json!({
        "port": 0, "contextTokens": 0, "maxSequences": 0, "batchTokens": 0,
        "startupTimeoutSeconds": 0, "speculativeTokens": 0,
        "toolParser": "", "reasoningParser": ""
    });
    explicit["spec"]["services"]["qwen"]["memory"] = json!({
        "hostReserveGiB": 0, "kvCacheGiB": 0, "minAvailableGiB": 0,
        "minFreeGiB": 0, "freeGateGiB": 0, "consecutiveSamples": 0,
        "gpuMemoryGiB": 0
    });
    assert_eq!(parse(&explicit).unwrap(), expected);
    assert_eq!(parse(&explicit).unwrap().digest(), expected.digest());
    for path in [
        "/spec/gateway/endpoint",
        "/spec/sandboxes/0/image",
        "/spec/services/qwen/serving/port",
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
        "/spec/sandboxes/0/harness",
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
        let mut invalid = input("spark/spark-inline.yaml");
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
    let pointer = "/spec/sandboxes/0/agent/inference/routes/0/overrides/piModel";
    *value.pointer_mut(pointer).unwrap() = json!({"future": [null, {"nested": null}]});
    parse(&value).unwrap();
    *value.pointer_mut(pointer).unwrap() = Value::Null;
    assert!(parse(&value).is_err());
}

#[test]
fn service_image_error_identifies_the_required_digest_pin() {
    let original = input("spark/spark-inline.yaml");
    for image in ["local/runtime:latest", "local/runtime@sha256:short"] {
        let mut value = original.clone();
        value["spec"]["services"]["qwen"]["image"] = json!(image);
        assert_eq!(
            parse(&value).unwrap_err().to_string(),
            "service image must be pinned by a SHA-256 digest"
        );
    }
    parse(&original).unwrap();
}

#[test]
fn local_service_image_ids_require_never_and_local_placement() {
    let image = format!("sha256:{}", "a".repeat(64));
    let mut local = input("spark/spark-inline.yaml");
    local["spec"]["services"]["qwen"]["image"] = json!(image);
    local["spec"]["services"]["qwen"]["imagePullPolicy"] = json!("Never");
    parse(&local).expect("preloaded local image ID");

    for policy in [None, Some("IfNotPresent")] {
        let mut invalid = local.clone();
        match policy {
            Some(policy) => {
                invalid["spec"]["services"]["qwen"]["imagePullPolicy"] = json!(policy);
            }
            None => {
                invalid["spec"]["services"]["qwen"]
                    .as_object_mut()
                    .unwrap()
                    .remove("imagePullPolicy");
            }
        }
        assert_eq!(
            parse(&invalid).unwrap_err().to_string(),
            "local Docker image ID requires imagePullPolicy Never on a local engine"
        );
    }

    let mut remote = local;
    remote["spec"]["services"]["qwen"]["placement"] = json!({
        "engine": "ssh://gpu-box",
        "networkCidr": "172.21.0.0/24"
    });
    remote["spec"]["services"]["qwen"]["publication"] = json!({
        "endpoint": "http://10.0.0.2:18888/v1",
        "bindAddress": "10.0.0.2"
    });
    assert_eq!(
        parse(&remote).unwrap_err().to_string(),
        "local Docker image ID requires imagePullPolicy Never on a local engine"
    );
}
