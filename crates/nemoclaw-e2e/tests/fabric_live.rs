// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    CancellationToken, Deployment, OperationResult, Outcome,
    backend::Row,
    config::{Document, Gateway},
    openshell::{EnvironmentSecrets, OpenShell},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

// These opt-in tests qualify deployment lifecycle and explicit invocation transport.
// Adapter-owned input/output meaning and native inference quality belong to Fabric.
fn successful_invocation(response: &[u8]) -> bool {
    serde_json::from_slice::<Value>(response).is_ok_and(|value| {
        value["status"] == "succeeded" && value["error"].is_null() && value.get("output").is_some()
    })
}

#[test]
fn failed_or_incomplete_results_are_not_successful_invocations() {
    for response in [
        json!({"status":"failed","output":"anything"}),
        json!({"status":"succeeded"}),
        json!({"status":"succeeded","output":null,"error":{"message":"failed"}}),
    ] {
        assert!(!successful_invocation(
            &serde_json::to_vec(&response).unwrap()
        ));
    }
}

#[test]
fn successful_fabric_results_allow_adapter_owned_output_shapes() {
    for output in [
        json!("native"),
        json!([1, 2]),
        json!({"artifact":"owned"}),
        Value::Null,
    ] {
        let result = json!({"status":"succeeded","output":output,"error":null});
        assert!(successful_invocation(&serde_json::to_vec(&result).unwrap()));
    }
}

