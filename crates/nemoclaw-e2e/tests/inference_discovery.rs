// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use serde_json::{Value, json};
use std::{fs, path::PathBuf, process::Command};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated HTTP fixture"]
async fn provider_model_catalog_reads_are_read_only_and_keep_api_qualification_unknown() {
    let tofu =
        PathBuf::from(std::env::var_os("NEMOCLAW_TEST_TOFU").expect("explicit OpenTofu required"));
    let provider = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_PROVIDER").expect("explicit provider required"),
    );
    assert!(tofu.is_absolute() && provider.is_absolute());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            bytes.push(stream.read_u8().await.unwrap());
        }
        let request = String::from_utf8(bytes).unwrap();
        assert!(request.starts_with("GET /v1/models HTTP/1.1\r\n"));
        assert!(!request.to_ascii_lowercase().contains("authorization:"));
        let body = r#"{"data":[{"id":"fixture-model"}]}"#;
        stream
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fs::copy(provider, root.join("terraform-provider-nemoclaw")).unwrap();
    fs::write(root.join("tofu.rc"),format!("provider_installation {{ dev_overrides {{ \"registry.opentofu.org/nvidia/nemoclaw\" = {} }} direct {{}} }}",serde_json::to_string(root).unwrap())).unwrap();
    let graph = json!({"terraform":{"required_version":"= 1.12.6","required_providers":{"nemoclaw":{"source":"nvidia/nemoclaw"}}},"provider":{"nemoclaw":{}},"data":{"nemoclaw_inference_capabilities":{"current":{"endpoint":endpoint,"api":"openai-responses"}}},"output":{"observation":{"value":"${data.nemoclaw_inference_capabilities.current.observation_json}"}}});
    fs::write(root.join("main.tf.json"), graph.to_string()).unwrap();
    let run = |args: &[&str]| {
        let result = Command::new(&tofu)
            .args(args)
            .current_dir(root)
            .env("TF_CLI_CONFIG_FILE", root.join("tofu.rc"))
            .env("TF_IN_AUTOMATION", "1")
            .env("CHECKPOINT_DISABLE", "1")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        result
    };
    run(&["plan", "-input=false", "-no-color", "-out=plan.bin"]);
    let plan: Value = serde_json::from_slice(&run(&["show", "-json", "plan.bin"]).stdout).unwrap();
    let observation: Value = serde_json::from_str(
        plan["planned_values"]["outputs"]["observation"]["value"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(observation["status"], "available");
    assert_eq!(observation["models"], json!(["fixture-model"]));
    assert_eq!(observation["api_verified"], false);
    assert!(!root.join("terraform.tfstate").exists());
    server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE; isolated HTTP and gateway fixtures"]
async fn optional_catalog_failures_preserve_complete_unchanged_plans_and_typed_uncertainty() {
    use nemoclaw_sdk::{
        CancellationToken, Deployment,
        config::{Document, InferenceApi, InferenceProviderKind},
    };
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let mode = Arc::new(AtomicUsize::new(0));
    let current = mode.clone();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let received = requests.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                bytes.push(stream.read_u8().await.unwrap());
            }
            received
                .lock()
                .unwrap()
                .push(String::from_utf8(bytes).unwrap());
            let (status, body) = match current.load(Ordering::SeqCst) {
                0 => ("404 Not Found", r#"{"error":"private-upstream-message"}"#),
                1 => (
                    "401 Unauthorized",
                    r#"{"error":"private-upstream-message"}"#,
                ),
                2 => ("200 OK", r#"{"unsupported":"private-upstream-message"}"#),
                _ => ("200 OK", r#"{"data":[{"id":"fixture-model"}]}"#),
            };
            stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
    });
    for (provider, api) in [
        (
            InferenceProviderKind::Anthropic,
            InferenceApi::AnthropicMessages,
        ),
        (
            InferenceProviderKind::Openai,
            InferenceApi::OpenaiCompletions,
        ),
    ] {
        mode.store(0, Ordering::SeqCst);
        let directory = tempfile::tempdir().unwrap();
        let fixture = nemoclaw_e2e::openshell::Fixture::start().await;
        let mut document =
            Document::parse(include_bytes!("../../../examples/fabric-openclaw.yaml").as_slice())
                .unwrap();
        *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
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
        for (selected, status, auth) in [
            (0, "unknown", "unknown"),
            (1, "unavailable", "required"),
            (2, "unknown", "unknown"),
            (3, "available", "not_required"),
        ] {
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
            let preview = deployment.plan(&document, &cancel).await.unwrap();
            assert!(preview.deferred.is_empty());
            assert!(preview.changes.is_empty());
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
    let requests = requests.lock().unwrap();
    assert!(!requests.is_empty());
    assert!(
        requests
            .iter()
            .all(|request| request.starts_with("GET /v1/models"))
    );
    assert!(
        requests
            .iter()
            .any(|request| request.contains("anthropic-version: 2023-06-01"))
    );
    server.abort();
}
