// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, compile},
    config::Document,
};
use serde_json::{Value, json};

fn authored() -> Value {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("fixtures/config/managed-ollama.yaml")).unwrap();
    let sandbox = value["spec"]["sandboxes"][0]["name"]
        .as_str()
        .unwrap()
        .to_owned();
    let agent = value["spec"]["sandboxes"][0]["agent"]["name"]
        .as_str()
        .unwrap()
        .to_owned();
    value["spec"]["services"]["voice"] = json!({
        "kind":"container", "image":format!("voice@sha256:{}", "a".repeat(64)),
        "architecture":"arm64", "imagePullPolicy":"Never",
        "inputSetup":{"image":format!("inputs@sha256:{}", "b".repeat(64))},
        "data":{"mountPath":"/var/lib/voiceclaw"},
        "secrets":{
            "speech":{"credential":{"env":"SPEECH_KEY"},"targetPath":"/var/lib/voiceclaw/credentials/speech"},
            "openshell":{"credential":{"env":"SERVICE_TOKEN"},"targetPath":"/var/lib/voiceclaw/credentials/openshell"}
        },
        "agentConnections":{"primary":{
            "sandboxRef":sandbox, "agent":agent,
            "targetPath":"/var/lib/voiceclaw/config/agent-connection.json",
            "gatewayEndpoint":"https://gateway.example.test:8443",
            "authentication":{"mode":"oidcBearer","secretRef":"openshell","refreshMode":"none"},
            "tls":{"trust":"system"},
            "timeouts":{"healthSeconds":12,"invokeSeconds":120}
        }}
    });
    value
}
fn generations() -> Generations {
    [
        "workspace",
        "provider",
        "sandbox",
        "ollama_service",
        "managed_gateway",
        "container_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into()
}

#[test]
fn complete_container_connection_document_keeps_operator_identity_out_of_application_inputs() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/config/container-agent-connection.yaml");
    let document = Document::parse(std::fs::File::open(path).unwrap()).unwrap();
    assert_eq!(
        document.credential_names(),
        [
            "AGENT_INFERENCE_API_KEY",
            "NVIDIA_API_KEY",
            "OPENSHELL_OPERATOR_TOKEN",
            "VOICECLAW_OPENSHELL_SERVICE_TOKEN",
        ]
    );
    let graph = compile(&document, &generations(), "0.1.0").unwrap();
    let inputs = &graph["resource"]["nemoclaw_container_inputs"]["voice"];
    let spec: Value = serde_json::from_str(inputs["spec"].as_str().unwrap()).unwrap();
    assert!(!inputs.to_string().contains("OPENSHELL_OPERATOR_TOKEN"));
    assert!(!inputs.to_string().contains("AGENT_INFERENCE_API_KEY"));
    assert!(
        spec.to_string()
            .contains("VOICECLAW_OPENSHELL_SERVICE_TOKEN")
    );
    assert_eq!(inputs["sandbox_id"], "${nemoclaw_sandbox.assistant.id}");
    let app = &graph["resource"]["docker_container"]["container_service_voice"];
    assert_eq!(app["user"], "65532:65532");
    for dependency in [
        "nemoclaw_container_inputs.voice",
        "data.nemoclaw_sandbox_readiness.assistant",
    ] {
        assert!(
            app["depends_on"]
                .as_array()
                .unwrap()
                .contains(&json!(dependency))
        );
    }
    let environment = app["env"].as_array().unwrap();
    assert!(environment.contains(&json!("VOICECLAW_RUNTIME_PROFILE=nemoclaw-container-v1")));
    assert!(environment.contains(&json!(
        "VOICECLAW_INSTALL_CONTRACT=voiceclaw.nemoclaw.container.v1"
    )));
    for name in document.credential_names() {
        assert!(
            !environment
                .iter()
                .any(|entry| { entry.as_str().unwrap().starts_with(&format!("{name}=")) })
        );
    }
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document
    );
}

