// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Authored HCL for inference catalog discovery through pinned OpenTofu
//! against a fake model server.

use crate::{http_fixture::Fixture, tofu::TofuWorkspace};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    process::Output,
    sync::{Arc, Mutex},
};

/// What the model server saw: method, path, `anthropic-version`, and whether
/// the request carried a credential.
type Seen = (String, String, Option<String>, bool);

fn workspace() -> TofuWorkspace {
    let path = |name| PathBuf::from(std::env::var_os(name).expect("explicit qualification path"));
    let (tofu, provider) = (path("NEMOCLAW_TEST_TOFU"), path("NEMOCLAW_TEST_PROVIDER"));
    assert!(tofu.is_absolute() && provider.is_absolute());
    TofuWorkspace::new(tofu, provider)
}

fn configure(workspace: &TofuWorkspace, endpoint: &str, api: &str) {
    let graph = json!({
        "terraform":{"required_version":"= 1.12.6","required_providers":{"nemoclaw":{"source":"registry.opentofu.org/nvidia/nemoclaw"}}},
        "provider":{"nemoclaw":{}},
        "data":{"nemoclaw_inference_capabilities":{"current":{"endpoint":endpoint,"api":api}}},
        "output":{"observation":{"value":"${data.nemoclaw_inference_capabilities.current.observation_json}"}}
    });
    fs::write(workspace.path().join("main.tf.json"), graph.to_string()).unwrap();
}

fn run(workspace: &TofuWorkspace, args: &[&str], success: bool) -> Output {
    let output = workspace.command().args(args).output().unwrap();
    assert_eq!(
        output.status.success(),
        success,
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

/// The observation a saved plan records for the data source.
fn planned_observation(workspace: &TofuWorkspace) -> Value {
    run(
        workspace,
        &["plan", "-input=false", "-no-color", "-out=plan.bin"],
        true,
    );
    let plan: Value =
        serde_json::from_slice(&run(workspace, &["show", "-json", "plan.bin"], true).stdout)
            .unwrap();
    serde_json::from_str(
        plan["planned_values"]["outputs"]["observation"]["value"]
            .as_str()
            .unwrap(),
    )
    .unwrap()
}

/// A model server that answers every request with `status` and `body`.
async fn model_server(status: u16, body: &'static str) -> (Fixture, Arc<Mutex<Vec<Seen>>>) {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let server = Fixture::start_tcp(move |request| {
        seen.lock().unwrap().push((
            request.method.clone(),
            request.path.clone(),
            request.header("anthropic-version").map(str::to_owned),
            request.header("authorization").is_some() || request.header("x-api-key").is_some(),
        ));
        Some((status, body.as_bytes().to_vec()))
    })
    .await;
    (server, requests)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated HTTP fixture"]
async fn model_catalog_reads_are_read_only_and_keep_api_qualification_unknown() {
    let (server, requests) = model_server(200, r#"{"data":[{"id":"fixture-model"}]}"#).await;
    let workspace = workspace();
    configure(
        &workspace,
        &format!("{}/v1", server.endpoint),
        "openai-responses",
    );
    let observation = planned_observation(&workspace);
    assert_eq!(observation["status"], "available");
    assert_eq!(observation["models"], json!(["fixture-model"]));
    assert_eq!(observation["api_verified"], false);
    assert!(!workspace.path().join("terraform.tfstate").exists());
    let requests = requests.lock().unwrap();
    assert!(!requests.is_empty());
    assert!(
        requests
            .iter()
            .all(|request| *request == ("GET".into(), "/v1/models".into(), None, false)),
        "{requests:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated HTTP fixture"]
async fn rejected_anthropic_catalog_reads_report_required_authentication_without_upstream_text() {
    let (server, requests) = model_server(401, r#"{"error":"private-upstream-message"}"#).await;
    let workspace = workspace();
    configure(
        &workspace,
        &format!("{}/v1", server.endpoint),
        "anthropic-messages",
    );
    let observation = planned_observation(&workspace);
    assert_eq!(observation["status"], "unavailable", "{observation}");
    assert_eq!(observation["authentication"], "required", "{observation}");
    assert_eq!(observation["api_verified"], false);
    assert!(!observation.to_string().contains("private-upstream-message"));
    assert!(!workspace.path().join("terraform.tfstate").exists());
    let requests = requests.lock().unwrap();
    assert!(!requests.is_empty());
    assert!(
        requests
            .iter()
            .all(|(method, path, version, credential)| method == "GET"
                && path.starts_with("/v1/models")
                && version.as_deref() == Some("2023-06-01")
                && !credential),
        "{requests:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated HTTP fixture"]
async fn invalid_inputs_fail_validation_without_contacting_the_endpoint() {
    let (server, requests) = model_server(200, r#"{"data":[]}"#).await;
    let workspace = workspace();
    for (endpoint, api) in [
        (format!("{}/v1", server.endpoint), "unsupported-api"),
        ("not a URL".to_owned(), "openai-completions"),
    ] {
        configure(&workspace, &endpoint, api);
        let output = run(&workspace, &["validate", "-no-color"], false);
        let diagnostic = String::from_utf8_lossy(&output.stderr);
        assert!(
            diagnostic
                .contains("Invalid inference discovery endpoint, API, or credential reference"),
            "{diagnostic}"
        );
    }
    assert!(requests.lock().unwrap().is_empty());
}
