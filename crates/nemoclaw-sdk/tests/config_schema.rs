// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::{Document, schema::input_schema};
use serde_json::{Value, json};

fn input(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples")
        .join(name);
    serde_saphyr::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn agrees(validator: &jsonschema::Validator, value: &Value, accepted: bool) {
    assert_eq!(
        Document::parse(value.to_string().as_bytes()).is_ok(),
        accepted,
        "parser: {value}"
    );
    assert_eq!(
        validator.is_valid(value),
        accepted,
        "schema errors: {:?}",
        validator.iter_errors(value).collect::<Vec<_>>()
    );
}

#[test]
fn input_schema_rejects_missing_required_fields_and_structural_nulls() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let original = input("local.yaml");
    agrees(&validator, &original, true);
    for path in [
        "/apiVersion",
        "/kind",
        "/metadata",
        "/metadata/name",
        "/metadata/uid",
        "/spec",
        "/spec/gateway",
        "/spec/gateway/management",
        "/spec/inferenceProviders",
        "/spec/inferenceProviders/0/name",
        "/spec/sandboxes",
        "/spec/sandboxes/0/name",
        "/spec/sandboxes/0/agents",
        "/spec/sandboxes/0/agents/0/harness",
        "/spec/sandboxes/0/agents/0/inference",
        "/spec/sandboxes/0/agents/0/inference/routes/0/overrides/model",
    ] {
        let mut value = original.clone();
        let (parent, key) = path.rsplit_once('/').unwrap();
        value
            .pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(key);
        agrees(&validator, &value, false);
    }
    for (parent, key) in [
        ("/spec/gateway", "credential"),
        ("/spec/gateway", "tls"),
        ("/spec/inferenceProviders/0", "service"),
        ("/spec/inferenceProviders/0", "ollama"),
    ] {
        let mut value = original.clone();
        value.pointer_mut(parent).unwrap()[key] = Value::Null;
        agrees(&validator, &value, false);
    }
}

#[test]
fn input_schema_preserves_defaults_strict_objects_and_opaque_pi_metadata() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let mut value = input("spark-inline.yaml");
    for key in ["endpoint", "engine", "image", "networkCIDR"] {
        value["spec"]["gateway"]
            .as_object_mut()
            .unwrap()
            .remove(key);
    }
    for key in ["image", "network", "runtime"] {
        value["spec"]["sandboxes"][0]
            .as_object_mut()
            .unwrap()
            .remove(key);
    }
    for key in ["serving", "memory"] {
        value["spec"]["inferenceProviders"][0]["service"]
            .as_object_mut()
            .unwrap()
            .remove(key);
    }
    agrees(&validator, &value, true);
    value["spec"]["gateway"]["surprise"] = json!(true);
    agrees(&validator, &value, false);
    let mut value = input("fabric-pi.yaml");
    let path = "/spec/sandboxes/0/agents/0/inference/routes/0/overrides/piModel";
    *value.pointer_mut(path).unwrap() = json!({"future": [null, {"value": null}]});
    agrees(&validator, &value, true);
    *value.pointer_mut(path).unwrap() = Value::Null;
    agrees(&validator, &value, false);
}

#[test]
fn schema_and_parser_accept_every_maintained_example() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples");
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|ext| ext == "yaml") {
            let value: Value =
                serde_saphyr::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            agrees(&validator, &value, true);
        }
    }
}

