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

fn storage(namespace: &str) -> String {
    format!(
        r#"resource "nemoclaw_kubernetes_storage" "platform" {{
  name                   = "nc-0123456789abcdef-gateway"
  compute_driver         = "openshift"
  endpoint               = "https://127.0.0.1:17671"
  kubeconfig_env         = "TEST_CLUSTER_KUBECONFIG"
  context                = "selected"
  namespace              = "{namespace}"
  authentication_profile = "development"
  environment            = ["AWS_PROFILE"]
}}
"#
    )
}

#[test]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; no cluster"]
fn kubernetes_resources_plan_from_typed_settings_and_reject_invalid_ones() {
    let valid = workspace(&storage("agents"));
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
    let change = &plan["resource_changes"][0]["change"];
    assert_eq!(change["actions"], json!(["create"]));
    assert_eq!(change["after"]["environment"], json!(["AWS_PROFILE"]));
    assert_eq!(change["after"]["namespace"], "agents");
    // The provider generates the identity the author omits.
    assert_eq!(change["after_unknown"]["owner"], true);
    assert_eq!(change["after_unknown"]["generation"], true);

    let invalid = workspace(&storage("Not A Namespace"));
    let output = run(&invalid, &["validate"]);
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("namespace must be a Kubernetes namespace name"),
        "{stderr}"
    );
}
