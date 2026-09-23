// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_e2e::{assert_same_managed_resources, openshell::Fixture};
use nemoclaw_sdk::{
    compile::{Generations, compile},
    config::Document,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER"]
async fn production_provider_applies_refreshes_and_destroys_the_reference_graph() {
    let fixture = Fixture::start().await;
    let directory = tempfile::tempdir().unwrap();
    let tofu = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_TOFU").expect("explicit pinned OpenTofu path"),
    );
    let provider = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_PROVIDER")
            .expect("explicit built production provider path"),
    );
    assert!(tofu.is_absolute() && provider.is_absolute());
    fs::copy(
        provider,
        directory.path().join(nemoclaw_sdk::bundle::executable(
            "terraform-provider-nemoclaw",
        )),
    )
    .unwrap();
    fs::write(directory.path().join("tofu.rc"),format!("provider_installation {{ dev_overrides {{ \"registry.opentofu.org/nvidia/nemoclaw\" = {} }} direct {{}} }}",serde_json::to_string(directory.path().to_str().unwrap()).unwrap())).unwrap();
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .into_iter()
        .map(|k| (k.into(), format!("{k}-generation")))
        .collect();
    let mut graph = compile(&document, &generations, "0.1.0").unwrap();
    fs::write(directory.path().join("main.tf.json"), graph.to_string()).unwrap();
    let run = |args: &[&str]| -> Output {
        Command::new(&tofu)
            .args(args)
            .current_dir(directory.path())
            .env("TF_CLI_CONFIG_FILE", directory.path().join("tofu.rc"))
            .env("CHECKPOINT_DISABLE", "1")
            .env("TF_IN_AUTOMATION", "1")
            .output()
            .unwrap()
    };
    let success = |args: &[&str]| -> Output {
        let output = run(args);
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output
    };
    let versions: Value = serde_json::from_str(include_str!("../../../versions.json")).unwrap();
    let version = versions["openshell"].as_str().unwrap();
    for failure in ["version", "driver", "multiple", "unavailable", "incomplete"] {
        {
            let mut state = fixture.state.lock().unwrap();
            match failure {
                "version" => {
                    state.gateway_info = Some(openshell_core::proto::GetGatewayInfoResponse {
                        gateway_version: "incompatible-version".into(),
                        compute_drivers: vec![openshell_core::proto::ComputeDriverInfo {
                            name: "docker".into(),
                            ..Default::default()
                        }],
                        ..Default::default()
                    })
                }
                "driver" => state.driver = Some("podman".into()),
                "multiple" => {
                    state.gateway_info = Some(openshell_core::proto::GetGatewayInfoResponse {
                        gateway_version: version.into(),
                        compute_drivers: vec![
                            openshell_core::proto::ComputeDriverInfo {
                                name: "docker".into(),
                                ..Default::default()
                            };
                            2
                        ],
                        ..Default::default()
                    });
                }
                "unavailable" => state.fail_read = Some(("gateway", tonic::Code::Unavailable)),
                _ => state.gateway_info = Some(Default::default()),
            }
        }
        let output = run(&["plan", "-input=false", "-no-color"]);
        assert!(!output.status.success(), "{failure} gateway was accepted");
        let diagnostic = String::from_utf8_lossy(&output.stderr);
        assert!(
            diagnostic.contains(if matches!(failure, "version" | "driver" | "multiple") {
                "Resource precondition failed"
            } else {
                "Gateway capability observation failed"
            }),
            "{diagnostic}"
        );
        if matches!(failure, "version" | "driver" | "multiple") {
            let normalized = diagnostic.split_whitespace().collect::<Vec<_>>().join(" ");
            let reason = match failure {
                "version" => format!(
                    "gateway runs OpenShell incompatible-version, but this build requires {version}"
                ),
                "driver" => {
                    "gateway compute driver is podman, but runtime.provider is docker".into()
                }
                _ => "gateway reports 2 compute drivers, but exactly one is required".into(),
            };
            let expected = format!("Gateway is incompatible with this configuration: {reason}.");
            assert!(
                normalized.contains(&expected),
                "missing {expected}: {diagnostic}"
            );
        }
        assert!(!diagnostic.contains("secret-sentinel"));
        let mut state = fixture.state.lock().unwrap();
        assert_eq!(
            state.effects, 0,
            "failed capability check mutated the gateway"
        );
        state.gateway_info = None;
        state.driver = None;
        state.fail_read = None;
    }
    success(&["apply", "-auto-approve", "-input=false", "-no-color"]);
    let before = fs::read(directory.path().join("terraform.tfstate")).unwrap();
    let effects = fixture.state.lock().unwrap().effects;
    success(&["plan", "-input=false", "-out=plan", "-no-color"]);
    let plan: Value = serde_json::from_slice(&success(&["show", "-json", "plan"]).stdout).unwrap();
    for change in plan["resource_changes"].as_array().unwrap() {
        if change["mode"] != "data" {
            assert_eq!(change["change"]["actions"], json!(["no-op"]));
        }
    }
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    fixture.state.lock().unwrap().driver = Some("podman".into());
    assert!(!run(&["plan", "-input=false", "-no-color"]).status.success());
    assert_eq!(
        fs::read(directory.path().join("terraform.tfstate")).unwrap(),
        before
    );
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    fixture.state.lock().unwrap().driver = None;
    fixture.state.lock().unwrap().fail_read = Some(("provider", tonic::Code::Unavailable));
    assert!(!run(&["plan", "-input=false", "-no-color"]).status.success());
    assert_eq!(
        fs::read(directory.path().join("terraform.tfstate")).unwrap(),
        before
    );
    fixture.state.lock().unwrap().fail_read = None;
    // A saved plan must re-observe compatibility during apply, even when
    // every managed resource is unchanged. No SDK coordinator runs here.
    for create in [false, true] {
        for failure in ["driver", "unavailable"] {
            if create {
                let mut sandbox = document.spec.sandboxes[0].clone();
                sandbox.name = format!("extra-{failure}");
                document.spec.sandboxes.push(sandbox);
                graph = compile(&document, &generations, "0.1.0").unwrap();
                fs::write(directory.path().join("main.tf.json"), graph.to_string()).unwrap();
            }
            success(&["plan", "-input=false", "-out=fresh.plan", "-no-color"]);
            let before = fs::read(directory.path().join("terraform.tfstate")).unwrap();
            let effects = fixture.state.lock().unwrap().effects;
            {
                let mut state = fixture.state.lock().unwrap();
                if failure == "driver" {
                    state.driver = Some("podman".into());
                } else {
                    state.fail_read = Some(("gateway", tonic::Code::Unavailable));
                }
            }
            let output = run(&["apply", "-input=false", "-no-color", "fresh.plan"]);
            assert!(
                !output.status.success(),
                "saved plan reused stale gateway metadata: create={create}, {failure}"
            );
            let diagnostic = String::from_utf8_lossy(&output.stderr);
            let normalized = diagnostic.split_whitespace().collect::<Vec<_>>().join(" ");
            assert!(
                normalized.contains(if failure == "driver" {
                    "Gateway is incompatible with this configuration: gateway compute driver is \
                     podman, but runtime.provider is docker."
                } else {
                    "Gateway capability observation failed"
                }),
                "{diagnostic}"
            );
            assert_eq!(fixture.state.lock().unwrap().effects, effects);
            assert_same_managed_resources(
                &fs::read(directory.path().join("terraform.tfstate")).unwrap(),
                &before,
            );
            {
                let mut state = fixture.state.lock().unwrap();
                state.driver = None;
                state.fail_read = None;
            }
            success(&["apply", "-auto-approve", "-input=false", "-no-color"]);
            assert_eq!(
                fixture.state.lock().unwrap().sandboxes.len(),
                document.spec.sandboxes.len()
            );
        }
    }

    graph["provider"]["nemoclaw"]["destroy"] = json!(true);
    graph.as_object_mut().unwrap().remove("data");
    graph["resource"]["nemoclaw_workspace"]["deployment"]
        .as_object_mut()
        .unwrap()
        .remove("depends_on");
    graph["resource"]["nemoclaw_workspace"]["deployment"]["lifecycle"] =
        json!({"prevent_destroy":true});
    for kind in [
        "nemoclaw_sandbox",
        "nemoclaw_provider_profile",
        "nemoclaw_provider",
    ] {
        graph["resource"].as_object_mut().unwrap().remove(kind);
    }
    fs::write(directory.path().join("main.tf.json"), graph.to_string()).unwrap();
    success(&["apply", "-auto-approve", "-input=false", "-no-color"]);
    let state = fixture.state.lock().unwrap();
    assert!(state.sandboxes.is_empty() && state.providers.is_empty() && state.profiles.is_empty());
    assert_eq!(state.workspaces.len(), 1);
}

