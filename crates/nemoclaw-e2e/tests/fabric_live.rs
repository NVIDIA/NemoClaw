// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    CancellationToken, Deployment,
    backend::Row,
    config::Document,
    openshell::{EnvironmentSecrets, OpenShell},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

fn confirmed_reply(harness: &str, response: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(response) else {
        return false;
    };
    if !value["error"].is_null() {
        return false;
    }
    let text = if harness == "openclaw" {
        let Some(payloads) = value["result"]["payloads"].as_array() else {
            return false;
        };
        if value["status"] != "ok"
            || payloads.is_empty()
            || payloads.iter().any(|p| p["isError"] == true)
        {
            return false;
        }
        payloads[0]["text"].as_str()
    } else {
        if value["status"] != "succeeded" {
            return false;
        }
        value["output"]["response"].as_str()
    };
    text.is_some_and(|text| {
        text.trim()
            .trim_end_matches(['.', '!'])
            .eq_ignore_ascii_case("FOUR")
    })
}
#[test]
fn a_prompt_echo_or_failed_result_is_not_an_agent_reply() {
    for response in [
        json!({"status":"failed","input":"Reply FOUR","output":{"response":"FOUR"}}),
        json!({"status":"succeeded","output":{"response":"NO"},"input":"Reply FOUR"}),
        json!({"status":"succeeded","output":{"response":"FOUR"},"error":{"message":"failed"}}),
    ] {
        assert!(!confirmed_reply(
            "deepagents",
            &serde_json::to_vec(&response).unwrap()
        ));
    }
    assert!(confirmed_reply(
        "hermes",
        br#"{"status":"succeeded","output":{"response":"FOUR"},"error":null}"#
    ));
    assert!(confirmed_reply(
        "openclaw",
        br#"{"status":"ok","result":{"payloads":[{"text":"FOUR"}]}}"#
    ));
    assert!(!confirmed_reply(
        "openclaw",
        br#"{"status":"ok","result":{"payloads":[{"text":"FOUR","isError":true}]}}"#
    ));
}

