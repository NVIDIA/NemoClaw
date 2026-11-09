// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::examples;

use nemoclaw_sdk::config::{DEFAULT_GATEWAY_IMAGE, Document, schema::input_schema};
use serde_json::{Value, json};

fn input(name: &str) -> Value {
    crate::support::example(name)
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

fn agrees_at(
    validator: &jsonschema::Validator,
    value: &Value,
    accepted: bool,
    file: &str,
    path: &str,
) {
    assert_eq!(
        Document::parse(value.to_string().as_bytes()).is_ok(),
        accepted,
        "parser: {file} {path}: {value}"
    );
    assert_eq!(
        validator.is_valid(value),
        accepted,
        "schema: {file} {path}: {:?}",
        validator.iter_errors(value).collect::<Vec<_>>()
    );
}

#[test]
fn image_pull_policy_accepts_only_supported_values_on_managed_containers() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for (file, path) in [
        (
            "../crates/nemoclaw-sdk/tests/fixtures/config/inline-recipe.yaml",
            "/spec/gateway",
        ),
        (
            "../crates/nemoclaw-sdk/tests/fixtures/config/inline-recipe.yaml",
            "/spec/services/qwen",
        ),
        ("managed-ollama.yaml", "/spec/services/ollama-server"),
    ] {
        for policy in ["Always", "IfNotPresent", "Never", "always", ""] {
            let mut value = input(file);
            value.pointer_mut(path).unwrap()["imagePullPolicy"] = json!(policy);
            let accepted = matches!(policy, "IfNotPresent" | "Never");
            agrees(&validator, &value, accepted);
            if policy == "Always" {
                let error = Document::parse(value.to_string().as_bytes())
                    .unwrap_err()
                    .to_string();
                assert!(
                    error.contains("IfNotPresent") && error.contains("Never"),
                    "{error}"
                );
            }
            if accepted {
                let document = Document::parse(value.to_string().as_bytes()).unwrap();
                let exported = document.yaml().unwrap();
                assert_eq!(Document::parse(exported.as_bytes()).unwrap(), document);
                assert_eq!(
                    serde_json::to_value(document)
                        .unwrap()
                        .pointer(path)
                        .unwrap()["imagePullPolicy"],
                    policy
                );
            }
        }
    }
    let mut external = input("local.yaml");
    external["spec"]["gateway"]["imagePullPolicy"] = json!("Never");
    agrees(&validator, &external, false);
    let mut sandbox = input("local.yaml");
    sandbox["spec"]["sandboxes"]["assistant"]["imagePullPolicy"] = json!("Never");
    agrees(&validator, &sandbox, false);
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
        "/spec/inferenceProviders/local/provider",
        "/spec/sandboxes",
        "/spec/sandboxes/assistant",
        "/spec/sandboxes/assistant/agent",
        "/spec/sandboxes/assistant/harness",
        "/spec/sandboxes/assistant/agent/inference",
        "/spec/sandboxes/assistant/agent/inference/routes/0/overrides/model",
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
        ("/spec/inferenceProviders/local", "serviceRef"),
        ("/spec", "services"),
    ] {
        let mut value = original.clone();
        value.pointer_mut(parent).unwrap()[key] = Value::Null;
        agrees(&validator, &value, false);
    }
}

#[test]
fn input_schema_preserves_defaults_strict_objects_and_opaque_route_settings() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let mut value = input("../crates/nemoclaw-sdk/tests/fixtures/config/inline-recipe.yaml");
    for key in ["endpoint", "engine", "networkCIDR"] {
        value["spec"]["gateway"]
            .as_object_mut()
            .unwrap()
            .remove(key);
    }
    for key in ["image", "network", "runtime"] {
        value["spec"]["sandboxes"]["assistant"]
            .as_object_mut()
            .unwrap()
            .remove(key);
    }
    for key in ["serving", "memory"] {
        value["spec"]["services"]["qwen"]
            .as_object_mut()
            .unwrap()
            .remove(key);
    }
    agrees(&validator, &value, true);
    value["spec"]["gateway"]["surprise"] = json!(true);
    agrees(&validator, &value, false);
    let mut value = input("fabric-pi.yaml");
    value
        .pointer_mut("/spec/sandboxes/assistant/agent/inference/routes/0/overrides")
        .unwrap()["settings"] = json!({});
    let path = "/spec/sandboxes/assistant/agent/inference/routes/0/overrides/settings";
    *value.pointer_mut(path).unwrap() = json!({"future": [null, {"value": null}]});
    agrees(&validator, &value, true);
    *value.pointer_mut(path).unwrap() = Value::Null;
    agrees(&validator, &value, false);
}

