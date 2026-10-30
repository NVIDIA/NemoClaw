// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The cluster access OpenTofu receives for a managed Kubernetes target: a
//! named kubeconfig, or the service account of the pod that runs NemoClaw.
//!
//! A script stands in for OpenTofu and records the environment it receives,
//! so these tests establish what the SDK passes, not what the providers do
//! with it.

#![cfg(unix)]

use crate::scripted_tofu::{Scripted, kubernetes_document};
use nemoclaw_sdk::{CancellationToken, config::Document};

const POD_VARIABLES: [&str; 2] = ["KUBERNETES_SERVICE_HOST", "KUBERNETES_SERVICE_PORT"];

/// Whether this test process runs in a pod, where both variables are set.
fn in_a_pod() -> bool {
    POD_VARIABLES
        .iter()
        .any(|name| std::env::var_os(name).is_some())
}

fn pod_document() -> Document {
    let mut value = serde_json::to_value(kubernetes_document("local-agent", "agents")).unwrap();
    let kubernetes = value["spec"]["gateway"]["kubernetes"]
        .as_object_mut()
        .unwrap();
    kubernetes.remove("kubeconfig");
    kubernetes.remove("context");
    Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap()
}

/// Outside a pod, a target without a kubeconfig stops before OpenTofu plans,
/// so no provider starts, and the error says what is missing.
#[tokio::test]
async fn outside_a_pod_a_target_without_kubeconfig_stops_before_opentofu_plans() {
    if in_a_pod() {
        eprintln!("skipped: the test process runs in a pod");
        return;
    }
    let scripted = Scripted::new();
    let error = scripted
        .deployment(&scripted.path("unused-kubeconfig"))
        .plan(&pod_document(), &CancellationToken::new())
        .await
        .unwrap_err()
        .to_string();
    for named in [
        "KUBERNETES_SERVICE_HOST",
        "KUBERNETES_SERVICE_PORT",
        "gateway.kubernetes.kubeconfig",
    ] {
        assert!(error.contains(named), "{named}: {error}");
    }
    let commands = scripted.commands();
    assert!(
        !commands.iter().any(|command| command == "root plan"),
        "{commands:?}"
    );
}

/// With a kubeconfig named, OpenTofu receives its path and none of a pod's
/// variables, even when the caller runs in a pod.
#[tokio::test]
async fn with_a_kubeconfig_opentofu_receives_no_pod_variables() {
    let scripted = Scripted::new();
    let kubeconfig = scripted.path("missing-kubeconfig");
    // The script plans nothing, so the SDK refuses the plan after OpenTofu ran.
    let _ = scripted
        .deployment(&kubeconfig)
        .plan(
            &kubernetes_document("local-agent", "agents"),
            &CancellationToken::new(),
        )
        .await;
    let environment = scripted
        .environment("plan")
        .expect("OpenTofu planned with a kubeconfig");
    assert_eq!(
        environment
            .get("TF_VAR_nemoclaw_kubeconfig")
            .map(String::as_str),
        kubeconfig.to_str()
    );
    for name in environment.keys() {
        assert!(!name.starts_with("KUBERNETES_"), "{name}");
    }
}
