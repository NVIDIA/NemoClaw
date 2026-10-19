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
            .current_dir(root.join("deployment"))
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
        value["spec"]["services"]["qwen"]["container"] = json!({
            "cpuLimitMillis": if kind == "ollama" { 10 } else { 1250 },
            "memoryLimitGiB": 64
        });
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
            &json!({"files":files,"stats":stats,"image_refs":[service["image"]],"image":{"Id":"sha256:runtime","Architecture":"arm64","Os":"linux","Config":{"Env":[],"Labels":{"org.nemoclaw.recipe.protocol":"v1","org.nemoclaw.inference.authentication":"bearer-v1","org.nemoclaw.inference.routes":"openai-v2","org.nemoclaw.backend":kind,"org.nemoclaw.model":service["model"]["revision"].as_str().or(service["model"]["digest"].as_str()).unwrap()}}}}),
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

    /// Why `nemoclaw export` refuses this deployment; the reason names its
    /// unfinished or destroyed state without reading the SDK's files.
    async fn export_refusal(&self) -> String {
        let output = tokio::process::Command::new(self.bundle.join("bin/nemoclaw"))
            .arg("--state-dir")
            .arg(self.root.join("deployment"))
            .arg("export")
            .output()
            .await
            .unwrap();
        assert!(!output.status.success());
        String::from_utf8(output.stderr).unwrap()
    }

    /// Applies the authored document and returns the engine it leaves, which
    /// later unchanged applies must reproduce.
    async fn apply(&self) -> Value {
        self.run("apply", "config.yaml", true).await;
        let state = read(&self.root, "engine.json");
        let config = read(&self.root, "config.yaml");
        let limits = &config["spec"]["services"]["qwen"]["container"];
        let host = &state["container"]["HostConfig"];
        // A 100 ms period, as on Kubernetes; Ollama's 10 millicores give the
        // kernel's 1 ms minimum quota.
        assert_eq!(host["CpuPeriod"], 100_000);
        assert_eq!(
            host["CpuQuota"],
            limits["cpuLimitMillis"].as_u64().unwrap() * 100
        );
        assert_eq!(
            host["Memory"],
            limits["memoryLimitGiB"].as_u64().unwrap() * (1_u64 << 30)
        );
        assert_eq!(host["MemorySwap"], host["Memory"]);
        assert_eq!(
            state["container"]["Config"]["Labels"]["nemoclaw.nvidia.com/memory-limit-gib"],
            limits["memoryLimitGiB"].to_string()
        );
        state
    }

    fn runtime_state(&self) -> Vec<u8> {
        fs::read(self.root.join("deployment/terraform.tfstate")).unwrap()
    }
}

