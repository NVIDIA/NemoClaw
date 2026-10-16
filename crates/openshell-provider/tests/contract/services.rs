// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! `openshell_sandbox`'s `service` blocks: OpenShell sandbox service
//! exposures, passed through at creation, and the URLs the gateway reports
//! for them as `service_urls`.
use super::*;
use openshell_sdk::raw::proto as p;
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
variable "services" {
  type = map(object({
    target_port        = number
    authorization_mode = optional(string)
  }))
  default = { research = { target_port = 8080 } }
}
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
  name       = "team"
  owner      = "team-owner"
  generation = "workspace-generation"
}
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
  name        = "researcher"
  owner       = openshell_workspace.example.owner
  generation  = "sandbox-generation"
  image       = "fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  launch_json = var.launch_json
  providers   = [openshell_web_search.brave.ref]
  policy {}
  dynamic "service" {
    for_each = var.services
    content {
      name               = service.key
      target_port        = service.value.target_port
      authorization_mode = service.value.authorization_mode
    }
  }
}
# Another resource consumes the reported URLs in the same apply.
resource "terraform_data" "caller" {
  input = openshell_sandbox.agent.service_urls
}
output "urls" { value = terraform_data.caller.output }
"#;

fn url(service: &str) -> String {
    format!("http://team--researcher--{service}.services.fixture.test/")
}

struct Services {
    root: TofuWorkspace,
}

impl Services {
    fn new(endpoint: &str) -> Self {
        let root = workspace();
        fs::write(root.path().join("main.tf"), CONFIG).unwrap();
        let mut variables: Value = serde_json::from_slice(
            &fs::read(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/contract/standalone/terraform.tfvars.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let variables = json!({
            "endpoint": endpoint,
            "launch_json": variables["launch_json"].take(),
            "binaries": variables["binaries"].take(),
        });
        fs::write(
            root.path().join("terraform.tfvars.json"),
            variables.to_string(),
        )
        .unwrap();
        Self { root }
    }
    fn run(&self, args: &[&str], services: &Value) -> Output {
        self.root
            .command()
            .args(args)
            .args(["-input=false", "-no-color"])
            .arg(format!("-var=services={services}"))
            .env("NEMOCLAW_TEST_BRAVE_KEY", "brave-fixture-secret")
            .output()
            .unwrap()
    }
    fn succeed(&self, args: &[&str], services: &Value) {
        let output = self.run(args, services);
        assert!(
            output.status.success(),
            "{args:?}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    /// Every managed resource plans no change.
    fn unchanged(&self, services: &Value) {
        self.succeed(&["plan", "-out=check.plan"], services);
        let output = self
            .root
            .command()
            .args(["show", "-json", "check.plan"])
            .output()
            .unwrap();
        let plan: Value = serde_json::from_slice(&output.stdout).unwrap();
        for change in plan["resource_changes"].as_array().unwrap() {
            assert_eq!(
                change["change"]["actions"],
                json!(["no-op"]),
                "{}",
                change["address"]
            );
        }
    }
    /// The plan fails because it would replace the sandbox.
    fn refused(&self, services: &Value) {
        let output = self.run(&["plan"], services);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success() && stderr.contains("Resource replacement refused"),
            "{stderr}"
        );
    }
    fn urls(&self) -> Value {
        let output = self
            .root
            .command()
            .args(["output", "-json", "urls"])
            .output()
            .unwrap();
        serde_json::from_slice(&output.stdout).unwrap()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn sandbox_services_are_created_and_report_their_urls() {
    let fixture = Fixture::start().await;
    let tofu = Services::new(&fixture.endpoint);
    let services = json!({
        "research": {"target_port": 8080},
        "writer": {"target_port": 7000, "authorization_mode": "BEARER_PASSTHROUGH"},
    });
    tofu.succeed(&["apply", "-auto-approve"], &services);

    // The creation request carries the exposures as written: an omitted
    // authorization mode stays unspecified for OpenShell to resolve.
    assert_eq!(
        fixture.state.lock().unwrap().sandbox_exposures,
        vec![vec![
            p::SandboxServiceExposure {
                service: "research".into(),
                target_port: 8080,
                authorization_mode: p::ServiceAuthorizationMode::Unspecified as i32,
            },
            p::SandboxServiceExposure {
                service: "writer".into(),
                target_port: 7000,
                authorization_mode: p::ServiceAuthorizationMode::BearerPassthrough as i32,
            },
        ]]
    );
    // Another resource received the reported URLs in the same apply.
    let urls = json!({"research": url("research"), "writer": url("writer")});
    assert_eq!(tofu.urls(), urls);

    // Each OpenTofu command is a new provider process, and GetSandbox reports
    // no URLs: refresh reads each endpoint. OpenShell's STRIP for the omitted
    // mode is no change.
    tofu.unchanged(&services);
    tofu.succeed(&["apply", "-refresh-only", "-auto-approve"], &services);
    assert_eq!(tofu.urls(), urls);
    tofu.unchanged(&services);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn sandbox_service_changes_are_refused_like_driver_config() {
    let fixture = Fixture::start().await;
    let tofu = Services::new(&fixture.endpoint);
    let services = json!({"research": {"target_port": 8080}});
    tofu.succeed(&["apply", "-auto-approve"], &services);

    // Exposures are part of the creation request: a change would replace
    // the sandbox, which the provider refuses.
    tofu.refused(&json!({"research": {"target_port": 9090}}));
    tofu.refused(&json!({}));

    // An endpoint changed behind OpenTofu shows as drift.
    fixture
        .state
        .lock()
        .unwrap()
        .services
        .values_mut()
        .next()
        .unwrap()
        .target_port = 1234;
    tofu.refused(&services);
}
