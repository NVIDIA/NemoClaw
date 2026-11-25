// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Inputs OpenShell would refuse, rejected when planning at the attribute
//! that holds them, while the workspace's generated owner and generation are
//! still unknown, so apply changes nothing.
use crate::*;

/// A workspace whose owner and generation the provider generates, inference
/// registrations, and a sandbox attaching them. `case` selects one invalid
/// input.
const MAIN: &str = r#"
terraform {
  required_providers {
    openshell = { source = "nvidia.github.io/nemoclaw/openshell" }
  }
}
variable "endpoint" { type = string }
variable "case" { default = "" }
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
  launch_json = jsonencode({
    command     = ["/usr/bin/agent"]
    environment = {}
    policy      = { version = 1, network_policies = {} }
    binaries    = ["/usr/bin/agent"]
    metadata    = {}
  })
}
resource "openshell_workspace" "team" {
  gateway = local.gateway
  name    = "team"
}
resource "openshell_inference" "local" {
  count     = var.case == "providers" ? 33 : 1
  gateway   = local.gateway
  workspace = openshell_workspace.team.ref
  name      = "local-${count.index}"
  server = {
    type              = "inference_server"
    endpoint          = "http://127.0.0.1:11434/v1"
    model             = ""
    credential_env    = ""
    credential_source = ""
  }
  api      = var.case == "api" ? "unsupported-api" : "openai-completions"
  binaries = ["/usr/bin/agent"]
}
resource "openshell_sandbox" "agent" {
  gateway     = local.gateway
  workspace   = openshell_workspace.team.ref
  name        = "agent"
  owner       = openshell_workspace.team.owner
  image       = "fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  launch_json = local.launch_json
  providers   = openshell_inference.local[*].ref
  policy {
    explicit {
      version = 1
      filesystem_policy {
        read_only  = ["/usr"]
        read_write = var.case == "policy" ? ["/"] : ["/sandbox"]
      }
    }
  }
}
"#;

/// Apply `main` for `case`, which must fail before changing the gateway, and
/// return OpenTofu's diagnostics.
fn refused(fixture: &openshell::Fixture, main: &str, case: &str) -> String {
    let root = workspace();
    fs::write(root.path().join("main.tf"), main).unwrap();
    let output = root
        .command()
        .args(["apply", "-auto-approve", "-input=false", "-no-color"])
        .arg(format!("-var=endpoint={}", fixture.endpoint))
        .arg(format!("-var=case={case}"))
        .output()
        .unwrap();
    // OpenTofu wraps long lines.
    let stderr = String::from_utf8_lossy(&output.stderr)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(!output.status.success(), "{case} was applied\n{stderr}");
    let state = fixture.state.lock().unwrap();
    assert_eq!(state.effects, 0, "{case} changed the gateway\n{stderr}");
    assert!(state.workspaces.is_empty(), "{case} created the workspace");
    stderr
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn plans_reject_inputs_openshell_would_refuse_at_their_attribute() {
    let fixture = openshell::Fixture::start().await;
    // Each diagnostic quotes the line of the attribute it names, and why.
    for (case, line, reason) in [
        (
            "policy",
            "explicit {",
            "read-write filesystem path is too broad",
        ),
        (
            "providers",
            "openshell_inference.local[*].ref",
            "at most 32",
        ),
        ("api", r#"var.case == "api""#, "openai-completions"),
    ] {
        let stderr = refused(&fixture, MAIN, case);
        assert!(stderr.contains(line), "{case}: no attribute path\n{stderr}");
        assert!(stderr.contains(reason), "{case}: no reason\n{stderr}");
    }
    let unowned = MAIN.replace("  owner       = openshell_workspace.team.owner\n", "");
    let stderr = refused(&fixture, &unowned, "");
    assert!(
        stderr.contains(r#"The argument "owner" is required"#),
        "a sandbox without owner\n{stderr}"
    );
}