#[test]
fn every_example_is_accepted_and_round_trips_without_changing_intent() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples");
    let paths = examples::yaml_files(&directory);
    assert!(!paths.is_empty());
    for path in paths {
        let text = std::fs::read_to_string(&path).unwrap();
        let value: Value = serde_saphyr::from_str(&text).unwrap();
        agrees(&validator, &value, true);
        let document = Document::parse(text.as_bytes()).unwrap();
        let restored = Document::parse(document.yaml().unwrap().as_bytes()).unwrap();
        assert_eq!(restored, document, "{}", path.display());
        assert_eq!(restored.workspace(), document.workspace());
        assert_eq!(restored.digest(), document.digest());
    }
}

#[test]
fn schema_and_parser_enforce_choices_bounds_and_conditional_forms() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for (file, path, replacement, accepted) in [
        ("local.yaml", "/apiVersion", json!("future"), false),
        ("local.yaml", "/metadata/name", json!("UPPER"), false),
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
            true,
        ),
        (
            "local.yaml",
            "/spec/gateway/credential",
            json!({"env": "TOKEN"}),
            false,
        ),
        (
            "local.yaml",
            "/spec/gateway/runtime/provider",
            json!("podman"),
            true,
        ),
        (
            "local.yaml",
            "/spec/gateway/runtime/provider",
            json!("future"),
            false,
        ),
        (
            "managed-ollama.yaml",
            "/spec/services/ollama-server/image",
            json!("ollama/ollama:latest"),
            false,
        ),
        (
            "spark/vllm.yaml",
            "/spec/inferenceProviders/qwen/endpoint",
            json!("https://api.example.com/v1"),
            false,
        ),
        (
            "spark/vllm.yaml",
            "/spec/inferenceProviders/qwen/credential",
            json!({"env": "TOKEN"}),
            false,
        ),
        (
            "spark/vllm.yaml",
            "/spec/services/qwen/kind",
            json!("removed-backend"),
            false,
        ),
        (
            "spark/vllm.yaml",
            "/spec/services/qwen/serving/speculativeTokens",
            json!(1),
            false,
        ),
        (
            "spark/vllm.yaml",
            "/spec/services/qwen/serving/startupTimeoutSeconds",
            json!(0),
            true,
        ),
        (
            "spark/vllm.yaml",
            "/spec/services/qwen/serving/startupTimeoutSeconds",
            json!(59),
            false,
        ),
        (
            "spark/vllm.yaml",
            "/spec/services/qwen/serving/startupTimeoutSeconds",
            json!(60),
            true,
        ),
        (
            "spark/vllm.yaml",
            "/spec/services/qwen/serving/startupTimeoutSeconds",
            json!(3600),
            true,
        ),
        (
            "spark/vllm.yaml",
            "/spec/services/qwen/serving/startupTimeoutSeconds",
            json!(3601),
            false,
        ),
        (
            "spark/vllm.yaml",
            "/spec/services/qwen/memory/hostReserveGiB",
            json!(27),
            false,
        ),
        (
            "spark/vllm.yaml",
            "/spec/services/qwen/memory/hostReserveGiB",
            json!(0),
            true,
        ),
        (
            "spark/vllm.yaml",
            "/spec/sandboxes/assistant/harness/kind",
            json!("deepagents"),
            true,
        ),
        (
            "../crates/nemoclaw-sdk/tests/fixtures/config/inline-recipe.yaml",
            "/spec/services/qwen/recipe/apiVersion",
            json!("future"),
            false,
        ),
        (
            "../crates/nemoclaw-sdk/tests/fixtures/config/inline-recipe.yaml",
            "/spec/services/qwen/memory/gpuMemoryGiB",
            json!(16),
            false,
        ),
        (
            "../crates/nemoclaw-sdk/tests/fixtures/config/inline-recipe.yaml",
            "/spec/services/qwen/recipe/resources/preparedBytes",
            json!(0),
            false,
        ),
    ] {
        let mut value = input(file);
        let (parent, key) = path.rsplit_once('/').unwrap();
        value.pointer_mut(parent).unwrap()[key] = replacement;
        agrees_at(&validator, &value, accepted, file, path);
    }
    for field in ["placement", "publication"] {
        let mut value = input("spark/remote-vllm.yaml");
        value["spec"]["services"]["qwen"]
            .as_object_mut()
            .unwrap()
            .remove(field);
        agrees(&validator, &value, false);
    }
}