fn invocation_input(variable: &str) -> Value {
    let path = PathBuf::from(std::env::var_os(variable).expect(variable));
    assert!(path.is_absolute(), "{variable} must be absolute");
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn bindings(directory: &Path) -> (Value, Row) {
    let state: Value =
        serde_json::from_slice(&fs::read(directory.join("terraform.tfstate")).unwrap()).unwrap();
    let mut ids = serde_json::Map::new();
    let mut sandbox = None;
    let resources = state["resources"].as_array().unwrap();
    for resource in resources {
        if resource["mode"] == "data" {
            continue;
        }
        let instances = resource["instances"].as_array().unwrap();
        assert_eq!(instances.len(), 1);
        let attributes = &instances[0]["attributes"];
        ids.insert(
            format!(
                "{}.{}",
                resource["type"].as_str().unwrap(),
                resource["name"].as_str().unwrap()
            ),
            attributes["id"].clone(),
        );
        if resource["type"] == "nemoclaw_sandbox" {
            assert!(
                sandbox
                    .replace(serde_json::from_value(attributes.clone()).unwrap())
                    .is_none(),
                "expected one sandbox binding"
            );
        }
    }
    (Value::Object(ids), sandbox.unwrap())
}
fn managed_bindings(directory: &Path) -> Value {
    let path = directory.join("runtime/terraform.tfstate");
    if !path.exists() {
        return json!({});
    }
    let state: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let mut result = serde_json::Map::new();
    for resource in state["resources"].as_array().unwrap() {
        if resource["mode"] == "data" {
            continue;
        }
        assert_eq!(resource["instances"].as_array().unwrap().len(), 1);
        result.insert(
            format!(
                "{}.{}",
                resource["type"].as_str().unwrap(),
                resource["name"].as_str().unwrap()
            ),
            resource["instances"][0]["attributes"].clone(),
        );
    }
    Value::Object(result)
}
async fn exec(client: &OpenShell, binding: &Row, command: Vec<String>) -> Vec<u8> {
    let (exit, output) = client
        .exec_bound(binding, command, Row::new(), 360)
        .await
        .unwrap();
    assert_eq!(exit, 0, "native runtime command failed");
    output
}
async fn invoke(client: &OpenShell, binding: &Row, name: &str, input: &Value) -> Vec<u8> {
    exec(
        client,
        binding,
        [
            "/opt/fabric/bin/python",
            "/opt/nemoclaw/fabric.py",
            "invoke",
            name,
            &input.to_string(),
        ]
        .map(String::from)
        .to_vec(),
    )
    .await
}

async fn runtime_id(client: &OpenShell, binding: &Row) -> String {
    let output = exec(client, binding, ["/opt/fabric/bin/python", "-c", "import socket; s=socket.socket(socket.AF_UNIX); s.connect('/sandbox/fabric.sock'); s.sendall(b'{\"operation\":\"status\"}\\n'); print(s.makefile().readline())"].map(String::from).to_vec()).await;
    let value: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(value["ready"], true);
    let id = value["runtime_id"].as_str().unwrap();
    assert!(!id.is_empty());
    id.into()
}

#[tokio::test]
#[ignore = "requires explicit NEMOCLAW_LIVE_FABRIC_CONFIG, NEMOCLAW_LIVE_FABRIC_STATE, NEMOCLAW_LIVE_FABRIC_INPUT, NEMOCLAW_TEST_BUNDLE; creates and destroys only that owned deployment"]
async fn fabric_native_access_and_reconciliation_preserve_the_hosted_runtime() {
    let explicit = |name| {
        let path = PathBuf::from(std::env::var_os(name).expect(name));
        assert!(path.is_absolute());
        path
    };
    let document =
        Document::parse(fs::File::open(explicit("NEMOCLAW_LIVE_FABRIC_CONFIG")).unwrap()).unwrap();
    let directory = explicit("NEMOCLAW_LIVE_FABRIC_STATE");
    let bundle = explicit("NEMOCLAW_TEST_BUNDLE");
    let input = invocation_input("NEMOCLAW_LIVE_FABRIC_INPUT");
    assert!(uses_independent_inference(&document));
    let provider = document.inference_provider().unwrap();
    let agent = &document.spec.sandboxes[0].agent;
    assert!(matches!(document.spec.gateway, Gateway::External(_)));
    // Managed-service installation is qualified separately; this live target
    // exercises only an external inference provider.
    assert!(provider.service_ref.is_none());
    fs::create_dir_all(&directory).unwrap();
    let deployment = Deployment::new(&directory, &bundle);
    let cancel = CancellationToken::new();
    let applied = deployment.apply(&document, &cancel).await.unwrap();
    assert_eq!(applied.outcome, Outcome::Succeeded);
    let (before, binding) = bindings(&directory);
    let managed_before = managed_bindings(&directory);
    let client = OpenShell::connect(&document.spec.gateway, Arc::new(EnvironmentSecrets)).unwrap();
    if document.spec.sandboxes[0].network.policy == nemoclaw_sdk::config::NetworkPolicy::Isolated {
        let denial = exec(
            &client,
            &binding,
            ["/opt/fabric/bin/python", "-c", "import urllib.request,urllib.error;\ntry: urllib.request.urlopen('https://example.com',timeout=15)\nexcept urllib.error.URLError as e:\n assert '403' in str(e), str(e)\n print('policy-denied-403')\nelse: raise AssertionError('isolated policy allowed external egress')"]
                .map(String::from).to_vec(),
        ).await;
        assert_eq!(
            String::from_utf8(denial).unwrap().trim(),
            "policy-denied-403"
        );
    }
    let hosted = runtime_id(&client, &binding).await;
    let unchanged = deployment.apply(&document, &cancel).await.unwrap();
    assert!(unchanged.changes.is_empty());
    let exported = deployment.export(&cancel).await.unwrap();
    assert_eq!(exported, document);
    assert!(
        deployment
            .apply(&exported, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(bindings(&directory).0, before);
    assert_eq!(managed_bindings(&directory), managed_before);
    assert_eq!(runtime_id(&client, &binding).await, hosted);
    assert!(matches!(
        client.agent_response(&binding).await,
        Err(nemoclaw_sdk::Error::Conflict(
            "Fabric does not expose a normalized text probe contract; resources retained"
        ))
    ));
    let response = invoke(&client, &binding, &agent.name, &input).await;
    assert!(
        successful_invocation(&response),
        "Fabric invocation did not succeed"
    );
    assert_eq!(runtime_id(&client, &binding).await, hosted);
    let destroyed = deployment.destroy(&cancel).await.unwrap();
    assert_eq!(destroyed.outcome, Outcome::Destroyed);
}

fn uses_independent_inference(document: &Document) -> bool {
    document.spec.sandboxes.len() == 1
        && document
            .selected_inference_providers()
            .is_ok_and(|providers| {
                providers.len() == 1
                    && providers
                        .iter()
                        .all(|provider| provider.service_ref.is_none())
            })
}

#[test]
fn apply_exit_test_requires_independent_inference() {
    for (input, accepted) in [
        (include_str!("../../../examples/fabric-openclaw.yaml"), true),
        (
            include_str!("../../../examples/inline-inference.yaml"),
            true,
        ),
        (include_str!("../../../examples/managed-ollama.yaml"), false),
        (include_str!("../../../examples/spark/vllm.yaml"), false),
        (include_str!("../../../examples/fabric-hermes.yaml"), true),
    ] {
        assert_eq!(
            uses_independent_inference(&Document::parse(input.as_bytes()).unwrap()),
            accepted
        );
    }
}

#[tokio::test]
#[ignore = "requires explicit NEMOCLAW_UPGRADE_CONFIG, fresh NEMOCLAW_UPGRADE_STATE, NEMOCLAW_UPGRADE_INPUT, and NEMOCLAW_TEST_BUNDLE; real independent inference and owned deployment"]
async fn dependency_upgrade_survives_apply_process_exit() {
    let explicit = |name| {
        let path = PathBuf::from(std::env::var_os(name).expect(name));
        assert!(path.is_absolute(), "{name} must be absolute");
        path
    };
    let config = explicit("NEMOCLAW_UPGRADE_CONFIG");
    let directory = explicit("NEMOCLAW_UPGRADE_STATE");
    let bundle = explicit("NEMOCLAW_TEST_BUNDLE");
    let document = Document::parse(fs::File::open(&config).unwrap()).unwrap();
    assert!(
        uses_independent_inference(&document),
        "use one agent and one independent inference provider"
    );
    let input = invocation_input("NEMOCLAW_UPGRADE_INPUT");
    fs::create_dir(&directory).expect("test requires a fresh owned state directory");
    let executable = bundle
        .join("bin")
        .join(nemoclaw_sdk::bundle::executable("nemoclaw"));
    // Wait for the real CLI to exit before probing the hosted agent. This test
    // neither serves inference nor starts a replacement agent through exec.
    let apply = std::process::Command::new(&executable)
        .args(["apply", "--state-dir"])
        .arg(&directory)
        .arg(&config)
        .output()
        .unwrap();
    assert!(
        apply.status.success(),
        "apply failed: {}",
        String::from_utf8_lossy(&apply.stderr)
    );
    let applied: OperationResult = serde_json::from_slice(&apply.stdout).unwrap();
    assert_eq!(applied.outcome, Outcome::Succeeded);
    let deployment = Deployment::new(&directory, &bundle);
    let cancel = CancellationToken::new();
    let client = OpenShell::connect(&document.spec.gateway, Arc::new(EnvironmentSecrets)).unwrap();
    client
        .verify_gateway(document.spec.sandboxes[0].runtime.provider)
        .await
        .unwrap();
    let (before, binding) = bindings(&directory);
    let hosted = runtime_id(&client, &binding).await;
    let reply = invoke(
        &client,
        &binding,
        &document.spec.sandboxes[0].agent.name,
        &input,
    )
    .await;
    assert!(
        successful_invocation(&reply),
        "Fabric invocation did not succeed"
    );
    let exported = deployment.export(&cancel).await.unwrap();
    assert_eq!(exported, document);
    assert!(
        deployment
            .apply(&exported, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(bindings(&directory).0, before);
    assert_eq!(runtime_id(&client, &binding).await, hosted);
    let destroyed = deployment.destroy(&cancel).await.unwrap();
    assert_eq!(destroyed.outcome, Outcome::Destroyed);
}
