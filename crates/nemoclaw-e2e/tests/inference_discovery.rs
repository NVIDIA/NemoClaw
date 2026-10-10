// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Inference catalog discovery through SDK deployments. The provider's
//! contract tests cover `nemoclaw_inference_capabilities` in authored HCL.

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated HTTP and gateway fixtures"]
async fn optional_catalog_failures_preserve_complete_unchanged_plans_and_typed_uncertainty() {
    use nemoclaw_e2e::http_fixture::Fixture;
    use nemoclaw_sdk::{
        CancellationToken, Deployment,
        config::{Document, InferenceApi, InferenceProviderKind},
    };
    use serde_json::{Value, json};
    use std::{
        fs,
        path::PathBuf,
        process::Command,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let mode = Arc::new(AtomicUsize::new(0));
    let current = mode.clone();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let received = requests.clone();
    let server = Fixture::start_tcp(move |request| {
        received.lock().unwrap().push((
            request.path.clone(),
            request.header("anthropic-version").map(str::to_owned),
        ));
        let (status, body) = match current.load(Ordering::SeqCst) {
            0 => (404, r#"{"error":"private-upstream-message"}"#),
            1 => (401, r#"{"error":"private-upstream-message"}"#),
            2 => (200, r#"{"unsupported":"private-upstream-message"}"#),
            _ => (200, r#"{"data":[{"id":"fixture-model"}]}"#),
        };
        Some((status, body.as_bytes().to_vec()))
    })
    .await;
    let endpoint = format!("{}/v1", server.endpoint);
    // nemoclaw-discovery's inference tests own how each catalog response is
    // classified; here each response reaches a complete plan once, across
    // both provider protocols.
    for (provider, api, modes) in [
        (
            InferenceProviderKind::Anthropic,
            InferenceApi::AnthropicMessages,
            [
                (1, "unavailable", "required"),
                (3, "available", "not_required"),
            ],
        ),
        (
            InferenceProviderKind::Openai,
            InferenceApi::OpenaiCompletions,
            [(0, "unknown", "unknown"), (2, "unknown", "unknown")],
        ),
    ] {
        mode.store(0, Ordering::SeqCst);
        let directory = tempfile::tempdir().unwrap();
        let fixture = nemoclaw_e2e::openshell::Fixture::start().await;
        let mut document =
            Document::parse(include_bytes!("../../../examples/fabric-openclaw.yaml").as_slice())
                .unwrap();
        *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
        let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
        document.spec.inference_providers[0].provider = provider;
        document.spec.inference_providers[0].api = Some(api);
        document.spec.inference_providers[0].endpoint = endpoint.clone();
        let input = directory.path().join("deployment.yaml");
        fs::write(&input, document.yaml().unwrap()).unwrap();
        let deployment = Deployment::new(directory.path(), &bundle);
        let cancel = CancellationToken::new();
        deployment.apply(&document, &cancel).await.unwrap();
        let state = fs::read(directory.path().join("terraform.tfstate")).unwrap();
        let intent = fs::read(directory.path().join("intent.json")).unwrap();
        let effects = fixture.state.lock().unwrap().effects;
        for (selected, status, auth) in modes {
            mode.store(selected, Ordering::SeqCst);
            let output = Command::new(
                bundle
                    .join("bin")
                    .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
            )
            .args(["plan", "-o", "json", "--progress", "off", "--state-dir"])
            .arg(directory.path())
            .arg(&input)
            .output()
            .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let result: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(result["complete"], true, "{result}");
            assert!(result.get("deferred").is_none(), "{result}");
            assert_eq!(result["changes"], json!([]));
            assert_eq!(
                result.get("unverified").is_some(),
                selected != 3,
                "{result}"
            );
            let observed = &result["discovery"]["observations"]["endpoint_0"]["observation"];
            assert_eq!(observed["status"], status);
            assert_eq!(observed["authentication"], auth);
            assert_eq!(observed["api_verified"], false);
            assert!(!String::from_utf8_lossy(&output.stdout).contains("private-upstream-message"));
            assert_eq!(
                fs::read(directory.path().join("terraform.tfstate")).unwrap(),
                state
            );
            assert_eq!(
                fs::read(directory.path().join("intent.json")).unwrap(),
                intent
            );
            assert_eq!(fixture.state.lock().unwrap().effects, effects);
        }
        fixture.state.lock().unwrap().fail_read = Some(("provider", tonic::Code::Unavailable));
        assert!(deployment.plan(&document, &cancel).await.is_err());
        assert_eq!(
            fs::read(directory.path().join("terraform.tfstate")).unwrap(),
            state
        );
        assert_eq!(fixture.state.lock().unwrap().effects, effects);
        fixture.state.lock().unwrap().fail_read = None;
        deployment.destroy(&cancel).await.unwrap();
    }
    drop(server);
    let requests = requests.lock().unwrap();
    assert!(!requests.is_empty());
    assert!(
        requests
            .iter()
            .all(|(path, _)| path.starts_with("/v1/models"))
    );
    assert!(
        requests
            .iter()
            .any(|(_, version)| version.as_deref() == Some("2023-06-01"))
    );
}