#[test]
fn the_host_reserve_floor_is_6_gib_on_dedicated_memory_and_28_on_unified_memory_or_a_recipe() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let reserve = |mut value: Value, service: &str, gib: i64| {
        value["spec"]["services"][service]["memory"]["hostReserveGiB"] = json!(gib);
        value
    };
    let with_hardware = |mut value: Value, service: &str, hardware: Value| {
        value["spec"]["services"][service]["hardware"] = hardware;
        value
    };
    let h100 = json!({"profile": "h100", "architecture": "amd64"});
    for (value, service) in [
        (
            with_hardware(input("spark/vllm.yaml"), "qwen", h100),
            "qwen",
        ),
        (input("nemotron-amd64.yaml"), "nemotron"),
        (
            with_hardware(
                input("managed-ollama.yaml"),
                "ollama-server",
                json!({"profile": "l4", "architecture": "amd64"}),
            ),
            "ollama-server",
        ),
    ] {
        agrees(&validator, &reserve(value.clone(), service, 6), true);
        agrees(&validator, &reserve(value, service, 5), false);
    }

    let mut dedicated_recipe = crate::support::fixture("inline-recipe.yaml");
    let compatibility =
        &mut dedicated_recipe["spec"]["services"]["qwen"]["recipe"]["compatibility"];
    compatibility["architecture"] = json!("amd64");
    compatibility["gpu"] = json!("NVIDIA H100 80GB HBM3");
    for (value, service) in [
        (input("spark/vllm.yaml"), "qwen"),
        (
            with_hardware(
                input("spark/vllm.yaml"),
                "qwen",
                json!({"profile": "rtx-spark"}),
            ),
            "qwen",
        ),
        (input("managed-ollama.yaml"), "ollama-server"),
        (crate::support::fixture("inline-recipe.yaml"), "qwen"),
        (dedicated_recipe, "qwen"),
    ] {
        let below = reserve(value.clone(), service, 6);
        agrees(&validator, &below, false);
        let error = Document::parse(below.to_string().as_bytes())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(&format!("spec.services.{service}.memory.hostReserveGiB"))
                && error.contains("between 28 and 64"),
            "{error}"
        );
        agrees(&validator, &reserve(value.clone(), service, 27), false);
        agrees(&validator, &reserve(value, service, 28), true);
    }
}

