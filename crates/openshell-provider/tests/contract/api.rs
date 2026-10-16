// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! API credentials through the served provider and pinned OpenTofu.
use super::*;
use serde_json::json;

const SECRET: &str = "booking-fixture-secret";
const CONFIG: &str = r#"terraform {
  required_version = "= 1.12.6"
  required_providers {
    openshell = { source = "registry.opentofu.org/nvidia/openshell" }
  }
}
variable "endpoint" { type = string }
variable "launch_json" { type = string }
variable "enabled" { default = true }
variable "sandbox" { default = false }
variable "destroy" { default = false }
provider "openshell" { destroy = var.destroy }
locals {
  gateway = {
    type = "openshell_gateway"
    endpoint = var.endpoint
    credential_env = ""
    tls_ca_env = ""
    tls_certificate_env = ""
    tls_key_env = ""
    kubernetes = ""
  }
}
resource "openshell_workspace" "example" {
  gateway = local.gateway
  name = "api-credentials"
  owner = "api-owner"
  generation = "workspace-generation"
  lifecycle { prevent_destroy = true }
}
resource "openshell_api" "booking" {
  count = var.enabled ? 1 : 0
  gateway = local.gateway
  workspace = openshell_workspace.example.ref
  name = "booking"
  endpoint = "https://booking.example.com/mcp"
  credential_env = "NEMOCLAW_TEST_BOOKING_KEY"
  binaries = ["/usr/bin/curl"]
}
resource "openshell_sandbox" "buyer" {
  count = var.sandbox ? 1 : 0
  gateway = local.gateway
  workspace = openshell_workspace.example.ref
  name = "buyer"
  owner = openshell_workspace.example.owner
  generation = "sandbox-generation"
  image = "fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  launch_json = var.launch_json
  providers = [openshell_api.booking[0].ref]
  policy {}
}
output "booking" { value = var.enabled ? openshell_api.booking[0].ref : null }
"#;

fn workspace(endpoint: &str) -> TofuWorkspace {
    let root = TofuWorkspace::with_providers(tofu(), &[("openshell", &provider())]);
    fs::write(root.path().join("main.tf"), CONFIG).unwrap();
    let fixture: Value = serde_json::from_slice(
        &fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/contract/standalone/terraform.tfvars.json"),
        )
        .unwrap(),
    )
    .unwrap();
    fs::write(
        root.path().join("terraform.tfvars.json"),
        json!({"endpoint": endpoint, "launch_json": fixture["launch_json"]}).to_string(),
    )
    .unwrap();
    root
}

fn run(root: &TofuWorkspace, args: &[&str]) -> Output {
    let output = root
        .command()
        .args(args)
        .arg("-no-color")
        .env("NEMOCLAW_TEST_BOOKING_KEY", SECRET)
        .env("NEMOCLAW_TEST_BOOKING_NEXT", "next-booking-fixture-secret")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    for secret in [SECRET, "next-booking-fixture-secret"] {
        assert!(!String::from_utf8_lossy(&output.stdout).contains(secret));
        assert!(!String::from_utf8_lossy(&output.stderr).contains(secret));
    }
    output
}

