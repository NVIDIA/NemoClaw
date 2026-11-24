// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Each check runs in a child process with its own environment, so no test
//! changes this process's environment.

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
        let expected = expected.to_str().unwrap();
        let generations: nemoclaw_sdk::compile::Generations = [
            "workspace",
            "provider",
            "sandbox",
            "managed_gateway",
            "gateway_storage",
        ]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
        let compile = |example: &[u8]| {
            let document = nemoclaw_sdk::config::Document::parse(example).unwrap();
            nemoclaw_sdk::compile::compile(&document, &generations, "0.1.0").unwrap()
        };
        // Docker computes the gateway's launch from what the deployment records.
        let docker = nemoclaw_sdk::compile::compile_runtime(
            &nemoclaw_sdk::config::Document::parse(
                include_bytes!("fixtures/config/spark.yaml").as_slice(),
            )
            .unwrap(),
            &[
                "workspace",
                "provider",
                "sandbox",
                "managed_gateway",
                "inference_service",
            ]
            .map(|key| (key.into(), "a".repeat(32)))
            .into(),
            "0.1.0",
        )
        .unwrap();
        let launch = &docker["data"]["openshell_docker_gateway_runtime"]["managed_gateway_runtime"];
        assert_eq!(launch["openshell_telemetry"], expected, "{launch}");
        // Podman's gateway resource records it, and its container follows.
        let podman = compile(include_bytes!(
            "../../../examples/platforms/podman/deepagents-external-inference.yaml"
        ));
        let row: nemoclaw_sdk::backend::Row =
            podman["resource"]["openshell_podman_gateway"]["runtime"]
                .as_object()
                .unwrap()
                .iter()
                .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
                .collect();
        let gateway = nemoclaw_sdk::managed::Spec::from_gateway_row(
            nemoclaw_sdk::managed::GATEWAY_KIND,
            &row,
        )
        .unwrap();
        let env = gateway.container("/data").unwrap().env.unwrap();
        let switch = format!("OPENSHELL_TELEMETRY_ENABLED={expected}");
        assert!(env.contains(&switch), "{env:?}");
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
        assert_eq!(values["server"]["telemetryEnabled"].to_string(), expected);
        return;
    }
    let test = "managed_gateways_follow_nemoclaw_telemetry";
    in_child(test, &[(CHILD, "true")]);
    // Any set value turns it off, as it turns off the CLI's own record.
    for off in ["1", "yes", "TRUE", "ture"] {
        in_child(
            test,
            &[(CHILD, "false"), ("NEMOCLAW_DISABLE_TELEMETRY", off)],
        );
    }
    for on in ["", "0", "false", "FALSE"] {
        in_child(test, &[(CHILD, "true"), ("NEMOCLAW_DISABLE_TELEMETRY", on)]);
    }
}

/// A managed gateway's OpenShell telemetry is decided when the deployment is
/// compiled and recorded with the gateway. A later plan run with the switch
/// flipped then reproduces the gateway it created instead of reporting its
/// environment as drifted.
#[test]
fn a_managed_gateway_keeps_the_telemetry_it_was_compiled_with() {
    use nemoclaw_sdk::managed::{GATEWAY_KIND, Spec};
    const ROW: &str = "NEMOCLAW_TELEMETRY_TEST_ROW";
    let test = "a_managed_gateway_keeps_the_telemetry_it_was_compiled_with";
    let path = std::env::var_os(ROW).map(std::path::PathBuf::from);
    match std::env::var(CHILD).as_deref() {
        Ok("compile") => {
            let generations: nemoclaw_sdk::compile::Generations = [
                "workspace",
                "provider",
                "sandbox",
                "managed_gateway",
                "gateway_storage",
            ]
            .map(|key| (key.into(), "a".repeat(32)))
            .into();
            let document = nemoclaw_sdk::config::Document::parse(
                include_bytes!(
                    "../../../examples/platforms/podman/deepagents-external-inference.yaml"
                )
                .as_slice(),
            )
            .unwrap();
            let graph = nemoclaw_sdk::compile::compile(&document, &generations, "0.1.0").unwrap();
            let gateway = &graph["resource"]["openshell_podman_gateway"]["runtime"];
            let row: nemoclaw_sdk::backend::Row = gateway
                .as_object()
                .unwrap()
                .iter()
                .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
                .collect();
            std::fs::write(path.unwrap(), serde_json::to_string(&row).unwrap()).unwrap();
        }
        Ok("observe") => {
            let row: nemoclaw_sdk::backend::Row =
                serde_json::from_str(&std::fs::read_to_string(path.unwrap()).unwrap()).unwrap();
            let gateway = Spec::from_gateway_row(GATEWAY_KIND, &row).unwrap();
            let env = gateway.container("/data").unwrap().env.unwrap();
            assert!(
                env.contains(&"OPENSHELL_TELEMETRY_ENABLED=false".to_owned()),
                "{env:?}"
            );
        }
        _ => {
            let directory = tempfile::tempdir().unwrap();
            let row = directory.path().join("row.json");
            let row = row.to_str().unwrap();
            in_child(
                test,
                &[
                    (CHILD, "compile"),
                    (ROW, row),
                    ("NEMOCLAW_DISABLE_TELEMETRY", "1"),
                ],
            );
            in_child(test, &[(CHILD, "observe"), (ROW, row)]);
        }
    }
}