#[test]
fn defaulted_numeric_bounds_match_the_parser_at_each_boundary() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for (section, field, min, max) in [
        ("serving", "port", 1024, 65535),
        ("serving", "contextTokens", 8192, 65536),
        ("serving", "maxSequences", 1, 2),
        ("serving", "batchTokens", 512, 4096),
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
            let mut value = input("spark/vllm.yaml");
            let service = &mut value["spec"]["services"]["qwen"];
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
        ("local.yaml", "/spec/inferenceProviders", json!({})),
        (
            "local.yaml",
            "/spec/sandboxes/assistant/agent/inference/routes/0/providerRef",
            json!("foreign"),
        ),
        (
            "local.yaml",
            "/spec/gateway/endpoint",
            json!("http://remote.example.com"),
        ),
        (
            "spark/remote-vllm.yaml",
            "/spec/services/qwen/publication/endpoint",
            json!("http://10.0.0.8:9999/v1"),
        ),
        (
            "spark/vllm.yaml",
            "/spec/services/qwen/memory/freeGateGiB",
            json!(6),
        ),
        (
            "managed-ollama.yaml",
            "/spec/sandboxes/assistant/agent/inference/routes/0/overrides/model",
            json!("untagged"),
        ),
        (
            "spark/vllm.yaml",
            "/spec/gateway/runtime/provider",
            json!("podman"),
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

#[test]
fn example_discovery_includes_nested_yaml_and_yml_and_excludes_other_files() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("nested/deeper")).unwrap();
    let expected: std::collections::BTreeSet<_> = [
        "top.yaml",
        "top.yml",
        "nested/child.yaml",
        "nested/child.yml",
        "nested/deeper/leaf.yaml",
        "nested/deeper/leaf.yml",
    ]
    .map(|name| root.path().join(name))
    .into();
    for path in &expected {
        std::fs::write(path, "name: fixture\n").unwrap();
    }
    std::fs::write(root.path().join("nested/readme.md"), "not a deployment").unwrap();
    std::fs::write(root.path().join("nested/deeper/data.json"), "{}").unwrap();
    assert_eq!(
        examples::yaml_files(root.path())
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>(),
        expected
    );
}

/// Deployment and sandbox inference providers are maps keyed by name, like
/// the other definition collections; only a route's inline provider names
/// itself.
#[test]
fn inference_providers_are_keyed_by_name_in_both_scopes() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let mut keyed = input("local.yaml");
    keyed["spec"]["inferenceProviders"] =
        json!({"local": {"provider": "openai", "endpoint": "http://172.20.0.1:11436/v1"}});
    let sandbox = &mut keyed["spec"]["sandboxes"]["assistant"];
    sandbox["inferenceProviders"] = json!({"hosted": {
        "provider": "openai",
        "endpoint": "https://inference.example/v1",
        "credential": {"env": "HOSTED_API_KEY"}
    }});
    let inference = &mut sandbox["agent"]["inference"];
    inference["default"] = json!("primary");
    inference["routes"].as_array_mut().unwrap().push(json!({
        "name": "hosted", "providerRef": "hosted", "overrides": {"model": "hosted-model"}
    }));
    let document = Document::parse(keyed.to_string().as_bytes())
        .unwrap_or_else(|error| panic!("name-keyed providers: {error}"));
    agrees(&validator, &keyed, true);
    let exported: Value = serde_saphyr::from_str(&document.yaml().unwrap()).unwrap();
    for (scope, path, name) in [
        ("/spec", "spec", "local"),
        (
            "/spec/sandboxes/assistant",
            "spec.sandboxes.assistant",
            "hosted",
        ),
    ] {
        let pointer = format!("{scope}/inferenceProviders");
        assert_eq!(
            exported.pointer(&pointer),
            keyed.pointer(&pointer),
            "{pointer}"
        );

        let mut listed = keyed.clone();
        let mut provider = keyed.pointer(&format!("{pointer}/{name}")).unwrap().clone();
        provider["name"] = json!(name);
        *listed.pointer_mut(&pointer).unwrap() = json!([provider]);
        agrees(&validator, &listed, false);

        let mut named = keyed.clone();
        named.pointer_mut(&format!("{pointer}/{name}")).unwrap()["name"] = json!(name);
        agrees(&validator, &named, false);

        for key in ["PRIVATE-KEY", "9local", "local_model", &"a".repeat(41)] {
            let mut renamed = keyed.clone();
            let providers = renamed
                .pointer_mut(&pointer)
                .unwrap()
                .as_object_mut()
                .unwrap();
            let provider = providers.remove(name).unwrap();
            providers.insert(key.into(), provider);
            agrees(&validator, &renamed, false);
            let error = Document::parse(renamed.to_string().as_bytes())
                .unwrap_err()
                .to_string();
            assert!(!error.contains("PRIVATE-KEY"), "{error}");
        }

        let mut endpoint = keyed.clone();
        endpoint.pointer_mut(&format!("{pointer}/{name}")).unwrap()["endpoint"] =
            json!("ftp://inference.example");
        let error = Document::parse(endpoint.to_string().as_bytes())
            .unwrap_err()
            .to_string();
        let field = format!("{path}.inferenceProviders.{name}.endpoint");
        assert!(error.contains(&field), "{field}: {error}");
    }

    // The schema cannot compare scopes; the parser rejects a sandbox name
    // that shadows a deployment name.
    let mut shadow = keyed.clone();
    shadow["spec"]["sandboxes"]["assistant"]["inferenceProviders"]["local"] =
        keyed["spec"]["inferenceProviders"]["local"].clone();
    assert!(validator.is_valid(&shadow));
    let error = Document::parse(shadow.to_string().as_bytes())
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("spec.sandboxes[assistant].inferenceProviders[local]")
            && error.contains("shadow"),
        "{error}"
    );

    // A route's inline provider still carries the name its registration uses.
    let mut inline = keyed.clone();
    let route = &mut inline["spec"]["sandboxes"]["assistant"]["agent"]["inference"]["routes"][1];
    route.as_object_mut().unwrap().remove("providerRef");
    route["provider"] =
        keyed["spec"]["sandboxes"]["assistant"]["inferenceProviders"]["hosted"].clone();
    route["provider"]["name"] = json!("inline");
    inline["spec"]["sandboxes"]["assistant"]
        .as_object_mut()
        .unwrap()
        .remove("inferenceProviders");
    agrees(&validator, &inline, true);
    inline["spec"]["sandboxes"]["assistant"]["agent"]["inference"]["routes"][1]["provider"]
        .as_object_mut()
        .unwrap()
        .remove("name");
    agrees(&validator, &inline, false);
}

