// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Contract tests: Fabric types through pinned OpenTofu against the fake
//! OpenShell gateway, which runs Fabric's configure, prepare, and status
//! commands, and a fake Docker engine for image capabilities.

// The fake Docker engine listens on a Unix socket.
#[cfg(unix)]
mod capabilities;
#[cfg(unix)]
#[path = "../../../test-support/http.rs"]
mod http;
mod readiness;

use nemoclaw_test_fixtures::{executable, openshell::Fixture, tofu::TofuWorkspace};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    process::Output,
};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/contract/fixtures");

fn tofu() -> PathBuf {
    let tofu = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_TOFU").expect("explicit pinned OpenTofu path"),
    );
    assert!(tofu.is_absolute());
    tofu
}

/// A provider built beside NEMOCLAW_TEST_PROVIDER, as the lifecycle tests
/// receive it.
fn provider(name: &str) -> PathBuf {
    let nemoclaw = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_PROVIDER").expect("explicit provider build path"),
    );
    assert!(nemoclaw.is_absolute());
    nemoclaw
        .parent()
        .unwrap()
        .join(executable(&format!("terraform-provider-{name}")))
}

/// A workspace with the openshell and fabric providers.
fn workspace() -> TofuWorkspace {
    TofuWorkspace::with_providers(
        tofu(),
        &[
            ("openshell", &provider("openshell")),
            ("fabric", &provider("fabric")),
        ],
    )
}

