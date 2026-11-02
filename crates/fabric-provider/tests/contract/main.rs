// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Contract tests: Fabric types through pinned OpenTofu against the fake
//! OpenShell gateway, which runs Fabric's configure, prepare, and status
//! commands, and a fake Docker engine for image capabilities.
//!
//! Each module under `tests/contract` keeps its scenarios in native
//! `tests/*.tftest.hcl` files. The Rust tests here start their fixtures and
//! check the failures `tofu test` cannot express: any provider error fails a
//! run, and its state stays in memory.

// The fake Docker engine listens on a Unix socket.
#[cfg(unix)]
mod capabilities;

use nemoclaw_test_fixtures::{
    Bundle,
    openshell::{self, Fixture},
    tofu::TofuWorkspace,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    process::Output,
};

const CONTRACT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/contract");

/// The fabric provider Cargo built from this checkout, the one under test.
fn fabric() -> PathBuf {
    nemoclaw_test_fixtures::package_executable!("terraform-provider-fabric")
}

/// A workspace with the fabric provider under test, the bundle's openshell
/// provider, and the fixture provider that observes the fake gateway.
fn workspace() -> TofuWorkspace {
    let bundle = Bundle::from_env();
    TofuWorkspace::with_providers(
        bundle.tofu(),
        &[
            ("openshell", &bundle.provider("openshell")),
            ("fabric", &fabric()),
            (
                "fixture",
                &nemoclaw_test_fixtures::fixture_executable("nemoclaw-fixture-control"),
            ),
        ],
    )
}

/// The harness ref carries the catalog records its agents plan against.
fn catalog_json() -> String {
    serde_json::to_string(
        &nemoclaw_fabric::catalog::FabricCatalog::bundled().for_adapter("nvidia.fabric.pi"),
    )
    .unwrap()
}

/// Every Fabric type is used by a module with native tests.
#[test]
fn every_fabric_type_has_a_contract_test() {
    let sources = nemoclaw_test_fixtures::tofu::native_sources(CONTRACT);
    let used: BTreeSet<&str> = ["fabric_agent", "fabric_harnesses"]
        .into_iter()
        .filter(|kind| sources.contains(&format!("\"{kind}\"")))
        .collect();
    assert_eq!(used.len(), 2, "types with a contract test: {used:?}");
}

/// The Pi agent's lifecycle in `fixtures/tests`, the files side by side, each
/// against a new fake gateway.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
async fn pi_agent_lifecycle() {
    let root = workspace();
    root.copy(Path::new(CONTRACT).join("fixtures"));
    let catalog = catalog_json();
    openshell::test_against_gateways(root, &[("TF_VAR_catalog_json", &catalog)]).await;
}

/// The Pi sandbox in `fixtures/main.tf`, run with OpenTofu's plan and apply
/// commands so a check can follow a failed one.
struct Standalone {
    root: TofuWorkspace,
}
impl Standalone {
    fn new(endpoint: &str) -> Self {
        let root = workspace();
        let fixtures = Path::new(CONTRACT).join("fixtures");
        fs::copy(fixtures.join("main.tf"), root.path().join("main.tf")).unwrap();
        let mut variables: Value =
            serde_json::from_slice(&fs::read(fixtures.join("terraform.tfvars.json")).unwrap())
                .unwrap();
        variables["endpoint"] = json!(endpoint);
        variables["catalog_json"] = json!(catalog_json());
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
            .args(["-input=false", "-no-color"])
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
}

/// OpenTofu wraps diagnostic text.
fn diagnostic(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Runtime starts and stops the fake gateway received.
fn writes(fixture: &Fixture) -> u64 {
    fixture.state.lock().unwrap().observations()["fabric"]["writes"]
        .as_u64()
        .unwrap()
}

/// A rejected configuration, a lost start reply, and an unobserved runtime
/// each fail OpenTofu's command, which `tofu test` cannot expect.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
async fn failed_pi_operations_change_nothing_they_did_not_report() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    // A configuration Fabric rejects fails validation at its field, before
    // any sandbox call, and the message never repeats the rejected value.
    let rejected = diagnostic(&tofu.run(
        &[
            "plan",
            "-var=model=PRIVATE_SENTINEL",
            "-var=mode=PRIVATE_SENTINEL",
        ],
        false,
    ));
    assert!(rejected.contains("Invalid configuration"), "{rejected}");
    assert!(
        rejected.contains("at instructions.system.mode"),
        "{rejected}"
    );
    assert!(!rejected.contains("PRIVATE_SENTINEL"), "{rejected}");
    assert!(fixture.state.lock().unwrap().exec_calls.is_empty());
    tofu.run(&["apply", "-auto-approve"], true);
    assert_eq!(writes(&fixture), 1);
    // Lose the reply to a new agent's start. Apply fails without retrying and
    // the agent is left tainted. The runtime may have started, and another
    // start would run beside it: replacing the sandbox recovers.
    fixture.state.lock().unwrap().lose_start_reply = true;
    tofu.run(
        &["apply", "-auto-approve", "-var=model=second-model"],
        false,
    );
    assert_eq!(writes(&fixture), 3);
    tofu.run(
        &[
            "apply",
            "-auto-approve",
            "-var=model=second-model",
            "-replace=openshell_sandbox.agent[0]",
        ],
        true,
    );
    assert_eq!(
        writes(&fixture),
        4,
        "the replaced sandbox starts the agent once"
    );
    // Reading an agent checks its runtime. A check whose reply is cut off
    // leaves the agent unobserved, so the plan fails and changes nothing.
    let prior = tofu.state();
    fixture.state.lock().unwrap().exec_truncated = true;
    let unobserved = diagnostic(&tofu.run(&["plan", "-var=model=second-model"], false));
    assert!(
        unobserved.contains("observation is incomplete"),
        "{unobserved}"
    );
    assert_eq!(tofu.state(), prior);
    assert_eq!(writes(&fixture), 4);
}

/// Without a trigger that replaces its sandbox, a changed agent is refused
/// while planning, with the way to fix it, and nothing changes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
async fn a_changed_agent_without_a_new_sandbox_is_refused() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint);
    let main = tofu.root.path().join("main.tf");
    let source = fs::read_to_string(&main).unwrap();
    let trigger =
        "  lifecycle {\n    replace_triggered_by = [terraform_data.agent_configuration]\n  }\n";
    assert!(source.contains(trigger));
    fs::write(&main, source.replace(trigger, "")).unwrap();
    tofu.run(&["apply", "-auto-approve"], true);
    let effects = fixture.state.lock().unwrap().effects;
    let refused = diagnostic(&tofu.run(&["plan", "-var=model=second-model"], false));
    assert!(
        refused.contains("A changed agent needs a new sandbox"),
        "{refused}"
    );
    assert!(refused.contains("replace_triggered_by"), "{refused}");
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
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
    let tofu = Standalone::new(&fixture.endpoint);
    let diagnostics = tofu.root.path().join("diagnostics");
    let output = tofu
        .root
        .command()
        .args(["apply", "-auto-approve", "-input=false", "-no-color"])
        .env(nemoclaw_backend::DIAGNOSTICS_ENV, &diagnostics)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stderr = diagnostic(&output);
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