/// Sandboxes are a map keyed by name, like the other definition collections;
/// the key is the sandbox's only name.
#[test]
fn sandboxes_are_keyed_by_name() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let sandbox = json!({
        "network": {"tier": "isolated"},
        "harness": {"kind": "nvidia.fabric.openclaw"},
        "agent": {"name": "main", "inference": {"routes": [
            {"name": "primary", "providerRef": "local", "overrides": {"model": "qwen3.5:0.8b"}}
        ]}}
    });
    let with = |sandboxes: Value| {
        let mut value = input("local.yaml");
        value["spec"]["sandboxes"] = sandboxes;
        value
    };
    let keyed = with(json!({"reviewer": sandbox, "assistant": sandbox}));
    let document = Document::parse(keyed.to_string().as_bytes())
        .unwrap_or_else(|error| panic!("name-keyed sandboxes: {error}"));
    agrees(&validator, &keyed, true);
    let exported: Value = serde_saphyr::from_str(&document.yaml().unwrap()).unwrap();
    assert_eq!(
        exported["spec"]["sandboxes"]
            .as_object()
            .map(|sandboxes| sandboxes.keys().map(String::as_str).collect::<Vec<_>>()),
        Some(vec!["assistant", "reviewer"])
    );

    let mut named = sandbox.clone();
    named["name"] = json!("assistant");
    agrees(&validator, &with(json!([named])), false);
    agrees(&validator, &with(json!({"assistant": named})), false);

    for key in ["PRIVATE-KEY", "9assistant", "my_assistant", &"a".repeat(41)] {
        let renamed = with(json!({key: sandbox}));
        agrees(&validator, &renamed, false);
        let error = Document::parse(renamed.to_string().as_bytes())
            .unwrap_err()
            .to_string();
        assert!(!error.contains("PRIVATE-KEY"), "{error}");
    }

    let count = |count: usize| {
        with(Value::Object(
            (0..count)
                .map(|index| (format!("sandbox-{index}"), sandbox.clone()))
                .collect(),
        ))
    };
    agrees(&validator, &count(0), false);
    agrees(&validator, &count(32), true);
    agrees(&validator, &count(33), false);

    // Schema errors name a valid sandbox key.
    let mut invalid = keyed.clone();
    invalid["spec"]["sandboxes"]["reviewer"]["agent"]["name"] = json!("Main");
    let error = Document::parse(invalid.to_string().as_bytes())
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("spec.sandboxes.reviewer.agent.name"),
        "{error}"
    );
}