#[test]
fn unsupported_health_opt_in_changes_only_the_selected_sandbox_postcondition() {
    let mut value = authored();
    let graph = |value: &Value| {
        compile(
            &Document::parse(value.to_string().as_bytes()).unwrap(),
            &generations(),
            "0.1.0",
        )
        .unwrap()
    };
    let strict = graph(&value);
    value["spec"]["sandboxes"][0]["allowUnsupportedHealth"] = json!(true);
    let optional = graph(&value);
    let condition =
        optional["data"]["nemoclaw_sandbox_readiness"]["assistant"]["lifecycle"]["postcondition"]
            [0]["condition"]
            .as_str()
            .unwrap();
    assert!(condition.contains("fabric_health_unsupported"));
    assert!(condition.contains("supported == false"));
    assert!(condition.contains("report == null"));
    assert_eq!(
        strict["data"]["nemoclaw_sandbox_readiness"]["assistant"]["lifecycle"]["postcondition"][0]
            ["condition"],
        "${self.ready}"
    );
    assert_eq!(strict["resource"], optional["resource"]);
    value["spec"]["sandboxes"][0]["allowUnsupportedHealth"] = json!(false);
    assert_eq!(strict, graph(&value));
}

#[test]
fn container_inputs_compile_references_and_order_complete_delivery_before_start() {
    let value = authored();
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    assert!(document.credential_names().contains(&"SPEECH_KEY"));
    assert!(document.credential_names().contains(&"SERVICE_TOKEN"));
    let graph = compile(&document, &generations(), "0.1.0").unwrap();
    let inputs = &graph["resource"]["nemoclaw_container_inputs"]["voice"];
    assert_eq!(inputs["sandbox_id"], "${nemoclaw_sandbox.assistant.id}");
    assert!(inputs["spec"].as_str().unwrap().contains("SERVICE_TOKEN"));
    assert!(
        inputs["depends_on"]
            .as_array()
            .unwrap()
            .contains(&json!("docker_volume.container_storage_voice"))
    );
    let app = &graph["resource"]["docker_container"]["container_service_voice"];
    for dependency in [
        "nemoclaw_container_inputs.voice",
        "data.nemoclaw_sandbox_readiness.assistant",
    ] {
        assert!(
            app["depends_on"]
                .as_array()
                .unwrap()
                .contains(&json!(dependency))
        );
    }
    assert_eq!(
        app["lifecycle"]["replace_triggered_by"],
        json!(["nemoclaw_container_inputs.voice"])
    );
    assert!(app["env"].as_array().unwrap().is_empty());
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document
    );
}

