// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Planned actions for the sandbox settings in `hcl/sandbox/main.tf`, which
//! `hcl/sandbox/tests` applies: `tofu test` does not expose a plan's actions.
use super::*;
use serde_json::json;

/// Unchanged settings read back by a new provider process plan no change,
/// numbers and an omitted authorization mode included. A driver
/// configuration changed behind OpenTofu is drift that replaces the sandbox;
/// a service endpoint changed behind it is drift that an in-place update
/// restores.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn sandbox_settings_read_back_and_drift_is_restored() {
    let fixture = Fixture::start().await;
    let root = workspace();
    fs::copy(
        Path::new(HCL).join("sandbox/main.tf"),
        root.path().join("main.tf"),
    )
    .unwrap();
    let run = |args: &[&str]| {
        let output = root
            .command()
            .args(args)
            .args(["-input=false", "-no-color"])
            .arg(format!("-var=endpoint={}", fixture.endpoint))
            .env("NEMOCLAW_TEST_BRAVE_KEY", "brave-fixture-secret")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{args:?}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    let actions = || {
        run(&["plan", "-out=check.plan"]);
        let shown = root
            .command()
            .args(["show", "-json", "check.plan"])
            .output()
            .unwrap();
        let plan: Value = serde_json::from_slice(&shown.stdout).unwrap();
        plan["resource_changes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|change| change["change"]["actions"] != json!(["no-op"]))
            .map(|change| {
                (
                    change["address"].clone(),
                    change["change"]["actions"].clone(),
                )
            })
            .collect::<Vec<_>>()
    };
    let replaced = vec![(
        json!("openshell_sandbox.agent"),
        json!(["delete", "create"]),
    )];
    run(&["apply", "-auto-approve"]);
    assert_eq!(actions(), vec![]);
    let sandboxes = fixture.state.lock().unwrap().sandboxes.clone();
    for sandbox in fixture.state.lock().unwrap().sandboxes.values_mut() {
        let template = sandbox.spec.as_mut().unwrap().template.as_mut().unwrap();
        template.driver_config = None;
    }
    // terraform_data.caller takes the replaced sandbox's URLs.
    let caller = (json!("terraform_data.caller"), json!(["update"]));
    assert_eq!(actions(), [replaced.clone(), vec![caller.clone()]].concat());
    fixture.state.lock().unwrap().sandboxes = sandboxes;
    assert_eq!(actions(), vec![]);
    let ports = || -> Vec<u32> {
        let state = fixture.state.lock().unwrap();
        state
            .services
            .values()
            .map(|service| service.target_port)
            .collect()
    };
    let declared = ports();
    for service in fixture.state.lock().unwrap().services.values_mut() {
        service.target_port = 1234;
    }
    // The update's URLs are unknown until it applies.
    let updated = (json!("openshell_sandbox.agent"), json!(["update"]));
    assert_eq!(actions(), vec![updated, caller]);
    let created = fixture.state.lock().unwrap().created_sandboxes.len();
    run(&["apply", "-auto-approve"]);
    assert_eq!(
        fixture.state.lock().unwrap().created_sandboxes.len(),
        created,
        "the update replaced the sandbox"
    );
    assert_eq!(ports(), declared, "the update left the drift");
    assert_eq!(actions(), vec![]);
}
