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
    assert_eq!(resources.len(), 4);
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
            sandbox = Some(serde_json::from_value(attributes.clone()).unwrap());
        }
    }
    (Value::Object(ids), sandbox.unwrap())
}
async fn exec(client: &OpenShell, binding: &Row, command: Vec<String>) -> Vec<u8> {
    let (exit, output) = client
        .exec_bound(binding, command, Row::new(), 360)
        .await
        .unwrap();
    assert_eq!(exit, 0, "native runtime command failed");
    output
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
    let provider = &document.spec.inference_providers[0];
    let agent = &document.spec.sandboxes[0].agents[0];
    assert_eq!(document.spec.gateway.management, "external");
    assert!(provider.service.is_none() && provider.ollama.is_none());
    assert_eq!(agent.agent_type, "fabric");
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
    let client = OpenShell::connect(&document.spec.gateway, Arc::new(EnvironmentSecrets)).unwrap();
    let hosted = runtime_id(&client, &binding).await;
    if agent.harness == "openclaw" {
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
    assert!(unchanged.changes.is_empty() && unchanged.agent_response.is_empty());
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
    assert_eq!(runtime_id(&client, &binding).await, hosted);
    let response = if agent.harness == "openclaw" {
        let setting = exec(
            &client,
            &binding,
            ["openclaw", "config", "get", "session.dmScope"]
                .map(String::from)
                .to_vec(),
        )
        .await;
        assert!(String::from_utf8_lossy(&setting).contains("per-channel-peer"));
        let params = json!({"agentId":agent.name,"sessionKey":format!("agent:{}:native-live",agent.name),"message":"Reply with exactly the word FOUR.","idempotencyKey":format!("{}-native-live",document.metadata.uid),"deliver":false}).to_string();
        exec(
            &client,
            &binding,
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
    } else {
        // This is a one-shot Fabric SDK call, not a conversation injected into
        // the hosted runtime by plan/apply or a new NemoClaw invocation API.
        exec(&client, &binding, ["/opt/fabric/bin/python", "-c", "import sys,asyncio,json; sys.path.insert(0,'/opt/nemoclaw'); from fabric import configuration; from nemo_fabric import Fabric,FabricConfig; c=configuration(sys.argv[1],sys.argv[2]); c['runtime']['artifacts']='/sandbox/sdk-smoke'; print(json.dumps(asyncio.run(Fabric().run(FabricConfig.model_validate(c),input='Reply with exactly the word FOUR.',base_dir='/sandbox')).to_mapping()))", &agent.name, &agent.harness].map(String::from).to_vec()).await
    };
    fs::write(directory.join("native-response.json"), &response).unwrap();
    assert!(
        confirmed_reply(&agent.harness, &response),
        "no confirmed successful native reply"
    );
    assert_eq!(runtime_id(&client, &binding).await, hosted);
    save(
        "destroy.json",
        &serde_json::to_value(deployment.destroy(&cancel).await.unwrap()).unwrap(),
    );
    save(
        "proof.json",
        &json!({"passed":true,"deployment":document.metadata.uid,"harness":agent.harness,"resourceBindings":before,"runtimeId":hosted,"unchangedApply":true,"exportReapply":true,"nativeResponse":true,"hostedRuntimePreserved":true,"destroyed":true}),
    );
}
