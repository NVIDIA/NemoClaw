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
    assert_eq!(
        provider_scope::resource(&graph["resource"]["nemoclaw_provider_profile"], "local")["authenticated"],
        "false"
    );
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
        "imagePullPolicy":"Never",
        "architecture":"arm64",
        "environment":{"VOICECLAW_RUNTIME_PROFILE":"nemoclaw-container-v1", "LITERAL":"${not_a_reference}"},
        "data":{"mountPath":"/var/lib/voiceclaw"},
        "publication":{"bindAddress":"127.0.0.1", "port":18790},
        "readiness":{"startupTimeoutSeconds":300}
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
fn container_service_uses_shared_compute_without_an_inference_consumer() {
    let mut value = managed_ollama_service();
    value["spec"]["services"]["voice"] = container_service();
    assert!(
        jsonschema::validator_for(&nemoclaw_sdk::config::schema::input_schema())
            .unwrap()
            .is_valid(&value)
    );
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let graph = compile(&document, &container_generations(), "0.1.0").unwrap();
    let container = &graph["resource"]["docker_container"]["container_service_voice"];
    assert_eq!(container["user"], "65532:65532");
    assert!(container.get("entrypoint").is_none());
    assert!(container.get("command").is_none());
    assert!(container.get("gpus").is_none());
    assert_eq!(container["ipc_mode"], "private");
    assert_eq!(container["restart"], "no");
    assert_eq!(container["destroy_grace_seconds"], 15);
    assert_eq!(container["mounts"][0]["target"], "/var/lib/voiceclaw");
    assert!(
        container["env"]
            .as_array()
            .unwrap()
            .contains(&json!("LITERAL=$${not_a_reference}"))
    );
    assert!(!container.to_string().contains("NEMOCLAW_RUNTIME_SPEC"));
    let volume = &graph["resource"]["docker_volume"]["container_storage_voice"];
    assert_ne!(volume["lifecycle"]["prevent_destroy"], true);
    let readiness = &graph["data"]["nemoclaw_service_readiness"]["container_service_voice"];
    assert_eq!(readiness["wait_timeout_seconds"], 300);
    assert_eq!(
        readiness["container_id"],
        "${docker_container.container_service_voice.id}"
    );
    assert!(
        graph["data"]["docker_image"]
            .as_object()
            .unwrap()
            .values()
            .any(|image| image["name"] == container_service()["image"])
    );
    let exported = document.yaml().unwrap();
    assert_eq!(Document::parse(exported.as_bytes()).unwrap(), document);
    assert_eq!(
        compile(
            &Document::parse(exported.as_bytes()).unwrap(),
            &container_generations(),
            "0.1.0"
        )
        .unwrap(),
        graph
    );
    let original = Document::parse(managed_ollama_service().to_string().as_bytes()).unwrap();
    assert_eq!(
        nemoclaw_sdk::compile::compile_runtime(&original, &container_generations(), "0.1.0")
            .unwrap(),
        nemoclaw_sdk::compile::compile_runtime(&document, &container_generations(), "0.1.0")
            .unwrap(),
        "adding an application must not change inference runtime identity or launch settings"
    );

    let established = [
        "docker_container.container_service_voice",
        "docker_volume.container_storage_voice",
        "nemoclaw_workspace.deployment",
    ]
    .map(String::from)
    .into();
    let teardown = nemoclaw_sdk::compile::compile_teardown(
        &document,
        &container_generations(),
        "0.1.0",
        &established,
        false,
    )
    .unwrap();
    assert!(
        !teardown
            .retained
            .contains("docker_volume.container_storage_voice")
    );
    assert!(teardown.graph["resource"]["docker_container"].is_null());
    assert!(teardown.graph["resource"]["docker_volume"].is_null());
    let runtime_teardown = nemoclaw_sdk::compile::compile_teardown(
        &document,
        &container_generations(),
        "0.1.0",
        &["docker_volume.ollama_service_storage_ollama-server".into()].into(),
        true,
    )
    .unwrap();
    assert!(
        runtime_teardown
            .retained
            .contains("docker_volume.ollama_service_storage_ollama-server")
    );
}

