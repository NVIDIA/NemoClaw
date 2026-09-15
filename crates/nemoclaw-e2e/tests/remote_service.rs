// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]
use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{config::Document, recipes::huggingface};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

fn save(root: &Path, name: &str, value: &Value) {
    fs::write(root.join(name), serde_json::to_vec(value).unwrap()).unwrap();
}
fn read(root: &Path, name: &str) -> Value {
    serde_json::from_slice(&fs::read(root.join(name)).unwrap()).unwrap()
}
async fn run(root: &Path, bundle: &Path, command: &str, file: &str, success: bool) -> Vec<u8> {
    let mut process = tokio::process::Command::new(bundle.join("bin/nemoclaw"));
    process
        .arg("--state-dir")
        .arg(root.join("deployment"))
        .arg(command);
    if !file.is_empty() {
        process.arg(root.join(file));
    }
    let output = process
        .env(
            "PATH",
            format!(
                "{}:{}",
                root.join("bin").display(),
                std::env::var("PATH").unwrap()
            ),
        )
        .env("NEMOCLAW_TEST_REMOTE", root)
        .output()
        .await
        .unwrap();
    if !output.status.success() {
        eprintln!("{command}: {}", String::from_utf8_lossy(&output.stderr));
    }
    assert_eq!(
        output.status.success(),
        success,
        "{command}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_BUNDLE; isolated SSH/Docker and OpenShell fixtures"]
async fn remote_model_lifecycle_preserves_data_and_stops_on_observation_failure() {
    lifecycle("openclaw", false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE; isolated fixtures"]
async fn managed_hermes_model_lifecycle_preserves_data_and_observes_native_probe() {
    lifecycle("hermes", false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE; isolated credential and SSH fixtures"]
async fn managed_bearer_credentials_survive_export_reapply_and_destroy() {
    lifecycle("hermes", true).await;
}
async fn lifecycle(harness: &str, authenticated: bool) {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fs::create_dir(root.join("bin")).unwrap();
    fs::write(
        root.join("bin/ssh"),
        include_bytes!("fixtures/remote_ssh.py"),
    )
    .unwrap();
    fs::set_permissions(root.join("bin/ssh"), fs::Permissions::from_mode(0o700)).unwrap();
    let gateway = Fixture::start().await;
    gateway.state.lock().unwrap().driver = Some("podman".into());
    let document = Document::parse(
        include_bytes!("../../nemoclaw-sdk/tests/fixtures/config/spark.yaml").as_slice(),
    )
    .unwrap();
    let mut value = serde_json::to_value(document).unwrap();
    value["spec"]["sandboxes"][0]["agents"][0]["harness"] = harness.into();
    value["spec"]["gateway"] = json!({"management":"external","endpoint":gateway.endpoint});
    value["spec"]["sandboxes"][0]["runtime"]["provider"] = json!("podman");
    value["spec"]["inferenceProviders"][0]["service"]["placement"] =
        json!({"engine":"ssh://operator@gpu-box","networkCidr":"172.30.119.0/24"});
    value["spec"]["inferenceProviders"][0]["service"]["publication"] =
        json!({"endpoint":"http://10.0.0.8:18888/v1","bindAddress":"10.0.0.8"});
    if authenticated {
        value["spec"]["inferenceProviders"][0]["service"]["authentication"] = "bearer".into();
        value["spec"]["sandboxes"][0]["agents"][0]["auth"] = json!({"method":"api-key","providerRef":value["spec"]["inferenceProviders"][0]["name"]});
    }
    save(root, "config.yaml", &value);
    let parsed = Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap();
    let service = parsed.spec.inference_providers[0].service.as_ref().unwrap();
    let recipe = service.recipe.as_ref().unwrap();
    let manifest = recipe.snapshot.as_ref().unwrap();
    let model = huggingface::directory(service);
    let key = recipe.key(service);
    let mut files = json!({});
    let mut stats = json!({});
    let bearer = "d".repeat(64);
    if authenticated {
        files["/data/inference-key"] = json!({"raw":bearer});
        stats["/data/inference-key"] = json!({"name":"inference-key","size":64,"mode":384,"mtime":"2026-09-15T00:00:00Z","linkTarget":""});
    }
    let mut receipt = serde_json::to_value(&manifest.files).unwrap();
    for file in receipt.as_array_mut().unwrap() {
        file["modified"] = json!(1);
        let path = format!("/data/{}/{}", model, file["name"].as_str().unwrap());
        stats[path] = json!({"name":file["name"],"size":file["size"],"mode":420,"mtime":"1970-01-01T00:00:00.000000001Z","linkTarget":""});
    }
    files[format!("/data/{}/.nemoclaw-complete.json", model)] =
        json!({"manifest":manifest.key(),"files":receipt});
    let mut prepared = Vec::new();
    for name in ["prepared.bin".to_string(), "prepared.json".to_string()] {
        prepared.push(json!({"name":name,"size":1,"sha256":"a".repeat(64),"modified":1}));
        stats[format!("/data/prepared/{}/{name}", key)] = json!({"name":name,"size":1,"mode":420,"mtime":"1970-01-01T00:00:00.000000001Z","linkTarget":""});
    }
    files[format!("/data/prepared/{}/complete.json", key)] = json!({"key":key,"files":prepared});
    files[format!("/data/{model}/{}", huggingface::MANIFEST_FILE)] =
        serde_json::to_value(manifest).unwrap();
    files["/data/status.json"] =
        json!({"phase":"ready","detail":"","updated":"2026-09-15T00:00:00Z","pid":42});
    let service = &value["spec"]["inferenceProviders"][0]["service"];
    save(
        root,
        "fixture.json",
        &json!({"files":files,"stats":stats,"image":{"Id":"sha256:runtime","Architecture":"arm64","Os":"linux","Config":{"Env":[],"Labels":{"org.nemoclaw.recipe.protocol":"v1","org.nemoclaw.inference.authentication":"bearer-v1","org.nemoclaw.backend":service["backend"],"org.nemoclaw.model":service["model"]["revision"]}}}}),
    );
    save(root, "engine.json", &json!({"effects":0,"creates":0}));
    save(root, "control.json", &json!({"capacity_failure":true}));
    run(root, &bundle, "plan", "config.yaml", false).await;
    assert_eq!(read(root, "engine.json")["effects"], 0);
    save(root, "control.json", &json!({"low_capacity":true}));
    run(root, &bundle, "plan", "config.yaml", false).await;
    assert_eq!(read(root, "engine.json")["effects"], 0);
    save(root, "control.json", &json!({}));
    run(root, &bundle, "plan", "config.yaml", true).await;
    assert_eq!(read(root, "engine.json")["effects"], 0);
    save(root, "control.json", &json!({"startup_failure":true}));
    run(root, &bundle, "apply", "config.yaml", false).await;
    assert_eq!(read(root, "engine.json")["creates"], 1);
    let volume = read(root, "engine.json")["volume"].clone();
    save(root, "control.json", &json!({}));
    run(root, &bundle, "apply", "config.yaml", true).await;
    if authenticated {
        assert!(
            gateway
                .state
                .lock()
                .unwrap()
                .providers
                .values()
                .any(|p| p.credentials.get("OPENAI_API_KEY") == Some(&bearer))
        );
        for name in [
            "deployment/runtime/terraform.tfstate",
            "deployment/terraform.tfstate",
            "config.yaml",
        ] {
            assert!(
                !fs::read_to_string(root.join(name))
                    .unwrap()
                    .contains(&bearer)
            );
        }
    }
    let stable = read(root, "engine.json");
    let state = fs::read(root.join("deployment/runtime/terraform.tfstate")).unwrap();
    run(root, &bundle, "apply", "config.yaml", true).await;
    let exported = run(root, &bundle, "export", "", true).await;
    assert!(!String::from_utf8_lossy(&exported).contains(&bearer));
    fs::write(root.join("export.yaml"), exported).unwrap();
    run(root, &bundle, "apply", "export.yaml", true).await;
    assert_eq!(read(root, "engine.json"), stable);
    for control in [
        json!({"transport_failure":true}),
        json!({"daemon":"other-engine"}),
    ] {
        save(root, "control.json", &control);
        run(root, &bundle, "plan", "config.yaml", false).await;
        assert_eq!(
            fs::read(root.join("deployment/runtime/terraform.tfstate")).unwrap(),
            state
        );
        assert_eq!(read(root, "engine.json"), stable);
    }
    save(root, "control.json", &json!({}));
    if authenticated {
        let original = read(root, "fixture.json");
        let mut corrupt = original.clone();
        corrupt["stats"]["/data/inference-key"]["mode"] = json!(420);
        save(root, "fixture.json", &corrupt);
        run(root, &bundle, "export", "", false).await;
        assert_eq!(
            fs::read(root.join("deployment/runtime/terraform.tfstate")).unwrap(),
            state
        );
        save(root, "fixture.json", &original);
    }
    run(root, &bundle, "destroy", "", true).await;
    let after = read(root, "engine.json");
    assert!(after["container"].is_null());
    assert_eq!(after["volume"], volume);
    assert_eq!(after["creates"], 1);
    assert_eq!(after["network"], stable["network"]);
}