// Every runtime plan, apply, export, or destroy after the service network
// exists reads it, and the Docker provider waits 2 s before each read. Each
// scenario therefore creates one runtime and runs every check that needs it,
// unless those checks would exceed the lifecycle per-test limit in
// .config/test-budgets.yaml.
//
// vLLM recovery runs in the bearer scenario below. The runtime-independent
// checks of an applied deployment (the readiness gate and pull policy reapply)
// run once, against vLLM. Replacement protection runs for both model kinds, in
// scenarios of its own that keep the reapply and recovery scenarios under that
// limit. The memory decrease, whose compiled label does not depend on the kind,
// runs once, against Ollama. The provider's readiness and storage tests cover
// their own observations.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated SSH/Docker and OpenShell fixtures"]
async fn remote_model_reapply_and_drift_keep_bindings_and_stop_on_observation_failure() {
    let s = Scenario::new("nvidia.fabric.openclaw", false, "vllm").await;
    let stable = s.apply().await;
    assert_eq!(stable["pulls"], 1);
    export_and_reapply_are_unchanged(&s, &stable).await;
    let state = readiness_is_checked_on_each_apply(&s, &stable).await;
    plans_stop_on_observation_failure(&s, &stable, &state, json!({"transport_failure":true})).await;
    assert_no_probes(&s);
    removed_pull_policy_reapplies_without_pulling(&s, &stable).await;
    incompatible_image_blocks_changes_but_not_teardown(&s, &stable["volume"]).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker and application-health fixtures"]
async fn remote_ollama_recovers_reapplies_and_stops_on_observation_failure_keeping_data() {
    let s = Scenario::new("nvidia.fabric.openclaw", false, "ollama").await;
    present_incompatible_images_fail_before_effects(&s).await;
    plan_collects_no_host_capacity(&s).await;
    let volume = recover_failed_creation_and_startup(&s).await;
    pull_policy_change_is_planned_without_engine_effects(&s).await;
    let stable = recover_lost_process_and_cache(&s, &volume).await;
    export_and_reapply_are_unchanged(&s, &stable).await;
    let state = s.runtime_state();
    plans_stop_on_observation_failure(&s, &stable, &state, json!({"transport_failure":true})).await;
    assert_no_probes(&s);
    incompatible_image_blocks_changes_but_not_teardown(&s, &stable["volume"]).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated SSH/Docker and OpenShell fixtures"]
async fn remote_vllm_preserve_refuses_image_change_and_recreate_plans_replacement() {
    let s = Scenario::new("nvidia.fabric.openclaw", false, "vllm").await;
    let stable = s.apply().await;
    let state = s.runtime_state();
    image_change_plans_compute_replacement_without_effects(&s, &stable, &state).await;
    assert_no_probes(&s);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated SSH/Docker and OpenShell fixtures"]
async fn remote_ollama_preserve_refuses_image_and_memory_changes_and_recreate_plans_replacement() {
    let s = Scenario::new("nvidia.fabric.openclaw", false, "ollama").await;
    let stable = s.apply().await;
    let state = s.runtime_state();
    image_change_plans_compute_replacement_without_effects(&s, &stable, &state).await;
    memory_change_plans_compute_replacement_without_effects(&s, &stable, &state).await;
    assert_no_probes(&s);
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
async fn managed_bearer_cleanup_recovers_damage_keeps_bindings_and_teardown_accepts_both_identities()
 {
    let s = Scenario::new("nvidia.fabric.hermes", true, "vllm").await;
    let volume = s.apply().await["volume"].clone();
    replacement_cleanup(&s.root, &s.bundle).await;
    // Cleanup ends with applies that settle the state; a failed apply that
    // refreshes must be compared with that settled state.
    let stable = read(&s.root, "engine.json");
    let state = s.runtime_state();
    plans_stop_on_observation_failure(&s, &stable, &state, json!({"daemon":"other-engine"})).await;
    damaged_bearer_storage_stops_plan_and_apply(&s, &stable, &state).await;
    insecure_bearer_key_stops_apply(&s, &stable, &state).await;
    // Teardown must also accept both current and pending-delete identities.
    interrupt_cleanup(&s.root, true);
    incompatible_image_blocks_changes_but_not_teardown(&s, &volume).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated SSH/Docker and OpenShell fixtures"]
async fn managed_pi_applies_without_generation_and_failed_sandbox_changes_keep_intent() {
    let s = Scenario::new("nvidia.fabric.pi", false, "vllm").await;
    present_incompatible_images_fail_before_effects(&s).await;
    plan_collects_no_host_capacity(&s).await;
    s.apply().await;
    failed_sandbox_and_runtime_change_preserves_retained_intent(&s.root, &s.bundle, &s.gateway)
        .await;
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

async fn pulled_incompatible_image_fails_before_storage(s: &Scenario) {
    let root = s.root.as_path();
    let mut stale = read(root, "fixture.json");
    stale["image"]["Config"]["Labels"]["org.nemoclaw.backend"] = json!("other");
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
    assert!(error.contains("org.nemoclaw.backend"), "{error}");
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

// The fast host-image matrix owns label variations. Each backend keeps this
// native check that a private invalid value is rejected before any mutation.
async fn present_incompatible_images_fail_before_effects(s: &Scenario) {
    let root = s.root.as_path();
    let original = read(root, "fixture.json");
    let engine = read(root, "engine.json");
    save(
        root,
        "engine.json",
        &json!({"effects":0,"creates":0,"image_missing":false,"pulls":0}),
    );
    let mut stale = original.clone();
    stale["image"]["Config"]["Labels"]["org.nemoclaw.backend"] = json!("PRIVATE_IMAGE_SENTINEL");
    save(root, "fixture.json", &stale);
    for command in ["plan", "apply"] {
        let error = String::from_utf8(s.run(command, "config.yaml", false).await).unwrap();
        assert!(error.contains("org.nemoclaw.backend"), "{error}");
        assert!(!error.contains("PRIVATE_IMAGE_SENTINEL"), "{error}");
        assert_eq!(read(root, "engine.json")["effects"], 0);
        assert_eq!(s.gateway.state.lock().unwrap().effects, 0);
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
    fs::remove_file(root.join("deployment/apply.plan")).unwrap();
    let result: Value = serde_json::from_slice(&s.run("destroy", "", true).await).unwrap();
    let graph = read(root, "deployment/main.tf.json");
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
    let refusal = s.export_refusal().await;
    assert!(
        refusal.contains("cannot export a destroyed deployment"),
        "{refusal}"
    );
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
    // The failed apply never reached an object whose creation reply could be
    // lost, so nothing is pending; export still refuses the unbound resources.
    let refusal = s.export_refusal().await;
    assert!(
        refusal.contains("export requires all declared resource bindings"),
        "{refusal}"
    );
    let runtime_state = read(root, "deployment/terraform.tfstate");
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
        "deployment/terraform.tfstate",
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
    let mut changed = read(&s.root, "config.yaml");
    changed["spec"]["services"]["qwen"]["image"] =
        json!(format!("runtime@sha256:{}", "f".repeat(64)));
    change_plans_compute_replacement_without_effects(s, stable, state, changed).await;
}

// The Docker provider would lower memory on the running model in place, where
// the kernel can OOM-kill it; Preserve must refuse the change as a replacement.
async fn memory_change_plans_compute_replacement_without_effects(
    s: &Scenario,
    stable: &Value,
    state: &[u8],
) {
    let mut changed = read(&s.root, "config.yaml");
    changed["spec"]["services"]["qwen"]["container"]["memoryLimitGiB"] = json!(32);
    change_plans_compute_replacement_without_effects(s, stable, state, changed).await;
}

async fn change_plans_compute_replacement_without_effects(
    s: &Scenario,
    stable: &Value,
    state: &[u8],
    mut changed: Value,
) {
    let root = s.root.as_path();
    let original = read(root, "config.yaml");
    save(root, "config.yaml", &changed);
    let intent = fs::read(root.join("deployment/intent.json")).unwrap();
    for operation in ["plan", "apply"] {
        let refusal: Value =
            serde_json::from_slice(&s.run(operation, "config.yaml", false).await).unwrap();
        assert!(
            refusal["error"]["message"]
                .as_str()
                .unwrap()
                .contains("updatePolicy: Recreate"),
            "{refusal}"
        );
        assert!(
            refusal["help"]
                .as_str()
                .unwrap()
                .contains("spec.services.qwen.updatePolicy: Recreate"),
            "{refusal}"
        );
        assert_eq!(&read(root, "engine.json"), stable);
        assert_eq!(s.runtime_state(), state);
        assert_eq!(
            fs::read(root.join("deployment/intent.json")).unwrap(),
            intent
        );
    }
    changed["spec"]["services"]["qwen"]["updatePolicy"] = json!("Recreate");
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

// The provider's storage contract tests cover missing, foreign, and
// substituted volumes; one substituted credential volume shows that the CLI
// stops before changing bindings.
async fn damaged_bearer_storage_stops_plan_and_apply(s: &Scenario, stable: &Value, state: &[u8]) {
    let root = s.root.as_path();
    let mut damaged = stable.clone();
    damaged["auth_volume"]["CreatedAt"] = json!("2026-09-16T00:00:00Z");
    save(root, "engine.json", &damaged);
    s.run("plan", "config.yaml", false).await;
    s.run("apply", "config.yaml", false).await;
    assert_eq!(read(root, "engine.json"), damaged);
    assert_eq!(s.runtime_state(), state);
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
    // The provider refreshes a stopped container as must_run=false. Because
    // the stopped container has no active port map, its published port also
    // drifts and the plan replaces it, which Preserve allows.
    let plan: Value = serde_json::from_slice(&s.run("plan", "config.yaml", true).await).unwrap();
    let address = "docker_container.inference_service_inference_qwen";
    assert!(
        plan["changes"]
            .as_array()
            .unwrap()
            .contains(&json!({"resource": address, "actions": ["delete", "create"]})),
        "{plan}"
    );
    let shown = tokio::process::Command::new(s.bundle.join("libexec/tofu"))
        .args(["show", "-json", "apply.plan"])
        .current_dir(root.join("deployment"))
        .output()
        .await
        .unwrap();
    let shown: Value = serde_json::from_slice(&shown.stdout).unwrap();
    let change = shown["resource_changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|change| change["address"] == address)
        .unwrap();
    assert_eq!(change["change"]["before"]["must_run"], false, "{change}");
    s.run("apply", "config.yaml", true).await;
    let replaced = read(root, "engine.json");
    assert_ne!(replaced["container"]["Id"], stable["container"]["Id"]);
    assert_eq!(replaced["container"]["State"]["Running"], true);
    assert_eq!(
        replaced["creates"].as_u64().unwrap(),
        stable["creates"].as_u64().unwrap() + 1
    );
    assert_eq!(replaced["pulls"], stable["pulls"]);
    assert_eq!(replaced["volume"], stable["volume"]);
}

// Compute image changes must not change the identity of retained credentials.
async fn bearer_survives_compute_replacement(s: &Scenario, volume: &Value) {
    let root = s.root.as_path();
    let before = read(root, "engine.json");
    let effects = s.gateway.state.lock().unwrap().effects;
    let mut changed = read(root, "config.yaml");
    let replacement = format!("runtime@sha256:{}", "e".repeat(64));
    changed["spec"]["services"]["qwen"]["image"] = json!(replacement);
    changed["spec"]["services"]["qwen"]["updatePolicy"] = json!("Recreate");
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
        .remove("org.nemoclaw.backend");
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
    let mut state = read(root, "deployment/terraform.tfstate");
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
    save(root, "deployment/terraform.tfstate", &state);
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
    let state = read(root, "deployment/terraform.tfstate");
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
}

async fn failed_sandbox_and_runtime_change_preserves_retained_intent(
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
    let before = ["intent.json", "terraform.tfstate"]
        .map(|path| fs::read(root.join("deployment").join(path)).unwrap());
    let engine = read(root, "engine.json");
    let effects = gateway.state.lock().unwrap().effects;
    // The SDK integration matrix covers individual sandbox edits. This native
    // case proves a replacement whose new images fail their checks stops before
    // any change, without partially updating its model runtime.
    let mut rejected = original.clone();
    rejected["spec"]["sandboxes"][1]["image"]["ref"] =
        json!(format!("sandbox@sha256:{}", "c".repeat(64)));
    rejected["spec"]["services"]["qwen"]["image"] =
        json!(format!("runtime@sha256:{}", "f".repeat(64)));
    save(root, "rejected.yaml", &rejected);
    for operation in ["apply", "plan"] {
        let result: Value =
            serde_json::from_slice(&run(root, bundle, operation, "rejected.yaml", false).await)
                .unwrap();
        for (path, saved) in ["intent.json", "terraform.tfstate"].iter().zip(&before) {
            assert_eq!(
                fs::read(root.join("deployment").join(path)).unwrap(),
                *saved,
                "{operation} changed {path}"
            );
        }
        assert_eq!(read(root, "engine.json"), engine, "{operation}");
        assert_eq!(gateway.state.lock().unwrap().effects, effects);
        let message = result["error"]["message"].as_str().unwrap();
        assert!(message.contains("reviewer"), "{result}");
        // Only operations that can mutate resources report remaining state.
        if operation == "apply" {
            assert_eq!(result["remainingState"], "No runtime resources changed.");
        } else {
            assert!(result.get("remainingState").is_none(), "{result}");
        }
    }
    // The saved intent is byte-identical after each failure, so one export
    // shows it still reproduces the accepted document.
    let exported = run(root, bundle, "export", "", true).await;
    assert_eq!(
        Document::parse(exported.as_slice()).unwrap(),
        Document::parse(serde_json::to_vec(&original).unwrap().as_slice()).unwrap()
    );
    // An observation failure must not save a new document either, even when
    // its sandbox changes would otherwise be valid.
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
    // The caller destroys directly, without applying the original YAML again.
}
