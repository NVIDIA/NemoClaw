// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::Document;
use serde_json::{Value, json};

fn source(file: &str) -> Value {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples");
    serde_saphyr::from_str(&std::fs::read_to_string(root.join(file)).unwrap()).unwrap()
}

#[test]
fn schema_failure_names_the_service_field_constraint_and_source_position() {
    let mut input = source("spark/spark-inline.yaml");
    input["spec"]["services"]["qwen"]["memory"]
        .as_object_mut()
        .unwrap()
        .remove("gpuMemoryUtilization");
    input["spec"]["services"]["qwen"]["memory"]["kvCacheGiB"] = json!(2);
    let yaml = serde_saphyr::to_string(&input).unwrap();
    let (line, text) = yaml
        .lines()
        .enumerate()
        .find(|(_, line)| line.contains("kvCacheGiB: 2"))
        .unwrap();
    let column = text.find(": 2").unwrap() + 3;
    let error = Document::parse(yaml.as_bytes()).unwrap_err().to_string();
    for expected in [
        "spec.services.qwen.memory.kvCacheGiB",
        "must be 0 or between 4 and 12",
        &format!("line {}, column {column}", line + 1),
    ] {
        assert!(error.contains(expected), "{error}");
    }
    assert!(!error.contains("$defs"), "{error}");
}

#[test]
fn schema_failure_identifies_array_indices_and_expected_type_without_values() {
    let mut input = source("fabric-openclaw.yaml");
    let mut second = input["spec"]["sandboxes"][0].clone();
    second["name"] = json!("second");
    second["agent"]["inference"]["routes"] = json!("PRIVATE_SENTINEL");
    input["spec"]["sandboxes"]
        .as_array_mut()
        .unwrap()
        .push(second);
    let error = Document::parse(input.to_string().as_bytes())
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("spec.sandboxes[1].agent.inference.routes"),
        "{error}"
    );
    assert!(error.contains("must be array"), "{error}");
    assert!(!error.contains("PRIVATE_SENTINEL"));
}

#[test]
fn yaml_syntax_and_duplicate_keys_have_safe_reasons_and_positions() {
    for (input, reason) in [
        (
            "metadata:\n  name: PRIVATE_SENTINEL\n   uid: invalid\n",
            "invalid YAML syntax",
        ),
        (
            "metadata:\n  name: PRIVATE_SENTINEL\n  name: repeated\n",
            "duplicate mapping key",
        ),
        (
            "---\nmetadata: {}\n---\nmetadata: {}\n",
            "multiple YAML documents",
        ),
    ] {
        let error = Document::parse(input.as_bytes()).unwrap_err().to_string();
        assert!(error.contains(reason), "{error}");
        assert!(
            error.contains("line ") && error.contains("column "),
            "{error}"
        );
        assert!(!error.contains("PRIVATE_SENTINEL"));
        assert!(!error.contains("repeated"));
    }
}

#[test]
fn empty_input_is_distinct_from_an_invalid_root_value() {
    for input in ["", " \n", "# only a comment\n", "---\n"] {
        let error = Document::parse(input.as_bytes()).unwrap_err().to_string();
        assert!(error.contains("empty document"), "{input:?}: {error}");
    }
    let error = Document::parse("[]".as_bytes()).unwrap_err().to_string();
    assert!(
        error.contains("document root") && error.contains("must be object"),
        "{error}"
    );
}

#[test]
fn explicit_core_tags_are_rejected_without_rejecting_tag_text_inside_strings() {
    let input = source("fabric-openclaw.yaml");
    let yaml = serde_saphyr::to_string(&input).unwrap();
    let name = input["metadata"]["name"].as_str().unwrap();
    for replacement in [
        "!!binary ZXhwbG9yZS10MTA=",
        "!!str explore-t10",
        "!<tag:yaml.org,2002:str> explore-t10",
    ] {
        let tagged = yaml.replacen(&format!("name: {name}"), &format!("name: {replacement}"), 1);
        let error = Document::parse(tagged.as_bytes()).unwrap_err().to_string();
        assert!(
            error.contains("explicit YAML tags are not allowed"),
            "{error}"
        );
        assert!(
            error.contains("line ") && error.contains("column "),
            "{error}"
        );
        assert!(!error.contains("ZXhwbG9yZS10MTA="));
    }
    let mut literal = input;
    literal["spec"]["sandboxes"][0]["harness"]["settings"] =
        json!({"opaque": "!!binary literal text"});
    Document::parse(literal.to_string().as_bytes()).unwrap();
}

#[test]
fn flow_document_columns_count_characters_and_do_not_include_values() {
    let mut input = source("fabric-openclaw.yaml");
    input["spec"]["inferenceProviders"][0]["endpoint"] = json!("http://é.example.com/v1");
    input["spec"]["sandboxes"][0]["agent"]["inference"]["routes"] = json!("PRIVATE_SENTINEL");
    let text = input.to_string();
    let offset = text.find("\"routes\":\"PRIVATE_SENTINEL\"").unwrap() + "\"routes\":".len();
    let column = text[..offset].chars().count() + 1;
    let error = Document::parse(text.as_bytes()).unwrap_err().to_string();
    assert!(
        error.contains(&format!("line 1, column {column}")),
        "{error}"
    );
    assert!(
        !error.contains("PRIVATE_SENTINEL") && !error.contains("é.example.com"),
        "{error}"
    );
}

#[test]
fn collection_tags_are_rejected_and_quoted_or_block_tag_text_is_preserved() {
    let input = source("fabric-openclaw.yaml");
    let yaml = serde_saphyr::to_string(&input).unwrap();
    for tagged in [
        yaml.replacen("metadata:", "metadata: !!map", 1),
        yaml.replacen("sandboxes:", "sandboxes: !!seq", 1),
    ] {
        let error = Document::parse(tagged.as_bytes()).unwrap_err().to_string();
        assert!(
            error.contains("explicit YAML tags are not allowed"),
            "{error}"
        );
    }
    let mut literal = input;
    literal["spec"]["sandboxes"][0]["harness"]["settings"] =
        json!({"opaque": "!!binary literal text\n!custom still text"});
    let text = serde_saphyr::to_string(&literal).unwrap();
    let document = Document::parse(text.as_bytes()).unwrap();
    assert_eq!(
        serde_json::to_value(document).unwrap()["spec"]["sandboxes"][0]["harness"]["settings"],
        literal["spec"]["sandboxes"][0]["harness"]["settings"]
    );
}
