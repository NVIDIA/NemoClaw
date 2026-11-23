// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Each check runs in a child process with its own environment, so no test
//! changes this process's environment.

use nemoclaw_sdk::config::{ComputeDriver, ManagedTarget};

/// Set in a child process; its value is what the child expects.
const CHILD: &str = "NEMOCLAW_TELEMETRY_TEST_CHILD";

/// Runs `test` alone in a child process with `environment`, and fails unless
/// exactly that test ran and passed.
fn in_child(test: &str, environment: &[(&str, &str)]) {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &format!("telemetry::{test}"), "--nocapture"])
        .env_remove("NEMOCLAW_DISABLE_TELEMETRY")
        .envs(environment.iter().copied())
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("1 passed"),
        "{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn openshell_telemetry_stays_disabled_even_when_environment_requests_it() {
    if std::env::var_os(CHILD).is_some() {
        assert!(!openshell_core::telemetry::enabled());
        assert_eq!(openshell_core::telemetry::enabled_env_value(), "false");
        return;
    }
    in_child(
        "openshell_telemetry_stays_disabled_even_when_environment_requests_it",
        &[(CHILD, "1"), ("OPENSHELL_TELEMETRY_ENABLED", "true")],
    );
}

#[test]
fn managed_gateways_follow_nemoclaw_telemetry() {
    if let Some(expected) = std::env::var_os(CHILD) {
        let fixtures: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../nemoclaw-provider/src/managed/reference.json"
        ))
        .unwrap();
        let docker: nemoclaw_sdk::managed::Spec =
            serde_json::from_str(fixtures[0]["spec"].as_str().unwrap()).unwrap();
        let mut podman = docker.clone();
        podman.compute_driver = ComputeDriver::Podman;
        podman.gateway.target = ManagedTarget::Podman(docker.gateway.local().unwrap().clone());
        for gateway in [docker, podman] {
            let env = gateway.container("/data").unwrap().env.unwrap();
            let switch = format!("OPENSHELL_TELEMETRY_ENABLED={}", expected.to_str().unwrap());
            assert!(env.contains(&switch), "{env:?}");
        }
        let kubernetes: nemoclaw_sdk::kubernetes::Spec = serde_json::from_value(serde_json::json!({
            "layout": 1, "kind": nemoclaw_sdk::kubernetes::GATEWAY_KIND,
            "name": "nc-0123456789abcdef-gateway",
            "owner": "11111111-1111-4111-8111-111111111111",
            "generation": "0123456789abcdef0123456789abcdef",
            "settings": {"target": {"kubernetes": {
                "kubeconfig": {"env": "TEST_KUBECONFIG"}, "context": "selected", "namespace": "agents",
                "authentication": {"profile": "development"}
            }}}
        }))
        .unwrap();
        let values = nemoclaw_sdk::kubernetes::gateway::values(&kubernetes).unwrap();
        assert_eq!(
            values["server"]["telemetryEnabled"].to_string(),
            expected.to_str().unwrap()
        );
        return;
    }
    let test = "managed_gateways_follow_nemoclaw_telemetry";
    in_child(test, &[(CHILD, "true")]);
    in_child(
        test,
        &[(CHILD, "false"), ("NEMOCLAW_DISABLE_TELEMETRY", "1")],
    );
}