fn noop(root: &TofuWorkspace) {
    run(root, &["plan", "-input=false", "-out=noop.plan"]);
    let output = run(root, &["show", "-json", "noop.plan"]);
    let plan: Value = serde_json::from_slice(&output.stdout).unwrap();
    for change in plan["resource_changes"].as_array().unwrap() {
        assert_eq!(change["change"]["actions"], json!(["no-op"]), "{change}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn api_credentials_register_an_endpoint_bound_profile_without_persisting_the_key() {
    let fixture = Fixture::start().await;
    let root = workspace(&fixture.endpoint);
    run(&root, &["apply", "-auto-approve", "-input=false"]);
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.profiles.len(), 1);
        assert_eq!(state.providers.len(), 1);
        let profile = state.profiles.values().next().unwrap();
        assert_eq!(profile.id, "nemoclaw-api-booking");
        assert!(!profile.inference_capable);
        assert_eq!(
            profile.credentials[0].env_vars,
            ["NEMOCLAW_API_BOOKING_KEY"]
        );
        assert_eq!(profile.credentials[0].auth_style, "bearer");
        assert_eq!(profile.credentials[0].header_name, "Authorization");
        assert_eq!(profile.endpoints[0].host, "booking.example.com");
        assert_eq!(profile.endpoints[0].port, 443);
        assert_eq!(profile.endpoints[0].path, "/mcp/**");
        assert_eq!(profile.binaries[0].path, "/usr/bin/curl");
        let registration = state.providers.values().next().unwrap();
        assert_eq!(registration.r#type, profile.id);
        assert_eq!(registration.credentials["NEMOCLAW_API_BOOKING_KEY"], SECRET);
    }
    let state = fs::read_to_string(root.path().join("terraform.tfstate")).unwrap();
    assert!(!state.contains(SECRET));
    let state: Value = serde_json::from_str(&state).unwrap();
    assert_eq!(
        state["outputs"]["booking"]["value"]["registration"],
        "booking"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn api_credentials_rotate_recover_and_remove_without_replacing_an_attached_sandbox() {
    let fixture = Fixture::start().await;
    let root = workspace(&fixture.endpoint);
    run(
        &root,
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-var=sandbox=true",
        ],
    );
    let (provider_id, sandbox_id) = {
        let state = fixture.state.lock().unwrap();
        (
            state
                .providers
                .values()
                .next()
                .unwrap()
                .metadata
                .as_ref()
                .unwrap()
                .id
                .clone(),
            state
                .sandboxes
                .values()
                .next()
                .unwrap()
                .metadata
                .as_ref()
                .unwrap()
                .id
                .clone(),
        )
    };
    // A fresh provider process must read an unchanged plan without resolving a
    // new value or mutating either OpenShell object.
    let effects = fixture.state.lock().unwrap().effects;
    let plan = root
        .command()
        .args([
            "plan",
            "-input=false",
            "-no-color",
            "-var=sandbox=true",
            "-out=noop.plan",
        ])
        .env_remove("NEMOCLAW_TEST_BOOKING_KEY")
        .env_remove("NEMOCLAW_TEST_BOOKING_NEXT")
        .output()
        .unwrap();
    assert!(
        plan.status.success(),
        "{}",
        String::from_utf8_lossy(&plan.stderr)
    );
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    let unchanged: Value =
        serde_json::from_slice(&run(&root, &["show", "-json", "noop.plan"]).stdout).unwrap();
    for change in unchanged["resource_changes"].as_array().unwrap() {
        assert_eq!(change["change"]["actions"], json!(["no-op"]));
    }
    fs::write(
        root.path().join("main.tf"),
        CONFIG.replace("NEMOCLAW_TEST_BOOKING_KEY", "NEMOCLAW_TEST_BOOKING_NEXT"),
    )
    .unwrap();
    run(
        &root,
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-var=sandbox=true",
        ],
    );
    {
        let state = fixture.state.lock().unwrap();
        let provider = state.providers.values().next().unwrap();
        assert_eq!(provider.metadata.as_ref().unwrap().id, provider_id);
        assert_eq!(
            provider.credentials["NEMOCLAW_API_BOOKING_KEY"],
            "next-booking-fixture-secret"
        );
    }
    let state = fs::read_to_string(root.path().join("terraform.tfstate")).unwrap();
    assert!(!state.contains(SECRET));
    assert!(!state.contains("next-booking-fixture-secret"));
    // Missing profile recovery must retain the registration a sandbox uses.
    fixture.state.lock().unwrap().profiles.clear();
    run(
        &root,
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-var=sandbox=true",
        ],
    );
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.profiles.len(), 1);
        assert_eq!(
            state
                .providers
                .values()
                .next()
                .unwrap()
                .metadata
                .as_ref()
                .unwrap()
                .id,
            provider_id
        );
        assert_eq!(
            state
                .sandboxes
                .values()
                .next()
                .unwrap()
                .metadata
                .as_ref()
                .unwrap()
                .id,
            sandbox_id
        );
    }
    // Losing the registration recreates the reconstructible pair; the
    // sandbox continues to name the same registration.
    fixture.state.lock().unwrap().providers.clear();
    run(
        &root,
        &[
            "apply",
            "-auto-approve",
            "-input=false",
            "-var=sandbox=true",
        ],
    );
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.providers.len(), 1);
        assert_eq!(
            state
                .sandboxes
                .values()
                .next()
                .unwrap()
                .metadata
                .as_ref()
                .unwrap()
                .id,
            sandbox_id
        );
    }
    // A foreign owner is an observation failure, not absence to repair.
    let (profiles, effects) = {
        let mut state = fixture.state.lock().unwrap();
        let profiles = state.profiles.clone();
        state
            .profiles
            .values_mut()
            .next()
            .unwrap()
            .annotations
            .insert(openshell_provider::OWNER.into(), "foreign-owner".into());
        (profiles, state.effects)
    };
    let rejected = root
        .command()
        .args(["plan", "-input=false", "-no-color", "-var=sandbox=true"])
        .env_remove("NEMOCLAW_TEST_BOOKING_NEXT")
        .output()
        .unwrap();
    assert!(!rejected.status.success());
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    fixture.state.lock().unwrap().profiles = profiles;
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
        ],
    );
    let state = fixture.state.lock().unwrap();
    assert!(state.providers.is_empty());
    assert!(state.profiles.is_empty());
    assert!(state.sandboxes.is_empty());
    assert_eq!(state.workspaces.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn api_credentials_support_custom_headers_and_reject_invalid_bindings_before_mutation() {
    let fixture = Fixture::start().await;
    let root = workspace(&fixture.endpoint);
    for (case, source) in [
        CONFIG.replace(
            "https://booking.example.com/mcp",
            "https://*.example.com/mcp",
        ),
        CONFIG.replace(
            "binaries =",
            "auth_style = \"header\"\n  header_name = \"Bad Header\"\n  binaries =",
        ),
        CONFIG.replace(
            "https://booking.example.com/mcp",
            "https://user:password@booking.example.com/mcp",
        ),
        CONFIG.replace(
            "https://booking.example.com/mcp",
            "https://booking.example.com/*",
        ),
        CONFIG.replace("binaries =", "auth_style = \"oauth\"\n  binaries ="),
        CONFIG.replace("binaries =", "auth_style = \"header\"\n  binaries ="),
    ]
    .into_iter()
    .enumerate()
    {
        fs::write(root.path().join("main.tf"), source).unwrap();
        let output = root
            .command()
            .args(["plan", "-input=false", "-no-color"])
            .env_remove("NEMOCLAW_TEST_BOOKING_KEY")
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "invalid binding {case} accepted: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert_eq!(fixture.state.lock().unwrap().effects, 0);
    }
    fs::write(
        root.path().join("main.tf"),
        CONFIG.replace(
            "binaries =",
            "auth_style = \"header\"\n  header_name = \"X-Booking-Key\"\n  binaries =",
        ),
    )
    .unwrap();
    run(&root, &["apply", "-auto-approve", "-input=false"]);
    noop(&root);
    let state = fixture.state.lock().unwrap();
    let profile = state.profiles.values().next().unwrap();
    assert_eq!(profile.credentials[0].auth_style, "header");
    assert_eq!(profile.credentials[0].header_name, "X-Booking-Key");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn api_credentials_recover_after_either_create_readback_is_unavailable() {
    for kind in ["provider_profile", "provider"] {
        let fixture = Fixture::start().await;
        let root = workspace(&fixture.endpoint);
        fixture.state.lock().unwrap().fail_after_create = Some((kind, tonic::Code::Unavailable));
        let failed = root
            .command()
            .args(["apply", "-auto-approve", "-input=false", "-no-color"])
            .env("NEMOCLAW_TEST_BOOKING_KEY", SECRET)
            .output()
            .unwrap();
        assert!(!failed.status.success(), "{kind}");
        assert!(!String::from_utf8_lossy(&failed.stdout).contains(SECRET));
        assert!(!String::from_utf8_lossy(&failed.stderr).contains(SECRET));
        let partial = fs::read_to_string(root.path().join("terraform.tfstate")).unwrap();
        assert!(!partial.contains(SECRET));
        let partial: Value = serde_json::from_str(&partial).unwrap();
        assert!(
            partial["resources"]
                .as_array()
                .unwrap()
                .iter()
                .any(|resource| {
                    resource["type"] == "openshell_api"
                        && resource["instances"][0]["attributes"]["generation"]
                            .as_str()
                            .is_some_and(|generation| !generation.is_empty())
                }),
            "{kind}: recovery binding missing"
        );
        assert_eq!(fixture.state.lock().unwrap().profiles.len(), 1);
        fixture.state.lock().unwrap().fail_read = None;
        if kind == "provider_profile" {
            let (profiles, effects) = {
                let mut state = fixture.state.lock().unwrap();
                let profiles = state.profiles.clone();
                state.profiles.values_mut().next().unwrap().resource_version += 1;
                (profiles, state.effects)
            };
            let rejected = root
                .command()
                .args(["plan", "-input=false", "-no-color"])
                .output()
                .unwrap();
            assert!(!rejected.status.success());
            assert_eq!(fixture.state.lock().unwrap().effects, effects);
            assert_same_managed_resources(
                &fs::read(root.path().join("terraform.tfstate")).unwrap(),
                serde_json::to_string(&partial).unwrap().as_bytes(),
            );
            fixture.state.lock().unwrap().profiles = profiles;
        }
        run(&root, &["apply", "-auto-approve", "-input=false"]);
        noop(&root);
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.profiles.len(), 1, "{kind}");
        assert_eq!(state.providers.len(), 1, "{kind}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn api_credentials_reject_foreign_or_substituted_survivors_of_a_partial_pair() {
    let fixture = Fixture::start().await;
    let root = workspace(&fixture.endpoint);
    run(&root, &["apply", "-auto-approve", "-input=false"]);
    let saved = fs::read(root.path().join("terraform.tfstate")).unwrap();
    let (profiles, providers, effects) = {
        let state = fixture.state.lock().unwrap();
        (
            state.profiles.clone(),
            state.providers.clone(),
            state.effects,
        )
    };
    for drift in [
        "foreign-profile",
        "foreign-registration",
        "substituted-registration",
    ] {
        {
            let mut state = fixture.state.lock().unwrap();
            // Every case starts with the same pair. A previous rejection must
            // not leave the next case failing for an unrelated reason.
            state.profiles = profiles.clone();
            state.providers = providers.clone();
            match drift {
                "foreign-profile" => {
                    state.providers.clear();
                    state
                        .profiles
                        .values_mut()
                        .next()
                        .unwrap()
                        .annotations
                        .insert(openshell_provider::OWNER.into(), "foreign".into());
                }
                "foreign-registration" => {
                    state.profiles.clear();
                    state
                        .providers
                        .values_mut()
                        .next()
                        .unwrap()
                        .metadata
                        .as_mut()
                        .unwrap()
                        .labels
                        .insert(openshell_provider::OWNER.into(), "foreign".into());
                }
                _ => {
                    state.profiles.clear();
                    state
                        .providers
                        .values_mut()
                        .next()
                        .unwrap()
                        .metadata
                        .as_mut()
                        .unwrap()
                        .id = "substituted".into();
                }
            }
        }
        let rejected = root
            .command()
            .args(["plan", "-input=false", "-no-color"])
            .output()
            .unwrap();
        assert!(!rejected.status.success(), "{drift} must stop planning");
        assert_eq!(fixture.state.lock().unwrap().effects, effects);
        assert_same_managed_resources(
            &fs::read(root.path().join("terraform.tfstate")).unwrap(),
            &saved,
        );
    }
}
