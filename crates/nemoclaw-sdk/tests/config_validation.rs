// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::{Document, ServiceDefinition};
use serde_json::json;

fn document(example: &str) -> Document {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples")
        .join(example);
    Document::parse(std::fs::read(path).unwrap().as_slice()).unwrap()
}

#[test]
fn directly_constructed_documents_and_services_enforce_normalized_bounds() {
    for (example, service, path, invalid) in [
        ("spark/vllm.yaml", "qwen", "/serving/port", json!(0)),
        (
            "spark/vllm.yaml",
            "qwen",
            "/serving/contextTokens",
            json!(-1),
        ),
        ("spark/vllm.yaml", "qwen", "/serving/maxSequences", json!(0)),
        (
            "spark/vllm.yaml",
            "qwen",
            "/memory/hostReserveGiB",
            json!(0),
        ),
        ("spark/vllm.yaml", "qwen", "/memory/kvCacheGiB", json!(0)),
        ("spark/vllm.yaml", "qwen", "/memory/minFreeGiB", json!(1000)),
        (
            "managed-ollama.yaml",
            "ollama-server",
            "/serving/port",
            json!(0),
        ),
        (
            "managed-ollama.yaml",
            "ollama-server",
            "/serving/contextTokens",
            json!(65537),
        ),
        (
            "managed-ollama.yaml",
            "ollama-server",
            "/memory/hostReserveGiB",
            json!(0),
        ),
        (
            "managed-ollama.yaml",
            "ollama-server",
            "/model/digest",
            json!("secret-invalid-digest"),
        ),
    ] {
        let mut value = serde_json::to_value(document(example)).unwrap();
        *value["spec"]["services"][service]
            .pointer_mut(path)
            .unwrap() = invalid;
        // Deserializing directly bypasses Document::parse, as Rust SDK callers can do.
        let candidate: Document = serde_json::from_value(value).unwrap();
        assert!(candidate.validate().is_err(), "{example} {path}");
        assert!(candidate.yaml().is_err(), "export: {example} {path}");
        let result = match &candidate.spec.services[service] {
            ServiceDefinition::Vllm(service) => service.validate(),
            ServiceDefinition::Ollama(service) => service.validate(),
            _ => unreachable!(),
        };
        assert!(result.is_err(), "standalone: {example} {path}");
    }
}

#[test]
fn normalization_markers_are_accepted_only_before_defaults() {
    let baseline = document("spark/vllm.yaml");
    for path in ["/spec/gateway/image", "/spec/sandboxes/0/image/ref"] {
        let mut value = serde_json::to_value(&baseline).unwrap();
        *value.pointer_mut(path).unwrap() = json!("");
        assert!(
            Document::parse(value.to_string().as_bytes()).is_ok(),
            "authored: {path}"
        );
        let direct: Document = serde_json::from_value(value).unwrap();
        assert!(direct.validate().is_err(), "normalized: {path}");
    }
    for example in [
        "spark/vllm.yaml",
        "managed-ollama.yaml",
        "spark/spark-inline.yaml",
    ] {
        let baseline = document(example);
        let reparsed = Document::parse(baseline.yaml().unwrap().as_bytes()).unwrap();
        assert_eq!(baseline, reparsed);
    }
}

#[test]
fn standalone_harness_validation_uses_the_same_contract_as_documents() {
    let baseline = document("fabric-openclaw.yaml");
    let harness = baseline.spec.sandboxes[0].harness.as_ref().unwrap();
    for invalid in [
        json!({"execution":{"timeoutSeconds":0}}),
        json!({"execution":{"heartbeatEvery":"30m\n"}}),
        json!({"interfaces":{"dashboard":{"port":8642}}}),
        json!({"observability":{"relay":{"enabled":true}}}),
    ] {
        let mut value = serde_json::to_value(harness).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .extend(invalid.as_object().unwrap().clone());
        let candidate: nemoclaw_sdk::config::Harness = serde_json::from_value(value).unwrap();
        assert!(candidate.validate().is_err());
        let mut direct = baseline.clone();
        direct.spec.sandboxes[0].harness = Some(candidate);
        assert!(direct.validate().is_err());
    }
}

