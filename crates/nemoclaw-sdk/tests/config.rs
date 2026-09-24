// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::{HarnessKind, InferenceProviderKind};

use nemoclaw_sdk::config::{Document, ServiceDefinition, validate_endpoint};
use serde_json::Value;

#[test]
fn exporting_and_reparsing_preserves_intent_identity_and_connections() {
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/config");
    let mut checked = 0;
    for entry in std::fs::read_dir(fixtures).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|extension| extension != "yaml") {
            continue;
        }
        let document = Document::parse(std::fs::File::open(&path).unwrap()).unwrap();
        let workspace = document.workspace();
        let digest = document.digest();
        let connection = document.inference_connection().unwrap();
        let restored = Document::parse(document.yaml().unwrap().as_bytes()).unwrap();
        assert_eq!(restored, document, "{}", path.display());
        assert_eq!(restored.workspace(), workspace);
        assert_eq!(restored.digest(), digest);
        assert_eq!(restored.inference_connection().unwrap(), connection);
        checked += 1;
    }
    assert!(checked > 0);
}

#[test]
fn ownership_identity_depends_on_uid_while_intent_tracks_configuration() {
    let mut document =
        Document::parse(include_str!("fixtures/config/local.yaml").as_bytes()).unwrap();
    document.metadata.name = "before".into();
    let mut renamed = document.clone();
    renamed.metadata.name = "after".into();
    renamed.validate().unwrap();
    assert_ne!(renamed.digest(), document.digest());
    assert_eq!(renamed.workspace(), document.workspace());
    let mut independent = document.clone();
    independent.metadata.uid.pop();
    independent
        .metadata
        .uid
        .push(if document.metadata.uid.ends_with('0') {
            '1'
        } else {
            '0'
        });
    independent.validate().unwrap();
    assert_ne!(independent.workspace(), document.workspace());
    assert_ne!(independent.digest(), document.digest());
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
        ("kind: nvidia.fabric.openclaw", "kind: ' '"),
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
    let mut original =
        Document::parse(include_str!("fixtures/config/spark.yaml").as_bytes()).unwrap();
    original.spec.sandboxes[0].image.ref_ = nemoclaw_sdk::config::DEFAULT_AGENT_IMAGE.into();
    let mut defaulted = original.clone();
    defaulted.spec.gateway.endpoint_mut().clear();
    defaulted
        .spec
        .gateway
        .as_managed_mut()
        .unwrap()
        .engine
        .clear();
    defaulted
        .spec
        .gateway
        .as_managed_mut()
        .unwrap()
        .image
        .clear();
    let ServiceDefinition::Vllm(service) = defaulted.spec.services.get_mut("qwen").unwrap() else {
        panic!("expected vLLM service");
    };
    service.serving = Default::default();
    service.memory = Default::default();
    defaulted.spec.sandboxes[0].image.ref_.clear();
    defaulted.spec.sandboxes[0].runtime = Default::default();
    defaulted.spec.sandboxes[0].network.policy = Default::default();
    defaulted.defaults();
    assert_eq!(defaulted, original);
    for timeout in [0, 59, 3601] {
        let mut changed = original.clone();
        let ServiceDefinition::Vllm(service) = changed.spec.services.get_mut("qwen").unwrap()
        else {
            panic!("expected vLLM service");
        };
        service.serving.startup_timeout_seconds = timeout;
        assert!(changed.validate().is_err());
    }
    let mut changed = original.clone();
    changed.spec.inference_providers[0].endpoint = "http://127.0.0.1:18888/v1".into();
    assert!(changed.validate().is_err());
    let mut changed = original;
    let ServiceDefinition::Vllm(service) = changed.spec.services.get_mut("qwen").unwrap() else {
        panic!("expected vLLM service");
    };
    service.memory.host_reserve_gib = 1;
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
        document.spec.sandboxes[0].harness.as_mut().unwrap().kind = harness.parse().unwrap();
        document.spec.inference_providers[0].provider = if harness == "claude" {
            nemoclaw_sdk::config::InferenceProviderKind::Anthropic
        } else {
            nemoclaw_sdk::config::InferenceProviderKind::Openai
        };
        assert!(document.validate().is_ok());
        assert_eq!(
            document
                .sandbox_harness(&document.spec.sandboxes[0])
                .unwrap()
                .runtime(),
            "fabric"
        );
    }
    let mut wrong = original;
    wrong.spec.sandboxes[0].harness.as_mut().unwrap().kind =
        "nvidia.fabric.claude".parse().unwrap();
    assert!(wrong.validate().is_ok());
    let base = include_str!("fixtures/config/managed-ollama.yaml");
    for (from, to) in [
        ("unix:///var/run/docker.sock", "tcp://127.0.0.1:2375"),
        (
            "nc-prototype-ollama@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "ollama/ollama:latest",
        ),
        (
            "7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435",
            "7DF6B6E09427A769808717C0A93CADC4AE99ED4EB8BF5CA557C90846BECEA435",
        ),
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
        document.spec.sandboxes[0].harness.as_mut().unwrap().kind =
            "nvidia.fabric.openclaw".parse().unwrap();
        document.spec.sandboxes[0].image.ref_.clear();
        document.defaults();
        document.validate().unwrap();
        assert_eq!(
            document.spec.sandboxes[0].image.ref_,
            nemoclaw_sdk::config::DEFAULT_AGENT_IMAGE
        );
        assert_eq!(
            document
                .sandbox_harness(&document.spec.sandboxes[0])
                .unwrap()
                .runtime(),
            "fabric"
        );
        let mut input = serde_json::to_value(&document).unwrap();
        input["spec"]["sandboxes"][0]["harness"]["kind"] = serde_json::json!("");
        assert!(
            Document::parse(input.to_string().as_bytes()).is_err(),
            "a harness must be declared"
        );
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
        "fabric"
    );
    assert!(!document.yaml().unwrap().contains("type:"));
    for field in ["type: fabric", "type: openclaw"] {
        let legacy = input.replace(
            "kind: nvidia.fabric.openclaw",
            &format!("{field}\n          kind: openclaw"),
        );
        assert!(Document::parse(legacy.as_bytes()).is_err());
    }
    for invalid in ["", " "] {
        let changed = input.replace(
            "kind: nvidia.fabric.openclaw",
            &format!("kind: '{invalid}'"),
        );
        assert!(Document::parse(changed.as_bytes()).is_err());
    }
}

