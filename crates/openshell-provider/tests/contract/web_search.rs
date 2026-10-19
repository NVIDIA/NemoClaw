// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! `openshell_web_search`: one resource owning a web search provider's
//! OpenShell profile and registration, taken by sandboxes through its ref.
use super::*;
use serde_json::json;

const CONFIG: &str = r#"terraform {
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
variable "sandbox_env" { default = null }
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
}
resource "openshell_workspace" "example" {
  gateway    = local.gateway
  name       = "web-search"
  owner      = "web-search-owner"
  generation = "workspace-generation"
  lifecycle { prevent_destroy = true }
}
resource "openshell_web_search" "brave" {
  count          = var.enabled ? 1 : 0
  gateway        = local.gateway
  workspace      = openshell_workspace.example.ref
  name           = "brave"
  provider_type  = "brave"
  credential_env = "NEMOCLAW_TEST_BRAVE_KEY"
  sandbox_env    = var.sandbox_env
  binaries       = var.binaries
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
  providers   = [openshell_web_search.brave[0].ref]
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
async fn web_search_owns_its_profile_and_registration() {
    let fixture = Fixture::start().await;
    let root = workspace(&fixture.endpoint);
    let apply = ["apply", "-auto-approve", "-input=false"];

    // One resource creates both OpenShell objects; the sandbox takes its ref.
    run(&root, &apply);
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.profiles.len(), 1, "{:?}", state.profiles.keys());
        assert_eq!(state.providers.len(), 1, "{:?}", state.providers.keys());
        let provider = state.providers.values().next().unwrap();
        assert!(
            provider.r#type.starts_with("nemoclaw-brave"),
            "{}",
            provider.r#type
        );
        assert_eq!(state.sandboxes.len(), 1);
    }
    noop(&root);

    // Losing the registration replaces the resource: the plan shows the
    // drift, removal deletes the remaining profile, and creation recreates
    // both under a new generation.
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

    // Removing it removes both objects without destroy mode, once the sandbox
    // that attaches it is gone; the workspace stays.
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
    assert_eq!(fixture.state.lock().unwrap().providers.len(), 1);
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn web_search_names_the_variable_sandboxes_see() {
    // Harnesses read the search key from different variables; Hermes's Brave
    // plugin reads BRAVE_SEARCH_API_KEY rather than the default.
    let fixture = Fixture::start().await;
    let root = workspace(&fixture.endpoint);
    let named = "-var=sandbox_env=BRAVE_SEARCH_API_KEY";
    run(&root, &["apply", "-auto-approve", "-input=false", named]);
    {
        let state = fixture.state.lock().unwrap();
        let profile = state.profiles.values().next().unwrap();
        assert_eq!(profile.credentials.len(), 1);
        assert_eq!(profile.credentials[0].env_vars, ["BRAVE_SEARCH_API_KEY"]);
        let provider = state.providers.values().next().unwrap();
        assert!(
            provider.credentials.contains_key("BRAVE_SEARCH_API_KEY"),
            "{:?}",
            provider.credentials.keys()
        );
    }
    // Applied state matches the configuration.
    run(
        &root,
        &["plan", "-input=false", "-detailed-exitcode", named],
    );
}