fn bindings(directory: &Path) -> (Value, Row) {
    let state: Value =
        serde_json::from_slice(&fs::read(directory.join("terraform.tfstate")).unwrap()).unwrap();
    let mut ids = serde_json::Map::new();
    let mut sandbox = None;
    let resources = state["resources"].as_array().unwrap();
    for resource in resources {
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
async fn openclaw_reply(client: &OpenShell, binding: &Row, name: &str, key: &str) -> Vec<u8> {
    let params = json!({"agentId":name,"sessionKey":format!("agent:{name}:{key}"),"message":"Reply with exactly the word FOUR.","idempotencyKey":key,"deliver":false}).to_string();
    exec(
        client,
        binding,
        [
            "openclaw",
            "gateway",
            "call",
            "agent",
            "--params",
            &params,
            "--expect-final",
            "--json",
            "--timeout",
            "280000",
        ]
        .map(String::from)
        .to_vec(),
    )
    .await
}

async fn runtime_id(client: &OpenShell, binding: &Row) -> String {
    let output = exec(client, binding, ["/opt/fabric/bin/python", "-c", "import socket; s=socket.socket(socket.AF_UNIX); s.connect('/sandbox/fabric.sock'); s.sendall(b'{\"operation\":\"check\"}\\n'); print(s.makefile().readline())"].map(String::from).to_vec()).await;
    let value: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(value["ready"], true);
    let id = value["runtime_id"].as_str().unwrap();
    assert!(!id.is_empty());
    id.into()
}

#[tokio::test]
#[ignore = "requires explicit NEMOCLAW_LIVE_FABRIC_CONFIG, NEMOCLAW_LIVE_FABRIC_STATE, NEMOCLAW_TEST_BUNDLE; creates and destroys only that owned deployment"]
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
    let provider = document.inference_provider().unwrap();
    let agent = &document.spec.sandboxes[0].agents[0];
    assert_eq!(document.spec.gateway.management, "external");
    // Ollama recovery/destroy is fixture-qualified separately; this live target
    // has not qualified its complete agent lifecycle.
    assert!(provider.ollama.is_none());
    fs::create_dir_all(&directory).unwrap();
    let save = |name: &str, value: &Value| {
        fs::write(
            directory.join(name),
            serde_json::to_vec_pretty(value).unwrap(),
        )
        .unwrap()
    };
    let deployment = Deployment::new(&directory, &bundle);
    let cancel = CancellationToken::new();
    save(
        "apply.json",
        &serde_json::to_value(deployment.apply(&document, &cancel).await.unwrap()).unwrap(),
    );
    let (before, binding) = bindings(&directory);
    let managed_before = managed_bindings(&directory);
    let client = OpenShell::connect(&document.spec.gateway, Arc::new(EnvironmentSecrets)).unwrap();
    if document.spec.sandboxes[0].network.tier == "isolated" {
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
        save(
            "policy-denial.json",
            &json!({"externalEgressDenied":true,"proxyStatus":403}),
        );
    }
    let hosted = runtime_id(&client, &binding).await;
    if document
        .sandbox_harness(&document.spec.sandboxes[0])
        .unwrap()
        .kind
        == "openclaw"
    {
        exec(
            &client,
            &binding,
            [
                "openclaw",
                "config",
                "set",
                "--strict-json",
                "session.dmScope",
                "\"per-channel-peer\"",
            ]
            .map(String::from)
            .to_vec(),
        )
        .await;
    }
    let unchanged = deployment.apply(&document, &cancel).await.unwrap();
    assert!(unchanged.changes.is_empty());
    save(
        "unchanged-apply.json",
        &serde_json::to_value(unchanged).unwrap(),
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
    assert_eq!(managed_bindings(&directory), managed_before);
    assert_eq!(runtime_id(&client, &binding).await, hosted);
    let response = if document
        .sandbox_harness(&document.spec.sandboxes[0])
        .unwrap()
        .kind
        == "openclaw"
    {
        let setting = exec(
            &client,
            &binding,
            ["openclaw", "config", "get", "session.dmScope"]
                .map(String::from)
                .to_vec(),
        )
        .await;
        assert!(String::from_utf8_lossy(&setting).contains("per-channel-peer"));
        // Explicitly qualify inference through the Fabric-hosted runtime after apply.
        let reply = client.agent_response(&binding).await.unwrap();
        save("managed-agent-probe.json", &json!({"response": reply}));
        assert_eq!(runtime_id(&client, &binding).await, hosted);
        openclaw_reply(
            &client,
            &binding,
            &agent.name,
            &format!("{}-native-live", document.metadata.uid),
        )
        .await
    } else {
        // This is a one-shot Fabric SDK call, not a conversation injected into
        // the hosted runtime by plan/apply or a new NemoClaw invocation API.
        exec(&client, &binding, ["/opt/fabric/bin/python", "-c", "import sys,asyncio,json; sys.path.insert(0,'/opt/nemoclaw'); from fabric import configuration; from nemo_fabric import Fabric,FabricConfig; c=configuration(sys.argv[1]) if sys.argv[2]=='deepagents' else configuration(sys.argv[1],sys.argv[2]); c['runtime']['artifacts']='/sandbox/sdk-smoke'; print(json.dumps(asyncio.run(Fabric().run(FabricConfig.model_validate(c),input='Reply with exactly the word FOUR.',base_dir='/sandbox')).to_mapping()))", &agent.name, &document.sandbox_harness(&document.spec.sandboxes[0]).unwrap().kind].map(String::from).to_vec()).await
    };
    fs::write(directory.join("native-response.json"), &response).unwrap();
    assert!(
        confirmed_reply(
            &document
                .sandbox_harness(&document.spec.sandboxes[0])
                .unwrap()
                .kind,
            &response
        ),
        "no confirmed successful native reply"
    );
    assert_eq!(runtime_id(&client, &binding).await, hosted);
    save(
        "destroy.json",
        &serde_json::to_value(deployment.destroy(&cancel).await.unwrap()).unwrap(),
    );
    save(
        "proof.json",
        &json!({"passed":true,"deployment":document.metadata.uid,"harness":document.sandbox_harness(&document.spec.sandboxes[0]).unwrap().kind,"resourceBindings":before,"managedRuntimeBindings":managed_before,"runtimeId":hosted,"unchangedApply":true,"exportReapply":true,"nativeResponse":true,"hostedRuntimePreserved":true,"destroyed":true}),
    );
}

fn upgrade_gate_configuration(document: &Document) -> bool {
    document
        .sandbox_harness(&document.spec.sandboxes[0])
        .is_ok_and(|harness| harness.kind == "openclaw")
        && document.spec.sandboxes[0].agents.len() == 1
        && document
            .selected_inference_providers()
            .is_ok_and(|providers| {
                providers.len() == 1
                    && providers.iter().all(|provider| {
                        provider.service.is_none()
                            && provider.ollama.is_none()
                            && provider.ollama_proxy.is_none()
                    })
            })
}

#[test]
fn upgrade_gate_requires_inference_to_exist_independently_of_apply() {
    for (input, accepted) in [
        (include_str!("../../../examples/fabric-openclaw.yaml"), true),
        (
            include_str!("../../../examples/inline-inference.yaml"),
            true,
        ),
        (include_str!("../../../examples/managed-ollama.yaml"), false),
        (include_str!("../../../examples/spark/vllm.yaml"), false),
        (include_str!("../../../examples/fabric-hermes.yaml"), false),
    ] {
        assert_eq!(
            upgrade_gate_configuration(&Document::parse(input.as_bytes()).unwrap()),
            accepted
        );
    }
}

#[tokio::test]
#[ignore = "requires explicit NEMOCLAW_UPGRADE_CONFIG, fresh NEMOCLAW_UPGRADE_STATE, and NEMOCLAW_TEST_BUNDLE; real independent inference and owned deployment"]
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
        upgrade_gate_configuration(&document),
        "use one OpenClaw agent and one independent inference provider"
    );
    let verified = nemoclaw_sdk::bundle::Bundle::open(&bundle).unwrap();
    fs::create_dir(&directory).expect("upgrade gate requires a fresh owned state directory");
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
    fs::write(directory.join("apply.stdout"), &apply.stdout).unwrap();
    fs::write(directory.join("apply.stderr"), &apply.stderr).unwrap();
    assert!(
        apply.status.success(),
        "apply failed; inspect the retained state and apply.stderr"
    );
    let deployment = Deployment::new(&directory, &bundle);
    let cancel = CancellationToken::new();
    let client = OpenShell::connect(&document.spec.gateway, Arc::new(EnvironmentSecrets)).unwrap();
    client
        .verify_gateway(&document.spec.sandboxes[0].runtime.provider)
        .await
        .unwrap();
    let (before, binding) = bindings(&directory);
    let hosted = runtime_id(&client, &binding).await;
    let reply = openclaw_reply(
        &client,
        &binding,
        &document.spec.sandboxes[0].agents[0].name,
        &format!("{}-upgrade", document.metadata.uid),
    )
    .await;
    assert!(
        confirmed_reply("openclaw", &reply),
        "no confirmed hosted agent reply"
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
    deployment.destroy(&cancel).await.unwrap();
    fs::write(
        directory.join("upgrade-proof.json"),
        serde_json::to_vec_pretty(&json!({
            "passed": true,
            "bundle": verified.manifest.version,
            "deployment": document.metadata.uid,
            "image": document.spec.sandboxes[0].image.ref_,
            "runtimeId": hosted,
            "resourceBindings": before,
            "replyAfterApplyExit": true,
            "exportReapply": true,
            "destroyed": true
        }))
        .unwrap(),
    )
    .unwrap();
}
