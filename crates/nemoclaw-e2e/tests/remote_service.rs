// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_e2e::{assert_same_managed_resources, http_fixture, openshell::Fixture};
use nemoclaw_sdk::config::{Document, ServiceDefinition};
use serde_json::{Value, json};
use std::{
    fs,
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
        .env("PATH", nemoclaw_test_fixtures::path_with(&root.join("bin")))
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
        if let Ok(plan) = serde_json::from_slice::<Value>(&shown.stdout)
            && let Some(changes) = plan["resource_changes"].as_array()
        {
            for change in changes {
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
        "{command}: {}\n{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    if success && command == "apply" {
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["outcome"], "succeeded");
    }
    output.stdout
}

/// One isolated deployment: the Docker-over-SSH simulator, an OpenShell
/// gateway fixture, and the CLI state directory, all under one temporary root.
struct Scenario {
    root: PathBuf,
    bundle: PathBuf,
    gateway: Fixture,
    bearer: String,
    check_pulls: bool,
    _image_engine: http_fixture::Fixture,
    // Dropped last, after the fixtures that serve files from it.
    _directory: tempfile::TempDir,
}

impl Scenario {
    async fn new(harness: &str, authenticated: bool, kind: &str) -> Self {
        let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        // OpenTofu passes its providers only platform variables, so the fake ssh
        // finds its state in the file installed beside it, not the environment.
        nemoclaw_test_fixtures::ssh::install_simulator(&root.join("bin"), root);
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
        let check_pulls = harness == "nvidia.fabric.openclaw" && !authenticated;
        if check_pulls {
            value["spec"]["services"]["qwen"]["imagePullPolicy"] = json!("IfNotPresent");
        }
        value["spec"]["sandboxes"][0]["harness"]["kind"] = harness.into();
        value["spec"]["gateway"] = json!({"management":"external","endpoint":gateway.endpoint});
        value["spec"]["gateway"]["runtime"]["provider"] = json!("podman");
        value["spec"]["services"]["qwen"]["placement"] =
            json!({"engine":"ssh://operator@gpu-box","networkCidr":"172.30.119.0/24"});
        value["spec"]["services"]["qwen"]["publication"] =
            json!({"endpoint":"http://10.0.0.8:18888/v1","bindAddress":"10.0.0.8"});
        if authenticated {
            value["spec"]["services"]["qwen"]["authentication"] = "bearer".into();
            value["spec"]["sandboxes"][0]["agent"]["auth"] = json!({"method":"api-key"});
        }
        let mut image_document =
            Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap();
        let image_engine = nemoclaw_e2e::image_runtime::engine(&mut image_document).await;
        value["spec"]["gateway"]["engine"] = json!(image_engine.endpoint);
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
            &json!({"files":files,"stats":stats,"image_refs":[service["image"]],"image":{"Id":"sha256:runtime","Architecture":"arm64","Os":"linux","Config":{"Env":[],"Labels":{"org.nemoclaw.runtime.spec":"v1","org.nemoclaw.recipe.protocol":"v1","org.nemoclaw.inference.authentication":"bearer-v1","org.nemoclaw.backend":kind,"org.nemoclaw.model":service["model"]["revision"].as_str().or(service["model"]["digest"].as_str()).unwrap()}}}}),
        );
        save(
            root,
            "engine.json",
            &json!({"effects":0,"creates":0,"image_missing":check_pulls,"pulls":0}),
        );
        save(root, "control.json", &json!({}));
        Self {
            root: root.to_owned(),
            bundle,
            gateway,
            bearer,
            check_pulls,
            _image_engine: image_engine,
            _directory: directory,
        }
    }

    async fn run(&self, command: &str, file: &str, success: bool) -> Vec<u8> {
        run(&self.root, &self.bundle, command, file, success).await
    }

    /// Applies the authored document and returns the engine it leaves, which
    /// later unchanged applies must reproduce.
    async fn apply(&self) -> Value {
        self.run("apply", "config.yaml", true).await;
        read(&self.root, "engine.json")
    }

    fn runtime_state(&self) -> Vec<u8> {
        fs::read(self.root.join("deployment/runtime/terraform.tfstate")).unwrap()
    }
}

