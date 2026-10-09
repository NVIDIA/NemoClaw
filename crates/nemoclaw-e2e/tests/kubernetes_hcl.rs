// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Managed Kubernetes resources written in HCL, planned without a cluster.

use nemoclaw_e2e::tofu::TofuWorkspace;
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

fn workspace(resources: &str) -> TofuWorkspace {
    let tofu = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_TOFU").unwrap());
    let provider = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_PROVIDER").unwrap());
    assert!(tofu.is_absolute() && provider.is_absolute());
    let workspace = TofuWorkspace::new(tofu, provider);
    fs::write(
        workspace.path().join("main.tf"),
        format!(
            r#"terraform {{
  required_version = "= 1.12.6"
  required_providers {{
    nemoclaw = {{ source = "registry.opentofu.org/nvidia/nemoclaw" }}
  }}
}}
provider "nemoclaw" {{}}
{resources}"#
        ),
    )
    .unwrap();
    workspace
}

/// Storage, authentication and the gateway for one cluster target. The
/// authentication and gateway resources take the storage's owner unless
/// `owner` names one for every resource.
fn platform(namespace: &str, owner: Option<&str>) -> String {
    let target = format!(
        r#"  name                   = "nc-0123456789abcdef-gateway"
  compute_driver         = "openshift"
  endpoint               = "https://127.0.0.1:17671"
  kubeconfig_env         = "TEST_CLUSTER_KUBECONFIG"
  context                = "selected"
  namespace              = "{namespace}"
  authentication_profile = "development"
  environment            = ["AWS_PROFILE"]
"#
    );
    let (storage, auth, gateway) = match owner {
        Some(owner) => {
            let identity = format!("  owner = \"{owner}\"\n");
            (identity.clone(), identity.clone(), identity)
        }
        None => (
            String::new(),
            "  owner = nemoclaw_kubernetes_storage.platform.owner\n".to_owned(),
            "  owner      = nemoclaw_kubernetes_storage.platform.owner\n  generation = nemoclaw_kubernetes_auth.platform.generation\n".to_owned(),
        ),
    };
    format!(
        r#"resource "nemoclaw_kubernetes_storage" "platform" {{
{target}{storage}}}

resource "nemoclaw_kubernetes_auth" "platform" {{
{target}{auth}}}

resource "nemoclaw_kubernetes_gateway" "platform" {{
{target}{gateway}}}
"#
    )
}

#[test]
#[ignore = "requires NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; no cluster"]
fn kubernetes_resources_plan_from_typed_settings_and_reject_invalid_ones() {
    let valid = workspace(&platform("agents", None));
    let run =
        |workspace: &TofuWorkspace, args: &[&str]| workspace.command().args(args).output().unwrap();
    let output = run(&valid, &["plan", "-input=false", "-out=platform.plan"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let plan: Value =
        serde_json::from_slice(&run(&valid, &["show", "-json", "platform.plan"]).stdout).unwrap();
    let changes = plan["resource_changes"].as_array().unwrap();
    assert_eq!(changes.len(), 3);
    for change in changes {
        let change = &change["change"];
        assert_eq!(change["actions"], json!(["create"]));
        assert_eq!(change["after"]["environment"], json!(["AWS_PROFILE"]));
        assert_eq!(change["after"]["namespace"], "agents");
        // The provider generates the storage's identity; the others share it.
        assert_eq!(change["after_unknown"]["owner"], true);
    }

    // OpenTofu skips resources whose dependencies fail validation, so each
    // resource names its own owner here.
    let invalid = workspace(&platform(
        "Not A Namespace",
        Some("302ff5e1-088d-42ce-959f-4ff4c3570c13"),
    ));
    let output = run(&invalid, &["validate"]);
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    for kind in [
        "nemoclaw_kubernetes_storage",
        "nemoclaw_kubernetes_auth",
        "nemoclaw_kubernetes_gateway",
    ] {
        assert!(
            stderr.contains(&format!("{kind}.platform")),
            "{kind}: {stderr}"
        );
    }
    assert!(
        stderr.contains("namespace must be a Kubernetes namespace name"),
        "{stderr}"
    );
}
