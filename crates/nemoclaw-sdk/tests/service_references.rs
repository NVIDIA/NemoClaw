// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::provider_scope;

use nemoclaw_sdk::{
    compile::{Generations, compile, runtime_targets},
    config::Document,
};
use serde_json::{Value, json};

fn managed_ollama_service() -> Value {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("fixtures/config/managed-ollama.yaml")).unwrap();
    let mut unused = value["spec"]["services"]["ollama-server"].clone();
    unused["serving"]["port"] = json!(18999);
    value["spec"]["services"]["unused"] = unused;
    value
}

#[test]
fn declared_services_install_once_and_service_ref_selects_the_inference_connection() {
    let value = managed_ollama_service();
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let generations: Generations = [
        "workspace",
        "provider",
        "sandbox",
        "ollama_service",
        "managed_gateway",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    let runtime = runtime_targets(&document, &generations).unwrap();
    assert!(
        runtime
            .iter()
            .any(|target| target.address == "docker_container.ollama_service_ollama-server")
    );
    assert!(
        runtime
            .iter()
            .any(|target| target.address == "docker_container.ollama_service_unused")
    );
    let graph = compile(&document, &generations, "0.1.0").unwrap();
    let server =
        &provider_scope::resource(&graph["resource"]["openshell_inference"], "local")["server"];
    assert_eq!(server["credential_env"], "");
    assert_eq!(server["credential_source"], "");
    assert_eq!(
        document.inference_endpoint().unwrap(),
        "http://172.20.0.1:18888/v1"
    );
}

#[test]
fn service_references_reject_missing_names() {
    let mut missing = managed_ollama_service();
    missing["spec"]["inferenceProviders"][0]["serviceRef"] = json!("missing");
    assert!(Document::parse(missing.to_string().as_bytes()).is_err());
}

fn container_service() -> Value {
    json!({
        "kind":"container",
        "image":format!("voiceclaw@sha256:{}", "a".repeat(64)),
        "environment":{"VOICECLAW_RUNTIME_PROFILE":"nemoclaw-container-v1", "LITERAL":"${not_a_reference}"},
        "data":{"mountPath":"/var/lib/voiceclaw"},
        "publication":{"bindAddress":"127.0.0.1", "port":18790}
    })
}

fn container_generations() -> Generations {
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
fn application_identity_uses_launch_settings_without_unrelated_gateway_settings() {
    let application = |value: &Value| {
        let document = Document::parse(value.to_string().as_bytes()).unwrap();
        compile(&document, &container_generations(), "0.1.0").unwrap()["resource"]["docker_container"]
            ["container_service_voice"]
            .clone()
    };
    let mut value = managed_ollama_service();
    value["spec"]["services"]["voice"] = container_service();
    let original = application(&value);
    value["spec"]["gateway"]["endpoint"] = json!("http://127.0.0.1:18892");
    assert_eq!(application(&value), original);
    value["spec"]["services"]["voice"]["environment"] = json!({"LOG_LEVEL":"debug"});
    assert_ne!(application(&value)["labels"], original["labels"]);
    assert_eq!(application(&value)["mounts"], original["mounts"]);
}

#[test]
fn container_service_runs_on_the_gateway_network_with_disposable_data_and_fresh_health() {
    let mut value = managed_ollama_service();
    value["spec"]["services"]["voice"] = container_service();
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let graph = compile(&document, &container_generations(), "0.1.0").unwrap();
    let container = &graph["resource"]["docker_container"]["container_service_voice"];
    assert_eq!(container["user"], "65532:65532");
    assert!(container.get("entrypoint").is_none());
    assert!(container.get("gpus").is_none());
    assert_eq!(container["mounts"][0]["target"], "/var/lib/voiceclaw");
    assert!(
        container["env"]
            .as_array()
            .unwrap()
            .contains(&json!("LITERAL=$${not_a_reference}"))
    );
    assert!(graph["resource"]["docker_network"].is_null());
    let volume = &graph["resource"]["docker_volume"]["container_storage_voice"];
    assert!(volume.get("lifecycle").is_none());
    let readiness = &graph["data"]["host_container_health"]["container_service_voice"];
    assert_eq!(
        readiness["container_id"],
        "${docker_container.container_service_voice.id}"
    );
    assert_eq!(
        readiness["labels"][nemoclaw_sdk::managed::OWNER_LABEL],
        document.metadata.uid
    );
    let original = Document::parse(managed_ollama_service().to_string().as_bytes()).unwrap();
    assert_eq!(
        nemoclaw_sdk::compile::compile_runtime(&original, &container_generations(), "0.1.0")
            .unwrap(),
        nemoclaw_sdk::compile::compile_runtime(&document, &container_generations(), "0.1.0")
            .unwrap(),
        "adding an application must not change inference runtime identity or launch settings"
    );
    let teardown = nemoclaw_sdk::compile::compile_teardown(
        &document,
        &container_generations(),
        "0.1.0",
        &["docker_volume.container_storage_voice".into()].into(),
    )
    .unwrap();
    assert!(
        !teardown
            .retained
            .contains("docker_volume.container_storage_voice")
    );
}

#[test]
fn explicit_containers_can_run_the_same_managed_model_configuration() {
    for yaml in [
        include_str!("fixtures/config/managed-ollama.yaml"),
        include_str!("../../../examples/spark/vllm.yaml"),
    ] {
        let typed = Document::parse(yaml.as_bytes()).unwrap();
        let mut generations = container_generations();
        generations.insert("inference_service".into(), "a".repeat(32));
        let targets = runtime_targets(&typed, &generations).unwrap();
        let target = targets
            .iter()
            .find(|target| matches!(target.kind.as_str(), "inference_service" | "ollama_service"))
            .unwrap();
        let spec: nemoclaw_sdk::managed::Spec =
            serde_json::from_str(&target.values["spec"]).unwrap();
        let process = spec.process.as_ref().unwrap();
        let name = typed.spec.services.keys().next().unwrap();
        let mut value = serde_json::to_value(&typed).unwrap();
        value["spec"]["services"][name] = json!({
            "kind": "container", "image": process.image, "user":"0:0",
            "environment": {"NEMOCLAW_RUNTIME_SPEC": process.configuration},
            "container": {"gpu":true, "memoryLimitGiB":104, "sharedMemoryGiB":8,
                "ulimits":{"memlock":-1,"stack":67108864}},
            "port": process.port,
            "publication":{"bindAddress":process.bind_address,"port":process.port},
            "data":{"mountPath":"/data"},
            "readiness":{"runtimeStatus":"/data/status.json","timeoutSeconds":1800}
        });
        let expected = Document::parse(value.to_string().as_bytes())
            .expect("the base must accept a managed image's explicit container configuration");
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
            "tests/fixtures/config/explicit-{}.yaml",
            if target.kind == "ollama_service" {
                "ollama"
            } else {
                "vllm"
            }
        ));
        if std::env::var_os("NEMOCLAW_REGENERATE_FIXTURES").is_some() {
            std::fs::write(&fixture, format!(
                "# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.\n# SPDX-License-Identifier: Apache-2.0\n# Explicit counterpart of a managed-model parser fixture. Not a live qualification or authorization.\n{}", expected.yaml().unwrap()
            )).unwrap();
        }
        let direct = Document::parse(std::fs::read(&fixture).unwrap().as_slice()).unwrap();
        assert_eq!(
            direct, expected,
            "regenerate explicit container fixtures after an intentional contract change"
        );
        let graph = compile(&direct, &generations, "0.1.0").unwrap();
        let logical = format!("container_service_{name}");
        let container = &graph["resource"]["docker_container"][&logical];
        assert_eq!(container["gpus"], "all");
        assert_eq!(container["memory"], process.memory_bytes / (1 << 20));
        assert_eq!(
            container["shm_size"],
            process.shared_memory_bytes / (1 << 20)
        );
        assert_eq!(container["mounts"][0]["target"], process.mount_target);
        assert!(
            container["env"]
                .as_array()
                .unwrap()
                .contains(&json!(format!(
                    "NEMOCLAW_RUNTIME_SPEC={}",
                    process
                        .configuration
                        .replace("${", "$${")
                        .replace("%{", "%%{")
                )))
        );
        let health = &graph["data"]["host_container_health"][&logical];
        assert_eq!(health["runtime_status"], "/data/status.json");
        assert_eq!(
            direct.inference_endpoint().unwrap(),
            typed.inference_endpoint().unwrap()
        );
        assert_eq!(
            Document::parse(direct.yaml().unwrap().as_bytes()).unwrap(),
            direct
        );
    }
}