#[test]
fn every_sandbox_requires_one_agent() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let value = input("local.yaml");
    agrees(&validator, &value, true);
    let mut missing = value.clone();
    missing["spec"]["sandboxes"]["assistant"]
        .as_object_mut()
        .unwrap()
        .remove("agent");
    agrees(&validator, &missing, false);
}

#[test]
fn gateway_variants_reject_fields_owned_by_the_other_mode() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for (field, value) in [
        ("networkCIDR", json!("")),
        ("imagePullPolicy", json!("Never")),
    ] {
        let mut external = input("local.yaml");
        external["spec"]["gateway"][field] = value;
        agrees(&validator, &external, false);
    }
    for (field, value) in [
        ("credential", json!({"env": "TOKEN"})),
        (
            "tls",
            json!({"ca": {"env": "CA"}, "certificate": {"env": "CERT"}, "key": {"env": "KEY"}}),
        ),
    ] {
        let mut managed = input("../crates/nemoclaw-sdk/tests/fixtures/config/inline-recipe.yaml");
        managed["spec"]["gateway"][field] = value;
        agrees(&validator, &managed, false);
    }
}

/// The SDK owns the gateway image pin, so editors and generated references
/// never offer a digest that a later SDK would reject.
#[test]
fn the_input_schema_names_no_gateway_image_pin() {
    assert!(!input_schema().to_string().contains(DEFAULT_GATEWAY_IMAGE));
}

#[test]
fn a_gateway_image_is_rejected_as_an_unknown_field() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for (file, image) in [
        ("spark/vllm.yaml", json!(DEFAULT_GATEWAY_IMAGE)),
        ("managed-podman.yaml", json!("")),
        (
            "kubernetes/managed-development.yaml",
            json!(DEFAULT_GATEWAY_IMAGE),
        ),
        ("local.yaml", json!("")),
    ] {
        let mut value = input(file);
        value["spec"]["gateway"]["image"] = image;
        agrees_at(&validator, &value, false, file, "/spec/gateway/image");
        let error = Document::parse(value.to_string().as_bytes())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("at spec.gateway") && error.ends_with("unknown fields are not allowed"),
            "{file}: {error}"
        );
    }
}

#[test]
fn a_sandbox_cannot_choose_a_runtime_apart_from_its_gateway() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let mut value = input("managed-podman.yaml");
    value["spec"]["sandboxes"]["assistant"]["runtime"] = json!({"provider": "docker"});
    agrees(&validator, &value, false);
}

#[test]
fn managed_podman_requires_an_explicit_engine() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let mut value = input("managed-podman.yaml");
    value["spec"]["gateway"]
        .as_object_mut()
        .unwrap()
        .remove("engine");
    agrees(&validator, &value, false);
    let error = Document::parse(value.to_string().as_bytes())
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("Podman requires spec.gateway.engine"),
        "{error}"
    );
    let mut document: Document = serde_json::from_value(value.clone()).unwrap();
    document.defaults();
    assert!(
        document
            .spec
            .gateway
            .as_managed()
            .unwrap()
            .engine
            .is_empty()
    );

    value["spec"]["gateway"]["engine"] = json!("");
    agrees(&validator, &value, false);
    let error = Document::parse(value.to_string().as_bytes())
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("schema at spec.gateway.engine (line")
            && error.contains("Podman requires spec.gateway.engine"),
        "{error}"
    );
}

#[test]
fn external_gateway_tls_takes_a_ca_alone_or_with_a_client_certificate_and_key() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let complete = input("kubernetes/external-gateway.yaml");
    agrees(&validator, &complete, true);
    let tls = complete["spec"]["gateway"]["tls"].clone();
    for (fields, accepted) in [
        (&["ca"][..], true),
        (&["ca", "certificate"][..], false),
        (&["ca", "key"][..], false),
        (&["certificate", "key"][..], false),
    ] {
        let mut value = complete.clone();
        value["spec"]["gateway"]["tls"] = fields
            .iter()
            .map(|field| (field.to_string(), tls[*field].clone()))
            .collect::<serde_json::Map<_, _>>()
            .into();
        agrees(&validator, &value, accepted);
    }
}