#[test]
fn pi_preserves_yaml_model_ids_and_explicit_custom_metadata() {
    let input = include_str!("fixtures/config/fabric-pi.yaml");
    let custom = Document::parse(input.as_bytes()).unwrap();
    for name in ["qwen3:4b", "my-custom-model", "gpt-4o-mini"] {
        let mut document = custom.clone();
        document.spec.sandboxes[0]
            .agent
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
    let route = &mut catalog.spec.sandboxes[0]
        .agent
        .inference
        .as_mut()
        .unwrap()
        .routes[0];
    route.overrides.model = "gpt-4o-mini".into();
    route.overrides.settings = None;
    catalog.validate().unwrap();
    assert!(Document::parse(input.replace("kind: pi", "kind: codex").as_bytes()).is_ok());
}

#[test]
fn pi_model_is_an_optional_opaque_object() {
    let mut tree: Value = serde_json::to_value(
        Document::parse(include_str!("fixtures/config/fabric-pi.yaml").as_bytes()).unwrap(),
    )
    .unwrap();
    let opaque = serde_json::json!({"contextWindow": "Pi validates this", "futureOption": {"nested": [null, 7, true]}, "thinkingLevelMap": {"off": null}});
    tree["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["overrides"]["settings"]["model_metadata"] =
        opaque.clone();
    let parsed = Document::parse(tree.to_string().as_bytes()).unwrap();
    assert_eq!(
        serde_json::to_value(&parsed).unwrap()["spec"]["sandboxes"][0]["agent"]["inference"]["routes"]
            [0]["overrides"]["settings"]["model_metadata"],
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
        tree["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["overrides"]["settings"] =
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
    document.spec.sandboxes[0]
        .agent
        .inference
        .as_mut()
        .unwrap()
        .routes[0]
        .overrides
        .model = "another-custom-model".into();
    let mut after = targets(&document, &generations).unwrap();
    let configuration = after
        .iter_mut()
        .find(|target| target.kind == "agent_configuration")
        .unwrap();
    let model: Value = serde_json::from_str(&configuration.values["config_json"]).unwrap();
    assert_eq!(model["models"]["default"]["model"], "another-custom-model");
    let prior = before
        .iter()
        .find(|target| target.address == configuration.address)
        .unwrap();
    configuration
        .values
        .insert("config_json".into(), prior.values["config_json"].clone());
    assert_eq!(after, before);
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
            include_str!("../../../examples/spark/vllm.yaml"),
            include_str!("fixtures/config/managed-ollama.yaml"),
        ] {
            let mut document = Document::parse(fixture.as_bytes()).unwrap();
            document.spec.sandboxes[0].harness.as_mut().unwrap().kind = harness.parse().unwrap();
            assert!(
                document.validate().is_ok(),
                "{harness}: {:?}",
                document.validate()
            );
        }
    }
    let mut claude =
        Document::parse(include_str!("../../../examples/spark/vllm.yaml").as_bytes()).unwrap();
    claude.spec.sandboxes[0].harness.as_mut().unwrap().kind =
        "nvidia.fabric.claude".parse().unwrap();
    assert!(
        claude.validate().is_ok(),
        "harness identity does not change the provider's protocol default"
    );
    claude.spec.inference_providers[0].provider = InferenceProviderKind::Anthropic;
    assert!(
        claude.validate().is_err(),
        "managed vLLM exposes the OpenAI API regardless of harness ownership"
    );
    let mut external =
        Document::parse(include_str!("fixtures/config/fabric-claude.yaml").as_bytes()).unwrap();
    external.spec.gateway = claude.spec.gateway;
    assert!(
        external.validate().is_ok(),
        "gateway ownership is independent of the harness"
    );
}

#[test]
fn external_gateways_reject_installation_fields_even_when_empty() {
    let base = include_str!("fixtures/config/local.yaml");
    for field in ["engine", "image", "networkCIDR"] {
        let input = base.replace(
            "management: external",
            &format!("management: external\n    {field}: \"\""),
        );
        assert!(
            Document::parse(input.as_bytes()).is_err(),
            "external gateway accepted {field}"
        );
    }
}

#[test]
fn fabric_harness_identifiers_are_extensible_and_validated() {
    let baseline = include_str!("fixtures/config/local.yaml");
    let source = baseline.replace("kind: nvidia.fabric.openclaw", "kind: fixture-new-agent");
    let mut document = Document::parse(source.as_bytes()).unwrap();
    document.spec.sandboxes[0]
        .harness
        .as_mut()
        .unwrap()
        .settings = Some(
        serde_json::json!({"custom": {"nested": [null, true, 42, "value"]}})
            .as_object()
            .unwrap()
            .clone(),
    );
    document.validate().unwrap();
    let schema = nemoclaw_sdk::config::schema::input_schema();
    assert_eq!(
        schema["$defs"]["Harness"]["properties"]["kind"]["type"],
        "string"
    );
    assert!(
        schema["$defs"]["Harness"]["properties"]["kind"]
            .get("enum")
            .is_none()
    );
    for api in [
        nemoclaw_sdk::config::InferenceApi::OpenaiCompletions,
        nemoclaw_sdk::config::InferenceApi::OpenaiResponses,
        nemoclaw_sdk::config::InferenceApi::AnthropicMessages,
    ] {
        document.spec.inference_providers[0].api = Some(api);
        document.spec.inference_providers[0].provider =
            if api == nemoclaw_sdk::config::InferenceApi::AnthropicMessages {
                InferenceProviderKind::Anthropic
            } else {
                InferenceProviderKind::Openai
            };
        document.validate().unwrap();
    }
    assert_eq!(
        document.spec.sandboxes[0]
            .harness
            .as_ref()
            .unwrap()
            .kind
            .as_str(),
        "fixture-new-agent"
    );
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document
    );
    for value in [
        "org.fabric.fixture.discoverable",
        "Uppercase",
        "space name",
        "with_underscore",
        "../opaque-id",
        "line\nbreak",
        "tab\tname",
    ] {
        assert_eq!(value.parse::<HarnessKind>().unwrap().as_str(), value);
    }
    for invalid in ["", " "] {
        assert!(invalid.parse::<HarnessKind>().is_err());
    }
}

#[test]
fn default_image_is_deployment_policy_independent_of_adapter_identity() {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("fixtures/config/local.yaml")).unwrap();
    value["spec"]["sandboxes"][0]["harness"]["kind"] = "fixture-new-agent".into();
    value["spec"]["sandboxes"][0]
        .as_object_mut()
        .unwrap()
        .remove("image");
    assert_eq!(
        Document::parse(serde_json::to_vec(&value).unwrap().as_slice())
            .unwrap()
            .spec
            .sandboxes[0]
            .image
            .ref_,
        nemoclaw_sdk::config::DEFAULT_AGENT_IMAGE
    );
}