#[test]
fn container_passes_native_arguments_files_and_http_readiness_without_interpreting_them() {
    let mut value = managed_ollama_service();
    let mut service = container_service();
    service["command"] = json!([
        "--config",
        "/etc/service/settings.yaml",
        "nemoclaw_container_service.voice"
    ]);
    service["files"] = json!({"/etc/service/settings.yaml": "setting: ${application_value}\n"});
    service["container"] = json!({"cpuLimitMillis":2000,"memoryLimitGiB":2});
    service["readiness"] = json!({"path":"/health","timeoutSeconds":60});
    value["spec"]["services"]["voice"] = service;
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let graph = compile(&document, &container_generations(), "0.1.0").unwrap();
    let container = &graph["resource"]["docker_container"]["container_service_voice"];
    assert_eq!(
        container["command"],
        json!([
            "--config",
            "/etc/service/settings.yaml",
            "nemoclaw_container_service.voice"
        ])
    );
    assert_eq!(
        container["upload"][0]["content"],
        "setting: $${application_value}\n"
    );
    assert_eq!(container["upload"][0]["permissions"], "0444");
    assert_eq!(container["memory"], 2048);
    assert_eq!(container["shm_size"], 64);
    assert!(container.get("gpus").is_none());
    assert_eq!(
        graph["data"]["host_container_health"]["container_service_voice"]["http_url"],
        "http://127.0.0.1:18790/health"
    );
}

#[test]
fn container_service_rejects_invalid_launch_and_unreachable_inference_publication() {
    for (field, bad) in [
        ("image", json!("voiceclaw:latest")),
        ("user", json!("root")),
        ("data", json!({"mountPath":"/etc"})),
        ("publication", json!({"bindAddress":"0.0.0.0","port":18790})),
    ] {
        let mut value = managed_ollama_service();
        value["spec"]["services"]["voice"] = container_service();
        value["spec"]["services"]["voice"][field] = bad;
        assert!(
            Document::parse(value.to_string().as_bytes()).is_err(),
            "accepted {field}"
        );
    }
    let mut value = managed_ollama_service();
    value["spec"]["services"]["voice"] = container_service();
    value["spec"]["inferenceProviders"][0]["serviceRef"] = json!("voice");
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
}