#[test]
fn container_service_rejects_inference_routes_and_unsafe_overrides() {
    for (field, bad) in [
        ("image", json!("voiceclaw:latest")),
        ("imagePullPolicy", json!("Always")),
        ("user", json!("0:0")),
        ("architecture", json!("native")),
        ("privileged", json!(true)),
        ("entrypoint", json!(["sh", "-c", "run"])),
        ("data", json!({"mountPath":"/var/../etc"})),
        ("environment", json!({"BAD=KEY":"value"})),
        ("environment", json!({"KEY":"bad\u{0}value"})),
        ("readiness", json!({"startupTimeoutSeconds":0})),
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

#[test]
fn unused_inference_provider_cannot_reference_an_application_container() {
    let mut value = managed_ollama_service();
    value["spec"]["services"]["voice"] = container_service();
    value["spec"]["inferenceProviders"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "name":"unused-container", "provider":"openai", "serviceRef":"voice"
        }));
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
}

#[test]
fn container_dependencies_require_declared_services_and_reject_cycles() {
    let mut value = managed_ollama_service();
    value["spec"]["services"]["first"] = container_service();
    value["spec"]["services"]["second"] = container_service();
    value["spec"]["services"]["second"]["publication"]["port"] = json!(18791);
    value["spec"]["services"]["second"]["dependsOn"] = json!(["first"]);
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let graph = compile(&document, &container_generations(), "0.1.0").unwrap();
    assert!(
        graph["resource"]["docker_container"]["container_service_second"]["depends_on"]
            .as_array()
            .unwrap()
            .contains(&json!(
                "data.nemoclaw_service_readiness.container_service_first"
            ))
    );
    for dependencies in [
        json!(["missing"]),
        json!(["second"]),
        json!(["first", "first"]),
    ] {
        let mut bad = value.clone();
        bad["spec"]["services"]["second"]["dependsOn"] = dependencies;
        assert!(Document::parse(bad.to_string().as_bytes()).is_err());
    }
    value["spec"]["services"]["first"]["dependsOn"] = json!(["second"]);
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
}

#[test]
fn container_explicit_placement_does_not_adopt_the_gateway_network() {
    let mut value = serde_json::to_value(
        Document::parse(managed_ollama_service().to_string().as_bytes()).unwrap(),
    )
    .unwrap();
    value["spec"]["services"]["voice"] = container_service();
    value["spec"]["services"]["voice"]["placement"] = json!({"engine":value["spec"]["gateway"]["engine"],"networkCIDR":value["spec"]["gateway"]["networkCIDR"]});
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let graph = compile(&document, &container_generations(), "0.1.0").unwrap();
    assert!(
        graph["resource"]["docker_network"].is_null(),
        "the retained gateway network must not become disposable application state"
    );
}

#[test]
fn unconsumed_local_services_cannot_inherit_a_podman_engine() {
    for source in [
        include_str!("../../../examples/spark/vllm.yaml"),
        include_str!("../../../examples/managed-ollama-gpu.yaml"),
    ] {
        let mut value: serde_json::Value = serde_saphyr::from_str(source).unwrap();
        let provider = value["spec"]["inferenceProviders"][0]
            .as_object_mut()
            .unwrap();
        provider.remove("serviceRef");
        provider.insert(
            "endpoint".into(),
            serde_json::json!("https://inference.example/v1"),
        );
        value["spec"]["sandboxes"][0]["runtime"]["provider"] = serde_json::json!("podman");
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn resolved_backend_can_be_used_directly_and_preserves_explicit_destroy_guard() {
    use nemoclaw_sdk::{ObservationError, backend::Backend};
    let connections = nemoclaw_provider::docker::Connections::default();
    let registry = nemoclaw_provider::services::BackendRegistry::new(&connections);
    let directory = tempfile::tempdir().unwrap();
    let socket = directory.path().join("engine.sock");
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    listener.set_nonblocking(true).unwrap();
    let row = [("engine".into(), format!("unix://{}", socket.display()))].into();
    for kind in ["ollama_proxy_storage", "ollama_external_model"] {
        let backend: Box<dyn Backend> = registry.resolve(kind, &row).unwrap().unwrap();
        assert_eq!(
            backend.remove(kind, &row, false).await,
            Err(ObservationError::Backend(
                "proxy deletion requires explicit destroy"
            ))
        );
    }
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}
