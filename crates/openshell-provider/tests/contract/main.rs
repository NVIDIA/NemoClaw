// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Contract tests: OpenShell types through pinned OpenTofu against the fake
//! OpenShell gateway.
//!
//! - `hcl/`: scenarios that pass, as native `tests/*.tftest.hcl` files beside
//!   the configuration they apply. This file starts their fakes and runs them.
//! - `failures/`: Rust tests of commands that must fail, which `tofu test`
//!   cannot expect.
//! - `fixtures/`: the OpenShell resources the SDK compiles for each example;
//!   each shape applies, reads back unchanged, and is removed by destroy.
//! - The other files check what `tofu test` cannot show: planned actions,
//!   and Kubernetes objects changed between steps.

use nemoclaw_test_fixtures::{openshell::Fixture, tofu::TofuWorkspace};
use serde_json::Value;
use std::{collections::BTreeSet, fs, path::Path, process::Output};

/// A fake Docker engine with volumes, containers, and files, shared with
/// nemoclaw-e2e's `tofu test` integration case.
#[cfg(unix)]
#[path = "../../../test-support/docker_engine.rs"]
mod docker_engine;
#[path = "../../../test-support/http.rs"]
mod http_fixture;
/// The in-memory Kubernetes API shared with the SDK tests, which reaches its
/// HTTP server as `transport`.
#[path = "../../../test-support/kube_api.rs"]
mod kube_api;
use http_fixture as transport;
pub use nemoclaw_test_fixtures::{openshell, tofu};

mod chart;
mod failures;
mod kubernetes_lifecycle;
mod sandbox;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/contract/fixtures");

/// The bundle's pinned OpenTofu.
fn tofu() -> std::path::PathBuf {
    nemoclaw_test_fixtures::Bundle::from_env().tofu()
}

/// The openshell provider Cargo built from this checkout, the one under test.
fn provider() -> std::path::PathBuf {
    nemoclaw_test_fixtures::package_executable!("terraform-provider-openshell")
}

/// A workspace with the openshell provider under test, OpenTofu and the
/// fabric provider from the bundle, and the fixture provider that observes the
/// fake gateway.
pub fn workspace() -> TofuWorkspace {
    let bundle = nemoclaw_test_fixtures::Bundle::from_env();
    TofuWorkspace::with_providers(
        bundle.tofu(),
        &[
            ("openshell", &provider()),
            ("fabric", &bundle.provider("fabric")),
            (
                "fixture",
                &nemoclaw_test_fixtures::fixture_executable("nemoclaw-fixture-control"),
            ),
        ],
    )
}

pub const CONTRACT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/contract");
/// The authored modules whose scenarios run with `tofu test`.
pub const HCL: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/contract/hcl");

/// The credential variables authored modules name, and their secret values.
const SECRETS: [(&str, &str); 5] = [
    (
        "NEMOCLAW_TEST_REGISTRATION_KEY",
        "registration-fixture-secret",
    ),
    ("NEMOCLAW_TEST_ROTATED_KEY", "rotated-fixture-secret"),
    ("NEMOCLAW_TEST_BRAVE_KEY", "brave-fixture-secret"),
    ("NEMOCLAW_TEST_BOOKING_KEY", "booking-fixture-secret"),
    ("NEMOCLAW_TEST_BOOKING_NEXT", "next-booking-fixture-secret"),
];

