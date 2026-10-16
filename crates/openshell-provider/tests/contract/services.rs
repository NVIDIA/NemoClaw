// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! `openshell_sandbox`'s `service` blocks: OpenShell sandbox service
//! endpoints, passed through in OpenShell's terms, and the URLs the gateway
//! reports for them as `service_urls`.
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
variable "destroying" { default = false }
variable "services" {
  type = map(object({
    target_port        = number
    authorization_mode = optional(string)
  }))
  default = { research = { target_port = 8080 } }
}
provider "openshell" {
  destroy = var.destroying
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

const URL: &str = "http://team--researcher--research.services.fixture.test/";

fn url(service: &str) -> String {
    if service.is_empty() {
        "http://team--researcher.services.fixture.test/".into()
    } else {
        format!("http://team--researcher--{service}.services.fixture.test/")
    }
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
    fn run(&self, args: &[&str], services: &Value, succeed: bool) -> Output {
        let output = self
            .root
            .command()
            .args(args)
            .args(["-input=false", "-no-color"])
            .arg(format!("-var=services={services}"))
            .env("NEMOCLAW_TEST_BRAVE_KEY", "brave-fixture-secret")
            .output()
            .unwrap();
        assert_eq!(
            output.status.success(),
            succeed,
            "{args:?}\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }
    fn apply(&self, services: &Value) {
        self.run(&["apply", "-auto-approve"], services, true);
    }
    /// The planned actions of each managed resource.
    fn actions(&self, services: &Value) -> Value {
        self.run(&["plan", "-out=check.plan"], services, true);
        let output = self
            .root
            .command()
            .args(["show", "-json", "check.plan"])
            .output()
            .unwrap();
        let plan: Value = serde_json::from_slice(&output.stdout).unwrap();
        plan["resource_changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|change| {
                (
                    change["address"].as_str().unwrap().to_owned(),
                    change["change"]["actions"].clone(),
                )
            })
            .collect::<serde_json::Map<_, _>>()
            .into()
    }
    fn unchanged(&self, services: &Value) {
        for (address, actions) in self.actions(services).as_object().unwrap() {
            assert_eq!(actions, &json!(["no-op"]), "{address}");
        }
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
    fn state(&self) -> Vec<u8> {
        fs::read(self.root.path().join("terraform.tfstate")).unwrap()
    }
    fn sandbox_id(&self) -> String {
        let state: Value = serde_json::from_slice(&self.state()).unwrap();
        state["resources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|resource| resource["type"] == "openshell_sandbox")
            .unwrap()["instances"][0]["attributes"]["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }
}

/// The fixture's endpoints as `name: (port, mode)`.
fn endpoints(fixture: &Fixture) -> Value {
    fixture
        .state
        .lock()
        .unwrap()
        .services
        .values()
        .map(|endpoint| {
            (
                endpoint.name.clone(),
                json!([
                    endpoint.target_port,
                    endpoint.authorization_mode().as_str_name()
                ]),
            )
        })
        .collect::<serde_json::Map<_, _>>()
        .into()
}

fn mutations(fixture: &Fixture) -> Vec<String> {
    std::mem::take(&mut fixture.state.lock().unwrap().service_mutations)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn sandbox_services_are_created_reported_and_stable() {
    let fixture = Fixture::start().await;
    let tofu = Services::new(&fixture.endpoint);
    let services = json!({"research": {"target_port": 8080}});
    tofu.apply(&services);

    // The creation request carries the exposure as written: an omitted
    // authorization mode stays unspecified for OpenShell to resolve.
    let sent = fixture.state.lock().unwrap().sandbox_exposures.clone();
    assert_eq!(
        sent,
        vec![vec![p::SandboxServiceExposure {
            service: "research".into(),
            target_port: 8080,
            authorization_mode: p::ServiceAuthorizationMode::Unspecified as i32,
        }]]
    );
    assert_eq!(
        endpoints(&fixture),
        json!({"research": [8080, "SERVICE_AUTHORIZATION_MODE_STRIP"]})
    );
    // Another resource received the reported URL in the same apply.
    assert_eq!(tofu.urls(), json!({"research": URL}));

    // Each OpenTofu command is a new provider process, and GetSandbox
    // reports no URLs: refresh reads them from the gateway's service records.
    // OpenShell's STRIP for the omitted mode is no change.
    tofu.unchanged(&services);
    tofu.run(
        &["apply", "-refresh-only", "-auto-approve"],
        &services,
        true,
    );
    assert_eq!(tofu.urls(), json!({"research": URL}));
    tofu.unchanged(&services);

    // Stating OpenShell's default explicitly is the same exposure.
    let explicit = json!({"research": {"target_port": 8080, "authorization_mode": "STRIP"}});
    tofu.apply(&explicit);
    tofu.unchanged(&explicit);
    assert!(mutations(&fixture).is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn sandbox_services_change_in_place() {
    let fixture = Fixture::start().await;
    let tofu = Services::new(&fixture.endpoint);
    tofu.apply(&json!({"research": {"target_port": 8080}}));
    let id = tofu.sandbox_id();
    mutations(&fixture);

    // A port change and an addition update the sandbox in place.
    let changed = json!({
        "research": {"target_port": 9090},
        "writer": {"target_port": 7000, "authorization_mode": "BEARER_PASSTHROUGH"},
    });
    let actions = tofu.actions(&changed);
    assert_eq!(actions["openshell_sandbox.agent"], json!(["update"]));
    tofu.apply(&changed);
    assert_eq!(tofu.sandbox_id(), id);
    assert_eq!(
        endpoints(&fixture),
        json!({
            "research": [9090, "SERVICE_AUTHORIZATION_MODE_STRIP"],
            "writer": [7000, "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH"],
        })
    );
    assert_eq!(
        tofu.urls(),
        json!({"research": URL, "writer": url("writer")})
    );
    tofu.unchanged(&changed);

    // A rename removes the old endpoint and exposes the new one; the
    // unnamed endpoint is OpenShell's empty service name.
    let renamed = json!({"editor": {"target_port": 7000}, "": {"target_port": 8000}});
    mutations(&fixture);
    tofu.apply(&renamed);
    let mut sent = mutations(&fixture);
    sent.sort();
    assert_eq!(
        sent,
        vec![
            "delete research",
            "delete writer",
            "expose ",
            "expose editor"
        ]
    );
    assert_eq!(tofu.urls(), json!({"": url(""), "editor": url("editor")}));
    assert_eq!(tofu.sandbox_id(), id);
    tofu.unchanged(&renamed);

    // No service blocks removes every endpoint.
    tofu.apply(&json!({}));
    assert_eq!(endpoints(&fixture), json!({}));
    assert_eq!(tofu.urls(), json!({}));
    assert_eq!(tofu.sandbox_id(), id);
    tofu.unchanged(&json!({}));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn sandbox_services_converge_after_drift_and_failures() {
    let fixture = Fixture::start().await;
    let tofu = Services::new(&fixture.endpoint);
    let services = json!({"research": {"target_port": 8080}});
    tofu.apply(&services);
    mutations(&fixture);

    // The sandbox owns every endpoint on it: one changed or added behind
    // OpenTofu is drift, which apply corrects.
    {
        let mut state = fixture.state.lock().unwrap();
        let research = state.services.values_mut().next().unwrap();
        research.target_port = 1234;
        let mut debug = research.clone();
        debug.name = "debug".into();
        state
            .services
            .insert(("team".into(), "researcher".into(), "debug".into()), debug);
    }
    assert_eq!(
        tofu.actions(&services)["openshell_sandbox.agent"],
        json!(["update"])
    );
    tofu.apply(&services);
    assert_eq!(
        endpoints(&fixture),
        json!({"research": [8080, "SERVICE_AUTHORIZATION_MODE_STRIP"]})
    );
    tofu.unchanged(&services);
    mutations(&fixture);

    // A failed service read is not an empty list: planning stops, and
    // nothing changes.
    let prior = tofu.state();
    fixture.state.lock().unwrap().fail_read = Some(("service", tonic::Code::Unavailable));
    tofu.run(&["plan"], &json!({}), false);
    tofu.run(&["apply", "-auto-approve"], &json!({}), false);
    assert_same_managed_resources(&tofu.state(), &prior);
    assert!(mutations(&fixture).is_empty());
    fixture.state.lock().unwrap().fail_read = None;

    // An endpoint recorded for another sandbox under this name is not this
    // sandbox's: planning stops without changing it.
    let recorded = fixture.state.lock().unwrap().services.clone();
    for endpoint in fixture.state.lock().unwrap().services.values_mut() {
        endpoint.sandbox_id = "id-substituted".into();
    }
    tofu.run(&["plan"], &services, false);
    tofu.run(&["apply", "-auto-approve"], &json!({}), false);
    assert!(mutations(&fixture).is_empty());
    fixture.state.lock().unwrap().services = recorded;

    // A failed endpoint mutation keeps the sandbox binding; the next apply
    // converges.
    let changed = json!({"research": {"target_port": 9090}});
    fixture.state.lock().unwrap().reject_rpc =
        Some(("ExposeService", tonic::Code::Unavailable, "lost".into()));
    let id = tofu.sandbox_id();
    tofu.run(&["apply", "-auto-approve"], &changed, false);
    assert_eq!(tofu.sandbox_id(), id);
    fixture.state.lock().unwrap().reject_rpc = None;
    tofu.apply(&changed);
    assert_eq!(tofu.sandbox_id(), id);
    tofu.unchanged(&changed);

    // An invalid exposure fails without mutating the sandbox's endpoints.
    mutations(&fixture);
    tofu.run(
        &["apply", "-auto-approve"],
        &json!({"research": {"target_port": 0}}),
        false,
    );
    tofu.run(
        &["apply", "-auto-approve"],
        &json!({"research": {"target_port": 9090, "authorization_mode": "ALLOW_ALL"}}),
        false,
    );
    assert!(mutations(&fixture).is_empty());
    assert_eq!(
        endpoints(&fixture),
        json!({"research": [9090, "SERVICE_AUTHORIZATION_MODE_STRIP"]})
    );

    // Explicit teardown still deletes the sandbox, and its endpoints with it.
    tofu.run(
        &["destroy", "-auto-approve", "-var=destroying=true"],
        &changed,
        true,
    );
    let state = fixture.state.lock().unwrap();
    assert!(state.sandboxes.is_empty());
    assert!(state.services.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn sandbox_services_report_no_url_the_gateway_does_not() {
    let fixture = Fixture::start().await;
    fixture.state.lock().unwrap().service_urls_unavailable = true;
    let tofu = Services::new(&fixture.endpoint);
    let services = json!({"research": {"target_port": 8080}});
    tofu.apply(&services);
    // The endpoint exists, but no URL is invented for it.
    assert_eq!(
        endpoints(&fixture),
        json!({"research": [8080, "SERVICE_AUTHORIZATION_MODE_STRIP"]})
    );
    assert_eq!(tofu.urls(), json!({}));
    tofu.unchanged(&services);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn state_from_before_services_plans_no_change() {
    let fixture = Fixture::start().await;
    let tofu = Services::new(&fixture.endpoint);
    let none = json!({});
    tofu.apply(&none);
    // State the previous provider wrote has neither attribute.
    let path = tofu.root.path().join("terraform.tfstate");
    let mut state: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for resource in state["resources"].as_array_mut().unwrap() {
        if resource["type"] == "openshell_sandbox" {
            let attributes = resource["instances"][0]["attributes"]
                .as_object_mut()
                .unwrap();
            attributes.remove("service").unwrap();
            attributes.remove("service_urls").unwrap();
        }
    }
    fs::write(&path, state.to_string()).unwrap();
    let actions = tofu.actions(&none);
    assert_eq!(actions["openshell_sandbox.agent"], json!(["no-op"]));
    tofu.apply(&none);
    assert_eq!(tofu.urls(), json!({}));
    assert!(mutations(&fixture).is_empty());
}