#[test]
fn schema_and_parser_enforce_choices_bounds_and_conditional_forms() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for (file, path, replacement, accepted) in [
        ("local.yaml", "/apiVersion", json!("future"), false),
        ("local.yaml", "/metadata/name", json!("UPPER"), false),
        ("local.yaml", "/spec/inferenceProviders", json!([]), false),
        (
            "local.yaml",
            "/spec/gateway/management",
            json!("future"),
            false,
        ),
        (
            "local.yaml",
            "/spec/gateway/engine",
            json!("unix:///var/run/docker.sock"),
            false,
        ),
        (
            "local.yaml",
            "/spec/gateway/credential",
            json!({"env": "TOKEN"}),
            false,
        ),
        (
            "local.yaml",
            "/spec/sandboxes/0/runtime/provider",
            json!("podman"),
            true,
        ),
        (
            "local.yaml",
            "/spec/sandboxes/0/runtime/provider",
            json!("future"),
            false,
        ),
        (
            "local.yaml",
            "/spec/sandboxes/0/agents/0/harness",
            json!("claude"),
            false,
        ),
        (
            "fabric-claude.yaml",
            "/spec/inferenceProviders/0/provider",
            json!("openai"),
            false,
        ),
        (
            "fabric-pi.yaml",
            "/spec/sandboxes/0/agents/0/harness",
            json!("codex"),
            false,
        ),
        (
            "managed-ollama.yaml",
            "/spec/inferenceProviders/0/ollama/image",
            json!("ollama/ollama:latest"),
            false,
        ),
        (
            "managed-ollama.yaml",
            "/spec/sandboxes/0/agents/0/inference/routes/0/overrides/model",
            json!("untagged"),
            false,
        ),
        (
            "vllm.yaml",
            "/spec/inferenceProviders/0/endpoint",
            json!("https://api.example.com/v1"),
            false,
        ),
        (
            "vllm.yaml",
            "/spec/inferenceProviders/0/credential",
            json!({"env": "TOKEN"}),
            false,
        ),
        (
            "vllm.yaml",
            "/spec/inferenceProviders/0/service/backend",
            json!("removed-backend"),
            false,
        ),
        (
            "vllm.yaml",
            "/spec/inferenceProviders/0/service/serving/speculativeTokens",
            json!(1),
            false,
        ),
        (
            "vllm.yaml",
            "/spec/inferenceProviders/0/service/serving/startupTimeoutSeconds",
            json!(0),
            true,
        ),
        (
            "vllm.yaml",
            "/spec/inferenceProviders/0/service/serving/startupTimeoutSeconds",
            json!(59),
            false,
        ),
        (
            "vllm.yaml",
            "/spec/inferenceProviders/0/service/serving/startupTimeoutSeconds",
            json!(60),
            true,
        ),
        (
            "vllm.yaml",
            "/spec/inferenceProviders/0/service/serving/startupTimeoutSeconds",
            json!(3600),
            true,
        ),
        (
            "vllm.yaml",
            "/spec/inferenceProviders/0/service/serving/startupTimeoutSeconds",
            json!(3601),
            false,
        ),
        (
            "vllm.yaml",
            "/spec/inferenceProviders/0/service/memory/hostReserveGiB",
            json!(27),
            false,
        ),
        (
            "vllm.yaml",
            "/spec/inferenceProviders/0/service/memory/hostReserveGiB",
            json!(0),
            true,
        ),
        (
            "vllm.yaml",
            "/spec/sandboxes/0/agents/0/harness",
            json!("hermes"),
            false,
        ),
        (
            "vllm.yaml",
            "/spec/sandboxes/0/runtime/provider",
            json!("podman"),
            false,
        ),
        (
            "spark-inline.yaml",
            "/spec/inferenceProviders/0/service/recipe/apiVersion",
            json!("future"),
            false,
        ),
        (
            "spark-inline.yaml",
            "/spec/inferenceProviders/0/service/memory/gpuMemoryGiB",
            json!(16),
            false,
        ),
        (
            "spark-inline.yaml",
            "/spec/inferenceProviders/0/service/recipe/resources/preparedBytes",
            json!(0),
            false,
        ),
    ] {
        let mut value = input(file);
        let (parent, key) = path.rsplit_once('/').unwrap();
        value.pointer_mut(parent).unwrap()[key] = replacement;
        agrees(&validator, &value, accepted);
    }
    for field in ["placement", "publication"] {
        let mut value = input("remote-vllm.yaml");
        value["spec"]["inferenceProviders"][0]["service"]
            .as_object_mut()
            .unwrap()
            .remove(field);
        agrees(&validator, &value, false);
    }
}

#[test]
fn defaulted_numeric_bounds_match_the_parser_at_each_boundary() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for (section, field, min, max) in [
        ("serving", "port", 1024, 65535),
        ("serving", "contextTokens", 8192, 65536),
        ("serving", "maxSequences", 1, 2),
        ("serving", "batchTokens", 512, 2048),
        ("serving", "startupTimeoutSeconds", 60, 3600),
        ("memory", "hostReserveGiB", 28, 64),
        ("memory", "kvCacheGiB", 4, 12),
        ("memory", "minAvailableGiB", 6, 16),
        ("memory", "minFreeGiB", 2, 8),
        ("memory", "freeGateGiB", 6, 24),
        ("memory", "consecutiveSamples", 1, 5),
    ] {
        for (number, accepted) in [
            (-1, false),
            (0, true),
            (min, true),
            (max, true),
            (max + 1, false),
        ] {
            let mut value = input("vllm.yaml");
            let service = &mut value["spec"]["inferenceProviders"][0]["service"];
            service["memory"]["minAvailableGiB"] = json!(6);
            service["memory"]["freeGateGiB"] = json!(24);
            service[section][field] = json!(number);
            agrees(&validator, &value, accepted);
        }
    }
}

#[test]
fn documented_parser_checks_remain_required_after_schema_validation() {
    let schema = input_schema();
    assert!(schema["x-nemoclaw-parser-checks"].as_array().unwrap().len() >= 4);
    let validator = jsonschema::validator_for(&schema).unwrap();
    for (file, path, replacement) in [
        (
            "local.yaml",
            "/spec/sandboxes/0/agents/0/inference/routes/0/providerRef",
            json!("foreign"),
        ),
        (
            "local.yaml",
            "/spec/gateway/endpoint",
            json!("http://remote.example.com"),
        ),
        (
            "remote-vllm.yaml",
            "/spec/inferenceProviders/0/service/publication/endpoint",
            json!("http://10.0.0.8:9999/v1"),
        ),
        (
            "vllm.yaml",
            "/spec/inferenceProviders/0/service/memory/freeGateGiB",
            json!(6),
        ),
    ] {
        let mut value = input(file);
        *value.pointer_mut(path).unwrap() = replacement;
        assert!(validator.is_valid(&value), "{path}");
        assert!(
            Document::parse(value.to_string().as_bytes()).is_err(),
            "{path}"
        );
    }
}