#[tokio::test]
async fn gateway_capability_observations_preserve_metadata_and_fail_closed_without_mutations() {
    use nemoclaw_sdk::{
        ObservationError,
        config::Gateway,
        openshell::{EnvironmentSecrets, OpenShell},
    };
    let fixture = Fixture::start().await;
    let client = OpenShell::connect(
        &Gateway::External(nemoclaw_sdk::config::ExternalGateway {
            endpoint: fixture.endpoint.clone(),
            ..Default::default()
        }),
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
    fixture.state.lock().unwrap().driver = Some("podman".into());
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
        fixture.state.lock().unwrap().fail_read = Some(("gateway", code));
        assert_eq!(client.gateway_capabilities().await.unwrap_err(), expected);
    }
    fixture.state.lock().unwrap().fail_read = None;
    fixture.state.lock().unwrap().gateway_info = Some(Default::default());
    assert_eq!(
        client.gateway_capabilities().await.unwrap_err(),
        ObservationError::Incomplete
    );
    assert_eq!(fixture.state.lock().unwrap().effects, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER"]
async fn gateway_capability_reads_wait_for_unknown_bootstrap_dependencies() {
    let fixture = Fixture::start().await;
    fixture.state.lock().unwrap().fail_read = Some(("gateway", tonic::Code::Unavailable));
    let directory = tempfile::tempdir().unwrap();
    let tofu = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_TOFU").expect("explicit pinned OpenTofu path"),
    );
    let provider = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_PROVIDER").expect("explicit production provider path"),
    );
    assert!(tofu.is_absolute() && provider.is_absolute());
    fs::copy(
        provider,
        directory.path().join(nemoclaw_sdk::bundle::executable(
            "terraform-provider-nemoclaw",
        )),
    )
    .unwrap();
    fs::write(directory.path().join("tofu.rc"), format!("provider_installation {{ dev_overrides {{ \"registry.opentofu.org/nvidia/nemoclaw\" = {} }} direct {{}} }}", serde_json::to_string(directory.path().to_str().unwrap()).unwrap())).unwrap();
    fs::write(directory.path().join("main.tf.json"), json!({
        "terraform":{"required_version":"= 1.12.6", "required_providers":{"nemoclaw":{"source":"registry.opentofu.org/nvidia/nemoclaw"}}},
        "provider":{"nemoclaw":{"endpoint":fixture.endpoint}},
        "resource":{"terraform_data":{"bootstrap":{"input":"docker"}}},
        "data":{"nemoclaw_gateway_capabilities":{"current":{
            "required_compute_drivers":["${terraform_data.bootstrap.output}"],
            "lifecycle":{"postcondition":[{"condition":"${self.compatible}", "error_message":"Gateway is incompatible."}]}
        }}},
        "output":{"compatible":{"value":"${data.nemoclaw_gateway_capabilities.current.compatible}"}}
    }).to_string()).unwrap();
    let run = |args: &[&str]| {
        let output = Command::new(&tofu)
            .args(args)
            .current_dir(directory.path())
            .env("TF_CLI_CONFIG_FILE", directory.path().join("tofu.rc"))
            .env("CHECKPOINT_DISABLE", "1")
            .env("TF_IN_AUTOMATION", "1")
            .output()
            .unwrap();
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
        fixture.state.lock().unwrap().gateway_reads,
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
    fixture.state.lock().unwrap().fail_read = None;
    run(&["apply", "-input=false", "-no-color", "bootstrap.plan"]);
    let state: Value =
        serde_json::from_slice(&fs::read(directory.path().join("terraform.tfstate")).unwrap())
            .unwrap();
    assert_eq!(state["outputs"]["compatible"]["value"], true);
    assert!(fixture.state.lock().unwrap().gateway_reads > 0);
    assert_eq!(fixture.state.lock().unwrap().effects, 0);
}

#[path = "fixtures/standalone_openshell.rs"]
mod standalone;
