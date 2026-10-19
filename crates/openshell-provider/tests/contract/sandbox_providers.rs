// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! `openshell_sandbox` without providers: `providers` is optional.
use super::*;
use serde_json::json;

const CONFIG: &str = r#"terraform {
  required_version = "= 1.12.8"
  required_providers {
    openshell = { source = "registry.opentofu.org/nvidia/openshell" }
  }
}
variable "endpoint" { type = string }
variable "launch_json" { type = string }
variable "binaries" { type = list(string) }
provider "openshell" {}
locals {
  gateway = {
    type                = "openshell_gateway"
    endpoint            = var.endpoint
    credential_env      = ""
    tls_ca_env          = ""
    tls_certificate_env = ""
    tls_key_env         = ""
    kubernetes          = ""
  }
}
resource "openshell_workspace" "example" {
  gateway    = local.gateway
  name       = "no-providers"
  owner      = "no-providers-owner"
  generation = "workspace-generation"
}
resource "openshell_sandbox" "omitted" {
  gateway     = local.gateway
  workspace   = openshell_workspace.example.ref
  name        = "omitted"
  owner       = openshell_workspace.example.owner
  generation  = "omitted-generation"
  image       = "fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  launch_json = var.launch_json
  policy {}
}
resource "openshell_sandbox" "empty" {
  gateway     = local.gateway
  workspace   = openshell_workspace.example.ref
  name        = "empty"
  owner       = openshell_workspace.example.owner
  generation  = "empty-generation"
  image       = "fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  launch_json = var.launch_json
  providers   = []
  policy {}
}
"#;

fn run(root: &TofuWorkspace, args: &[&str]) -> Output {
    let output = root.command().args(args).arg("-no-color").output().unwrap();
    assert!(
        output.status.success(),
        "{args:?}\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn sandboxes_attach_no_providers_when_none_are_given() {
    let fixture = Fixture::start().await;
    let root = TofuWorkspace::with_providers(tofu(), &[("openshell", &provider())]);
    fs::write(root.path().join("main.tf"), CONFIG).unwrap();
    let mut variables: Value = serde_json::from_slice(
        &fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/contract/standalone/terraform.tfvars.json"),
        )
        .unwrap(),
    )
    .unwrap();
    variables["endpoint"] = json!(fixture.endpoint);
    fs::write(
        root.path().join("terraform.tfvars.json"),
        variables.to_string(),
    )
    .unwrap();

    run(&root, &["apply", "-auto-approve", "-input=false"]);
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.sandboxes.len(), 2);
        for sandbox in state.sandboxes.values() {
            assert!(sandbox.spec.as_ref().unwrap().providers.is_empty());
        }
    }

    // Reading both back plans no change.
    run(&root, &["plan", "-input=false", "-out=noop.plan"]);
    let plan: Value =
        serde_json::from_slice(&run(&root, &["show", "-json", "noop.plan"]).stdout).unwrap();
    for change in plan["resource_changes"].as_array().unwrap() {
        assert_eq!(change["change"]["actions"], json!(["no-op"]), "{change}");
    }
}
