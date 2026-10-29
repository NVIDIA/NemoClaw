// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! How pinned OpenTofu and the bundled Docker provider report a container
//! replacement whose cleanup is unfinished. OpenTofu and the provider own that
//! cleanup (`docs/provider.md`), so this test pins only the plans and state the
//! SDK reads. The SDK's `replacement_cleanup` test drives `Deployment` with
//! canned copies of these shapes, so a change here must change it too.

use super::vllm_runtime::Workspace;
use serde_json::{Value, json};
use std::{fs, path::Path};

const KEY: &str = "deadbeef";
const OLD: &str = "old-container";
const ADDRESS: &str = "docker_container.service";

fn container() -> String {
    format!(
        "resource \"docker_container\" \"service\" {{\n  name  = \"service\"\n  image = \"runtime@sha256:{}\"\n}}\n",
        "a".repeat(64)
    )
}

fn read(root: &Path, name: &str) -> Value {
    serde_json::from_slice(&fs::read(root.join(name)).unwrap()).unwrap()
}

fn save(root: &Path, name: &str, value: &Value) {
    fs::write(root.join(name), value.to_string()).unwrap();
}

struct Scenario {
    workspace: Workspace,
    remote: tempfile::TempDir,
}

impl Scenario {
    fn new() -> Self {
        let remote = tempfile::tempdir().unwrap();
        let root = remote.path();
        // The Docker provider runs `ssh` from PATH without passing the
        // environment on, so the simulator reads its root from beside itself.
        nemoclaw_test_fixtures::ssh::install_simulator(&root.join("bin"), root);
        save(
            root,
            "fixture.json",
            &json!({"files":{}, "stats":{}, "image_refs":[], "image":{"Id":"sha256:runtime", "Config":{"Labels":{}}}}),
        );
        save(
            root,
            "engine.json",
            &json!({"effects":0, "creates":0, "network":{"Name":"bridge"}}),
        );
        save(root, "control.json", &json!({}));
        let workspace = Workspace::with("ssh://operator@gpu-box", &container());
        Self { workspace, remote }
    }

    fn root(&self) -> &Path {
        self.remote.path()
    }

    fn tofu(&self, args: &[&str]) -> Vec<u8> {
        let output = self
            .workspace
            .command()
            .args(args)
            .env(
                "PATH",
                nemoclaw_test_fixtures::path_with(&self.root().join("bin")),
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{args:?}\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    /// The saved plan's changes to the container, current and deposed. The
    /// SDK also reads drift, and its canned plans report none for the old
    /// container.
    fn plan(&self) -> Vec<Value> {
        self.tofu(&["plan", "-input=false", "-no-color", "-out=cleanup.plan"]);
        let plan: Value =
            serde_json::from_slice(&self.tofu(&["show", "-json", "cleanup.plan"])).unwrap();
        let drift = plan["resource_drift"].as_array().into_iter().flatten();
        assert!(
            drift.clone().all(|change| change["deposed"].is_null()),
            "{:?}",
            drift.collect::<Vec<_>>()
        );
        plan["resource_changes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|change| change["address"] == ADDRESS)
            .cloned()
            .collect()
    }

    /// The state's container objects, current and deposed.
    fn objects(&self) -> Vec<Value> {
        let state: Value = serde_json::from_slice(&self.tofu(&["show", "-json"])).unwrap();
        state["values"]["root_module"]["resources"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|resource| resource["address"] == ADDRESS)
            .cloned()
            .collect()
    }

    /// Record the old container OpenTofu keeps in state after a replacement
    /// created the new one but did not finish deleting the old one. OpenTofu
    /// writes such state itself only for `create_before_destroy`, which
    /// NemoClaw's graphs never set, so this fixture writes it.
    fn interrupt_cleanup(&self) {
        let path = self.workspace.path();
        let mut state = read(path, "terraform.tfstate");
        let resource = state["resources"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|resource| resource["type"] == "docker_container")
            .unwrap();
        let mut old = resource["instances"][0].clone();
        old["deposed"] = json!(KEY);
        old["attributes"]["id"] = json!(OLD);
        old["attributes"]["name"] = json!(OLD);
        resource["instances"].as_array_mut().unwrap().push(old);
        save(path, "terraform.tfstate", &state);
    }

    /// Run the old container on the engine, or remove it as a delete whose
    /// reply was lost would.
    fn old_container(&self, present: bool) {
        let mut engine = read(self.root(), "engine.json");
        let mut old = engine["container"].clone();
        old["Id"] = json!(OLD);
        old["Name"] = json!(format!("/{OLD}"));
        engine["deposed_container"] = if present { old } else { Value::Null };
        save(self.root(), "engine.json", &engine);
    }
}

fn deposed(changes: &[Value]) -> &Value {
    let deposed: Vec<_> = changes
        .iter()
        .filter(|change| change["deposed"].is_string())
        .collect();
    assert_eq!(deposed.len(), 1, "{changes:?}");
    assert_eq!(deposed[0]["mode"], "managed");
    assert_eq!(deposed[0]["deposed"], KEY);
    deposed[0]
}

fn current(changes: &[Value]) -> &Value {
    changes
        .iter()
        .find(|change| change.get("deposed").is_none_or(Value::is_null))
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated SSH fixture"]
async fn unfinished_replacement_cleanup_plans_in_the_shapes_the_sdk_reads() {
    let s = Scenario::new();
    s.tofu(&["apply", "-input=false", "-auto-approve", "-no-color"]);
    s.interrupt_cleanup();
    s.old_container(true);

    // State keeps the old container under its deposed key, beside the current one.
    let objects = s.objects();
    assert_eq!(objects.len(), 2, "{objects:?}");
    let old = objects
        .iter()
        .find(|object| object["deposed_key"] == KEY)
        .unwrap();
    assert_eq!(old["mode"], "managed");
    assert_eq!(old["values"]["id"], OLD);

    // Apply plans to delete only the old container, by its ID.
    let changes = s.plan();
    assert_eq!(current(&changes)["change"]["actions"], json!(["no-op"]));
    let cleanup = &deposed(&changes)["change"];
    assert_eq!(cleanup["actions"], json!(["delete"]));
    assert_eq!(cleanup["before"]["id"], OLD);
    assert!(cleanup["after"].is_null());

    // After a lost delete reply, refresh finds the old container gone and the
    // plan has nothing to do for it.
    s.old_container(false);
    let changes = s.plan();
    let cleanup = &deposed(&changes)["change"];
    assert_eq!(cleanup["actions"], json!(["no-op"]));
    assert!(cleanup["before"].is_null() && cleanup["after"].is_null());

    // Teardown, which plans without the container's configuration, deletes
    // the current and the old container.
    s.old_container(true);
    fs::write(
        s.workspace.path().join("main.tf"),
        fs::read_to_string(s.workspace.path().join("main.tf"))
            .unwrap()
            .replace(&container(), ""),
    )
    .unwrap();
    let changes = s.plan();
    assert_eq!(current(&changes)["change"]["actions"], json!(["delete"]));
    let cleanup = &deposed(&changes)["change"];
    assert_eq!(cleanup["actions"], json!(["delete"]));
    assert_eq!(cleanup["before"]["id"], OLD);
}
