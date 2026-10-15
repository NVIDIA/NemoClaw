// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! References between resources through pinned OpenTofu: one resource exports
//! its identity as a typed `ref`, and another takes it as an object input.

use crate::tofu::TofuWorkspace;
use serde_json::{Value, json};
use std::{fs, process::Output};

struct References {
    dir: TofuWorkspace,
}

impl References {
    fn new() -> Self {
        let this = Self {
            dir: TofuWorkspace::with_fixture(
                &nemoclaw_test_fixtures::Bundle::from_env(),
                nemoclaw_test_fixtures::fixture_executable("nemoclaw-fixture-provider"),
            ),
        };
        fs::write(this.dir.path().join("mode"), "normal").unwrap();
        this
    }
    /// A workspace with `label`, and a sandbox taking `workspace` (the
    /// workspace's `ref` unless a literal object is given).
    fn config(&self, label: &str, workspace: Option<Value>) {
        fs::write(self.dir.path().join("main.tf.json"), json!({
            "terraform": {"required_version": "= 1.12.6", "required_providers": {"nemoclaw": {"source": "registry.opentofu.org/nvidia/nemoclaw"}}},
            "provider": {"nemoclaw": {}},
            "resource": {
                "nemoclaw_workspace": {"team": {"name": "team", "label": label}},
                "nemoclaw_sandbox": {"coder": {
                    "name": "coder",
                    "workspace": workspace.unwrap_or_else(|| json!("${nemoclaw_workspace.team.ref}")),
                }},
            },
        }).to_string()).unwrap();
    }
    fn run(&self, args: &[&str]) -> Output {
        self.dir
            .command()
            .args(args)
            .env("NEMOCLAW_FIXTURE_DIR", self.dir.path())
            .output()
            .unwrap()
    }
    fn success(&self, args: &[&str]) -> Output {
        let output = self.run(args);
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }
    fn plan(&self) -> Value {
        self.success(&["plan", "-input=false", "-out=plan"]);
        serde_json::from_slice(&self.success(&["show", "-json", "plan"]).stdout).unwrap()
    }
    fn stored(&self, kind: &str) -> Value {
        serde_json::from_slice(&fs::read(self.dir.path().join(format!("{kind}.json"))).unwrap())
            .unwrap()
    }
}

/// The planned change for a resource address.
fn change<'a>(plan: &'a Value, address: &str) -> &'a Value {
    plan["resource_changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|change| change["address"] == address)
        .unwrap_or_else(|| panic!("no change for {address}: {plan}"))
}

#[test]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; no live services"]
fn a_ref_carries_identity_between_resources_and_replacement_follows_it() {
    let e = References::new();
    e.config("first", None);

    // The consumer keeps only the ref attributes it declares, so it is fully
    // known before the workspace exists; the workspace's own ID is not.
    let plan = e.plan();
    let workspace = change(&plan, "nemoclaw_workspace.team");
    assert_eq!(
        workspace["change"]["after"]["ref"]["type"],
        "nemoclaw_workspace"
    );
    assert_eq!(workspace["change"]["after_unknown"]["ref"]["id"], true);
    let sandbox = change(&plan, "nemoclaw_sandbox.coder");
    assert_eq!(
        sandbox["change"]["after"]["workspace"],
        json!({"type": "nemoclaw_workspace", "name": "team", "label": "first"})
    );

    e.success(&["apply", "-input=false", "plan"]);
    let stored = e.stored("sandbox");
    assert_eq!(stored["workspace"], "team");
    assert_eq!(stored["workspace_label"], "first");
    assert!(stored.get("ref").is_none());
    assert!(e.stored("workspace").get("ref").is_none());

    let plan = e.plan();
    for address in ["nemoclaw_workspace.team", "nemoclaw_sandbox.coder"] {
        assert_eq!(
            change(&plan, address)["change"]["actions"],
            json!(["no-op"]),
            "{address} changed on an unchanged plan"
        );
    }

    // A replaced workspace changes the ref, which replaces its consumer.
    e.config("second", None);
    let plan = e.plan();
    for address in ["nemoclaw_workspace.team", "nemoclaw_sandbox.coder"] {
        assert_eq!(
            change(&plan, address)["change"]["actions"],
            json!(["delete", "create"]),
            "{address}"
        );
    }
    assert_eq!(
        change(&plan, "nemoclaw_sandbox.coder")["change"]["replace_paths"],
        json!([["workspace"]])
    );
    e.success(&["apply", "-input=false", "plan"]);
    assert_eq!(e.stored("sandbox")["workspace_label"], "second");
}

#[test]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; no live services"]
fn a_ref_of_another_type_is_rejected_during_validation() {
    let e = References::new();
    e.config(
        "first",
        Some(json!({"type": "nemoclaw_registration", "name": "team", "label": "first"})),
    );
    let output = e.run(&["validate", "-no-color"]);
    assert!(!output.status.success());
    let diagnostic = String::from_utf8_lossy(&output.stderr);
    assert!(diagnostic.contains("Invalid reference"), "{diagnostic}");
    assert!(
        diagnostic.contains("Expected a ref of nemoclaw_workspace, not nemoclaw_registration"),
        "{diagnostic}"
    );
    assert!(!e.dir.path().join("sandbox.json").exists());
}
