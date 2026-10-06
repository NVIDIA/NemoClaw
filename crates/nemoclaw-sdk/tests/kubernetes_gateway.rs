// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The gateway release: Helm runs only against the authored cluster, with
//! the pinned chart and images, and none of the caller's Helm settings.
#![cfg(unix)]

use nemoclaw_sdk::kubernetes::gateway::{Release, install, uninstall};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// A fake helm that records its arguments, environment and values file.
fn fake_helm(directory: &Path, exit: i32) -> PathBuf {
    let helm = directory.join("helm");
    std::fs::write(
        &helm,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > {log}/argv\nenv > {log}/env\n\
             while [ $# -gt 0 ]; do [ \"$1\" = -f ] && cp \"$2\" {log}/values.json; shift; done\nexit {exit}\n",
            log = directory.display()
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&helm, std::fs::Permissions::from_mode(0o700)).unwrap();
    helm
}

fn release(directory: &Path, helm: PathBuf) -> Release {
    Release {
        helm,
        state: directory.join("state"),
        kubeconfig: directory.join("kubeconfig"),
        context: "selected".into(),
        namespace: "agents".into(),
        name: "nc-0123456789abcdef-gateway".into(),
    }
}

fn argv(directory: &Path) -> Vec<String> {
    std::fs::read_to_string(directory.join("argv"))
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect()
}

#[tokio::test]
async fn install_upgrades_the_pinned_chart_on_the_authored_context_and_waits() {
    let directory = tempfile::tempdir().unwrap();
    let helm = fake_helm(directory.path(), 0);
    install(&release(directory.path(), helm)).await.unwrap();
    let argv = argv(directory.path());
    assert_eq!(
        argv[..3],
        ["upgrade", "--install", "nc-0123456789abcdef-gateway"]
    );
    assert!(
        argv[3].starts_with("oci://ghcr.io/nvidia/openshell/helm-chart@sha256:"),
        "{}",
        argv[3]
    );
    for (flag, value) in [
        (
            "--kubeconfig",
            directory.path().join("kubeconfig").display().to_string(),
        ),
        ("--kube-context", "selected".into()),
        ("--namespace", "agents".into()),
    ] {
        let at = argv
            .iter()
            .position(|argument| argument == flag)
            .unwrap_or_else(|| panic!("{flag}"));
        assert_eq!(argv[at + 1], value);
    }
    assert!(argv.contains(&"--wait".to_owned()));
}

#[tokio::test]
async fn the_chart_values_pin_every_image_by_digest_and_require_authentication() {
    let directory = tempfile::tempdir().unwrap();
    let helm = fake_helm(directory.path(), 0);
    install(&release(directory.path(), helm)).await.unwrap();
    let values: Value =
        serde_json::from_slice(&std::fs::read(directory.path().join("values.json")).unwrap())
            .unwrap();
    assert_eq!(values["fullnameOverride"], "nc-0123456789abcdef-gateway");
    for image in ["gateway", "sandboxRuntime", "supervisor", "sandbox"] {
        let digest = values[image]["image"]["digest"]
            .as_str()
            .unwrap_or_else(|| panic!("{image}"));
        assert!(
            digest.starts_with("sha256:") && digest.len() == 71,
            "{image}: {digest}"
        );
    }
    assert_eq!(values["server"]["auth"]["allowUnauthenticatedUsers"], false);
    assert_eq!(values["server"]["disableTls"], false);
    assert_eq!(values["server"]["telemetryEnabled"], false);
    assert_eq!(
        values["server"]["credentialStorage"]["existingSecret"],
        "nc-0123456789abcdef-gateway-kek"
    );
}

#[tokio::test]
async fn helm_sees_none_of_the_callers_helm_or_cluster_settings() {
    // Rerun in a child process whose environment selects another cluster
    // and Helm configuration; the fake records what Helm actually received.
    const CHILD: &str = "NEMOCLAW_HELM_TEST_DIRECTORY";
    if let Some(directory) = std::env::var_os(CHILD) {
        let directory = PathBuf::from(directory);
        let helm = fake_helm(&directory, 0);
        install(&release(&directory, helm)).await.unwrap();
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "kubernetes_gateway::helm_sees_none_of_the_callers_helm_or_cluster_settings",
        ])
        .env(CHILD, directory.path())
        .env("KUBECONFIG", "/elsewhere/kubeconfig")
        .env("HELM_KUBECONTEXT", "elsewhere")
        .env("HELM_NAMESPACE", "elsewhere")
        .env("HELM_REGISTRY_CONFIG", "/elsewhere/registry.json")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let environment = std::fs::read_to_string(directory.path().join("env")).unwrap();
    for name in [
        "KUBECONFIG=",
        "HELM_KUBECONTEXT=",
        "HELM_NAMESPACE=",
        "HELM_REGISTRY_CONFIG=/elsewhere",
    ] {
        assert!(
            !environment.lines().any(|line| line.starts_with(name)),
            "{name} reached helm"
        );
    }
}

/// Renders the pinned chart with the SDK's values using a real helm.
#[test]
#[ignore = "pulls the pinned chart; needs NEMOCLAW_TEST_HELM"]
fn the_pinned_chart_renders_with_the_sdk_values() {
    let helm =
        std::env::var_os("NEMOCLAW_TEST_HELM").expect("NEMOCLAW_TEST_HELM names a helm executable");
    let directory = tempfile::tempdir().unwrap();
    let release = release(directory.path(), helm.clone().into());
    let values = directory.path().join("values.json");
    std::fs::write(
        &values,
        nemoclaw_sdk::kubernetes::gateway::values(&release).to_string(),
    )
    .unwrap();
    let output = std::process::Command::new(helm)
        .args([
            "template",
            &release.name,
            nemoclaw_sdk::kubernetes::gateway::CHART,
            "--namespace",
            "agents",
        ])
        .args(["--set", "agentSandbox.preflight.enabled=false", "-f"])
        .arg(&values)
        .env("HELM_CACHE_HOME", directory.path().join("cache"))
        .env("HELM_CONFIG_HOME", directory.path().join("config"))
        .env("HELM_DATA_HOME", directory.path().join("data"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let rendered = String::from_utf8(output.stdout).unwrap();
    let gateway = nemoclaw_sdk::kubernetes::gateway::values(&release)["gateway"]["image"].clone();
    let pinned = format!(
        "{}@{}",
        gateway["repository"].as_str().unwrap(),
        gateway["digest"].as_str().unwrap()
    );
    assert!(
        rendered.contains(&pinned),
        "gateway image {pinned} not rendered"
    );
    assert!(rendered.contains("name: nc-0123456789abcdef-gateway"));
}

#[tokio::test]
async fn a_failed_helm_command_is_reported_without_its_output() {
    let directory = tempfile::tempdir().unwrap();
    let helm = fake_helm(directory.path(), 1);
    assert!(
        install(&release(directory.path(), helm.clone()))
            .await
            .is_err()
    );
    assert!(uninstall(&release(directory.path(), helm)).await.is_err());
}

#[tokio::test]
async fn uninstall_removes_the_release_from_the_authored_context_and_waits() {
    let directory = tempfile::tempdir().unwrap();
    let helm = fake_helm(directory.path(), 0);
    uninstall(&release(directory.path(), helm)).await.unwrap();
    let argv = argv(directory.path());
    assert_eq!(argv[..2], ["uninstall", "nc-0123456789abcdef-gateway"]);
    assert!(argv.contains(&"--wait".to_owned()));
    let at = argv
        .iter()
        .position(|argument| argument == "--kube-context")
        .unwrap();
    assert_eq!(argv[at + 1], "selected");
}
