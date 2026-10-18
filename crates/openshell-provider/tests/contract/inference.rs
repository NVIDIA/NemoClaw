// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! `openshell_inference`: one resource owning an inference server's OpenShell
//! profile and registration, taking the server's ref.
use super::*;
use serde_json::json;

const CONFIG: &str = r#"terraform {
  required_version = "= 1.12.6"
  required_providers {
    openshell = { source = "registry.opentofu.org/nvidia/openshell" }
  }
}
variable "endpoint" { type = string }
variable "launch_json" { type = string }
variable "binaries" { type = list(string) }
variable "enabled" { default = true }
variable "sandbox" { default = true }
variable "destroy" { default = false }
provider "openshell" { destroy = var.destroy }
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
  # What a readiness read exports for an unauthenticated server.
  server = {
    type              = "inference_server"
    endpoint          = "http://127.0.0.1:11434/v1"
    model             = "nemotron"
    credential_env    = ""
    credential_source = ""
  }
}
resource "openshell_workspace" "example" {
  gateway    = local.gateway
  name       = "inference"
  owner      = "inference-owner"
  generation = "workspace-generation"
  lifecycle { prevent_destroy = true }
}
resource "openshell_inference" "local" {
  count     = var.enabled ? 1 : 0
  gateway   = local.gateway
  workspace = openshell_workspace.example.ref
  name      = "local"
  server    = local.server
  api       = "openai-completions"
  binaries  = var.binaries
}
resource "openshell_sandbox" "agent" {
  count       = var.enabled && var.sandbox ? 1 : 0
  gateway     = local.gateway
  workspace   = openshell_workspace.example.ref
  name        = "assistant"
  owner       = openshell_workspace.example.owner
  generation  = "sandbox-generation"
  image       = "fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  launch_json = var.launch_json
  providers   = [openshell_inference.local[0].ref]
  policy {
    managed {
      endpoints {
        access      = "full"
        allowed_ips = ["127.0.0.1/32"]
        host        = "127.0.0.1"
        path        = "/v1/**"
        port        = 11434
        protocol    = "rest"
      }
      name = "nemoclaw-inference-local"
    }
  }
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
    let output = root.command().args(args).arg("-no-color").output().unwrap();
    assert!(
        output.status.success(),
        "{args:?}\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn noop(root: &TofuWorkspace) {
    run(root, &["plan", "-input=false", "-out=noop.plan"]);
    let plan: Value =
        serde_json::from_slice(&run(root, &["show", "-json", "noop.plan"]).stdout).unwrap();
    for change in plan["resource_changes"].as_array().unwrap() {
        assert_eq!(change["change"]["actions"], json!(["no-op"]), "{change}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn inference_owns_its_profile_and_registration() {
    let fixture = Fixture::start().await;
    let root = workspace(&fixture.endpoint);
    let apply = ["apply", "-auto-approve", "-input=false"];

    // One resource creates both OpenShell objects from the server's ref; the
    // sandbox takes the resource's ref.
    run(&root, &apply);
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(
            state.profiles.keys().collect::<Vec<_>>(),
            ["inference/nemoclaw-inference-local"]
        );
        assert_eq!(
            state.providers.keys().collect::<Vec<_>>(),
            ["inference/local"]
        );
        assert_eq!(state.sandboxes.len(), 1);
    }
    noop(&root);

    // Losing the registration replaces the resource.
    let profiles = fixture.state.lock().unwrap().profiles.clone();
    fixture.state.lock().unwrap().providers.clear();
    run(&root, &apply);
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.providers.len(), 1);
        assert_eq!(state.profiles.len(), 1);
        assert_ne!(state.profiles, profiles);
    }
    noop(&root);

    // Removing it removes both objects once the sandbox is gone.
    run(
        &root,
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-var=sandbox=false",
            "-var=destroy=true",
        ],
    );
    run(
        &root,
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-var=enabled=false",
            "-var=sandbox=false",
        ],
    );
    let state = fixture.state.lock().unwrap();
    assert!(state.providers.is_empty());
    assert!(state.profiles.is_empty());
    assert_eq!(state.workspaces.len(), 1);
}