/// Run the native test files of `module` side by side, each against a new
/// fake gateway and with `extra` environment, and require that OpenTofu's
/// output repeats no secret.
pub async fn native(module: &str, extra: &[(&str, &str)]) {
    let root = workspace();
    root.copy(Path::new(HCL).join(module));
    let environment: Vec<_> = SECRETS.into_iter().chain(extra.iter().copied()).collect();
    for output in openshell::test_against_gateways(root, &environment).await {
        for (_, secret) in SECRETS {
            assert!(!output.contains(secret), "{module}:\n{output}");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
async fn standalone_resources() {
    native("standalone", &[]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
async fn sandbox_settings() {
    native("sandbox", &[]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
async fn tool_credentials() {
    native("credentials", &[]).await;
}

/// A Docker engine that answers reads only.
#[cfg(unix)]
pub(crate) async fn read_only_engine() -> http_fixture::Fixture {
    http_fixture::Fixture::engine(|request| {
        assert_eq!(request.method, "GET", "a prerequisite read mutated the engine");
        let path = request.path.split('?').next().unwrap();
        let body = if path.ends_with("/libpod/info") {
            serde_json::json!({"host":{"security":{"rootless":false}}})
        } else if path.ends_with("/version") {
            serde_json::json!({"Version":"28.0", "ApiVersion":"1.47", "Components":[{"Name":"Engine", "Version":"28.0"}]})
        } else if path.ends_with("/info") {
            serde_json::json!({"ID":"engine"})
        } else if path.ends_with("/networks") || path.ends_with("/containers/json") {
            // No other network or container holds the gateway's subnet or name.
            serde_json::json!([])
        } else if ["/volumes/", "/containers/", "/networks/"]
            .iter()
            .any(|kind| path.contains(kind))
        {
            // A new gateway's storage reads its volume, helper, and network,
            // and finds none of them.
            return Some((404, br#"{"message":"no such object"}"#.to_vec()));
        } else {
            panic!("unexpected engine query {path}")
        };
        Some((200, serde_json::to_vec(&body).unwrap()))
    })
    .await
}

/// `hcl/gateway`: the Docker gateway launch, engine prerequisites, and the
/// Kubernetes resources plan from typed settings.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker fixture"]
async fn gateway_settings_plan_without_contacting_a_host() {
    let engine = read_only_engine().await;
    native("gateway", &[("TF_VAR_engine", &engine.endpoint)]).await;
}

/// Failed apply may record new data-source observations and condition
/// results; its managed resources and lineage must still be preserved.
pub fn assert_same_managed_resources(actual: &[u8], expected: &[u8]) {
    fn managed(bytes: &[u8]) -> (String, Vec<Value>) {
        let state: Value = serde_json::from_slice(bytes).unwrap();
        let resources = state["resources"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|resource| resource["mode"] == "managed")
            .cloned()
            .collect();
        (state["lineage"].as_str().unwrap().into(), resources)
    }
    assert_eq!(managed(actual), managed(expected));
}

/// Credential variables the fixture's registrations, inference servers, and
/// web search resources name, with fixture values.
fn credentials(fixture: &Value) -> BTreeSet<String> {
    let direct = ["openshell_provider_registration", "openshell_web_search"]
        .into_iter()
        .filter_map(|kind| fixture["resource"][kind].as_object())
        .flat_map(|registrations| registrations.values())
        .filter_map(|registration| registration["credential_env"].as_str());
    let servers = fixture["resource"]["openshell_inference"]
        .as_object()
        .into_iter()
        .flat_map(|registrations| registrations.values())
        .filter_map(|registration| registration["server"]["credential_env"].as_str());
    direct
        .chain(servers)
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

/// Every resource and data source the provider serves appears in a contract
/// test or a fixture.
#[test]
fn every_type_has_a_contract_test() {
    use tf_provider::Provider;
    let provider = openshell_provider::OpenShellProvider::default();
    let mut diagnostics = tf_provider::Diagnostics::default();
    let types: Vec<String> = provider
        .get_resources(&mut diagnostics)
        .unwrap()
        .into_keys()
        .chain(
            provider
                .get_data_sources(&mut diagnostics)
                .unwrap()
                .into_keys(),
        )
        .collect();
    let sources = nemoclaw_test_fixtures::tofu::contract_sources(CONTRACT);
    let missing: Vec<_> = types
        .iter()
        .filter(|kind| !sources.contains(&format!("openshell_{kind}")))
        .collect();
    assert!(
        missing.is_empty(),
        "types without a contract test: {missing:?}"
    );
}

/// A fixture's resource and data types, their attributes, and which values
/// are set, without the values or generated names. Examples that differ only
/// in values, such as the harness a sandbox launches or a model's address,
/// exercise the same provider contract.
fn shape(fixture: &Value) -> Value {
    fn skeleton(value: &Value) -> Value {
        match value {
            Value::Object(fields) => fields
                .iter()
                .map(|(name, value)| (name.clone(), skeleton(value)))
                .collect(),
            Value::Array(items) => items.iter().map(skeleton).collect(),
            Value::String(text) if text.is_empty() => Value::Null,
            Value::Null => Value::Null,
            _ => Value::Bool(true),
        }
    }
    ["resource", "data"]
        .into_iter()
        .flat_map(|block| fixture[block].as_object().into_iter().flatten())
        .map(|(kind, bodies)| {
            let mut bodies: Vec<String> = bodies
                .as_object()
                .unwrap()
                .values()
                .map(|body| skeleton(body).to_string())
                .collect();
            bodies.sort();
            (kind.clone(), Value::from(bodies))
        })
        .collect::<serde_json::Map<_, _>>()
        .into()
}

/// The first generated fixture of each shape applies, reads back unchanged,
/// and is torn down, side by side, each against its own fake gateway.
#[test]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
fn each_generated_fixture_shape_reads_back_unchanged() {
    let mut names: Vec<String> = fs::read_dir(FIXTURES)
        .unwrap()
        .filter_map(|entry| {
            let file = entry.unwrap().file_name().to_string_lossy().into_owned();
            file.strip_suffix(".tf.json").map(str::to_owned)
        })
        .collect();
    names.sort();
    let mut shapes = BTreeSet::new();
    names.retain(|name| {
        let fixture: Value = serde_json::from_slice(
            &fs::read(Path::new(FIXTURES).join(format!("{name}.tf.json"))).unwrap(),
        )
        .unwrap();
        shapes.insert(shape(&fixture).to_string())
    });
    assert!(names.len() > 1);
    // Each lifecycle blocks on OpenTofu while its gateway serves, so each
    // takes its own runtime.
    std::thread::scope(|scope| {
        for name in &names {
            scope.spawn(move || {
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(reads_back_unchanged(name));
            });
        }
    });
}

/// Every OpenShell type the SDK compiles has a generated fixture.
#[test]
fn every_compiled_type_has_a_fixture() {
    let used: BTreeSet<String> = fs::read_dir(FIXTURES)
        .unwrap()
        .flat_map(|entry| {
            let fixture: Value =
                serde_json::from_slice(&fs::read(entry.unwrap().path()).unwrap()).unwrap();
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
        "openshell_inference",
        "openshell_web_search",
        "openshell_sandbox",
        "openshell_gateway",
    ] {
        assert!(used.contains(kind), "no fixture uses {kind}");
    }
}