#[test]
fn ollama_and_vllm_services_state_the_same_placement_requirement() {
    let schema = input_schema();
    let service = |kind: &str| {
        schema["$defs"]["ServiceDefinition"]["oneOf"]
            .as_array()
            .unwrap()
            .iter()
            .find(|variant| variant["properties"]["kind"]["const"] == kind)
            .unwrap()
            .clone()
    };
    let (ollama, vllm) = (service("ollama"), service("vllm"));
    for field in ["placement", "publication"] {
        assert_eq!(
            ollama["properties"][field], vllm["properties"][field],
            "{field}"
        );
    }
}

#[test]
fn an_ollama_service_without_placement_is_refused_beside_podman_or_an_external_gateway() {
    let managed = input("managed-ollama.yaml");
    let mut podman = managed.clone();
    podman["spec"]["gateway"]["runtime"]["provider"] = json!("podman");
    let mut external = managed;
    external["spec"]["gateway"] = json!({
        "management": "external",
        "endpoint": "https://gateway.example.com",
    });
    for value in [podman, external] {
        let error = Document::parse(value.to_string().as_bytes())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(
                "Ollama requires the managed gateway Docker engine or explicit placement"
            ),
            "{error}"
        );
    }
}

#[test]
fn schema_errors_identify_the_contract_without_echoing_input_values_or_map_keys() {
    let mut value = input("fabric-openclaw.yaml");
    value["spec"]["harnesses"] = json!({"SECRET-MAP-KEY": {
        "kind": "openclaw", "execution": {"timeoutSeconds": 0}
    }});
    let error = Document::parse(value.to_string().as_bytes())
        .unwrap_err()
        .to_string();
    assert!(error.contains("schema"), "{error}");
    assert!(!error.contains("SECRET-MAP-KEY"), "{error}");
}

#[test]
fn schema_patterns_reject_trailing_newlines_in_identifiers_and_pins() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for (file, path) in [
        ("local.yaml", "/metadata/name"),
        ("local.yaml", "/metadata/uid"),
        ("local.yaml", "/spec/sandboxes/assistant/agent/name"),
        (
            "local.yaml",
            "/spec/sandboxes/assistant/agent/inference/routes/0/overrides/model",
        ),
        ("spark/vllm.yaml", "/spec/services/qwen/image"),
        (
            "managed-ollama.yaml",
            "/spec/services/ollama-server/model/digest",
        ),
    ] {
        let mut value = input(file);
        let target = value.pointer_mut(path).unwrap();
        *target = json!(format!("{}\n", target.as_str().unwrap()));
        agrees_at(&validator, &value, false, file, path);
    }
}

/// Collect every `pattern` keyword in a schema with its JSON pointer.
fn schema_patterns(value: &Value, pointer: &str, found: &mut Vec<(String, String)>) {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                let path = format!("{pointer}/{key}");
                if key == "pattern"
                    && let Some(pattern) = child.as_str()
                {
                    found.push((path, pattern.to_owned()));
                } else {
                    schema_patterns(child, &path, found);
                }
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                schema_patterns(child, &format!("{pointer}/{index}"), found);
            }
        }
        _ => {}
    }
}

#[test]
fn schema_patterns_use_syntax_that_re2_validators_compile() {
    let mut patterns = Vec::new();
    schema_patterns(&input_schema(), "", &mut patterns);
    assert!(
        patterns.len() > 50,
        "found only {} patterns",
        patterns.len()
    );
    // The regex crate shares RE2's syntax limits: no lookaround or backreferences.
    let unsupported: Vec<_> = patterns
        .iter()
        .filter(|(_, pattern)| regex::Regex::new(pattern).is_err())
        .collect();
    assert!(unsupported.is_empty(), "{unsupported:#?}");
}

