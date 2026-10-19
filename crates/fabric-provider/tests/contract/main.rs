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
    let used: BTreeSet<&str> = ["fabric_agent", "fabric_harnesses"]
        .into_iter()
        .filter(|kind| sources.contains(&format!("\"{kind}\"")))
        .collect();
    assert_eq!(used.len(), 2, "types with a contract test: {used:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
async fn a_changed_pi_configuration_replaces_the_sandbox() {
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
    // Valid Fabric configuration plans even when the harness can't apply it,
    // such as Pi appending to system instructions: Fabric decides that when
    // the agent is configured in its sandbox.
    tofu.run(&["plan", "-input=false", "-var=mode=append"], true);
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
                    .is_some_and(|arg| arg == "start" || arg == "stop")
            })
            .count()
    };
    assert_eq!(writes(), 1);
    tofu.noop();
    assert_eq!(writes(), 1, "no-op must not restart Pi");
    let first = sandbox_id(&fixture);
    tofu.run(
        &[
            "plan",
            "-input=false",
            "-var=model=second-model",
            "-out=change.plan",
        ],
        true,
    );
    assert_eq!(writes(), 1, "plan must not start Pi");
    tofu.run(&["apply", "-input=false", "change.plan"], true);
    // The changed agent runs in a new sandbox: Pi is stopped in the old one,
    // then started in the new one.
    assert_ne!(sandbox_id(&fixture), first);
    assert_eq!(writes(), 3);
    let _ = effects;
    // Lose the reply to a new agent's start. Apply fails without retrying and
    // the agent is left tainted. The runtime may have started, so the sandbox
    // can't start another: replacing the sandbox recovers.
    tofu.run(
        &[
            "plan",
            "-input=false",
            "-var=model=third-model",
            "-out=ambiguous.plan",
        ],
        true,
    );
    fixture.state.lock().unwrap().lose_start_reply = true;
    tofu.run(&["apply", "-input=false", "ambiguous.plan"], false);
    assert_eq!(writes(), 5);
    assert!(!fixture.state.lock().unwrap().lose_start_reply);
    tofu.run(
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-var=model=third-model",
            "-replace=openshell_sandbox.agent[0]",
        ],
        true,
    );
    assert_eq!(writes(), 6, "the replaced sandbox starts the agent once");
    // Reading an agent runs nothing in its sandbox, so a reply that would be
    // cut off cannot fail a plan or change state.
    let prior = tofu.state();
    fixture.state.lock().unwrap().exec_truncated = true;
    tofu.run(&["plan", "-input=false", "-var=model=third-model"], true);
    assert_eq!(tofu.state(), prior);
    assert_eq!(writes(), 6);
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
    assert_eq!(
        writes(),
        7,
        "destroy stops Pi once before removing its sandbox"
    );
}

/// Without a trigger that replaces its sandbox, a changed agent is refused
/// while planning, with the way to fix it, and nothing changes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
async fn a_changed_agent_without_a_new_sandbox_is_refused() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint, &[]);
    let main = tofu.root.path().join("main.tf");
    let source = fs::read_to_string(&main).unwrap();
    let trigger =
        "  lifecycle {\n    replace_triggered_by = [terraform_data.agent_configuration]\n  }\n";
    assert!(source.contains(trigger));
    fs::write(&main, source.replace(trigger, "")).unwrap();
    tofu.apply();
    let sandbox = sandbox_id(&fixture);
    let effects = fixture.state.lock().unwrap().effects;
    let refused = tofu.run(&["plan", "-input=false", "-var=model=second-model"], false);
    let stderr = String::from_utf8_lossy(&refused.stderr)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        stderr.contains("A changed agent needs a new sandbox"),
        "{stderr}"
    );
    assert!(stderr.contains("replace_triggered_by"), "{stderr}");
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    assert_eq!(sandbox_id(&fixture), sandbox);
}

/// Fabric's own message about a failed start can repeat the harness's output,
/// so the diagnostic leaves it out and names the private file that keeps it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
async fn a_failed_start_keeps_fabrics_message_in_a_private_file() {
    let fixture = Fixture::start().await;
    fixture.state.lock().unwrap().configuration_error = Some(json!({
        "error": {"stage": "start", "code": "start_failed", "message": "harness said PRIVATE_SENTINEL"}
    }));
    let tofu = Standalone::new(&fixture.endpoint, &[]);
    let diagnostics = tofu.root.path().join("diagnostics");
    let output = tofu
        .root
        .command()
        .args(["apply", "-auto-approve", "-input=false", "-no-color"])
        .env("NEMOCLAW_TEST_REGISTRATION_KEY", "fixture-secret")
        .env("NEMOCLAW_TEST_ROTATED_KEY", "rotated-fixture-secret")
        .env(nemoclaw_backend::DIAGNOSTICS_ENV, &diagnostics)
        .output()
        .unwrap();
    assert!(!output.status.success());
    // OpenTofu wraps diagnostic text.
    let stderr = String::from_utf8_lossy(&output.stderr)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(stderr.contains("start_failed"), "{stderr}");
    assert!(!stderr.contains("PRIVATE_SENTINEL"), "{stderr}");
    let saved: Vec<PathBuf> = fs::read_dir(&diagnostics)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    let [saved] = saved.as_slice() else {
        panic!("one message file: {saved:?}");
    };
    assert!(
        stderr.contains(&format!("Fabric's message is in {}", saved.display())),
        "{stderr}"
    );
    let message: Value = serde_json::from_slice(&fs::read(saved).unwrap()).unwrap();
    assert_eq!(
        message,
        json!({"stage": "start", "code": "start_failed", "effects": "unknown", "message": "harness said PRIVATE_SENTINEL"})
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(saved).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&diagnostics).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}

/// The only sandbox's ID in the fake gateway.
fn sandbox_id(fixture: &Fixture) -> String {
    fixture
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
        .clone()
}

/// Removing an agent stops it, as removing an attachment does, and leaves its
/// sandbox. The sandbox can't start another runtime, so adding the agent back
/// needs a new sandbox. A sandbox that is already gone took its agent with it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
async fn removing_an_agent_stops_it_and_keeps_its_sandbox() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint, &[]);
    tofu.apply();
    let sandbox = sandbox_id(&fixture);
    assert!(
        fixture
            .state
            .lock()
            .unwrap()
            .fabric_configurations
            .contains_key(&sandbox)
    );
    let remove_agent = [
        "apply",
        "-auto-approve",
        "-input=false",
        "-destroy",
        "-target=fabric_agent.agent[0]",
    ];
    tofu.run(&remove_agent, true);
    {
        let state = fixture.state.lock().unwrap();
        assert!(
            state.fabric_stopped.contains(&sandbox),
            "removal stops the agent"
        );
        assert!(
            !state.fabric_configurations.contains_key(&sandbox),
            "removal clears the agent's configuration"
        );
        assert_eq!(state.sandboxes.len(), 1, "the sandbox stays");
    }
    let readded = tofu.run(&["apply", "-auto-approve", "-input=false"], false);
    assert!(
        String::from_utf8_lossy(&readded.stderr).contains("replace the sandbox"),
        "{}",
        String::from_utf8_lossy(&readded.stderr)
    );
    tofu.run(
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-replace=openshell_sandbox.agent[0]",
        ],
        true,
    );
    // Skip refresh so the removal itself meets the missing sandbox.
    fixture.state.lock().unwrap().sandboxes.clear();
    tofu.run(&[&remove_agent[..], &["-refresh=false"]].concat(), true);
}
