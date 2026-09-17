// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::{Document, validate_endpoint};
use serde_json::Value;

#[test]
fn all_recipes_preserve_defaults_digest_workspace_and_round_trip() {
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/config");
    for entry in std::fs::read_dir(&fixtures).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().unwrap() != "yaml" {
            continue;
        }
        let input = std::fs::read_to_string(&path).unwrap();
        let expected: Value =
            serde_json::from_slice(&std::fs::read(path.with_extension("yaml.json")).unwrap())
                .unwrap();
        let document = Document::parse(input.as_bytes()).unwrap();
        assert_eq!(
            serde_json::to_value(&document).unwrap(),
            expected["document"],
            "{}",
            path.display()
        );
        assert_eq!(document.digest(), expected["digest"].as_str().unwrap());
        assert_eq!(
            document.workspace(),
            expected["workspace"].as_str().unwrap()
        );
        assert_eq!(
            document.inference_endpoint().unwrap(),
            expected["endpoint"].as_str().unwrap()
        );
        assert_eq!(
            Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
            document
        );
    }
}
#[test]
fn unsafe_yaml_and_secret_values_are_rejected_without_echoing_input() {
    let base = include_str!("fixtures/config/local.yaml");
    let changes = [
        (
            "management: external",
            "management: external\n    surprise: secret-do-not-print",
        ),
        (
            "provider: openai",
            "provider: openai\n      apiKey: secret-do-not-print",
        ),
        ("name: local-agent", "name: local-agent\n  name: second"),
        ("name: local-agent", "name: &name local-agent"),
        ("management: external", "management: null"),
        ("providerRef: local", "providerRef: foreign"),
        (
            "model: qwen3.5:0.8b",
            "model: '${file(\"secret-do-not-print\")}'",
        ),
        ("provider: docker", "provider: unsupported"),
        ("kind: openclaw", "kind: unknown"),
    ];
    for (from, to) in changes {
        let error = Document::parse(base.replace(from, to).as_bytes()).unwrap_err();
        assert!(!error.to_string().contains("secret-do-not-print"));
    }
    assert!(Document::parse(format!("{base}\n---\nkind: NemoClawConfig\n").as_bytes()).is_err());
    assert!(Document::parse(vec![b' '; (1 << 20) + 1].as_slice()).is_err());
}
#[test]
fn endpoint_policy_rejects_credentials_metadata_and_remote_plaintext() {
    for endpoint in [
        "http://169.254.169.254/v1",
        "http://example.com/v1",
        "https://user:secret@example.com/v1",
        "https://example.com/v1?key=secret",
        "https://[fe80::1]/v1",
        "http://0.0.0.0:1",
        "file:///etc/passwd",
        "https://metadata.google.internal/",
    ] {
        assert!(validate_endpoint(endpoint, false).is_err(), "{endpoint}");
    }
    for endpoint in [
        "http://127.0.0.1:11434/v1",
        "http://172.20.0.1:11436/v1",
        "https://api.example.com/v1",
    ] {
        assert!(validate_endpoint(endpoint, false).is_ok());
    }
    assert!(validate_endpoint("http://172.20.0.1:17671", true).is_err());
}

#[test]
fn managed_defaults_and_safety_bounds_match_the_qualified_recipe() {
    let original = Document::parse(include_str!("fixtures/config/spark.yaml").as_bytes()).unwrap();
    let mut defaulted = original.clone();
    defaulted.spec.gateway.endpoint.clear();
    defaulted.spec.gateway.engine.clear();
    defaulted.spec.gateway.image.clear();
    defaulted.spec.inference_providers[0]
        .service
        .as_mut()
        .unwrap()
        .serving = Default::default();
    defaulted.spec.inference_providers[0]
        .service
        .as_mut()
        .unwrap()
        .memory = Default::default();
    defaulted.spec.sandboxes[0].image.ref_.clear();
    defaulted.spec.sandboxes[0].runtime.provider.clear();
    defaulted.spec.sandboxes[0].network.tier.clear();
    defaulted.defaults();
    assert_eq!(defaulted, original);
    for timeout in [0, 59, 3601] {
        let mut changed = original.clone();
        changed.spec.inference_providers[0]
            .service
            .as_mut()
            .unwrap()
            .serving
            .startup_timeout_seconds = timeout;
        assert!(changed.validate().is_err());
    }
    let mut changed = original.clone();
    changed.spec.inference_providers[0].endpoint = "http://127.0.0.1:18888/v1".into();
    assert!(changed.validate().is_err());
    let mut changed = original;
    changed.spec.inference_providers[0]
        .service
        .as_mut()
        .unwrap()
        .memory
        .host_reserve_gib = 1;
    assert!(changed.validate().is_err());
}

