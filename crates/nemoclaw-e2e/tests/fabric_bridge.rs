// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The provider's client for Fabric's `fabric-agent-ctl`, against the fake
//! OpenShell gateway: the image's own command and environment, input on
//! stdin, and uncertain work never replayed.
use fabric_provider::AgentBridge as _;

use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{backend::Backend, config::Document};
use openshell_provider::OpenShell;
use std::{collections::BTreeMap, sync::Arc};

async fn sandbox() -> (Fixture, OpenShell, nemoclaw_sdk::backend::Row) {
    sandbox_with_runtime(None).await
}

async fn sandbox_with_runtime(
    runtime: Option<nemoclaw_sdk::image_runtime::RuntimeBinding>,
) -> (Fixture, OpenShell, nemoclaw_sdk::backend::Row) {
    let fixture = Fixture::start().await;
    let mut doc = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *doc.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let client = OpenShell::connect(
        &doc.spec.gateway.connection(),
        Arc::new(nemoclaw_sdk::EnvironmentSecrets),
    )
    .unwrap();
    let generations = ["workspace", "provider", "sandbox"]
        .into_iter()
        .map(|k| (k.into(), format!("{k}-generation")))
        .collect::<BTreeMap<_, _>>();
    let mut targets = nemoclaw_e2e::image_runtime::targets(&doc, &generations).unwrap();
    if let Some(runtime) = runtime {
        let agent = doc.spec.sandboxes[0].agent.name.clone();
        targets
            .iter_mut()
            .find(|target| target.kind == "sandbox")
            .unwrap()
            .values
            .insert(
                "launch_json".into(),
                serde_json::to_string(&runtime.launch(&agent)).unwrap(),
            );
    }
    for target in targets.iter().filter(|target| {
        matches!(
            target.kind.as_str(),
            "workspace" | "provider_profile" | "provider"
        )
    }) {
        let result = client.ensure(&target.kind, &target.values).await;
        assert!(result.error().is_none(), "{:?}", result.error());
    }
    let target = targets
        .iter()
        .find(|target| target.kind == "sandbox")
        .unwrap();
    let mutation = client.ensure("sandbox", &target.values).await;
    assert!(mutation.error().is_none(), "{:?}", mutation.error());
    // The provider reads the agent and runtime binding from the launch metadata.
    let binding = fabric_provider::fabric_binding(mutation.into_parts().0.unwrap()).unwrap();
    (fixture, client, binding)
}

fn config(binding: &nemoclaw_sdk::backend::Row) -> serde_json::Value {
    serde_json::json!({"metadata":{"name":binding["agent_name"]}})
}

#[tokio::test]
async fn explicit_invocation_sends_input_on_stdin_and_never_replays_uncertain_work() {
    let (fixture, client, binding) = sandbox().await;
    let runtime_id = client
        .start_agent(&binding, &config(&binding))
        .await
        .unwrap();
    let input = serde_json::json!({"prompt":"PRIVATE_REQUEST_SENTINEL"});
    for response in [
        b"truncated".to_vec(),
        // A reply for another operation is not this invocation's outcome.
        serde_json::to_vec(&serde_json::json!({"operation":"stop","status":"succeeded","changed":true,"result":null,"error":null})).unwrap().into_iter().chain(*b"\n").collect(),
    ] {
        fixture.state.lock().unwrap().exec_response = Some(response);
        let before = fixture.state.lock().unwrap().exec_calls.len();
        let error = client
            .invoke_agent(&binding, &runtime_id, &input)
            .await
            .unwrap_err();
        assert!(!error.to_string().contains("PRIVATE_REQUEST_SENTINEL"));
        let state = fixture.state.lock().unwrap();
        // One exec carries the request on stdin; nothing stages or removes a file.
        assert_eq!(state.exec_calls.len(), before + 1);
        assert_eq!(
            state.exec_calls[before][1..],
            [
                "invoke",
                "--agent",
                binding["agent_name"].as_str(),
                "--runtime-id",
                runtime_id.as_str(),
                "--input",
                "-"
            ]
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&state.exec_stdin[before]).unwrap(),
            input
        );
        assert!(!state.exec_calls[before].iter().any(|arg| arg.contains("PRIVATE_REQUEST_SENTINEL")));
    }
    fixture.state.lock().unwrap().exec_response = None;
    fixture.state.lock().unwrap().exec_exit = 1;
    let before = fixture.state.lock().unwrap().exec_calls.len();
    assert!(
        client
            .invoke_agent(&binding, &runtime_id, &input)
            .await
            .is_err()
    );
    // A failed invocation is reported once and never retried.
    assert_eq!(fixture.state.lock().unwrap().exec_calls.len(), before + 1);
}