#[test]
fn container_inputs_reject_unsafe_paths_bindings_credentials_and_transports() {
    for (path, bad) in [
        ("/spec/services/voice/inputSetup", Value::Null),
        (
            "/spec/services/voice/inputSetup/image",
            json!("inputs:latest"),
        ),
        (
            "/spec/services/voice/inputSetup/image",
            json!(format!("sha256:{}", "b".repeat(64))),
        ),
        (
            "/spec/services/voice/secrets/speech/targetPath",
            json!("/etc/key"),
        ),
        (
            "/spec/services/voice/secrets/speech/targetPath",
            json!("/var/lib/voiceclaw/../key"),
        ),
        (
            "/spec/services/voice/secrets/speech/targetPath",
            json!("/var/lib/voiceclaw/config"),
        ),
        (
            "/spec/services/voice/secrets/speech/credential/env",
            json!("TF_VAR_KEY"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/sandboxRef",
            json!("missing"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/agent",
            json!("wrong"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/authentication/secretRef",
            json!("missing"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/authentication/mode",
            json!("operatorLogin"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/gatewayEndpoint",
            json!("http://gateway.example.test"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/gatewayEndpoint",
            json!("https://token@gateway.example.test"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/gatewayEndpoint",
            json!("https://127.0.0.1:8443"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/tls/trust",
            json!("insecure"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/timeouts/healthSeconds",
            json!(0),
        ),
    ] {
        let mut value = authored();
        *value.pointer_mut(path).unwrap() = bad;
        assert!(
            Document::parse(value.to_string().as_bytes()).is_err(),
            "accepted {path}"
        );
    }
}

#[test]
fn setup_image_is_not_allowed_without_any_protected_inputs() {
    let mut value = authored();
    value["spec"]["services"]["voice"]["secrets"] = json!({});
    value["spec"]["services"]["voice"]["agentConnections"] = json!({});
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
    value["spec"]["services"]["voice"]
        .as_object_mut()
        .unwrap()
        .remove("inputSetup");
    Document::parse(value.to_string().as_bytes()).unwrap();
}

#[test]
fn changed_input_references_replace_disposable_data_but_literal_settings_do_not() {
    let mut value = authored();
    let graph = |v: &Value| {
        compile(
            &Document::parse(v.to_string().as_bytes()).unwrap(),
            &generations(),
            "0.1.0",
        )
        .unwrap()
    };
    let original = graph(&value);
    value["spec"]["services"]["voice"]["secrets"]["speech"]["credential"]["env"] =
        json!("OTHER_SPEECH_KEY");
    let changed = graph(&value);
    assert_ne!(
        original["resource"]["docker_volume"]["container_storage_voice"]["name"],
        changed["resource"]["docker_volume"]["container_storage_voice"]["name"]
    );
    value["spec"]["services"]["voice"]["environment"] = json!({"SETTING":"changed"});
    assert_eq!(
        changed["resource"]["docker_volume"]["container_storage_voice"]["name"],
        graph(&value)["resource"]["docker_volume"]["container_storage_voice"]["name"]
    );
}

#[test]
fn application_descriptor_records_explicit_binding_without_secret_values() {
    let document = Document::parse(authored().to_string().as_bytes()).unwrap();
    let target = nemoclaw_sdk::compile::targets(&document, &generations())
        .unwrap()
        .into_iter()
        .find(|t| t.kind == "container_inputs")
        .unwrap();
    let spec: nemoclaw_sdk::services::installers::container::inputs::InputsSpec =
        serde_json::from_str(&target.values["spec"]).unwrap();
    let sandbox_id = "11111111-2222-3333-4444-555555555555";
    let (path, descriptor) = spec.descriptor(sandbox_id).unwrap().unwrap();
    assert_eq!(path, "/var/lib/voiceclaw/config/agent-connection.json");
    assert_eq!(descriptor["schemaVersion"], "nemoclaw.agent-connection.v1");
    assert_eq!(descriptor["target"]["workspace"], document.workspace());
    assert_eq!(descriptor["target"]["sandboxId"], sandbox_id);
    assert_eq!(
        descriptor["target"]["agent"],
        document.spec.sandboxes[0].agent.name
    );
    assert_eq!(
        descriptor["gateway"]["tls"],
        json!({"trust":"system","caFile":null})
    );
    assert_eq!(
        descriptor["authentication"]["credentialFile"],
        "/var/lib/voiceclaw/credentials/openshell"
    );
    assert!(descriptor.get("credentialValue").is_none());
    assert!(
        !descriptor.to_string().contains("SERVICE_TOKEN"),
        "descriptor has a file path, not an installer credential reference"
    );
    assert!(spec.descriptor("unresolved").is_err());
    assert!(serde_json::from_value::<nemoclaw_sdk::services::installers::container::inputs::InputsSpec>({
        let mut value=serde_json::to_value(&spec).unwrap(); value["unexpected"]=json!("field"); value
    }).is_err());
}

#[tokio::test]
async fn missing_protected_credentials_fail_before_bundle_access_or_deployment_changes() {
    struct Missing;
    impl nemoclaw_sdk::Secrets for Missing {
        fn resolve(&self, _: &str) -> Result<String, nemoclaw_sdk::ObservationError> {
            Err(nemoclaw_sdk::ObservationError::Authentication)
        }
    }
    let document = Document::parse(authored().to_string().as_bytes()).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let deployment = nemoclaw_sdk::Deployment::new(
        &directory.path().join("state"),
        &directory.path().join("missing-bundle"),
    )
    .with_secrets(std::sync::Arc::new(Missing));
    let error = deployment
        .apply(&document, &nemoclaw_sdk::CancellationToken::new())
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        nemoclaw_sdk::Error::Observation(nemoclaw_sdk::ObservationError::Authentication)
    ));
    assert!(!directory.path().join("state").exists());
}
