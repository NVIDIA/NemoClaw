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
    let mut input = source("../crates/nemoclaw-sdk/tests/fixtures/config/inline-recipe.yaml");
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
    let mut second = input["spec"]["sandboxes"]["assistant"].clone();
    second["agent"]["inference"]["routes"][0]["overrides"] = json!("PRIVATE_SENTINEL");
    input["spec"]["sandboxes"]["second"] = second;
    let error = Document::parse(input.to_string().as_bytes())
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("spec.sandboxes.second.agent.inference.routes[0].overrides"),
        "{error}"
    );
    assert!(error.contains("must be object"), "{error}");
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
    literal["spec"]["sandboxes"]["assistant"]["harness"]["settings"] =
        json!({"opaque": "!!binary literal text"});
    Document::parse(literal.to_string().as_bytes()).unwrap();
}

#[test]
fn flow_document_columns_count_characters_and_do_not_include_values() {
    let mut input = source("fabric-openclaw.yaml");
    input["spec"]["inferenceProviders"]["local"]["endpoint"] = json!("http://é.example.com/v1");
    input["spec"]["sandboxes"]["assistant"]["agent"]["inference"]["routes"] =
        json!("PRIVATE_SENTINEL");
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
    literal["spec"]["sandboxes"]["assistant"]["harness"]["settings"] =
        json!({"opaque": "!!binary literal text\n!custom still text"});
    let text = serde_saphyr::to_string(&literal).unwrap();
    let document = Document::parse(text.as_bytes()).unwrap();
    assert_eq!(
        serde_json::to_value(document).unwrap()["spec"]["sandboxes"]["assistant"]["harness"]["settings"],
        literal["spec"]["sandboxes"]["assistant"]["harness"]["settings"]
    );
}

#[test]
fn a_missing_service_image_reports_the_digest_pin_rule_at_its_service() {
    let mut input = source("../crates/nemoclaw-sdk/tests/fixtures/config/inline-recipe.yaml");
    input["spec"]["services"]["qwen"]
        .as_object_mut()
        .unwrap()
        .remove("image");
    let error = Document::parse(input.to_string().as_bytes())
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("schema at spec.services.qwen (line")
            && error.ends_with(": service image must be pinned by a SHA-256 digest"),
        "{error}"
    );
}

fn local_yaml() -> String {
    std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/local.yaml"),
    )
    .unwrap()
}

/// `examples/local.yaml` after `edit`, which must change it.
fn edited(edit: impl FnOnce(String) -> String) -> String {
    let original = local_yaml();
    let text = edit(original.clone());
    assert_ne!(text, original, "the edit must change the example");
    text
}

/// The 1-based line and character column where `needle` starts in `text`.
fn position_of(text: &str, needle: &str) -> String {
    let before = &text[..text.find(needle).unwrap()];
    let line = before.matches('\n').count() + 1;
    let column = before.rsplit('\n').next().unwrap().chars().count() + 1;
    format!("line {line}, column {column}")
}

fn rejection(text: &str) -> String {
    Document::parse(text.as_bytes()).unwrap_err().to_string()
}

const WEB_SEARCH: &str = "  integrations:\n    search:\n      kind: webSearch\n      provider: brave\n      credential:\n        env: BRAVE_API_KEY\n  sandboxes:\n";