// Each remote service is split by what it proves: recovery while applying, and
// behavior of an applied deployment. Both start from their own fresh state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated SSH/Docker and OpenShell fixtures"]
async fn remote_model_apply_recovers_failed_creation_and_lost_process_or_cache_keeping_data() {
    apply_recovery("vllm").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated SSH/Docker and OpenShell fixtures"]
async fn remote_model_reapply_and_drift_keep_bindings_and_stop_on_observation_failure() {
    applied_deployment("vllm").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker and application-health fixtures"]
async fn remote_ollama_apply_recovers_failed_creation_and_lost_process_or_cache_keeping_data() {
    apply_recovery("ollama").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker and application-health fixtures"]
async fn remote_ollama_reapply_and_drift_keep_bindings_and_stop_on_observation_failure() {
    applied_deployment("ollama").await;
}

// Bearer scenarios leave image compatibility, readiness, and transport checks,
// which do not depend on authentication, to the scenarios above.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated credential and SSH fixtures"]
async fn managed_bearer_credentials_survive_recovery_reapply_and_replacement_outside_state() {
    let s = Scenario::new("nvidia.fabric.hermes", true, "vllm").await;
    plan_collects_no_host_capacity(&s).await;
    let volume = recover_failed_creation_and_startup(&s).await;
    bearer_is_registered_once_outside_state(&s);
    let stable = recover_lost_process_and_cache(&s, &volume).await;
    export_and_reapply_are_unchanged(&s, &stable).await;
    assert_no_probes(&s);
    bearer_survives_compute_replacement(&s, &stable["volume"]).await;
    destroy_retains_storage(&s, &stable["volume"]).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated credential and SSH fixtures"]
async fn managed_bearer_storage_or_key_damage_stops_plan_and_apply_without_changing_bindings() {
    let s = Scenario::new("nvidia.fabric.hermes", true, "vllm").await;
    // The first apply leaves attributes that the next refresh normalizes; a
    // failed apply that refreshes must be compared with the settled state.
    s.apply().await;
    let stable = s.apply().await;
    let state = s.runtime_state();
    plans_stop_on_observation_failure(&s, &stable, &state, json!({"daemon":"other-engine"})).await;
    damaged_bearer_storage_stops_plan_and_apply(&s, &stable, &state).await;
    insecure_bearer_key_stops_apply(&s, &stable, &state).await;
    destroy_retains_storage(&s, &stable["volume"]).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated credential and SSH fixtures"]
async fn managed_bearer_replacement_cleanup_recovers_and_teardown_accepts_both_identities() {
    let s = Scenario::new("nvidia.fabric.hermes", true, "vllm").await;
    let volume = s.apply().await["volume"].clone();
    replacement_cleanup(&s.root, &s.bundle).await;
    incompatible_image_blocks_changes_but_not_teardown(&s, &volume).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated SSH/Docker and OpenShell fixtures"]
async fn managed_pi_applies_without_generation_and_refused_sandbox_changes_keep_intent() {
    let s = Scenario::new("nvidia.fabric.pi", false, "vllm").await;
    present_incompatible_images_fail_before_effects(&s).await;
    plan_collects_no_host_capacity(&s).await;
    recover_failed_creation_and_startup(&s).await;
    refused_sandbox_changes_preserve_retained_intent(&s.root, &s.bundle, &s.gateway).await;
    s.run("destroy", "", true).await;
    assert!(read(&s.root, "engine.json")["container"].is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; protocol-only partial deployment fixtures"]
async fn partial_runtime_destroy_retains_storage_without_creating_network() {
    let s = Scenario::new("nvidia.fabric.openclaw", false, "vllm").await;
    plan_collects_no_host_capacity(&s).await;
    partial_destroy_retains_storage(&s).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated partial deployment fixtures"]
async fn partial_ollama_destroy_retains_storage_without_creating_network() {
    let s = Scenario::new("nvidia.fabric.openclaw", false, "ollama").await;
    plan_collects_no_host_capacity(&s).await;
    partial_destroy_retains_storage(&s).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated SSH/Docker fixtures"]
async fn unverified_vllm_images_are_checked_after_pull_before_storage() {
    pulled_incompatible_image_fails_before_storage(
        &Scenario::new("nvidia.fabric.openclaw", false, "vllm").await,
    )
    .await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated SSH/Docker fixtures"]
async fn unverified_ollama_images_are_checked_after_pull_before_storage() {
    pulled_incompatible_image_fails_before_storage(
        &Scenario::new("nvidia.fabric.openclaw", false, "ollama").await,
    )
    .await;
}

async fn apply_recovery(kind: &str) {
    let s = Scenario::new("nvidia.fabric.openclaw", false, kind).await;
    present_incompatible_images_fail_before_effects(&s).await;
    plan_collects_no_host_capacity(&s).await;
    let volume = recover_failed_creation_and_startup(&s).await;
    pull_policy_change_is_planned_without_engine_effects(&s).await;
    let stable = recover_lost_process_and_cache(&s, &volume).await;
    destroy_retains_storage(&s, &stable["volume"]).await;
}

async fn applied_deployment(kind: &str) {
    let s = Scenario::new("nvidia.fabric.openclaw", false, kind).await;
    let stable = s.apply().await;
    assert_eq!(stable["pulls"], 1);
    export_and_reapply_are_unchanged(&s, &stable).await;
    let state = readiness_is_checked_on_each_apply(&s, &stable).await;
    image_change_plans_compute_replacement_without_effects(&s, &stable, &state).await;
    plans_stop_on_observation_failure(&s, &stable, &state, json!({"transport_failure":true})).await;
    assert_no_probes(&s);
    removed_pull_policy_reapplies_without_pulling(&s, &stable).await;
    incompatible_image_blocks_changes_but_not_teardown(&s, &stable["volume"]).await;
}

async fn pulled_incompatible_image_fails_before_storage(s: &Scenario) {
    let root = s.root.as_path();
    let mut stale = read(root, "fixture.json");
    stale["image"]["Config"]["Labels"]["org.nemoclaw.runtime.spec"] = json!("v0");
    save(root, "fixture.json", &stale);
    let plan: Value = serde_json::from_slice(&s.run("plan", "config.yaml", true).await).unwrap();
    assert_eq!(plan["complete"], false);
    assert!(
        plan["deferred"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason
                .as_str()
                .unwrap()
                .contains("Runtime image compatibility")),
        "{plan}"
    );
    assert_eq!(read(root, "engine.json")["effects"], 0);
    let error = String::from_utf8(s.run("apply", "config.yaml", false).await).unwrap();
    assert!(error.contains("runtime specification"), "{error}");
    let engine = read(root, "engine.json");
    assert_eq!(engine["pulls"], 1);
    assert_eq!(engine["effects"], 1);
    assert_eq!(engine["creates"], 0);
    for resource in ["volume", "auth_volume", "network", "container"] {
        assert!(engine[resource].is_null(), "{engine}");
    }
    assert_eq!(s.gateway.state.lock().unwrap().effects, 0);
    s.run("destroy", "", true).await;
    assert_eq!(read(root, "engine.json")["effects"], 1);
}

// An already present incompatible image must fail before any owned resources exist.
async fn present_incompatible_images_fail_before_effects(s: &Scenario) {
    let root = s.root.as_path();
    let original = read(root, "fixture.json");
    let engine = read(root, "engine.json");
    save(
        root,
        "engine.json",
        &json!({"effects":0,"creates":0,"image_missing":false,"pulls":0}),
    );
    for version in [None, Some("v0"), Some("PRIVATE_IMAGE_SENTINEL")] {
        let mut stale = original.clone();
        let labels = stale["image"]["Config"]["Labels"].as_object_mut().unwrap();
        labels.remove("org.nemoclaw.runtime.spec");
        if let Some(version) = version {
            labels.insert("org.nemoclaw.runtime.spec".into(), json!(version));
        }
        save(root, "fixture.json", &stale);
        for command in ["plan", "apply"] {
            let error = String::from_utf8(s.run(command, "config.yaml", false).await).unwrap();
            assert!(error.contains("runtime specification"), "{error}");
            assert!(error.contains("rebuild"), "{error}");
            assert!(!error.contains("PRIVATE_IMAGE_SENTINEL"), "{error}");
            assert_eq!(read(root, "engine.json")["effects"], 0);
            assert_eq!(s.gateway.state.lock().unwrap().effects, 0);
        }
    }
    save(root, "fixture.json", &original);
    save(root, "engine.json", &engine);
}

// Runtime-owned admission means planning needs no SSH host collector,
// model registry access, or retained artifact inventory.
async fn plan_collects_no_host_capacity(s: &Scenario) {
    let root = s.root.as_path();
    save(root, "control.json", &json!({"capacity_failure":true}));
    s.run("plan", "config.yaml", true).await;
    assert_eq!(read(root, "engine.json")["effects"], 0);
    assert!(!root.join("capacity_reads").exists());
}

async fn partial_destroy_retains_storage(s: &Scenario) {
    let root = s.root.as_path();
    save(
        root,
        "control.json",
        &json!({"network_create_failure":true}),
    );
    s.run("apply", "config.yaml", false).await;
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
    let result: Value = serde_json::from_slice(&s.run("destroy", "", true).await).unwrap();
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
    let repeated: Value = serde_json::from_slice(&s.run("destroy", "", true).await).unwrap();
    assert_eq!(repeated["retained"], result["retained"]);
    let destroyed = read(root, "engine.json");
    assert_eq!(destroyed["volume"], partial["volume"]);
    assert!(destroyed["network"].is_null());
    assert!(destroyed["container"].is_null());
    assert_eq!(destroyed["effects"], partial["effects"]);
    assert_eq!(read(root, "deployment/intent.json")["destroyed"], true);
}

// Fail before a process exists: the provider has already committed the
// volume/network, and SDK recovery must reuse those exact identities.
// Returns the model volume that later recovery must keep.
async fn recover_failed_creation_and_startup(s: &Scenario) -> Value {
    let root = s.root.as_path();
    save(root, "control.json", &json!({"create_failure":true}));
    s.run("apply", "config.yaml", false).await;
    let partial = read(root, "engine.json");
    assert!(partial["volume"].is_object());
    assert!(partial["network"].is_object());
    assert!(partial["container"].is_null());
    assert_eq!(partial["creates"], 0);
    save(root, "control.json", &json!({"startup_failure":true}));
    s.run("apply", "config.yaml", false).await;
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
    s.run("apply", "config.yaml", true).await;
    volume
}

fn bearer_is_registered_once_outside_state(s: &Scenario) {
    {
        let state = s.gateway.state.lock().unwrap();
        let provider = state.providers.values().next().unwrap();
        assert_eq!(state.providers.len(), 1);
        let profile = state.profiles.values().next().unwrap();
        assert_eq!(profile.credentials.len(), 1);
        assert_eq!(provider.credentials.len(), 1);
        assert_eq!(
            provider.credentials.get(&profile.credentials[0].name),
            Some(&s.bearer)
        );
    }
    for name in [
        "deployment/runtime/terraform.tfstate",
        "deployment/terraform.tfstate",
        "config.yaml",
    ] {
        assert!(
            !fs::read_to_string(s.root.join(name))
                .unwrap()
                .contains(&s.bearer)
        );
    }
}

async fn pull_policy_change_is_planned_without_engine_effects(s: &Scenario) {
    let root = s.root.as_path();
    assert_eq!(read(root, "engine.json")["pulls"], 1);
    let original = read(root, "config.yaml");
    let mut changed = original.clone();
    changed["spec"]["services"]["qwen"]["imagePullPolicy"] = json!("Always");
    save(root, "config.yaml", &changed);
    let before = read(root, "engine.json");
    s.run("plan", "config.yaml", false).await;
    assert_eq!(read(root, "engine.json"), before);
    save(root, "config.yaml", &original);
}

// Returns the engine after both recoveries, which unchanged applies reproduce.
async fn recover_lost_process_and_cache(s: &Scenario, volume: &Value) -> Value {
    let root = s.root.as_path();
    // Process recovery preserves both cache and credentials.
    let before_loss = read(root, "engine.json");
    let mut missing = before_loss.clone();
    missing["container"] = Value::Null;
    save(root, "engine.json", &missing);
    s.run("apply", "config.yaml", true).await;
    let recreated = read(root, "engine.json");
    assert_ne!(recreated["container"]["Id"], before_loss["container"]["Id"]);
    assert_eq!(&recreated["volume"], volume);
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
    s.run("apply", "config.yaml", true).await;
    let rebuilt = read(root, "engine.json");
    assert!(rebuilt["volume"].is_object());
    assert_eq!(rebuilt["auth_volume"], before_cache_loss["auth_volume"]);
    assert_eq!(
        rebuilt["creates"].as_u64().unwrap(),
        before_cache_loss["creates"].as_u64().unwrap() + 1
    );
    rebuilt
}

async fn export_and_reapply_are_unchanged(s: &Scenario, stable: &Value) {
    let root = s.root.as_path();
    let exported = s.run("export", "", true).await;
    assert!(!String::from_utf8_lossy(&exported).contains(&s.bearer));
    if s.check_pulls {
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
    s.run("apply", "export.yaml", true).await;
    assert_eq!(&read(root, "engine.json"), stable);
}

// Readiness is an apply-time gate, even after a successful unchanged apply.
// Returns the runtime state after recovery, which later refusals must keep.
async fn readiness_is_checked_on_each_apply(s: &Scenario, stable: &Value) -> Vec<u8> {
    let root = s.root.as_path();
    let before_plan = s.runtime_state();
    let shell_state = fs::read(root.join("deployment/terraform.tfstate")).unwrap();
    let gateway_effects = s.gateway.state.lock().unwrap().effects;
    save(root, "control.json", &json!({"startup_failure":true}));
    let preview: Value = serde_json::from_slice(&s.run("plan", "export.yaml", true).await).unwrap();
    assert_eq!(preview["complete"], true, "{preview}");
    assert!(preview.get("deferred").is_none(), "{preview}");
    assert_eq!(preview["changes"], json!([]));
    assert!(
        preview["unverified"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message.as_str().unwrap().contains("readiness"))
    );
    assert!(
        preview["discovery"]["observations"]
            .as_object()
            .unwrap()
            .values()
            .any(|observation| observation["kind"] == "service"
                && observation["observation"]["ready"].is_null())
    );
    assert_eq!(&read(root, "engine.json"), stable);
    assert_eq!(s.gateway.state.lock().unwrap().effects, gateway_effects);
    assert_eq!(s.runtime_state(), before_plan);
    assert_eq!(
        fs::read(root.join("deployment/terraform.tfstate")).unwrap(),
        shell_state
    );
    assert!(!root.join("capacity_reads").exists());
    s.run("apply", "export.yaml", false).await;
    assert_eq!(&read(root, "engine.json"), stable);
    save(root, "control.json", &json!({}));
    s.run("apply", "export.yaml", true).await;
    s.runtime_state()
}

async fn image_change_plans_compute_replacement_without_effects(
    s: &Scenario,
    stable: &Value,
    state: &[u8],
) {
    let root = s.root.as_path();
    let original = read(root, "config.yaml");
    let mut changed = original.clone();
    changed["spec"]["services"]["qwen"]["image"] =
        json!(format!("runtime@sha256:{}", "f".repeat(64)));
    save(root, "config.yaml", &changed);
    let output = s.run("plan", "config.yaml", true).await;
    let plan: Value = serde_json::from_slice(&output).unwrap();
    assert!(
        plan["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|change| { change["actions"] == json!(["delete", "create"]) }),
        "{plan}"
    );
    assert_eq!(&read(root, "engine.json"), stable);
    assert_eq!(s.runtime_state(), state);
    save(root, "config.yaml", &original);
}

async fn plans_stop_on_observation_failure(
    s: &Scenario,
    stable: &Value,
    state: &[u8],
    control: Value,
) {
    let root = s.root.as_path();
    save(root, "control.json", &control);
    s.run("plan", "config.yaml", false).await;
    assert_eq!(s.runtime_state(), state);
    assert_eq!(&read(root, "engine.json"), stable);
    save(root, "control.json", &json!({}));
}

async fn damaged_bearer_storage_stops_plan_and_apply(s: &Scenario, stable: &Value, state: &[u8]) {
    let root = s.root.as_path();
    let storage = "auth_volume";
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
        s.run("plan", "config.yaml", false).await;
        s.run("apply", "config.yaml", false).await;
        assert_eq!(read(root, "engine.json"), damaged);
        assert_eq!(s.runtime_state(), state);
    }
    save(root, "engine.json", stable);
}

async fn insecure_bearer_key_stops_apply(s: &Scenario, stable: &Value, state: &[u8]) {
    let root = s.root.as_path();
    let original = read(root, "fixture.json");
    let mut corrupt = original.clone();
    corrupt["stats"]["/credentials/inference-key"]["mode"] = json!(420);
    save(root, "fixture.json", &corrupt);
    // Export does not load the generated credential. Apply must reject an insecure key.
    s.run("export", "", true).await;
    s.run("apply", "config.yaml", false).await;
    assert_same_managed_resources(&s.runtime_state(), state);
    assert_eq!(&read(root, "engine.json"), stable);
    save(root, "fixture.json", &original);
}

fn assert_no_probes(s: &Scenario) {
    assert!(
        !s.gateway
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
}

async fn removed_pull_policy_reapplies_without_pulling(s: &Scenario, stable: &Value) {
    let root = s.root.as_path();
    let mut changed = read(root, "config.yaml");
    changed["spec"]["services"]["qwen"]
        .as_object_mut()
        .unwrap()
        .remove("imagePullPolicy");
    save(root, "config.yaml", &changed);
    s.run("apply", "config.yaml", true).await;
    assert_eq!(&read(root, "engine.json"), stable);
    let mut stopped = stable.clone();
    stopped["container"]["State"]["Running"] = json!(false);
    save(root, "engine.json", &stopped);
    save(root, "control.json", &json!({"pull_failure":true}));
    s.run("apply", "config.yaml", true).await;
    assert_eq!(read(root, "engine.json")["pulls"], stable["pulls"]);
    assert_eq!(read(root, "engine.json")["volume"], stable["volume"]);
}

// Compute image changes must not change the identity of retained credentials.
async fn bearer_survives_compute_replacement(s: &Scenario, volume: &Value) {
    let root = s.root.as_path();
    let before = read(root, "engine.json");
    let effects = s.gateway.state.lock().unwrap().effects;
    let mut changed = read(root, "config.yaml");
    let replacement = format!("runtime@sha256:{}", "e".repeat(64));
    changed["spec"]["services"]["qwen"]["image"] = json!(replacement);
    save(root, "config.yaml", &changed);
    let mut fixture = read(root, "fixture.json");
    fixture["image"]["Id"] = json!("sha256:replacement-runtime");
    fixture["image_refs"] = json!([replacement]);
    save(root, "fixture.json", &fixture);
    s.run("apply", "config.yaml", true).await;
    let replaced = read(root, "engine.json");
    assert_ne!(replaced["container"]["Id"], before["container"]["Id"]);
    assert_eq!(&replaced["volume"], volume);
    let state = s.gateway.state.lock().unwrap();
    assert_eq!(state.effects, effects);
    assert!(state.providers.values().any(|provider| {
        provider
            .credentials
            .values()
            .any(|value| value == &s.bearer)
    }));
}

async fn incompatible_image_blocks_changes_but_not_teardown(s: &Scenario, volume: &Value) {
    let root = s.root.as_path();
    let mut stale = read(root, "fixture.json");
    stale["image"]["Config"]["Labels"]
        .as_object_mut()
        .unwrap()
        .remove("org.nemoclaw.runtime.spec");
    save(root, "fixture.json", &stale);
    let before = read(root, "engine.json");
    let bindings = s.runtime_state();
    let intent = fs::read(root.join("deployment/intent.json")).unwrap();
    for operation in ["plan", "apply"] {
        s.run(operation, "config.yaml", false).await;
        assert_eq!(read(root, "engine.json"), before);
        assert_eq!(s.runtime_state(), bindings);
        assert_eq!(
            fs::read(root.join("deployment/intent.json")).unwrap(),
            intent
        );
    }
    // Teardown must not require a compatible image for the bound workload.
    destroy_retains_storage(s, volume).await;
}

async fn destroy_retains_storage(s: &Scenario, volume: &Value) {
    s.run("destroy", "", true).await;
    let after = read(&s.root, "engine.json");
    assert!(after["container"].is_null());
    assert!(after["deposed_container"].is_null());
    assert_eq!(&after["volume"], volume);
    assert!(after["network"].is_null());
    assert!(!s.root.join("capacity_reads").exists());
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

async fn refused_sandbox_changes_preserve_retained_intent(
    root: &Path,
    bundle: &Path,
    gateway: &Fixture,
) {
    let mut original = read(root, "config.yaml");
    let mut reviewer = original["spec"]["sandboxes"][0].clone();
    reviewer["name"] = json!("reviewer");
    original["spec"]["sandboxes"]
        .as_array_mut()
        .unwrap()
        .push(reviewer);
    save(root, "config.yaml", &original);
    run(root, bundle, "apply", "config.yaml", true).await;
    let before = [
        "intent.json",
        "terraform.tfstate",
        "runtime/terraform.tfstate",
    ]
    .map(|path| fs::read(root.join("deployment").join(path)).unwrap());
    let engine = read(root, "engine.json");
    let effects = gateway.state.lock().unwrap().effects;
    for change in ["remove", "image", "policy", "image-with-runtime-change"] {
        let mut rejected = original.clone();
        match change {
            "remove" => {
                rejected["spec"]["sandboxes"].as_array_mut().unwrap().pop();
            }
            "policy" => {
                rejected["spec"]["sandboxes"][1]["network"] =
                    json!({"policy":{"explicit":{"version":1,"network_policies":{}}}});
            }
            _ => {
                rejected["spec"]["sandboxes"][1]["image"]["ref"] =
                    json!(format!("sandbox@sha256:{}", "c".repeat(64)));
                if change == "image-with-runtime-change" {
                    rejected["spec"]["services"]["qwen"]["image"] =
                        json!(format!("runtime@sha256:{}", "f".repeat(64)));
                }
            }
        }
        save(root, "rejected.yaml", &rejected);
        for operation in ["apply", "plan"] {
            let result: Value =
                serde_json::from_slice(&run(root, bundle, operation, "rejected.yaml", false).await)
                    .unwrap();
            for (path, saved) in [
                "intent.json",
                "terraform.tfstate",
                "runtime/terraform.tfstate",
            ]
            .iter()
            .zip(&before)
            {
                assert_eq!(
                    fs::read(root.join("deployment").join(path)).unwrap(),
                    *saved,
                    "{change}: {operation} changed {path}"
                );
            }
            assert_eq!(read(root, "engine.json"), engine, "{change}: {operation}");
            assert_eq!(gateway.state.lock().unwrap().effects, effects);
            let message = result["error"]["message"].as_str().unwrap();
            assert!(message.contains("reviewer"), "{result}");
            assert!(message.contains("apply cannot"), "{result}");
            assert!(!message.contains("ordinary"), "{result}");
            // Only operations that can mutate resources report remaining state.
            if operation == "apply" {
                assert_eq!(result["remainingState"], "No runtime resources changed.");
            } else {
                assert!(result.get("remainingState").is_none(), "{result}");
            }
            assert!(result["help"].as_str().unwrap().contains("docs/usage.md"));
        }
    }
    // The saved intent is byte-identical after each refusal, so one export
    // shows it still reproduces the accepted document.
    let exported = run(root, bundle, "export", "", true).await;
    assert_eq!(
        Document::parse(exported.as_slice()).unwrap(),
        Document::parse(serde_json::to_vec(&original).unwrap().as_slice()).unwrap()
    );
    // A root observation failure after runtime planning must not save a new
    // document either, even when its sandbox changes would otherwise be valid.
    let mut revised = original.clone();
    revised["metadata"]["name"] = json!("unaccepted-display-name");
    save(root, "unaccepted.yaml", &revised);
    gateway.state.lock().unwrap().fail_read = Some(("sandbox", tonic::Code::PermissionDenied));
    run(root, bundle, "apply", "unaccepted.yaml", false).await;
    assert_eq!(
        fs::read(root.join("deployment/intent.json")).unwrap(),
        before[0]
    );
    assert_eq!(read(root, "engine.json"), engine);
    assert_eq!(gateway.state.lock().unwrap().effects, effects);
    gateway.state.lock().unwrap().fail_read = None;
    run(root, bundle, "export", "", true).await;
    // The caller destroys directly, without applying the original YAML again.
}