#[test]
fn schema_diagnostics_never_echo_values_unknown_properties_or_definition_names() {
    let baseline = serde_json::to_value(document("spark/vllm.yaml")).unwrap();
    for (path, replacement) in [
        ("/spec/services/qwen/image", json!("SECRET-VALUE")),
        (
            "/spec/services/qwen/model",
            json!({"repository":"SECRET-VALUE", "revision":"SECRET-VALUE"}),
        ),
        (
            "/spec/services",
            json!({"SECRET-MAP-KEY": {"kind":"SECRET-VALUE"}}),
        ),
        (
            "/spec/sandboxes/0/harness",
            json!({"kind":"openclaw", "SECRET-PROPERTY":"SECRET-VALUE"}),
        ),
    ] {
        let mut value = baseline.clone();
        *value.pointer_mut(path).unwrap() = replacement;
        let error = Document::parse(value.to_string().as_bytes())
            .unwrap_err()
            .to_string();
        for secret in ["SECRET-VALUE", "SECRET-MAP-KEY", "SECRET-PROPERTY"] {
            assert!(!error.contains(secret), "{path}: {error}");
        }
    }
}

#[test]
fn semantic_checks_still_reject_schema_valid_relationships() {
    let mut value = serde_json::to_value(document("spark/vllm.yaml")).unwrap();
    value["spec"]["services"]["qwen"]["memory"]["freeGateGiB"] = json!(6);
    let validator =
        jsonschema::validator_for(&nemoclaw_sdk::config::schema::input_schema()).unwrap();
    assert!(validator.is_valid(&value));
    let candidate: Document = serde_json::from_value(value).unwrap();
    assert!(candidate.validate().is_err());
}

#[test]
fn recipe_byte_limits_remain_semantic_checks_for_multibyte_strings() {
    let mut value = serde_json::to_value(document("spark/spark-inline.yaml")).unwrap();
    value["spec"]["services"]["qwen"]["recipe"]["serving"]["environment"] =
        json!({"VLLM_LABEL": "é".repeat(2049)});
    let validator =
        jsonschema::validator_for(&nemoclaw_sdk::config::schema::input_schema()).unwrap();
    assert!(
        validator.is_valid(&value),
        "the string has fewer than 4096 characters"
    );
    assert!(
        Document::parse(value.to_string().as_bytes()).is_err(),
        "UTF-8 exceeds 4096 bytes"
    );
    let candidate: Document = serde_json::from_value(value).unwrap();
    assert!(candidate.validate().is_err());
    let ServiceDefinition::Vllm(service) = &candidate.spec.services["qwen"] else {
        unreachable!()
    };
    assert!(service.validate().is_err());
}

#[test]
fn policy_schema_owns_nonempty_destinations_and_rules() {
    let baseline = serde_json::to_value(document("explicit-policy.yaml")).unwrap();
    let validator =
        jsonschema::validator_for(&nemoclaw_sdk::config::schema::input_schema()).unwrap();
    let path =
        "/spec/sandboxes/0/network/policy/explicit/network_policies/documentation/endpoints/0";
    for replacement in [
        json!({"port":443,"host":""}),
        json!({"port":443,"allowed_ips":[]}),
        json!({"port":443,"host":"docs.example.com","rules":[]}),
        json!({"port":443,"host":"docs.example.com","deny_rules":[]}),
        json!({"ports":[443,443],"host":"docs.example.com"}),
    ] {
        let mut value = baseline.clone();
        *value.pointer_mut(path).unwrap() = replacement;
        assert!(!validator.is_valid(&value));
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
        let direct: Document = serde_json::from_value(value).unwrap();
        assert!(direct.validate().is_err());
        assert!(direct.spec.sandboxes[0].network.policy_proto().is_err());
    }
}