#[tokio::test]
async fn a_relocated_image_owns_its_bridge_command_and_environment() {
    let mut runtime = nemoclaw_e2e::image_runtime::binding("fixture");
    runtime.runtime.command = vec!["/srv/fabric-agent-ctl".into()];
    for (key, value) in [
        ("ADAPTER_PYTHON", "/srv/python3.99"),
        ("HOME", "/work"),
        ("TMPDIR", "/work/tmp"),
        ("PATH", "/srv"),
    ] {
        runtime.runtime.environment.insert(key.into(), value.into());
    }
    runtime
        .runtime
        .policy
        .filesystem_policy
        .as_mut()
        .unwrap()
        .read_write = Some(vec!["/work".into()]);
    let (fixture, client, binding) = sandbox_with_runtime(Some(runtime.clone())).await;
    let name = binding["agent_name"].clone();
    let runtime_id = client
        .start_agent(&binding, &config(&binding))
        .await
        .unwrap();
    let calls = fixture.state.lock().unwrap().exec_calls.clone();
    assert_eq!(
        calls,
        [runtime.command("start", &["--agent", &name, "--config", "-"])]
    );
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&state.exec_stdin[0]).unwrap(),
            config(&binding)
        );
        assert_eq!(
            state.exec_environments[0],
            runtime.environment().into_iter().collect()
        );
    }
    // A substituted or missing runtime binding never runs anything.
    let mut substituted = runtime.clone();
    substituted.runtime.command = vec!["/srv/substituted".into()];
    for encoded in [
        None,
        Some("{}".into()),
        Some(serde_json::to_string(&substituted).unwrap()),
    ] {
        let mut invalid = binding.clone();
        invalid.remove("runtime_json");
        if let Some(encoded) = encoded {
            invalid.insert("runtime_json".into(), encoded);
        }
        assert!(
            client
                .invoke_agent(&invalid, &runtime_id, &serde_json::json!("hello"))
                .await
                .is_err()
        );
    }
    assert_eq!(fixture.state.lock().unwrap().exec_calls.len(), calls.len());
}

#[tokio::test]
async fn input_needs_no_writable_directory_and_oversized_input_never_executes() {
    // Stdin delivery replaces staged files, so a read-only home and temporary
    // directory do not prevent starting or invoking an agent.
    let mut runtime = nemoclaw_e2e::image_runtime::binding("fixture");
    for key in ["HOME", "TMPDIR"] {
        runtime
            .runtime
            .environment
            .insert(key.into(), "/read-only".into());
    }
    let filesystem = runtime.runtime.policy.filesystem_policy.as_mut().unwrap();
    filesystem
        .read_only
        .get_or_insert_default()
        .push("/read-only".into());
    filesystem.read_write = Some(Vec::new());
    let (fixture, client, binding) = sandbox_with_runtime(Some(runtime)).await;
    let runtime_id = client
        .start_agent(&binding, &config(&binding))
        .await
        .unwrap();
    let calls = fixture.state.lock().unwrap().exec_calls.len();
    let oversized = serde_json::json!({"prompt": "x".repeat(512 * 1024)});
    assert!(matches!(
        client.invoke_agent(&binding, &runtime_id, &oversized).await,
        Err(nemoclaw_sdk::Error::Conflict(_))
    ));
    assert_eq!(fixture.state.lock().unwrap().exec_calls.len(), calls);
}
