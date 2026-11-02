// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Failures of the API credentials in `credentials/main.tf`, whose lifecycle
//! `credentials/tests` covers: a rejected or failed command, and the state
//! file it leaves, which `tofu test` cannot check.
use super::*;
use serde_json::json;

const SECRET: &str = "booking-fixture-secret";

fn credentials(endpoint: &str) -> TofuWorkspace {
    let root = workspace();
    fs::copy(
        Path::new(CONTRACT).join("credentials/main.tf"),
        root.path().join("main.tf"),
    )
    .unwrap();
    fs::write(
        root.path().join("terraform.tfvars.json"),
        json!({"endpoint": endpoint, "sandbox": false}).to_string(),
    )
    .unwrap();
    root
}

/// Run OpenTofu with the fixture keys, and require that its output repeats
/// none of them.
fn run(root: &TofuWorkspace, args: &[&str]) -> Output {
    let output = root
        .command()
        .args(args)
        .args(["-input=false", "-no-color"])
        .envs(SECRETS)
        .output()
        .unwrap();
    for (_, secret) in SECRETS {
        assert!(!String::from_utf8_lossy(&output.stdout).contains(secret));
        assert!(!String::from_utf8_lossy(&output.stderr).contains(secret));
    }
    output
}

fn success(root: &TofuWorkspace, args: &[&str]) {
    let output = run(root, args);
    assert!(
        output.status.success(),
        "{args:?}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn api_credentials_reject_invalid_bindings_before_mutation() {
    let fixture = Fixture::start().await;
    let root = credentials(&fixture.endpoint);
    for variables in [
        ["-var=api_endpoint=https://*.example.com/mcp"].as_slice(),
        &["-var=api_endpoint=https://user:password@booking.example.com/mcp"],
        &["-var=api_endpoint=https://booking.example.com/*"],
        &["-var=auth_style=oauth"],
        &["-var=auth_style=header"],
        &["-var=auth_style=header", "-var=header_name=Bad Header"],
    ] {
        let output = run(&root, &[["plan"].as_slice(), variables].concat());
        assert!(!output.status.success(), "{variables:?} was accepted");
        assert_eq!(fixture.state.lock().unwrap().effects, 0);
    }
}

/// A foreign owner is an observation failure, not absence to repair.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn api_credentials_reject_foreign_or_substituted_survivors_of_a_partial_pair() {
    let fixture = Fixture::start().await;
    let root = credentials(&fixture.endpoint);
    success(&root, &["apply", "-auto-approve"]);
    let saved = fs::read(root.path().join("terraform.tfstate")).unwrap();
    let (profiles, providers, effects) = {
        let state = fixture.state.lock().unwrap();
        (
            state.profiles.clone(),
            state.providers.clone(),
            state.effects,
        )
    };
    let booking = |key: &String| key.ends_with("booking");
    for drift in [
        "foreign-profile",
        "foreign-pair",
        "foreign-registration",
        "substituted-registration",
    ] {
        {
            let mut guard = fixture.state.lock().unwrap();
            let state = &mut *guard;
            // Every case starts with the same pair. A previous rejection must
            // not leave the next case failing for an unrelated reason.
            state.profiles = profiles.clone();
            state.providers = providers.clone();
            if drift.ends_with("profile") {
                state.providers.retain(|key, _| !booking(key));
            } else if drift.ends_with("registration") {
                state.profiles.retain(|key, _| !booking(key));
            }
            let (_, profile) = state
                .profiles
                .iter_mut()
                .find(|(key, _)| booking(key))
                .unzip();
            let (_, registration) = state
                .providers
                .iter_mut()
                .find(|(key, _)| booking(key))
                .unzip();
            match drift {
                "foreign-profile" | "foreign-pair" => {
                    profile
                        .unwrap()
                        .annotations
                        .insert(openshell_provider::OWNER.into(), "foreign".into());
                }
                "foreign-registration" => {
                    let metadata = registration.unwrap().metadata.as_mut().unwrap();
                    metadata
                        .labels
                        .insert(openshell_provider::OWNER.into(), "foreign".into());
                }
                _ => registration.unwrap().metadata.as_mut().unwrap().id = "substituted".into(),
            }
        }
        let rejected = run(&root, &["plan"]);
        assert!(!rejected.status.success(), "{drift} must stop planning");
        assert_eq!(fixture.state.lock().unwrap().effects, effects);
        assert_same_managed_resources(
            &fs::read(root.path().join("terraform.tfstate")).unwrap(),
            &saved,
        );
    }
}

/// A create whose readback fails leaves its recovery binding, but not the
/// key, in state; the next apply completes the pair. A substituted profile
/// stops that plan first.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated OpenShell fixture"]
async fn api_credentials_recover_after_either_create_readback_is_unavailable() {
    for kind in ["provider_profile", "provider"] {
        let fixture = Fixture::start().await;
        let root = credentials(&fixture.endpoint);
        // Only the API, so the failed readback is its own.
        fs::write(
            root.path().join("terraform.tfvars.json"),
            json!({"endpoint": fixture.endpoint, "sandbox": false, "web_search": false})
                .to_string(),
        )
        .unwrap();
        fixture.state.lock().unwrap().fail_after_create = Some((kind, tonic::Code::Unavailable));
        assert!(
            !run(&root, &["apply", "-auto-approve"]).status.success(),
            "{kind}"
        );
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
            assert!(!run(&root, &["plan"]).status.success());
            assert_eq!(fixture.state.lock().unwrap().effects, effects);
            assert_same_managed_resources(
                &fs::read(root.path().join("terraform.tfstate")).unwrap(),
                serde_json::to_string(&partial).unwrap().as_bytes(),
            );
            fixture.state.lock().unwrap().profiles = profiles;
        }
        success(&root, &["apply", "-auto-approve"]);
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.profiles.len(), 1, "{kind}");
        assert_eq!(state.providers.len(), 1, "{kind}");
    }
}
