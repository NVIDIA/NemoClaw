// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::{DEFAULT_AGENT_IMAGE, DEFAULT_GATEWAY_IMAGE, DEFAULT_HERMES_IMAGE};

#[test]
fn openshell_telemetry_stays_disabled_even_when_environment_requests_it() {
    const CHILD: &str = "NEMOCLAW_TELEMETRY_TEST_CHILD";
    if std::env::var_os(CHILD).is_some() {
        assert!(!openshell_core::telemetry::enabled());
        assert_eq!(openshell_core::telemetry::enabled_env_value(), "false");
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "openshell_telemetry_stays_disabled_even_when_environment_requests_it",
            "--nocapture",
        ])
        .env(CHILD, "1")
        .env("OPENSHELL_TELEMETRY_ENABLED", "true")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn runtime_defaults_use_the_artifact_manifest() {
    let pins: serde_json::Value =
        serde_json::from_str(include_str!("../../../versions.json")).unwrap();
    assert_eq!(pins["images"]["agent"], DEFAULT_AGENT_IMAGE);
    assert_eq!(pins["images"]["hermes"], DEFAULT_HERMES_IMAGE);
    assert_eq!(pins["images"]["gateway"], DEFAULT_GATEWAY_IMAGE);
    for image in pins["images"].as_object().unwrap().values() {
        let digest = image.as_str().unwrap().split_once("@sha256:").unwrap().1;
        assert_eq!(digest.len(), 64);
        assert!(
            digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        );
    }
}

#[test]
fn declared_openshell_clients_match_the_artifact_revision() {
    let pins: serde_json::Value =
        serde_json::from_str(include_str!("../../../versions.json")).unwrap();
    let output = std::process::Command::new(env!("CARGO"))
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .args([
            "metadata",
            "--format-version",
            "1",
            "--no-deps",
            "--locked",
            "--offline",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let metadata: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let package = metadata["packages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|package| package["name"] == env!("CARGO_PKG_NAME"))
        .unwrap();
    for name in ["openshell-core", "openshell-policy", "openshell-sdk"] {
        let dependency = package["dependencies"]
            .as_array()
            .unwrap()
            .iter()
            .find(|dependency| dependency["name"] == name)
            .unwrap();
        let source = url::Url::parse(
            dependency["source"]
                .as_str()
                .unwrap()
                .strip_prefix("git+")
                .unwrap(),
        )
        .unwrap();
        let revision = source
            .query_pairs()
            .find(|(key, _)| key == "rev")
            .map(|(_, value)| value.into_owned());
        assert_eq!(
            revision.as_deref(),
            pins["openshellRevision"].as_str(),
            "{name}"
        );
    }
}