#[test]
fn arbitrary_adapter_features_are_preserved_for_fabric_validation() {
    let mut tree: Value = serde_saphyr::from_str(include_str!(
        "../../../examples/full-featured-openclaw.yaml"
    ))
    .unwrap();
    // The selected image's Fabric schema, not a compiled name list, owns these
    // native feature combinations. Deployment policy and reference checks remain.
    tree["spec"]["harnesses"]["assistant"]["kind"] = "fixture-featureful-agent".into();
    let document = Document::parse(serde_json::to_vec(&tree).unwrap().as_slice()).unwrap();
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document
    );
}

#[test]
fn native_identifiers_and_model_metadata_do_not_require_sdk_registration() {
    let mut tree: Value =
        serde_saphyr::from_str(include_str!("fixtures/config/local.yaml")).unwrap();
    let sandbox = &mut tree["spec"]["sandboxes"][0];
    sandbox["harness"]["kind"] = "fixture-featureful-agent".into();
    sandbox["agent"]["tools"] = serde_json::json!({"allow":["lookup","custom_search"]});
    let inference = &mut sandbox["agent"]["inference"];
    inference["default"] = "primary".into();
    let mut second = inference["routes"][0].clone();
    second["name"] = "secondary".into();
    second["overrides"]["settings"]["reasoning_effort"] = "adaptive".into();
    second["overrides"]["settings"]["contextWindow"] = 65536.into();
    second["overrides"]["settings"]["model_metadata"] = serde_json::json!({"custom":null});
    inference["routes"].as_array_mut().unwrap().push(second);
    let parsed = Document::parse(serde_json::to_vec(&tree).unwrap().as_slice()).unwrap();
    assert_eq!(
        Document::parse(parsed.yaml().unwrap().as_bytes()).unwrap(),
        parsed
    );
    tree["spec"]["sandboxes"][0]["harness"]["settings"] =
        serde_json::json!({"disclosure":"adapter-defined-mode"});
    Document::parse(serde_json::to_vec(&tree).unwrap().as_slice()).unwrap();
    for invalid in [
        serde_json::json!({"allow":[]}),
        serde_json::json!({"allow":["read","read"]}),
        serde_json::json!({"disclosure":""}),
    ] {
        tree["spec"]["sandboxes"][0]["agent"]["tools"] = invalid;
        assert!(Document::parse(serde_json::to_vec(&tree).unwrap().as_slice()).is_err());
    }
}