#[test]
fn an_end_anchored_pattern_rejects_a_trailing_newline() {
    let managed = input("kubernetes/managed-development.yaml");
    Document::parse(managed.to_string().as_bytes()).unwrap();
    for pointer in [
        "/metadata/uid",
        "/spec/gateway/endpoint",
        "/spec/gateway/kubernetes/context",
        "/spec/gateway/kubernetes/namespace",
    ] {
        let mut value = managed.clone();
        let field = value.pointer_mut(pointer).unwrap();
        *field = json!(format!("{}\n", field.as_str().unwrap()));
        assert!(
            Document::parse(value.to_string().as_bytes()).is_err(),
            "accepted a trailing newline at {pointer}"
        );
    }
    let mut value = managed;
    value["spec"]["gateway"]["kubernetes"]["imagePullSecrets"] = json!(["registry-login\n"]);
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
}

#[test]
fn metadata_uid_accepts_either_case_and_keeps_it_lowercase() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let lower = "5f0b6e1c-3a2d-4b8e-9c7f-1a2b3c4d5e6f";
    let mut value = input("openclaw.yaml");
    value["metadata"]["uid"] = json!(lower.to_uppercase());
    agrees(&validator, &value, true);
    let upper = Document::parse(value.to_string().as_bytes()).unwrap();
    assert_eq!(upper.metadata.uid, lower);
    value["metadata"]["uid"] = json!(lower);
    let same = Document::parse(value.to_string().as_bytes()).unwrap();
    assert_eq!(upper, same);
    assert_eq!(upper.workspace(), same.workspace());

    // A value built in Rust is checked after defaults, which store the UUID lowercase.
    let mut direct = same.clone();
    direct.metadata.uid = lower.to_uppercase();
    assert!(direct.validate().is_err());
    direct.defaults();
    assert_eq!(direct, same);
    direct.validate().unwrap();
}

#[test]
fn a_model_containers_gpu_is_one_uuid_or_index_in_the_schema_and_the_parser() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for (file, service) in [
        ("spark/vllm.yaml", "qwen"),
        ("managed-ollama.yaml", "ollama-server"),
    ] {
        for (gpu, accepted) in [
            (json!("0"), true),
            (json!("12"), true),
            (json!("GPU-79b44e99-d10d-a381-8cd6-5ccb073eaea3"), true),
            (json!("all"), false),
            (json!(""), false),
            (json!("device=0"), false),
            (json!("0,1"), false),
            (json!("01"), false),
            (json!(" 0"), false),
            (json!("1000"), false),
            (json!("GPU-79B44E99-D10D-A381-8CD6-5CCB073EAEA3"), false),
            (json!("GPU-79b44e99"), false),
            (json!("MIG-79b44e99-d10d-a381-8cd6-5ccb073eaea3"), false),
            (json!(0), false),
        ] {
            let mut value = input(file);
            value["spec"]["services"][service]["container"]["gpu"] = gpu.clone();
            agrees(&validator, &value, accepted);
        }
    }
}

#[test]
fn service_exposures_take_a_port_and_an_authorization_mode_openshell_accepts() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let mut value = input("fabric-openclaw.yaml");
    let set = |value: &mut Value, exposures: Value| {
        value["spec"]["sandboxes"]["assistant"]["serviceExposures"] = exposures;
    };
    let many: serde_json::Map<String, Value> = (0..33)
        .map(|index| (format!("s{index}"), json!({"targetPort": 8000 + index})))
        .collect();
    let mut at_most: serde_json::Map<String, Value> = many.clone();
    at_most.remove("s32");
    for accepted in [
        json!({"dashboard": {"targetPort": 18800}}),
        json!({"": {"targetPort": 65535, "authorizationMode": "STRIP"}}),
        json!({"api": {"targetPort": 1, "authorizationMode": "BEARER_PASSTHROUGH"}}),
        Value::Object(at_most),
    ] {
        set(&mut value, accepted);
        agrees(&validator, &value, true);
    }
    for rejected in [
        json!({"dashboard": {"targetPort": 0}}),
        json!({"dashboard": {"targetPort": 65536}}),
        json!({"dashboard": {"targetPort": "80"}}),
        json!({"dashboard": {"targetPort": 80, "authorizationMode": "OPEN"}}),
        json!({"dashboard": {"targetPort": 80, "surprise": true}}),
        json!({"dashboard": {}}),
        json!([{"name": "dashboard", "targetPort": 80}]),
        Value::Object(many),
    ] {
        set(&mut value, rejected);
        agrees(&validator, &value, false);
    }
}
