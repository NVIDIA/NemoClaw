// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Deterministic managed-service protocol with real agent image execution.
//! GPU admission and weight loading remain runtime qualification responsibilities.
use super::support::Scenario;
use nemoclaw_sdk::config::Document;
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt};

/// Complete engine observation, kept opaque so tests describe preservation intent.
#[derive(Debug, PartialEq)]
pub struct ServiceSnapshot(Value);

pub struct ManagedService {
    root: tempfile::TempDir,
    pub document: Document,
}
impl ManagedService {
    pub async fn start(scenario: &mut Scenario) -> Self {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("bin")).unwrap();
        let ssh = root.path().join("bin/ssh");
        fs::write(&ssh, include_bytes!("../fixtures/remote_ssh.py")).unwrap();
        fs::set_permissions(ssh, fs::Permissions::from_mode(0o700)).unwrap();
        let endpoint = scenario
            .managed_model_endpoint(root.path().join("engine.json"))
            .await;
        let address = endpoint
            .strip_prefix("http://")
            .unwrap()
            .split(':')
            .next()
            .unwrap();
        let port: u16 = endpoint
            .strip_suffix("/v1")
            .unwrap()
            .rsplit(':')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let mut document = serde_json::to_value(scenario.proxy_document(1).await).unwrap();
        document["spec"]["services"]["shared"] = json!({
            "kind":"ollama", "hardware":{"profile":"dgx-spark"},
            "image":format!("nc-managed-ollama-fixture@sha256:{}", "a".repeat(64)),
            "imagePullPolicy":"Never",
            "model":{"name":"llama3:fixture","digest":"a".repeat(64)},
            "serving":{"port":port,"contextTokens":8192},
            "memory":{"gpuMemoryGiB":16},
            "placement":{"engine":"ssh://operator@service-fixture","networkCidr":"172.30.119.0/24"},
            "publication":{"endpoint":endpoint,"bindAddress":address}
        });
        let document = Document::parse(document.to_string().as_bytes()).unwrap();
        let fixture = Self { root, document };
        let service =
            serde_json::to_value(&fixture.document).unwrap()["spec"]["services"]["shared"].clone();
        fixture.write("fixture.json", &json!({
            "files":{"/data/status.json":{"phase":"ready","detail":"","updated":"2026-09-15T00:00:00Z","pid":42}},
            "stats":{}, "image_refs":[service["image"]],
            "image":{"Id":"sha256:runtime","Architecture":"arm64","Os":"linux","Config":{"Env":[],"Labels":{
                "org.nemoclaw.runtime.spec":"v1", "org.nemoclaw.recipe.protocol":"v1", "org.nemoclaw.backend":"ollama", "org.nemoclaw.model":"a".repeat(64)
            }}}
        }));
        fixture.write(
            "engine.json",
            &json!({"effects":0,"creates":0,"image_missing":false,"pulls":0}),
        );
        fixture.control(json!({}));
        fixture
    }
    fn write(&self, name: &str, value: &Value) {
        fs::write(
            self.root.path().join(name),
            serde_json::to_vec(value).unwrap(),
        )
        .unwrap();
    }
    fn engine(&self) -> Value {
        serde_json::from_slice(&fs::read(self.root.path().join("engine.json")).unwrap()).unwrap()
    }
    fn control(&self, value: Value) {
        self.write("control.json", &value);
    }
    async fn run(&self, scenario: &Scenario, command: &str, success: bool) -> Value {
        let document = self.root.path().join("config.json");
        fs::write(&document, serde_json::to_vec(&self.document).unwrap()).unwrap();
        let mut child = tokio::process::Command::new(scenario.bundle.join("bin/nemoclaw"));
        child
            .arg(command)
            .arg("--state-dir")
            .arg(scenario.state.path());
        if matches!(command, "plan" | "apply") {
            child.arg(document);
        }
        if command != "export" {
            child.args(["-o", "json"]);
        }
        let output = child
            .env(
                "PATH",
                format!(
                    "{}:{}",
                    self.root.path().join("bin").display(),
                    std::env::var("PATH").unwrap()
                ),
            )
            .env("NEMOCLAW_TEST_REMOTE", self.root.path())
            .output()
            .await
            .unwrap();
        assert_eq!(
            output.status.success(),
            success,
            "{command}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if command == "export" {
            return serde_json::to_value(Document::parse(output.stdout.as_slice()).unwrap())
                .unwrap();
        }
        serde_json::from_slice(&output.stdout).unwrap()
    }
    pub fn fail_capacity_observation(&self) {
        self.control(json!({"capacity_failure": true}));
    }
    pub fn fail_container_creation(&self) {
        self.control(json!({"create_failure": true}));
    }
    pub fn fail_ssh_observation(&self) {
        self.control(json!({"transport_failure": true}));
    }
    pub fn clear_failures(&self) {
        self.control(json!({}));
    }
    pub async fn plan(&self, scenario: &Scenario) {
        self.run(scenario, "plan", true).await;
    }
    pub async fn plan_expect_failure(&self, scenario: &Scenario) {
        self.run(scenario, "plan", false).await;
    }
    pub async fn apply(&self, scenario: &Scenario) {
        self.run(scenario, "apply", true).await;
    }
    pub async fn apply_expect_failure(&self, scenario: &Scenario) {
        self.run(scenario, "apply", false).await;
    }
    pub async fn assert_apply_unchanged(&self, scenario: &Scenario) {
        let result = self.run(scenario, "apply", true).await;
        assert_eq!(result["changes"], json!([]), "reapply must have no changes");
    }
    pub async fn assert_export_matches_document(&self, scenario: &Scenario) {
        let exported = self.run(scenario, "export", true).await;
        assert_eq!(exported, serde_json::to_value(&self.document).unwrap());
    }
    pub async fn destroy(&self, scenario: &Scenario) {
        self.run(scenario, "destroy", true).await;
    }
    pub fn snapshot(&self) -> ServiceSnapshot {
        ServiceSnapshot(self.engine())
    }
    pub fn assert_no_effects(&self) {
        assert_eq!(
            self.engine()["effects"],
            0,
            "plan must not mutate the service"
        );
    }
    pub fn assert_no_capacity_observations(&self) {
        assert!(!self.has_capacity_reads(), "plan must not observe capacity");
    }
    pub fn assert_storage_created_without_container(&self) {
        let state = self.engine();
        assert!(state["volume"].is_object(), "model storage must exist");
        assert!(
            state["container"].is_null(),
            "failed creation must leave no container"
        );
    }
    pub fn assert_storage_retained(&self, before: &ServiceSnapshot) {
        assert_eq!(
            self.engine()["volume"],
            before.0["volume"],
            "model storage must be retained"
        );
    }
    pub fn assert_running(&self) {
        assert_eq!(self.engine()["container"]["State"]["Running"], true);
    }
    pub fn assert_container_preserved(&self, before: &ServiceSnapshot) {
        assert_eq!(
            self.engine()["container"]["Id"],
            before.0["container"]["Id"],
            "service container must not be replaced"
        );
    }
    pub fn assert_unchanged(&self, before: &ServiceSnapshot) {
        assert_eq!(
            &self.snapshot(),
            before,
            "remote resources must remain unchanged"
        );
    }
    pub fn assert_destroyed_with_storage_retained(&self, before: &ServiceSnapshot) {
        let state = self.engine();
        assert!(
            state["container"].is_null(),
            "service container must be removed"
        );
        assert!(
            state["network"].is_null(),
            "service network must be removed"
        );
        assert_eq!(
            state["volume"], before.0["volume"],
            "model storage must be retained"
        );
    }
    pub fn assert_runtime_configuration(&self) {
        let remote = self.engine();
        let configuration = remote["container"]["Config"]["Env"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|entry| {
                entry
                    .as_str()
                    .unwrap()
                    .strip_prefix("NEMOCLAW_RUNTIME_SPEC=")
            })
            .expect("supervisor configuration was not delivered to the service");
        let nemoclaw_runtime::RuntimeSpec::Ollama(runtime) =
            nemoclaw_runtime::RuntimeSpec::decode(configuration).unwrap()
        else {
            panic!("wrong runtime backend");
        };
        assert_eq!(runtime.model.name, "llama3:fixture");
        assert_eq!(runtime.model.digest, "a".repeat(64));
        assert_eq!(runtime.serving.context_tokens, 8192);
        let mounts = remote["container"]["Mounts"].as_array().unwrap();
        let data = mounts
            .iter()
            .find(|mount| mount["Destination"] == "/data")
            .unwrap();
        assert_eq!(data["Name"], remote["volume"]["Name"]);
        assert_eq!(data["RW"], true);
    }
    pub fn assert_remote_publication(&self) {
        let document = serde_json::to_value(&self.document).unwrap();
        let service = &document["spec"]["services"]["shared"];
        assert_eq!(
            service["placement"]["engine"],
            "ssh://operator@service-fixture"
        );
        assert_ne!(
            service["placement"]["engine"],
            document["spec"]["gateway"]["engine"]
        );
        let remote = self.engine();
        let ports = remote["container"]["HostConfig"]["PortBindings"]
            .as_object()
            .unwrap();
        assert_eq!(ports.len(), 1);
        assert_eq!(
            ports.values().next().unwrap()[0]["HostIp"],
            service["publication"]["bindAddress"]
        );
        let filter = format!(
            "label=nemoclaw.nvidia.com/uid={}",
            self.document.metadata.uid
        );
        assert!(
            super::support::docker(&["container", "ls", "--all", "-q", "--filter", &filter])
                .is_empty(),
            "model compute leaked onto the gateway engine"
        );
        assert!(
            super::support::docker(&["volume", "ls", "-q", "--filter", &filter]).is_empty(),
            "remote model storage leaked onto the gateway engine"
        );
    }
    fn has_capacity_reads(&self) -> bool {
        self.root.path().join("capacity_reads").exists()
    }
}