#[test]
fn fabric_protocol_and_managed_ollama_constraints_survive_the_port() {
    let original = Document::parse(include_str!("fixtures/config/fabric.yaml").as_bytes()).unwrap();
    for harness in [
        "deepagents",
        "hermes",
        "openclaw",
        "claude",
        "codex",
        "mini-swe-agent",
        "nooa",
        "nooa-bench",
        "remote-agent",
        "pi",
    ] {
        let mut document = original.clone();
        document.spec.sandboxes[0].harness.as_mut().unwrap().kind = harness.into();
        document.spec.inference_providers[0].provider = if harness == "claude" {
            "anthropic"
        } else {
            "openai"
        }
        .into();
        assert!(document.validate().is_ok());
        assert_eq!(
            document
                .sandbox_harness(&document.spec.sandboxes[0])
                .unwrap()
                .runtime(),
            format!("fabric-{harness}")
        );
    }
    let mut wrong = original;
    wrong.spec.sandboxes[0].harness.as_mut().unwrap().kind = "claude".into();
    assert!(wrong.validate().is_err());
    let base = include_str!("fixtures/config/managed-ollama.yaml");
    for (from, to) in [
        ("unix:///var/run/docker.sock", "tcp://127.0.0.1:2375"),
        ("172.20.0.1:11436", "0.0.0.0:11436"),
        ("172.20.0.1:11436", "172.20.0.1"),
        ("qwen3:0.6b", "qwen3"),
    ] {
        assert!(Document::parse(base.replace(from, to).as_bytes()).is_err());
    }
}

#[test]
fn openclaw_uses_only_fabric_with_external_or_managed_dependencies() {
    for input in [
        include_str!("fixtures/config/local.yaml"),
        include_str!("fixtures/config/spark.yaml"),
        include_str!("fixtures/config/managed-ollama.yaml"),
    ] {
        let mut document = Document::parse(input.as_bytes()).unwrap();
        document.spec.sandboxes[0].harness.as_mut().unwrap().kind = "openclaw".into();
        document.spec.sandboxes[0].image.ref_.clear();
        document.defaults();
        document.validate().unwrap();
        assert!(
            document.spec.sandboxes[0]
                .image
                .ref_
                .starts_with("nc-multi-models@sha256:")
        );
        assert_eq!(
            document
                .sandbox_harness(&document.spec.sandboxes[0])
                .unwrap()
                .runtime(),
            "fabric-openclaw"
        );
        document.spec.sandboxes[0]
            .harness
            .as_mut()
            .unwrap()
            .kind
            .clear();
        assert!(document.validate().is_err(), "a harness must be declared");
    }
}

#[test]
fn sandbox_harness_is_the_only_implementation_selector() {
    let input = include_str!("fixtures/config/local.yaml");
    let document = Document::parse(input.as_bytes()).unwrap();
    assert_eq!(
        document
            .sandbox_harness(&document.spec.sandboxes[0])
            .unwrap()
            .runtime(),
        "fabric-openclaw"
    );
    assert!(!document.yaml().unwrap().contains("type:"));
    for field in ["type: fabric", "type: openclaw"] {
        let legacy = input.replace(
            "kind: openclaw",
            &format!("{field}\n          kind: openclaw"),
        );
        assert!(Document::parse(legacy.as_bytes()).is_err());
    }
    for invalid in ["", "unknown"] {
        let changed = input.replace("kind: openclaw", &format!("kind: '{invalid}'"));
        assert!(Document::parse(changed.as_bytes()).is_err());
    }
}

