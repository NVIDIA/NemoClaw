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

use nemoclaw_test_fixtures::{Bundle, openshell::Fixture, tofu::TofuWorkspace};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    process::Output,
};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/contract/fixtures");

/// The fabric provider Cargo built from this checkout, the one under test.
fn fabric() -> PathBuf {
    nemoclaw_test_fixtures::package_executable!("terraform-provider-fabric")
}

/// A workspace with the fabric provider under test and the bundle's openshell
/// provider.
fn workspace() -> TofuWorkspace {
    let bundle = Bundle::from_env();
    TofuWorkspace::with_providers(
        bundle.tofu(),
        &[
            ("openshell", &bundle.provider("openshell")),
            ("fabric", &fabric()),
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
        // The harness ref carries the catalog records its agents plan against.
        variables["catalog_json"] = json!(
            serde_json::to_string(
                &nemoclaw_fabric::catalog::FabricCatalog::bundled().for_adapter("nvidia.fabric.pi")
            )
            .unwrap()
        );
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
    let used: BTreeSet<&str> = ["fabric_agent", "fabric_agent_readiness", "fabric_harnesses"]
        .into_iter()
        .filter(|kind| sources.contains(&format!("\"{kind}\"")))
        .collect();
    assert_eq!(used.len(), 3, "types with a contract test: {used:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
async fn removing_an_agent_stops_it_without_removing_its_sandbox() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint, &[]);
    tofu.apply();
    let sandboxes = fixture.state.lock().unwrap().sandboxes.clone();
    tofu.run(
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-var=agent_enabled=false",
        ],
        true,
    );
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.sandboxes, sandboxes);
        assert!(state.fabric_configurations.is_empty());
        assert_eq!(
            state
                .exec_calls
                .iter()
                .filter(|args| args.get(1).is_some_and(|arg| arg == "stop"))
                .count(),
            1
        );
    }
    // The removed agent has no state to remove again.
    tofu.run(
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-var=agent_enabled=false",
        ],
        true,
    );
    assert_eq!(fixture.state.lock().unwrap().sandboxes, sandboxes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
async fn removing_an_agent_from_an_old_image_retains_its_binding_with_guidance() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint, &[]);
    tofu.apply();
    fixture.state.lock().unwrap().stop_unsupported = true;
    let output = tofu.run(
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-var=agent_enabled=false",
        ],
        false,
    );
    let diagnostic = String::from_utf8_lossy(&output.stderr)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        diagnostic.contains("image must support fabric-agent stop"),
        "{diagnostic}"
    );
    assert!(diagnostic.contains("resources retained"), "{diagnostic}");
    let state: Value = serde_json::from_slice(&tofu.state()).unwrap();
    assert!(
        state["resources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|resource| resource["type"] == "fabric_agent")
    );
    assert!(
        !fixture
            .state
            .lock()
            .unwrap()
            .fabric_configurations
            .is_empty()
    );
    assert_eq!(
        fixture
            .state
            .lock()
            .unwrap()
            .exec_calls
            .iter()
            .filter(|args| args.get(1).is_some_and(|arg| arg == "stop"))
            .count(),
        1,
        "failed mutations are never replayed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
async fn removing_an_agent_succeeds_when_its_sandbox_is_already_absent() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint, &[]);
    tofu.apply();
    fixture.state.lock().unwrap().sandboxes.clear();
    let calls = fixture.state.lock().unwrap().exec_calls.len();
    tofu.run(
        &[
            "destroy",
            "-auto-approve",
            "-input=false",
            "-refresh=false",
            "-target=fabric_agent.agent",
        ],
        true,
    );
    assert_eq!(fixture.state.lock().unwrap().exec_calls.len(), calls);
    let state: Value = serde_json::from_slice(&tofu.state()).unwrap();
    assert!(
        !state["resources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|resource| resource["type"] == "fabric_agent")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
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
            "-var=mode=PRIVATE_SENTINEL",
        ],
        false,
    );
    // OpenTofu wraps diagnostic text.
    let stderr = String::from_utf8_lossy(&rejected.stderr)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(stderr.contains("Invalid configuration"), "{stderr}");
    assert!(stderr.contains("at instructions.system.mode"), "{stderr}");
    assert!(!stderr.contains("PRIVATE_SENTINEL"), "{stderr}");
    assert!(fixture.state.lock().unwrap().exec_calls.is_empty());
    // Valid Fabric configuration the harness cannot apply fails at plan too:
    // Pi replaces system instructions and cannot append to them.
    let unsupported = tofu.run(&["plan", "-input=false", "-var=mode=append"], false);
    let stderr = String::from_utf8_lossy(&unsupported.stderr)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        stderr.contains(
            "The harness does not accept this agent configuration at instructions.system.mode"
        ),
        "{stderr}"
    );
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
    fixture.state.lock().unwrap().exec_truncated = false;
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
