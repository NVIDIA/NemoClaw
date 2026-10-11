// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Gateway capability observations, and their preconditions through OpenTofu.

use super::*;
use nemoclaw_backend::ObservationError;
use openshell_provider::{EnvironmentSecrets, OpenShell};
use serde_json::json;
use std::process::Output;

/// The local example's OpenShell resources, applied by one workspace.
struct Local {
    workspace: TofuWorkspace,
    endpoint: String,
}
impl Local {
    fn new(endpoint: &str) -> Self {
        let workspace = TofuWorkspace::with_providers(tofu(), &[("openshell", &provider())]);
        fs::copy(
            Path::new(FIXTURES).join("local.tf.json"),
            workspace.path().join("main.tf.json"),
        )
        .unwrap();
        Self {
            workspace,
            endpoint: format!("endpoint={endpoint}"),
        }
    }
    fn run(&self, args: &[&str]) -> Output {
        self.workspace
            .command()
            .args(args)
            .args(["-input=false", "-no-color", "-var"])
            .arg(&self.endpoint)
            .output()
            .unwrap()
    }
    fn success(&self, args: &[&str]) -> Output {
        let output = self.run(args);
        assert!(
            output.status.success(),
            "{args:?}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }
    /// Managed resources in state; data sources re-read on every plan.
    fn state(&self) -> Value {
        let state: Value = fs::read(self.workspace.path().join("terraform.tfstate"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Value::Array(
            state["resources"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|resource| resource["mode"] == "managed")
                .cloned()
                .collect(),
        )
    }
    /// Declare a second sandbox like the first, so the next plan creates it.
    fn add_sandbox(&self) {
        let path = self.workspace.path().join("main.tf.json");
        let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let sandboxes = config["resource"]["openshell_sandbox"]
            .as_object_mut()
            .unwrap();
        let mut extra = sandboxes.values().next().unwrap().clone();
        extra["name"] = json!("extra");
        sandboxes.insert("extra".into(), extra);
        fs::write(path, config.to_string()).unwrap();
    }
}

/// An incompatible gateway fails its precondition, a failed read fails the
/// plan, and a saved plan observes the gateway again when applied, all
/// without changing the gateway or state. nemoclaw-openshell's observation
/// tests own each incompatibility reason.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
async fn gateway_capabilities_gate_plans_and_saved_plan_applies() {
    let gateway = Fixture::start().await;
    let local = Local::new(&gateway.endpoint);
    let versions: Value = serde_json::from_str(include_str!("../../../../versions.json")).unwrap();
    let version = versions["openshell"].as_str().unwrap();
    for failure in ["version", "unavailable"] {
        {
            let mut state = gateway.state.lock().unwrap();
            if failure == "version" {
                state.gateway_info = Some(openshell_core::proto::GetGatewayInfoResponse {
                    gateway_version: "incompatible-version".into(),
                    compute_drivers: vec![openshell_core::proto::ComputeDriverInfo {
                        name: "docker".into(),
                        ..Default::default()
                    }],
                    ..Default::default()
                });
            } else {
                state.fail_read = Some(("gateway", tonic::Code::Unavailable));
            }
        }
        let output = local.run(&["plan"]);
        assert!(!output.status.success(), "{failure} gateway was accepted");
        let diagnostic = String::from_utf8_lossy(&output.stderr);
        let normalized = diagnostic.split_whitespace().collect::<Vec<_>>().join(" ");
        let expected = if failure == "version" {
            format!(
                "Gateway is incompatible with this configuration: gateway runs OpenShell \
                 incompatible-version, but this build requires {version}."
            )
        } else {
            "Gateway capability observation failed".to_owned()
        };
        assert!(normalized.contains(&expected), "{diagnostic}");
        assert!(!diagnostic.contains("fixture-secret"));
        assert_eq!(gateway.state.lock().unwrap().effects, 0);
        let mut state = gateway.state.lock().unwrap();
        state.gateway_info = None;
        state.fail_read = None;
    }

    // After apply, an incompatible gateway or a failed object read stops the
    // next plan without changing state.
    local.success(&["apply", "-auto-approve"]);
    let applied = local.state();
    let effects = gateway.state.lock().unwrap().effects;
    gateway.state.lock().unwrap().driver = Some("podman".into());
    assert!(!local.run(&["plan"]).status.success());
    gateway.state.lock().unwrap().driver = None;
    gateway.state.lock().unwrap().fail_read = Some(("provider", tonic::Code::Unavailable));
    assert!(!local.run(&["plan"]).status.success());
    gateway.state.lock().unwrap().fail_read = None;
    assert!(local.state() == applied, "a failed plan changed state");
    assert_eq!(gateway.state.lock().unwrap().effects, effects);

    // A saved plan observes the gateway again when applied: a driver change
    // for an unchanged plan, and a failed read while creating.
    for (create, failure) in [(false, "driver"), (true, "unavailable")] {
        if create {
            local.add_sandbox();
        }
        local.success(&["plan", "-out=fresh.plan"]);
        let effects = gateway.state.lock().unwrap().effects;
        let before = local.state();
        {
            let mut state = gateway.state.lock().unwrap();
            if failure == "driver" {
                state.driver = Some("podman".into());
            } else {
                state.fail_read = Some(("gateway", tonic::Code::Unavailable));
            }
        }
        let output = local
            .workspace
            .command()
            .args(["apply", "-input=false", "-no-color", "fresh.plan"])
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "saved plan reused stale gateway metadata: create={create}, {failure}"
        );
        let diagnostic = String::from_utf8_lossy(&output.stderr);
        let normalized = diagnostic.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            normalized.contains(if failure == "driver" {
                "Gateway is incompatible with this configuration: gateway compute driver is \
                 podman, but spec.gateway.runtime.provider is docker."
            } else {
                "Gateway capability observation failed"
            }),
            "{diagnostic}"
        );
        assert_eq!(gateway.state.lock().unwrap().effects, effects);
        assert!(local.state() == before, "a failed saved plan changed state");
        let mut state = gateway.state.lock().unwrap();
        state.driver = None;
        state.fail_read = None;
    }
}

#[tokio::test]
async fn gateway_capability_observations_preserve_metadata_and_fail_closed_without_mutations() {
    let gateway = Fixture::start().await;
    let client = OpenShell::connect(
        &nemoclaw_openshell::Connection {
            endpoint: gateway.endpoint.clone(),
            ..Default::default()
        },
        std::sync::Arc::new(EnvironmentSecrets),
    )
    .unwrap();
    assert!(
        client
            .gateway_capabilities()
            .await
            .unwrap()
            .supports("docker")
    );
    gateway.state.lock().unwrap().driver = Some("podman".into());
    let observed = client.gateway_capabilities().await.unwrap();
    assert!(observed.supports("podman") && !observed.supports("docker"));
    for (code, expected) in [
        (
            tonic::Code::Unauthenticated,
            ObservationError::Authentication,
        ),
        (tonic::Code::PermissionDenied, ObservationError::Permission),
        (tonic::Code::Unavailable, ObservationError::Transport),
        (tonic::Code::NotFound, ObservationError::Query),
    ] {
        gateway.state.lock().unwrap().fail_read = Some(("gateway", code));
        assert_eq!(client.gateway_capabilities().await.unwrap_err(), expected);
    }
    gateway.state.lock().unwrap().fail_read = None;
    gateway.state.lock().unwrap().gateway_info = Some(Default::default());
    assert_eq!(
        client.gateway_capabilities().await.unwrap_err(),
        ObservationError::Incomplete
    );
    assert_eq!(gateway.state.lock().unwrap().effects, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; fake OpenShell gateway"]
async fn gateway_capability_reads_wait_for_unknown_bootstrap_dependencies() {
    let gateway = Fixture::start().await;
    gateway.state.lock().unwrap().fail_read = Some(("gateway", tonic::Code::Unavailable));
    let directory = TofuWorkspace::with_providers(tofu(), &[("openshell", &provider())]);
    fs::write(directory.path().join("main.tf.json"), json!({
        "terraform":{"required_version":"= 1.12.6", "required_providers":{"openshell":{"source":"registry.opentofu.org/nvidia/openshell"}}},
        "provider":{"openshell":{"endpoint":gateway.endpoint}},
        "resource":{"terraform_data":{"bootstrap":{"input":"docker"}}},
        "data":{"openshell_gateway":{"current":{
            "required_compute_drivers":["${terraform_data.bootstrap.output}"],
            "lifecycle":{"postcondition":[{"condition":"${self.compatible}", "error_message":"Gateway is incompatible."}]}
        }}},
        "output":{"compatible":{"value":"${data.openshell_gateway.current.compatible}"}}
    }).to_string()).unwrap();
    let run = |args: &[&str]| {
        let output = directory.command().args(args).output().unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output
    };
    run(&["validate", "-no-color"]);
    run(&["plan", "-input=false", "-out=bootstrap.plan", "-no-color"]);
    assert_eq!(
        gateway.state.lock().unwrap().gateway_reads,
        0,
        "unknown inputs contacted the gateway"
    );
    let plan: Value =
        serde_json::from_slice(&run(&["show", "-json", "bootstrap.plan"]).stdout).unwrap();
    assert!(
        plan["resource_changes"].as_array().unwrap().iter().any(
            |change| change["mode"] == "data" && change["change"]["actions"] == json!(["read"])
        )
    );
    gateway.state.lock().unwrap().fail_read = None;
    run(&["apply", "-input=false", "-no-color", "bootstrap.plan"]);
    let state: Value =
        serde_json::from_slice(&fs::read(directory.path().join("terraform.tfstate")).unwrap())
            .unwrap();
    assert_eq!(state["outputs"]["compatible"]["value"], true);
    assert!(gateway.state.lock().unwrap().gateway_reads > 0);
    assert_eq!(gateway.state.lock().unwrap().effects, 0);
}
