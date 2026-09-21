// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    compile::{Generations, compile, targets},
    config::{DEFAULT_GATEWAY_IMAGE, Document, schema::input_schema},
};
use serde_json::{Value, json};

fn input() -> Value {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric-openclaw.yaml")).unwrap();
    value["spec"]["gateway"]["management"] = json!("managed");
    value["spec"]["gateway"]["engine"] = json!("unix:///var/run/docker.sock");
    value["spec"]["gateway"]["image"] = json!(DEFAULT_GATEWAY_IMAGE);
    value["spec"]["gateway"]["networkCIDR"] = json!("172.20.0.0/24");
    value["spec"]["services"] = json!({
        "voice-server": {
            "kind": "voiceclaw",
            "image": format!("sha256:{}", "a".repeat(64)),
            "imagePullPolicy": "Never",
            "speech": {
                "provider": "nvidia",
                "credential": {"env": "NVIDIA_API_KEY"}
            },
            "serving": {"port": 18790, "startupTimeoutSeconds": 180}
        }
    });
    value["spec"]["integrations"] =
        json!({"voice":{"kind":"voiceclaw","serviceRef":"voice-server"}});
    value["spec"]["sandboxes"][0]["agent"]["integrationRefs"] = json!(["voice"]);
    value
}

fn generations() -> Generations {
    [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "managed_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into()
}

#[test]
fn selected_voiceclaw_integration_compiles_one_package_neutral_runtime() {
    let value = input();
    let document = Document::parse(value.to_string().as_bytes()).expect("VoiceClaw config");
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
    let targets = targets(&document, &generations()).expect("VoiceClaw deployment targets");
    assert!(targets.iter().any(|target| {
        target.address == "docker_container.managed_service_voice-server"
            && target.kind == "managed_service"
    }));
    assert!(targets.iter().any(|target| {
        target.address == "docker_volume.managed_service_storage_voice-server"
            && target.kind == "docker_volume"
    }));
    assert!(targets.iter().any(|target| {
        target.address.starts_with("data.docker_image.image_")
            && target.kind == "docker_image_data"
            && target.values["name"] == format!("sha256:{}", "a".repeat(64))
    }));

    let graph = compile(&document, &generations(), "0.1.0").unwrap();
    let container = &graph["resource"]["docker_container"]["managed_service_voice-server"];
    assert_eq!(
        container["entrypoint"],
        json!(["/usr/local/bin/voiceclaw-runtime"])
    );
    assert_eq!(container["command"], json!(["serve"]));
    assert_eq!(container["env"], json!([]));
    assert_eq!(container["ipc_mode"], "private");
    assert!(container.get("gpus").is_none());
    assert_eq!(container["restart"], "no");
    assert_eq!(container["must_run"], true);
    assert_eq!(container["wait"], false);
    assert_eq!(container["ports"][0]["internal"], 18790);
    assert_eq!(container["mounts"][0]["target"], "/var/lib/voiceclaw");
    assert!(graph["resource"].get("docker_image").is_none());
}

#[test]
fn unused_voiceclaw_definition_creates_no_runtime() {
    let mut value = input();
    value["spec"]["sandboxes"][0]["agent"]["integrationRefs"] = json!([]);
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    assert!(
        targets(&document, &generations())
            .unwrap()
            .iter()
            .all(|target| !target.address.contains("managed_service_voice-server"))
    );
}

#[test]
fn voiceclaw_references_reject_missing_wrong_kind_and_ambiguous_agents() {
    let mut missing = input();
    missing["spec"]["integrations"]["voice"]["serviceRef"] = json!("missing");
    assert!(Document::parse(missing.to_string().as_bytes()).is_err());

    let mut wrong_kind = input();
    wrong_kind["spec"]["services"]["voice-server"] = json!({
        "kind": "ollamaProxy",
        "image": format!("proxy@sha256:{}", "b".repeat(64)),
        "endpoint": "http://172.20.0.1:11435/v1",
        "upstream": {
            "endpoint": "http://127.0.0.1:11434/v1",
            "model": {"name":"qwen3:0.6b","digest":"c".repeat(64)}
        }
    });
    assert!(Document::parse(wrong_kind.to_string().as_bytes()).is_err());

    let mut ambiguous = input();
    let mut second = ambiguous["spec"]["sandboxes"][0].clone();
    second["name"] = json!("other");
    second["agent"]["name"] = json!("other");
    ambiguous["spec"]["sandboxes"]
        .as_array_mut()
        .unwrap()
        .push(second);
    assert!(Document::parse(ambiguous.to_string().as_bytes()).is_err());
}

#[test]
fn voiceclaw_schema_rejects_untrusted_integration_metadata() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for field in ["credential", "command", "hooks", "agentRef"] {
        let mut value = input();
        value["spec"]["integrations"]["voice"][field] = json!("untrusted");
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
        assert!(!validator.is_valid(&value));
    }

    for (field, replacement) in [
        (
            "image",
            json!(format!("voiceclaw@sha256:{}", "a".repeat(64))),
        ),
        ("imagePullPolicy", json!("IfNotPresent")),
    ] {
        let mut value = input();
        value["spec"]["services"]["voice-server"][field] = replacement;
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
        assert!(!validator.is_valid(&value));
    }

    let mut missing_policy = input();
    missing_policy["spec"]["services"]["voice-server"]
        .as_object_mut()
        .unwrap()
        .remove("imagePullPolicy");
    assert!(Document::parse(missing_policy.to_string().as_bytes()).is_err());
    assert!(!validator.is_valid(&missing_policy));

    let mut defaults = input();
    defaults["spec"]["services"]["voice-server"]
        .as_object_mut()
        .unwrap()
        .remove("serving");
    assert!(validator.is_valid(&defaults));
    let document = Document::parse(defaults.to_string().as_bytes()).unwrap();
    let nemoclaw_sdk::services::ServiceDefinition::Voiceclaw(service) =
        &document.spec.services["voice-server"]
    else {
        panic!("expected VoiceClaw service")
    };
    assert_eq!(service.serving.port, 18790);
    assert_eq!(service.serving.startup_timeout_seconds, 180);
}