/// A sandbox with a Pi configuration, plus `extra` fixture files.
struct Standalone {
    root: TofuWorkspace,
}
impl Standalone {
    fn new(endpoint: &str, extra: &[&str]) -> Self {
        let root = workspace();
        for file in std::iter::once("main.tf").chain(extra.iter().copied()) {
            fs::copy(Path::new(FIXTURES).join(file), root.path().join(file)).unwrap();
        }
        let mut variables: Value = serde_json::from_slice(
            &fs::read(Path::new(FIXTURES).join("terraform.tfvars.json")).unwrap(),
        )
        .unwrap();
        variables["endpoint"] = json!(endpoint);
        fs::write(
            root.path().join("terraform.tfvars.json"),
            variables.to_string(),
        )
        .unwrap();
        Self { root }
    }
    fn run(&self, args: &[&str], success: bool) -> Output {
        let output = self
            .root
            .command()
            .args(args)
            .arg("-no-color")
            .env("NEMOCLAW_TEST_REGISTRATION_KEY", "fixture-secret")
            .env("NEMOCLAW_TEST_ROTATED_KEY", "rotated-fixture-secret")
            .output()
            .unwrap();
        assert_eq!(
            output.status.success(),
            success,
            "{args:?}\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }
    fn state(&self) -> Vec<u8> {
        fs::read(self.root.path().join("terraform.tfstate")).unwrap()
    }
    fn apply(&self) {
        self.run(&["apply", "-auto-approve", "-input=false"], true);
    }
    fn noop(&self) {
        self.run(&["plan", "-input=false", "-out=noop.plan"], true);
        let output = self.run(&["show", "-json", "noop.plan"], true);
        let plan: Value = serde_json::from_slice(&output.stdout).unwrap();
        for change in plan["resource_changes"].as_array().unwrap() {
            assert_eq!(change["change"]["actions"], json!(["no-op"]));
        }
    }
}

/// Every Fabric type has a contract test.
#[test]
fn every_fabric_type_has_a_contract_test() {
    let mut sources = String::new();
    for entry in fs::read_dir(FIXTURES).unwrap() {
        sources += &fs::read_to_string(entry.unwrap().path()).unwrap();
    }
    sources += include_str!("capabilities.rs");
    let used: BTreeSet<&str> = [
        "fabric_agent_configuration",
        "fabric_sandbox_readiness",
        "fabric_capabilities",
    ]
    .into_iter()
    .filter(|kind| sources.contains(&format!("\"{kind}\"")))
    .collect();
    assert_eq!(used.len(), 3, "types with a contract test: {used:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; fake OpenShell gateway"]
async fn pi_configuration_updates_without_replacing_the_sandbox() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint, &[]);
    // A configuration Fabric rejects fails validation at its field, before
    // any sandbox call, and the message never repeats the rejected value.
    let rejected = tofu.run(
        &[
            "plan",
            "-input=false",
            "-var=model=PRIVATE_SENTINEL",
            r#"-var=adapter=["PRIVATE_SENTINEL"]"#,
        ],
        false,
    );
    let stderr = String::from_utf8_lossy(&rejected.stderr);
    assert!(stderr.contains("Invalid config_json"), "{stderr}");
    assert!(stderr.contains("at harness.adapter_id"), "{stderr}");
    assert!(!stderr.contains("PRIVATE_SENTINEL"), "{stderr}");
    assert!(fixture.state.lock().unwrap().exec_calls.is_empty());
    tofu.run(&["plan", "-input=false"], true);
    assert!(fixture.state.lock().unwrap().exec_calls.is_empty());
    tofu.apply();
    let effects = fixture.state.lock().unwrap().effects;
    let writes = || {
        fixture
            .state
            .lock()
            .unwrap()
            .exec_calls
            .iter()
            .filter(|command| {
                command
                    .get(1)
                    .is_some_and(|arg| arg == "configure" || arg == "prepare")
            })
            .count()
    };
    assert_eq!(writes(), 1);
    tofu.noop();
    assert_eq!(writes(), 1, "no-op must not reconfigure Pi");
    tofu.run(
        &[
            "plan",
            "-input=false",
            "-var=model=second-model",
            "-out=change.plan",
        ],
        true,
    );
    assert_eq!(writes(), 1, "plan must not configure Pi");
    tofu.run(&["apply", "-input=false", "change.plan"], true);
    assert_eq!(writes(), 2);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    // A stopped host is observed as drift; explicit apply reconfigures it.
    let sandbox_id = fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .values()
        .next()
        .unwrap()
        .metadata
        .as_ref()
        .unwrap()
        .id
        .clone();
    fixture
        .state
        .lock()
        .unwrap()
        .fabric_stopped
        .insert(sandbox_id.clone());
    tofu.run(
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-var=model=second-model",
        ],
        true,
    );
    assert_eq!(writes(), 3);
    assert!(
        !fixture
            .state
            .lock()
            .unwrap()
            .fabric_stopped
            .contains(&sandbox_id)
    );
    // Lose the exec response after the host accepted a configuration. Never
    // retry the mutation automatically; the next refresh observes the outcome.
    tofu.run(
        &[
            "plan",
            "-input=false",
            "-var=model=third-model",
            "-out=ambiguous.plan",
        ],
        true,
    );
    fixture.state.lock().unwrap().lose_configure_reply = true;
    tofu.run(&["apply", "-input=false", "ambiguous.plan"], false);
    assert_eq!(writes(), 4);
    assert!(!fixture.state.lock().unwrap().lose_configure_reply);
    tofu.run(
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-var=model=third-model",
        ],
        true,
    );
    assert_eq!(
        writes(),
        4,
        "confirmed configuration must not be written again"
    );
    let prior = tofu.state();
    fixture.state.lock().unwrap().exec_truncated = true;
    tofu.run(&["plan", "-input=false", "-var=model=second-model"], false);
    assert_eq!(tofu.state(), prior);
    assert_eq!(writes(), 4);
    assert!(!fixture.state.lock().unwrap().lose_configure_reply);
    tofu.run(
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-var=enabled=false",
            "-var=destroying=true",
        ],
        true,
    );
    assert!(fixture.state.lock().unwrap().sandboxes.is_empty());
    assert_eq!(writes(), 4, "destroy must not reconfigure Pi");
}
