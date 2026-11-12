// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Planned actions for the sandbox settings in `hcl/sandbox/main.tf`, which
//! `hcl/sandbox/tests` applies: `tofu test` does not expose a plan's actions.
use super::*;
use serde_json::json;

/// Unchanged settings read back by a new provider process plan no change,
/// numbers and an omitted authorization mode included. A driver
/// configuration changed behind OpenTofu is drift that replaces the sandbox;
/// a declared service endpoint changed or deleted behind it is drift that an
/// in-place update restores. An endpoint under a name the configuration
/// doesn't declare stays through those updates and the removal of every
/// declared one.
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
    // An endpoint exposed outside OpenTofu, as `openshell service expose`
    // would, under a name the configuration doesn't declare.
    let extra = {
        let mut state = fixture.state.lock().unwrap();
        let (key, endpoint) = state.services.first_key_value().unwrap();
        let key = (key.0.clone(), key.1.clone(), "extra".to_owned());
        let endpoint = openshell_core::proto::ServiceEndpoint {
            name: "extra".into(),
            target_port: 4321,
            ..endpoint.clone()
        };
        state.services.insert(key.clone(), endpoint);
        key
    };
    let extra_port = || {
        let state = fixture.state.lock().unwrap();
        state
            .services
            .get(&extra)
            .map(|endpoint| endpoint.target_port)
    };
    assert_eq!(actions(), vec![], "an undeclared endpoint is not drift");
    let ports = || -> Vec<u32> {
        let state = fixture.state.lock().unwrap();
        state
            .services
            .iter()
            .filter(|(key, _)| **key != extra)
            .map(|(_, service)| service.target_port)
            .collect()
    };
    let declared = ports();
    for (_, service) in fixture
        .state
        .lock()
        .unwrap()
        .services
        .iter_mut()
        .filter(|(key, _)| **key != extra)
    {
        service.target_port = 1234;
    }
    // The update's URLs are unknown until it applies.
    let updated = vec![
        (json!("openshell_sandbox.agent"), json!(["update"])),
        caller,
    ];
    assert_eq!(actions(), updated);
    let created = fixture.state.lock().unwrap().created_sandboxes.len();
    let restored = |drift: &str| {
        run(&["apply", "-auto-approve"]);
        assert_eq!(
            fixture.state.lock().unwrap().created_sandboxes.len(),
            created,
            "restoring {drift} replaced the sandbox"
        );
        assert_eq!(ports(), declared, "the update left {drift}");
        assert_eq!(extra_port(), Some(4321), "restoring {drift} changed extra");
        assert_eq!(actions(), vec![], "{drift}");
    };
    restored("a changed endpoint");
    // A declared endpoint deleted behind OpenTofu is restored the same way.
    {
        let mut state = fixture.state.lock().unwrap();
        let declared = state.services.keys().find(|key| **key != extra).cloned();
        state.services.remove(&declared.unwrap());
    }
    assert_eq!(actions(), updated);
    restored("a deleted endpoint");
    // Removing every declared exposure leaves the undeclared one, and a plan
    // with no exposures then changes nothing.
    run(&["apply", "-auto-approve", "-var=services={}"]);
    assert_eq!(ports(), Vec::<u32>::new(), "removed exposures stayed");
    assert_eq!(
        extra_port(),
        Some(4321),
        "removing the exposures removed extra"
    );
    run(&["plan", "-detailed-exitcode", "-var=services={}"]);
}
