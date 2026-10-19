// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! `openshell_sandbox`'s `driver_config`: OpenShell's per-driver sandbox
//! settings, such as mounts, passed through unchanged.
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
variable "target" { default = "/sandbox/skills" }
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
  name       = "mounts"
  owner      = "mounts-owner"
  generation = "workspace-generation"
}
# Sandboxes attach at least one provider.
resource "openshell_web_search" "brave" {
  gateway        = local.gateway
  workspace      = openshell_workspace.example.ref
  name           = "brave"
  provider_type  = "brave"
  credential_env = "NEMOCLAW_TEST_BRAVE_KEY"
  binaries       = var.binaries
}
resource "openshell_sandbox" "agent" {
  gateway     = local.gateway
  workspace   = openshell_workspace.example.ref
  name        = "assistant"
  owner       = openshell_workspace.example.owner
  generation  = "sandbox-generation"
  image       = "fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  launch_json = var.launch_json
  providers   = [openshell_web_search.brave.ref]
  driver_config = jsonencode({
    docker = {
      mounts = [{ type = "volume", source = "skills", target = var.target }]
      tmpfs_bytes = 1048576
    }
  })
  policy {}
}
"#;

fn workspace(endpoint: &str) -> TofuWorkspace {
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
    variables["endpoint"] = json!(endpoint);
    fs::write(
        root.path().join("terraform.tfvars.json"),
        variables.to_string(),
    )
    .unwrap();
    root
}

fn run(root: &TofuWorkspace, args: &[&str]) -> Output {
    let output = root
        .command()
        .args(args)
        .arg("-no-color")
        .env("NEMOCLAW_TEST_BRAVE_KEY", "brave-fixture-secret")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

/// A plan that would replace the sandbox, which the provider refuses.
fn sandbox_actions(root: &TofuWorkspace, extra: &[&str]) -> Value {
    let mut args = vec!["plan", "-input=false", "-out=check.plan"];
    args.extend(extra);
    run(root, &args);
    let plan: Value =
        serde_json::from_slice(&run(root, &["show", "-json", "check.plan"]).stdout).unwrap();
    plan["resource_changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|change| change["address"] == "openshell_sandbox.agent")
        .unwrap()["change"]["actions"]
        .clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn sandbox_driver_config_passes_through_unchanged() {
    let fixture = Fixture::start().await;
    let root = workspace(&fixture.endpoint);
    run(&root, &["apply", "-auto-approve", "-input=false"]);

    // The gateway receives the configuration as written, with nothing added.
    let sent = {
        let state = fixture.state.lock().unwrap();
        let sandbox = state.sandboxes.values().next().unwrap();
        let template = sandbox.spec.as_ref().unwrap().template.as_ref().unwrap();
        openshell_core::proto_struct::struct_to_json_value(template.driver_config.as_ref().unwrap())
    };
    assert_eq!(
        sent,
        json!({"docker": {"mounts": [{"type": "volume", "source": "skills", "target": "/sandbox/skills"}], "tmpfs_bytes": 1048576.0}})
    );

    // Reading it back plans no change, numbers included.
    assert_eq!(sandbox_actions(&root, &[]), json!(["no-op"]));

    // It's part of the immutable sandbox specification: a change replaces
    // the sandbox, as for its image.
    assert_eq!(
        sandbox_actions(&root, &["-var=target=/sandbox/other"]),
        json!(["delete", "create"])
    );

    // A configuration changed behind OpenTofu shows as drift.
    {
        let mut state = fixture.state.lock().unwrap();
        let sandbox = state.sandboxes.values_mut().next().unwrap();
        let template = sandbox.spec.as_mut().unwrap().template.as_mut().unwrap();
        template.driver_config = None;
    }
    assert_eq!(sandbox_actions(&root, &[]), json!(["delete", "create"]));
}
