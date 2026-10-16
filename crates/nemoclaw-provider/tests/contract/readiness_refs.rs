// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Container-mode readiness exports the `inference_server` ref inference
//! registrations take, naming where an authenticated server's generated key
//! lives, as observed from its container.
use nemoclaw_sdk::{compile, config::Document};
use serde_json::{Value, json};
use std::fs;

const KEY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated SSH fixture"]
async fn container_readiness_exports_the_server_ref_with_its_observed_credential_source() {
    let directory = crate::workspace();
    let root = directory.path();
    nemoclaw_test_fixtures::ssh::install_simulator(root, root);
    let document = Document::parse(
        include_bytes!("../../../nemoclaw-sdk/tests/fixtures/config/spark.yaml").as_slice(),
    )
    .unwrap();
    let mut document = serde_json::to_value(document).unwrap();
    document["spec"]["gateway"] = json!({"management":"external","endpoint":"http://127.0.0.1:1"});
    let service = &mut document["spec"]["services"]["qwen"];
    service["authentication"] = json!("bearer");
    service["placement"] =
        json!({"engine":"ssh://operator@gpu-box","networkCidr":"172.30.119.0/24"});
    service["publication"] =
        json!({"endpoint":"http://10.0.0.8:18888/v1","bindAddress":"10.0.0.8"});
    let document = Document::parse(document.to_string().as_bytes()).unwrap();
    let generations = ["workspace", "provider", "sandbox", "inference_service"]
        .map(|kind| (kind.into(), "a".repeat(32)))
        .into();
    let target = compile::runtime_targets(&document, &generations)
        .unwrap()
        .into_iter()
        .find(|target| target.kind == "inference_service")
        .unwrap();
    let spec: nemoclaw_sdk::managed::Spec = serde_json::from_str(&target.values["spec"]).unwrap();
    let (name, owner) = (spec.name.clone(), spec.owner.clone());
    let contract = spec.runtime_configuration().unwrap().to_owned();
    let volume = format!("{name}-auth");

    // The running container mounts its credential volume, which carries
    // NemoClaw's identity labels.
    fs::write(
        root.join("engine.json"),
        json!({
            "effects": 0,
            "container": {
                "Id": "owned",
                "Name": format!("/{name}"),
                "State": {"Running": true, "StartedAt": "2026-09-15T00:00:00Z"},
                "Mounts": [{"Type": "volume", "Name": volume, "Destination": "/credentials"}]
            },
            "auth_volume": {
                "Name": volume, "Driver": "local", "Scope": "local", "Options": {},
                "Mountpoint": "/var/lib/docker/volumes/auth/_data", "CreatedAt": "2026-09-15T00:00:00Z",
                "Labels": {"nemoclaw.nvidia.com/uid": owner, "nemoclaw.nvidia.com/generation": "b".repeat(32)}
            }
        })
        .to_string(),
    )
    .unwrap();
    fs::write(
        root.join("fixture.json"),
        json!({
            "files": {
                "/data/status.json": {"phase":"ready", "updated":"2026-09-15T00:00:01Z", "pid":42, "detail":""},
                "/credentials/inference-key": {"raw": KEY}
            },
            "stats": {"/credentials/inference-key": {"name":"inference-key", "size":64, "mode":384,
                "mtime":"2026-09-15T00:00:00Z", "linkTarget":""}}
        })
        .to_string(),
    )
    .unwrap();
    fs::write(root.join("control.json"), "{}").unwrap();

    let write = |sandbox_endpoint: Option<&str>| {
        let mut readiness = json!({
            "engine": "ssh://operator@gpu-box",
            "name": name,
            "contract": contract,
            "container_id": "owned",
            "wait_timeout_seconds": 3
        });
        if let Some(endpoint) = sandbox_endpoint {
            readiness["sandbox_endpoint"] = json!(endpoint);
        }
        let graph = json!({
            "terraform": {"required_providers": {"vllm": {"source": "registry.opentofu.org/nvidia/vllm"}}},
            "provider": {"vllm": {}},
            "data": {"vllm_readiness": {"qwen": readiness}},
            "output": {"server": {"value": "${data.vllm_readiness.qwen.ref}"}}
        });
        fs::write(root.join("main.tf.json"), graph.to_string()).unwrap();
    };
    let run = |args: &[&str]| {
        let output = directory
            .command()
            .args(args)
            .arg("-no-color")
            .env("NEMOCLAW_TEST_REMOTE", root)
            .env("PATH", nemoclaw_test_fixtures::path_with(root))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{args:?}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output
    };

    // Without the address sandboxes use, container mode exports no ref.
    write(None);
    run(&["apply", "-auto-approve", "-input=false"]);
    // OpenTofu omits a null output.
    let shown = run(&["output", "-json"]);
    let outputs: Value = serde_json::from_slice(&shown.stdout).unwrap();
    assert!(outputs.get("server").is_none(), "{outputs}");

    // With it, the ref names the server, its model, and where its key lives.
    write(Some("http://10.0.0.8:18888/v1"));
    run(&["apply", "-auto-approve", "-input=false"]);
    let shown = run(&["output", "-json", "server"]);
    assert!(!String::from_utf8_lossy(&shown.stdout).contains(KEY));
    let server: Value = serde_json::from_slice(&shown.stdout).unwrap();
    assert_eq!(server["type"], "inference_server");
    assert_eq!(server["endpoint"], "http://10.0.0.8:18888/v1");
    assert_eq!(server["model"], spec_model(&contract));
    assert_eq!(server["credential_env"], "");
    let source: nemoclaw_docker::credentials::Source =
        serde_json::from_str(server["credential_source"].as_str().unwrap()).unwrap();
    assert_eq!(
        source,
        nemoclaw_docker::credentials::Source::ManagedService {
            storage: nemoclaw_docker::Storage {
                name: volume.clone(),
                owner: owner.clone(),
                generation: "b".repeat(32),
                engine: "ssh://operator@gpu-box".into(),
            },
            container: name.clone(),
            endpoint: "http://10.0.0.8:18888/v1".into(),
        }
    );
    // It is a source registrations accept for that endpoint.
    nemoclaw_docker::credentials::Source::parse(
        server["credential_source"].as_str().unwrap(),
        &owner,
        "http://10.0.0.8:18888/v1",
    )
    .unwrap();
}

/// The model a vLLM contract serves.
fn spec_model(contract: &str) -> String {
    match nemoclaw_runtime::RuntimeSpec::decode(contract).unwrap() {
        nemoclaw_runtime::RuntimeSpec::Vllm(service) => service.served_model().to_owned(),
        nemoclaw_runtime::RuntimeSpec::Ollama(_) => unreachable!("a vLLM contract"),
    }
}