#[test]
fn pi_preserves_yaml_model_ids_and_explicit_custom_metadata() {
    let input = include_str!("fixtures/config/fabric-pi.yaml");
    let custom = Document::parse(input.as_bytes()).unwrap();
    for name in ["qwen3:4b", "my-custom-model", "gpt-4o-mini"] {
        let mut document = custom.clone();
        document.spec.sandboxes[0].agents[0]
            .inference
            .as_mut()
            .unwrap()
            .routes[0]
            .overrides
            .model = name.into();
        document.validate().unwrap();
        let yaml = document.yaml().unwrap();
        assert_eq!(Document::parse(yaml.as_bytes()).unwrap(), document);
    }
    let mut catalog = custom;
    let route = &mut catalog.spec.sandboxes[0].agents[0]
        .inference
        .as_mut()
        .unwrap()
        .routes[0];
    route.overrides.model = "gpt-4o-mini".into();
    route.overrides.pi_model = None;
    catalog.validate().unwrap();
    assert!(Document::parse(input.replace("kind: pi", "kind: codex").as_bytes()).is_err());
}

#[test]
fn pi_model_is_an_optional_opaque_object() {
    let mut tree: Value = serde_json::to_value(
        Document::parse(include_str!("fixtures/config/fabric-pi.yaml").as_bytes()).unwrap(),
    )
    .unwrap();
    let opaque = serde_json::json!({"contextWindow": "Pi validates this", "futureOption": {"nested": [null, 7, true]}, "thinkingLevelMap": {"off": null}});
    tree["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"][0]["overrides"]["piModel"] =
        opaque.clone();
    let parsed = Document::parse(tree.to_string().as_bytes()).unwrap();
    assert_eq!(
        serde_json::to_value(&parsed).unwrap()["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"]
            [0]["overrides"]["piModel"],
        opaque
    );
    assert_eq!(
        Document::parse(parsed.yaml().unwrap().as_bytes()).unwrap(),
        parsed
    );
    for invalid in [
        serde_json::json!("text"),
        serde_json::json!([]),
        serde_json::json!(7),
        Value::Null,
    ] {
        tree["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"][0]["overrides"]["piModel"] =
            invalid;
        assert!(Document::parse(tree.to_string().as_bytes()).is_err());
    }
}

#[test]
fn pi_model_updates_leave_the_sandbox_connection_unchanged() {
    use nemoclaw_sdk::compile::{Generations, targets};
    let mut document =
        Document::parse(include_str!("fixtures/config/fabric-pi.yaml").as_bytes()).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|name| (name.into(), "a".repeat(32)))
        .into();
    let before = targets(&document, &generations).unwrap();
    document.spec.sandboxes[0].agents[0]
        .inference
        .as_mut()
        .unwrap()
        .routes[0]
        .overrides
        .model = "another-custom-model".into();
    assert_eq!(targets(&document, &generations).unwrap(), before);
}

#[test]
fn harness_selection_does_not_determine_service_ownership() {
    for harness in [
        "openclaw",
        "hermes",
        "deepagents",
        "codex",
        "mini-swe-agent",
        "nooa",
        "nooa-bench",
        "remote-agent",
        "pi",
    ] {
        for fixture in [
            include_str!("../../../examples/vllm.yaml"),
            include_str!("fixtures/config/managed-ollama.yaml"),
        ] {
            let mut document = Document::parse(fixture.as_bytes()).unwrap();
            document.spec.sandboxes[0].harness.as_mut().unwrap().kind = harness.into();
            assert!(
                document.validate().is_ok(),
                "{harness}: {:?}",
                document.validate()
            );
        }
    }
    let mut claude =
        Document::parse(include_str!("../../../examples/vllm.yaml").as_bytes()).unwrap();
    claude.spec.sandboxes[0].harness.as_mut().unwrap().kind = "claude".into();
    assert!(
        claude.validate().is_err(),
        "managed vLLM still requires a compatible API"
    );
    claude.spec.inference_providers[0].provider = "anthropic".into();
    assert!(
        claude.validate().is_ok(),
        "ownership does not imply API compatibility of the actual server"
    );
    let mut external =
        Document::parse(include_str!("fixtures/config/fabric-claude.yaml").as_bytes()).unwrap();
    external.spec.gateway = claude.spec.gateway;
    assert!(
        external.validate().is_ok(),
        "gateway ownership is independent of the harness"
    );
}