#[test]
fn schema_rules_without_their_own_message_still_explain_the_failure() {
    for (text, path, at, constraint) in [
        (
            edited(|yaml| yaml.replace("kind: nvidia.fabric.openclaw", "kind: \"\"")),
            "spec.sandboxes.assistant.harness.kind",
            "\"\"",
            "must not be empty",
        ),
        (
            edited(|yaml| {
                let routes = yaml.find("          routes:").unwrap();
                format!("{}          routes: []\n", &yaml[..routes])
            }),
            "spec.sandboxes.assistant.agent.inference.routes",
            "[]",
            "must not be empty",
        ),
        (
            edited(|yaml| {
                yaml.replace("  sandboxes:\n", WEB_SEARCH).replace(
                    "        name: main\n",
                    "        name: main\n        integrationRefs: [search, search]\n",
                )
            }),
            "spec.sandboxes.assistant.agent.integrationRefs",
            "[search, search]",
            "must not repeat an entry",
        ),
        (
            edited(|yaml| {
                yaml.replace(
                    "      endpoint: http://172.20.0.1:11436/v1\n",
                    "      serviceRef: ollama\n      credential:\n        env: OPENAI_API_KEY\n",
                )
            }),
            "spec.inferenceProviders.local",
            "provider: openai",
            "must not set credential",
        ),
        (
            edited(|yaml| {
                yaml.replace(
                    "        ref: nc-fabric@sha256:",
                    "        metadata:\n          env: IMAGE_METADATA\n        ref: nc-fabric@sha256:",
                )
            }),
            "spec.sandboxes.assistant.image",
            "metadata:\n          env: IMAGE_METADATA",
            "image.metadata is available only for Kubernetes and OpenShift; Docker and Podman use engine image inspection",
        ),
        (
            edited(|yaml| yaml.replace("    assistant:\n", "    Assistant_1:\n")),
            "spec.sandboxes",
            "Assistant_1",
            "names must start with a lowercase letter and use only lowercase letters, digits, and hyphens, up to 40 characters",
        ),
    ] {
        assert_eq!(
            rejection(&text),
            format!(
                "configuration violates schema at {path} ({}): {constraint}",
                position_of(&text, at)
            )
        );
    }
}

#[test]
fn a_tag_that_names_no_variant_lists_the_allowed_values() {
    let text = edited(|yaml| yaml.replace("management: external", "management: extrnal"));
    assert_eq!(
        rejection(&text),
        format!(
            "configuration violates schema at spec.gateway.management ({}): must be one of: external, managed",
            position_of(&text, "extrnal")
        )
    );
    let text = edited(|yaml| {
        yaml.replace(
            "  sandboxes:\n",
            &WEB_SEARCH.replace("kind: webSearch", "kind: websearch"),
        )
    });
    assert_eq!(
        rejection(&text),
        format!(
            "configuration violates schema at spec.integrations.search.kind ({}): must be one of: api, webSearch",
            position_of(&text, "websearch")
        )
    );
    let text = edited(|yaml| {
        yaml.replace(
            "  sandboxes:\n",
            &WEB_SEARCH.replace("      kind: webSearch\n", ""),
        )
    });
    assert_eq!(
        rejection(&text),
        format!(
            "configuration violates schema at spec.integrations.search ({}): required field: \"kind\"; must be one of: api, webSearch",
            position_of(&text, "provider: brave")
        )
    );
}

#[test]
fn an_unknown_field_is_reported_at_its_key_with_a_declared_name() {
    let text = edited(|yaml| yaml.replace("tier: isolated", "teir: isolated"));
    assert_eq!(
        rejection(&text),
        format!(
            "configuration violates schema at spec.sandboxes.assistant.network ({}): unknown fields are not allowed; did you mean \"tier\"?",
            position_of(&text, "teir")
        )
    );
    // Without a close declared name, the error lists the declared ones and
    // never the key, which can hold any text.
    for key in ["lables", "PRIVATE_SENTINEL"] {
        let text = edited(|yaml| {
            yaml.replace(
                "  uid: 87d485ad-fba7-4197-9eaa-aa97cc97446b\n",
                &format!("  uid: 87d485ad-fba7-4197-9eaa-aa97cc97446b\n  {key}: {{team: a}}\n"),
            )
        });
        assert_eq!(
            rejection(&text),
            format!(
                "configuration violates schema at metadata ({}): unknown fields are not allowed; accepted fields: name, uid",
                position_of(&text, key)
            )
        );
    }
}

#[test]
fn an_integer_beyond_its_rust_type_fails_in_the_schema_at_its_position() {
    let text = edited(|yaml| {
        yaml.replace(
            "      network:\n",
            "      gpus: 5000000000\n      network:\n",
        )
    });
    assert_eq!(
        rejection(&text),
        format!(
            "configuration violates schema at spec.sandboxes.assistant.gpus ({}): must be at most 4294967295",
            position_of(&text, "5000000000")
        )
    );
}
