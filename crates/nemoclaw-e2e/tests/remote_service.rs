// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]
use nemoclaw_e2e::{assert_same_managed_resources, openshell::Fixture};
use nemoclaw_sdk::config::{Document, ServiceDefinition};
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
        .arg("--verbose")
        .arg("--state-dir")
        .arg(root.join("deployment"))
        .arg(command);
    if matches!(command, "plan" | "apply" | "destroy") {
        process.args(["-o", "json"]);
    }
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
    if output.status.success() != success {
        let shown = tokio::process::Command::new(bundle.join("libexec/tofu"))
            .args(["show", "-json", "apply.plan"])
            .current_dir(root.join("deployment/runtime"))
            .output()
            .await
            .unwrap();
        if let Ok(plan) = serde_json::from_slice::<Value>(&shown.stdout) {
            for change in plan["resource_changes"].as_array().unwrap() {
                eprintln!(
                    "planned cleanup: {}",
                    json!({"address":change["address"],"deposed":change["deposed"],"actions":change["change"]["actions"],"id":change["change"]["before"]["id"]})
                );
            }
        }
        eprintln!(
            "fixture host config: {}",
            read(root, "engine.json")["container"]["HostConfig"]
        );
    }
    assert_eq!(
        output.status.success(),
        success,
        "{command}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    if success && command == "apply" {
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["outcome"], "succeeded");
    }
    output.stdout
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_BUNDLE; isolated SSH/Docker and OpenShell fixtures"]
async fn remote_model_lifecycle_preserves_data_and_stops_on_observation_failure() {
    lifecycle("openclaw", false, "vllm", false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE; isolated fixtures"]
async fn managed_hermes_model_lifecycle_preserves_data_without_generation() {
    lifecycle("hermes", false, "vllm", false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE; isolated credential and SSH fixtures"]
async fn managed_bearer_credentials_survive_export_reapply_and_destroy() {
    lifecycle("hermes", true, "vllm", false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE; isolated SSH/Docker and OpenShell fixtures"]
async fn managed_pi_model_lifecycle_preserves_data_without_generation() {
    lifecycle("pi", false, "vllm", false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker and application-health fixtures"]
async fn remote_ollama_lifecycle_preserves_data_and_stops_on_observation_failure() {
    lifecycle("openclaw", false, "ollama", false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE; protocol-only partial deployment fixtures"]
async fn partial_runtime_destroy_retains_storage_without_creating_network() {
    lifecycle("openclaw", false, "vllm", true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated partial deployment fixtures"]
async fn partial_ollama_destroy_retains_storage_without_creating_network() {
    lifecycle("openclaw", false, "ollama", true).await;
}

async fn lifecycle(harness: &str, authenticated: bool, kind: &str, partial_destroy: bool) {
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
    gateway.state.lock().unwrap().inference_exit = 1;
    let document = Document::parse(
        include_bytes!("../../nemoclaw-sdk/tests/fixtures/config/spark.yaml").as_slice(),
    )
    .unwrap();
    let mut value = serde_json::to_value(document).unwrap();
    if kind == "ollama" {
        let source: Value = serde_saphyr::from_str(include_str!(
            "../../nemoclaw-sdk/tests/fixtures/config/managed-ollama.yaml"
        ))
        .unwrap();
        value["spec"]["services"]["qwen"] = source["spec"]["services"]["ollama-server"].clone();
        value["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["overrides"]["model"] =
            json!("qwen3:0.6b");
    }
    let check_pulls = harness == "openclaw" && !authenticated;
    if check_pulls {
        value["spec"]["services"]["qwen"]["imagePullPolicy"] = json!("IfNotPresent");
    }
    value["spec"]["sandboxes"][0]["harness"]["kind"] = harness.into();
    value["spec"]["gateway"] = json!({"management":"external","endpoint":gateway.endpoint});
    value["spec"]["sandboxes"][0]["runtime"]["provider"] = json!("podman");
    value["spec"]["services"]["qwen"]["placement"] =
        json!({"engine":"ssh://operator@gpu-box","networkCidr":"172.30.119.0/24"});
    value["spec"]["services"]["qwen"]["publication"] =
        json!({"endpoint":"http://10.0.0.8:18888/v1","bindAddress":"10.0.0.8"});
    if authenticated {
        value["spec"]["services"]["qwen"]["authentication"] = "bearer".into();
        value["spec"]["sandboxes"][0]["agent"]["auth"] = json!({"method":"api-key"});
    }
    save(root, "config.yaml", &value);
    let mut files = json!({});
    let mut stats = json!({});
    let bearer = "d".repeat(64);
    if authenticated {
        files["/credentials/inference-key"] = json!({"raw":bearer});
        stats["/credentials/inference-key"] = json!({"name":"inference-key","size":64,"mode":384,"mtime":"2026-09-15T00:00:00Z","linkTarget":""});
    }
    files["/data/status.json"] =
        json!({"phase":"ready","detail":"","updated":"2026-09-15T00:00:00Z","pid":42});
    let service = &value["spec"]["services"]["qwen"];
    save(
        root,
        "fixture.json",
        &json!({"files":files,"stats":stats,"image_refs":[service["image"]],"image":{"Id":"sha256:runtime","Architecture":"arm64","Os":"linux","Config":{"Env":[],"Labels":{"org.nemoclaw.recipe.protocol":"v1","org.nemoclaw.inference.authentication":"bearer-v1","org.nemoclaw.backend":kind,"org.nemoclaw.model":service["model"]["revision"].as_str().or(service["model"]["digest"].as_str()).unwrap()}}}}),
    );
    save(
        root,
        "engine.json",
        &json!({"effects":0,"creates":0,"image_missing":check_pulls,"pulls":0}),
    );
    // Runtime-owned admission means planning needs no SSH host collector,
    // model registry access, or retained artifact inventory.
    save(root, "control.json", &json!({"capacity_failure":true}));
    run(root, &bundle, "plan", "config.yaml", true).await;
    assert_eq!(read(root, "engine.json")["effects"], 0);
    assert!(!root.join("capacity_reads").exists());
    if partial_destroy {
        save(
            root,
            "control.json",
            &json!({"network_create_failure":true}),
        );
        run(root, &bundle, "apply", "config.yaml", false).await;
        let partial = read(root, "engine.json");
        assert!(partial["volume"].is_object());
        assert!(partial["network"].is_null());
        assert!(partial["container"].is_null());
        save(root, "control.json", &json!({}));
        // OpenTofu can tear down the recorded subset without creating missing
        // compute or deleting retained data after a failed runtime operation.
        // Recovery uses current bindings and a fresh teardown plan even when
        // the failed operation's plan artifact is no longer available.
        fs::remove_file(root.join("deployment/runtime/apply.plan")).unwrap();
        let result: Value =
            serde_json::from_slice(&run(root, &bundle, "destroy", "", true).await).unwrap();
        let graph = read(root, "deployment/runtime/main.tf.json");
        let mut retained: Vec<String> = graph["resource"]
            .as_object()
            .unwrap()
            .iter()
            .flat_map(|(kind, instances)| {
                instances
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(move |name| format!("{kind}.{name}"))
            })
            .collect();
        retained.sort();
        assert_eq!(result["retained"], json!(retained));
        let repeated: Value =
            serde_json::from_slice(&run(root, &bundle, "destroy", "", true).await).unwrap();
        assert_eq!(repeated["retained"], result["retained"]);
        let destroyed = read(root, "engine.json");
        assert_eq!(destroyed["volume"], partial["volume"]);
        assert!(destroyed["network"].is_null());
        assert!(destroyed["container"].is_null());
        assert_eq!(destroyed["effects"], partial["effects"]);
        assert_eq!(read(root, "deployment/intent.json")["destroyed"], true);
        return;
    }
    // Fail before a process exists: the provider has already committed the
    // volume/network, and SDK recovery must reuse those exact identities.
    save(root, "control.json", &json!({"create_failure":true}));
    run(root, &bundle, "apply", "config.yaml", false).await;
    let partial = read(root, "engine.json");
    assert!(partial["volume"].is_object());
    assert!(partial["network"].is_object());
    assert!(partial["container"].is_null());
    assert_eq!(partial["creates"], 0);
    save(root, "control.json", &json!({"startup_failure":true}));
    run(root, &bundle, "apply", "config.yaml", false).await;
    assert_eq!(read(root, "engine.json")["creates"], 1);
    assert_eq!(read(root, "deployment/intent.json")["runtimePending"], true);
    let runtime_state = read(root, "deployment/runtime/terraform.tfstate");
    let resources = runtime_state["resources"].as_array().unwrap();
    for expected in ["docker_container", "docker_network"] {
        assert!(
            resources
                .iter()
                .any(|resource| resource["type"] == expected)
        );
    }
    assert!(!resources.iter().any(|resource| matches!(
        resource["type"].as_str(),
        Some("nemoclaw_ollama_service" | "nemoclaw_inference_service")
    )));
    assert_eq!(read(root, "engine.json")["volume"], partial["volume"]);
    assert_eq!(read(root, "engine.json")["network"], partial["network"]);
    let volume = read(root, "engine.json")["volume"].clone();
    save(root, "control.json", &json!({}));
    let mut corrected = read(root, "config.yaml");
    corrected["metadata"]["name"] = json!("corrected-runtime-intent");
    save(root, "config.yaml", &corrected);
    run(root, &bundle, "apply", "config.yaml", true).await;
    if authenticated {
        {
            let state = gateway.state.lock().unwrap();
            let provider = state.providers.values().next().unwrap();
            assert_eq!(state.providers.len(), 1);
            let profile = state.profiles.values().next().unwrap();
            assert_eq!(profile.credentials.len(), 1);
            assert_eq!(provider.credentials.len(), 1);
            assert_eq!(
                provider.credentials.get(&profile.credentials[0].name),
                Some(&bearer)
            );
        }
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
    if check_pulls {
        assert_eq!(read(root, "engine.json")["pulls"], 1);
        let original = read(root, "config.yaml");
        let mut changed = original.clone();
        changed["spec"]["services"]["qwen"]["imagePullPolicy"] = json!("Always");
        save(root, "config.yaml", &changed);
        let before = read(root, "engine.json");
        run(root, &bundle, "plan", "config.yaml", false).await;
        assert_eq!(read(root, "engine.json"), before);
        save(root, "config.yaml", &original);
    }
    // Process recovery preserves both cache and credentials.
    let before_loss = read(root, "engine.json");
    let mut missing = before_loss.clone();
    missing["container"] = Value::Null;
    save(root, "engine.json", &missing);
    run(root, &bundle, "apply", "config.yaml", true).await;
    let recreated = read(root, "engine.json");
    assert_ne!(recreated["container"]["Id"], before_loss["container"]["Id"]);
    assert_eq!(recreated["volume"], volume);
    assert_eq!(
        recreated["creates"].as_u64().unwrap(),
        before_loss["creates"].as_u64().unwrap() + 1
    );
    // Cache loss is recoverable independently of durable credentials.
    let before_cache_loss = read(root, "engine.json");
    let mut missing = before_cache_loss.clone();
    missing["container"] = Value::Null;
    missing["volume"] = Value::Null;
    save(root, "engine.json", &missing);
    run(root, &bundle, "apply", "config.yaml", true).await;
    let rebuilt = read(root, "engine.json");
    assert!(rebuilt["volume"].is_object());
    assert_eq!(rebuilt["auth_volume"], before_cache_loss["auth_volume"]);
    assert_eq!(
        rebuilt["creates"].as_u64().unwrap(),
        before_cache_loss["creates"].as_u64().unwrap() + 1
    );
    let volume = rebuilt["volume"].clone();
    let stable = rebuilt;
    run(root, &bundle, "apply", "config.yaml", true).await;
    let exported = run(root, &bundle, "export", "", true).await;
    assert!(!String::from_utf8_lossy(&exported).contains(&bearer));
    if check_pulls {
        let document = Document::parse(exported.as_slice()).unwrap();
        let policy = match &document.spec.services["qwen"] {
            ServiceDefinition::Vllm(service) => service.image_pull_policy,
            ServiceDefinition::Ollama(service) => service.image_pull_policy,
            _ => panic!("expected managed runtime"),
        };
        assert_eq!(
            policy,
            Some(nemoclaw_sdk::config::ImagePullPolicy::IfNotPresent)
        );
    }
    fs::write(root.join("export.yaml"), exported).unwrap();
    run(root, &bundle, "apply", "export.yaml", true).await;
    assert_eq!(read(root, "engine.json"), stable);
    let state = fs::read(root.join("deployment/runtime/terraform.tfstate")).unwrap();
    if harness == "openclaw" && !authenticated {
        let original = read(root, "config.yaml");
        let mut changed = original.clone();
        changed["spec"]["services"]["qwen"]["image"] =
            json!(format!("runtime@sha256:{}", "f".repeat(64)));
        save(root, "config.yaml", &changed);
        let output = run(root, &bundle, "plan", "config.yaml", true).await;
        let plan: Value = serde_json::from_slice(&output).unwrap();
        assert!(
            plan["changes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|change| { change["actions"] == json!(["delete", "create"]) }),
            "{plan}"
        );
        assert_eq!(read(root, "engine.json"), stable);
        assert_eq!(
            fs::read(root.join("deployment/runtime/terraform.tfstate")).unwrap(),
            state
        );
        save(root, "config.yaml", &original);
    }
    let mut failures = vec![json!({"transport_failure":true})];
    if authenticated {
        failures.push(json!({"daemon":"other-engine"}));
    }
    for control in failures {
        save(root, "control.json", &control);
        run(root, &bundle, "plan", "config.yaml", false).await;
        assert_eq!(
            fs::read(root.join("deployment/runtime/terraform.tfstate")).unwrap(),
            state
        );
        assert_eq!(read(root, "engine.json"), stable);
    }
    save(root, "control.json", &json!({}));
    for storage in if authenticated {
        vec!["auth_volume"]
    } else {
        vec![]
    } {
        for fault in ["missing", "foreign", "substituted"] {
            let mut damaged = stable.clone();
            match fault {
                "missing" => damaged[storage] = Value::Null,
                "foreign" => {
                    damaged[storage]["Labels"]["nemoclaw.nvidia.com/uid"] =
                        json!("ffffffff-ffff-ffff-ffff-ffffffffffff");
                }
                "substituted" => {
                    damaged[storage]["CreatedAt"] = json!("2026-09-16T00:00:00Z");
                }
                _ => unreachable!(),
            }
            save(root, "engine.json", &damaged);
            run(root, &bundle, "plan", "config.yaml", false).await;
            run(root, &bundle, "apply", "config.yaml", false).await;
            assert_eq!(read(root, "engine.json"), damaged);
            assert_eq!(
                fs::read(root.join("deployment/runtime/terraform.tfstate")).unwrap(),
                state
            );
        }
    }
    save(root, "engine.json", &stable);
    if authenticated {
        let original = read(root, "fixture.json");
        let mut corrupt = original.clone();
        corrupt["stats"]["/credentials/inference-key"]["mode"] = json!(420);
        save(root, "fixture.json", &corrupt);
        // Export does not load the generated credential. Apply must reject an insecure key.
        run(root, &bundle, "export", "", true).await;
        run(root, &bundle, "apply", "config.yaml", false).await;
        assert_same_managed_resources(
            &fs::read(root.join("deployment/runtime/terraform.tfstate")).unwrap(),
            &state,
        );
        assert_eq!(read(root, "engine.json"), stable);
        save(root, "fixture.json", &original);
    }
    assert!(
        !gateway
            .state
            .lock()
            .unwrap()
            .exec_calls
            .iter()
            .flatten()
            .any(|arg| arg.contains("inference-probe")
                || arg.contains("pi-probe")
                || arg == "probe"
                || arg == "--message")
    );
    if check_pulls {
        let mut changed = read(root, "config.yaml");
        changed["spec"]["services"]["qwen"]
            .as_object_mut()
            .unwrap()
            .remove("imagePullPolicy");
        save(root, "config.yaml", &changed);
        run(root, &bundle, "apply", "config.yaml", true).await;
        assert_eq!(read(root, "engine.json"), stable);
        let mut stopped = stable.clone();
        stopped["container"]["State"]["Running"] = json!(false);
        save(root, "engine.json", &stopped);
        save(root, "control.json", &json!({"pull_failure":true}));
        run(root, &bundle, "apply", "config.yaml", true).await;
        assert_eq!(read(root, "engine.json")["pulls"], stable["pulls"]);
        assert_eq!(read(root, "engine.json")["volume"], volume);
    }
    if authenticated {
        // Compute image changes must not change the identity of retained credentials.
        let before = read(root, "engine.json");
        let effects = gateway.state.lock().unwrap().effects;
        let mut changed = read(root, "config.yaml");
        let replacement = format!("runtime@sha256:{}", "e".repeat(64));
        changed["spec"]["services"]["qwen"]["image"] = json!(replacement);
        save(root, "config.yaml", &changed);
        let mut fixture = read(root, "fixture.json");
        fixture["image"]["Id"] = json!("sha256:replacement-runtime");
        fixture["image_refs"] = json!([replacement]);
        save(root, "fixture.json", &fixture);
        run(root, &bundle, "apply", "config.yaml", true).await;
        let replaced = read(root, "engine.json");
        assert_ne!(replaced["container"]["Id"], before["container"]["Id"]);
        assert_eq!(replaced["volume"], volume);
        let state = gateway.state.lock().unwrap();
        assert_eq!(state.effects, effects);
        assert!(
            state
                .providers
                .values()
                .any(|provider| provider.credentials.values().any(|value| value == &bearer))
        );
    }
    if authenticated {
        replacement_cleanup(root, &bundle).await;
    }
    run(root, &bundle, "destroy", "", true).await;
    let after = read(root, "engine.json");
    assert!(after["container"].is_null());
    assert!(after["deposed_container"].is_null());
    assert_eq!(after["volume"], volume);
    assert!(after["network"].is_null());
    assert!(!root.join("capacity_reads").exists());
}

// Fault injection reproduces the state persisted after a replacement creates
// its current object but fails to delete the old one. Only this owned fixture
// writes the private state format; the SDK must consume OpenTofu's public JSON.
fn interrupt_cleanup(root: &Path, old_present: bool) {
    let mut state = read(root, "deployment/runtime/terraform.tfstate");
    let container = state["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|resource| resource["type"] == "docker_container")
        .unwrap();
    let mut old = container["instances"][0].clone();
    old["deposed"] = json!("deadbeef");
    old["attributes"]["id"] = json!("old-container");
    old["attributes"]["name"] = json!("old-container");
    container["instances"].as_array_mut().unwrap().push(old);
    save(root, "deployment/runtime/terraform.tfstate", &state);
    let mut engine = read(root, "engine.json");
    let mut old = engine["container"].clone();
    old["Id"] = json!("old-container");
    old["Name"] = json!("/old-container");
    old["State"]["Running"] = json!(true);
    engine["deposed_container"] = if old_present { old } else { Value::Null };
    save(root, "engine.json", &engine);
}

async fn replacement_cleanup(root: &Path, bundle: &Path) {
    let before = read(root, "engine.json");
    interrupt_cleanup(root, true);
    save(root, "control.json", &json!({"cleanup_failure":true}));
    run(root, bundle, "apply", "config.yaml", false).await;
    assert!(read(root, "engine.json")["deposed_container"].is_object());
    let state = read(root, "deployment/runtime/terraform.tfstate");
    assert!(
        state["resources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|resource| resource["instances"]
                .as_array()
                .unwrap()
                .iter()
                .any(|instance| instance["deposed"] == "deadbeef"))
    );
    run(root, bundle, "export", "", false).await;
    save(root, "control.json", &json!({}));
    run(root, bundle, "apply", "config.yaml", true).await;
    let recovered = read(root, "engine.json");
    assert!(recovered["deposed_container"].is_null());
    for key in ["container", "volume", "auth_volume", "creates"] {
        assert_eq!(recovered[key], before[key], "cleanup changed {key}");
    }
    run(root, bundle, "export", "", true).await;
    // A lost delete response leaves an already absent old object in state.
    interrupt_cleanup(root, false);
    run(root, bundle, "apply", "config.yaml", true).await;
    assert_eq!(read(root, "engine.json")["container"], before["container"]);
    // Teardown must also accept both current and pending-delete identities.
    interrupt_cleanup(root, true);
}
