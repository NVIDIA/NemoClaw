// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Contract tests: each fixture in `fixtures/` applies through pinned
//! OpenTofu against the fake OpenShell gateway, reads back unchanged, and is
//! removed by destroy. The fixtures are the OpenShell resources the SDK
//! compiles for each example; nemoclaw-e2e regenerates them.

use nemoclaw_test_fixtures::{openshell::Fixture, tofu::TofuWorkspace};
use serde_json::Value;
use std::{collections::BTreeSet, fs, path::Path, process::Output};

mod capabilities;
mod standalone;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/contract/fixtures");

fn tofu() -> std::path::PathBuf {
    let tofu = std::path::PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_TOFU").expect("explicit pinned OpenTofu path"),
    );
    assert!(tofu.is_absolute());
    tofu
}

/// The openshell provider built beside NEMOCLAW_TEST_PROVIDER, as the
/// lifecycle tests receive it.
fn provider() -> std::path::PathBuf {
    let nemoclaw = std::path::PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_PROVIDER").expect("explicit provider build path"),
    );
    assert!(nemoclaw.is_absolute());
    nemoclaw
        .parent()
        .unwrap()
        .join(nemoclaw_test_fixtures::executable(
            "terraform-provider-openshell",
        ))
}

/// Credential variables the fixture's registrations name, with fixture values.
fn credentials(fixture: &Value) -> BTreeSet<String> {
    fixture["resource"]["openshell_provider_registration"]
        .as_object()
        .into_iter()
        .flat_map(|registrations| registrations.values())
        .filter_map(|registration| registration["credential_env"].as_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect()
}

async fn reads_back_unchanged(name: &str) {
    let source = fs::read_to_string(Path::new(FIXTURES).join(format!("{name}.tf.json"))).unwrap();
    let parsed: Value = serde_json::from_str(&source).unwrap();
    let gateway = Fixture::start().await;
    // The gateway runs the compute driver the configuration requires.
    if let Some(driver) =
        parsed["data"]["openshell_gateway"]["current"]["required_compute_drivers"][0].as_str()
    {
        gateway.state.lock().unwrap().driver = Some(driver.to_owned());
    }
    let workspace = TofuWorkspace::with_providers(tofu(), &[("openshell", &provider())]);
    fs::write(workspace.path().join("main.tf.json"), &source).unwrap();
    let endpoint = format!("endpoint={}", gateway.endpoint);
    let run = |args: &[&str]| -> Output {
        let mut command = workspace.command();
        command
            .args(args)
            .args(["-input=false", "-no-color", "-var"])
            .arg(&endpoint);
        for credential in credentials(&parsed) {
            command.env(credential, "fixture-credential");
        }
        command.output().unwrap()
    };
    let success = |args: &[&str]| {
        let output = run(args);
        assert!(
            output.status.success(),
            "{name}: {args:?}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    success(&["apply", "-auto-approve"]);
    // A managed change on the next plan means the provider read back
    // something other than what it wrote. Data sources re-read on purpose.
    success(&["plan", "-out=unchanged.plan"]);
    let shown = workspace
        .command()
        .args(["show", "-json", "unchanged.plan"])
        .output()
        .unwrap();
    let plan: Value = serde_json::from_slice(&shown.stdout).unwrap();
    for change in plan["resource_changes"].as_array().unwrap() {
        if change["mode"] == "managed" {
            assert_eq!(
                change["change"]["actions"],
                serde_json::json!(["no-op"]),
                "{name}: {} changes after it was applied",
                change["address"]
            );
        }
    }
    // Teardown keeps the retained workspace and removes everything else, as
    // the SDK's teardown graph does.
    let mut retained = parsed.clone();
    retained["resource"]
        .as_object_mut()
        .unwrap()
        .retain(|kind, _| kind == "openshell_workspace");
    for body in retained["resource"]["openshell_workspace"]
        .as_object_mut()
        .unwrap()
        .values_mut()
    {
        body.as_object_mut().unwrap().remove("depends_on");
    }
    fs::write(
        workspace.path().join("main.tf.json"),
        serde_json::to_string(&retained).unwrap(),
    )
    .unwrap();
    success(&["apply", "-auto-approve", "-var", "destroying=true"]);
    let state = gateway.state.lock().unwrap();
    assert!(state.sandboxes.is_empty(), "{name}");
    assert!(state.providers.is_empty(), "{name}");
    assert!(state.profiles.is_empty(), "{name}");
}

macro_rules! fixtures {
    ($($test:ident => $name:literal,)*) => {
        $(
            #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
            #[ignore = "requires NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; fake OpenShell gateway"]
            async fn $test() {
                reads_back_unchanged($name).await;
            }
        )*

        /// Every fixture file has a test, and every OpenShell type has a fixture.
        #[test]
        fn every_fixture_runs_and_every_type_is_covered() {
            let listed: BTreeSet<&str> = [$($name),*].into();
            let files: BTreeSet<String> = fs::read_dir(FIXTURES)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .filter_map(|file| file.strip_suffix(".tf.json").map(str::to_owned))
                .collect();
            assert_eq!(
                files.iter().map(String::as_str).collect::<BTreeSet<_>>(),
                listed
            );
            let used: BTreeSet<String> = files
                .iter()
                .flat_map(|file| {
                    let fixture: Value = serde_json::from_slice(
                        &fs::read(Path::new(FIXTURES).join(format!("{file}.tf.json"))).unwrap(),
                    )
                    .unwrap();
                    ["resource", "data"]
                        .into_iter()
                        .flat_map(|block| {
                            fixture[block]
                                .as_object()
                                .map(|types| types.keys().cloned().collect::<Vec<_>>())
                                .unwrap_or_default()
                        })
                        .collect::<Vec<_>>()
                })
                .collect();
            for kind in [
                "openshell_workspace",
                "openshell_provider_profile",
                "openshell_provider_registration",
                "openshell_sandbox",
                "openshell_gateway",
            ] {
                assert!(used.contains(kind), "no fixture uses {kind}");
            }
        }
    };
}

fixtures! {
    explicit_policy => "explicit-policy",
    fabric => "fabric",
    fabric_claude => "fabric-claude",
    fabric_codex => "fabric-codex",
    fabric_hermes => "fabric-hermes",
    fabric_mini_swe_agent => "fabric-mini-swe-agent",
    fabric_nooa => "fabric-nooa",
    fabric_nooa_bench => "fabric-nooa-bench",
    fabric_openclaw => "fabric-openclaw",
    fabric_pi => "fabric-pi",
    fabric_remote_agent => "fabric-remote-agent",
    hermes_auth => "hermes-auth",
    hermes_interfaces => "hermes-interfaces",
    inference_tuning => "inference-tuning",
    inline_inference => "inline-inference",
    local => "local",
    multiple_models => "multiple-models",
    multiple_providers => "multiple-providers",
    multiple_sandboxes => "multiple-sandboxes",
    openclaw_dashboard => "openclaw-dashboard",
    openclaw_web_search => "openclaw-web-search",
    tavily_web_search => "tavily-web-search",
}
