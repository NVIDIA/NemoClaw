// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Several OpenClaw agents in one deployment, each in its own sandbox, through
//! the SDK and the bundle's CLI against the fixture gateway.
use crate::deployment::Lifecycle;
use nemoclaw_sdk::config::{AgentTools, Document};
use std::{collections::BTreeMap, fs, process::Command};

/// Each sandbox's id on the gateway, by sandbox name.
fn sandbox_ids(lifecycle: &Lifecycle) -> BTreeMap<String, String> {
    lifecycle
        .fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .values()
        .map(|sandbox| {
            let metadata = sandbox.metadata.as_ref().unwrap();
            (metadata.name.clone(), metadata.id.clone())
        })
        .collect()
}

// The failure is injected on an update, so the assistant's agent is already
// running and the test can check that a sibling's failure neither stops,
// restarts, nor replaces it. The same apply replaces the researcher's sandbox,
// which must finish although the reviewer's start fails.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn one_failed_agent_is_reported_alone_and_its_retry_replaces_only_it() {
    let mut document =
        Document::parse(include_str!("../../../examples/fabric-openclaw.yaml").as_bytes()).unwrap();
    let primary = document.spec.sandboxes[0].clone();
    for name in ["researcher", "reviewer"] {
        let mut sandbox = primary.clone();
        sandbox.name = name.into();
        sandbox.agent.name = name.into();
        document.spec.sandboxes.push(sandbox);
    }
    let mut lifecycle = Lifecycle::start(&document.yaml().unwrap()).await;
    lifecycle.apply().await;
    let applied = sandbox_ids(&lifecycle);
    let (configurations, calls) = {
        let state = lifecycle.fixture.state.lock().unwrap();
        (state.fabric_configurations.clone(), state.exec_calls.len())
    };

    // Narrowing the researcher's and reviewer's tools replaces both sandboxes.
    // Fabric then starts the researcher's agent and rejects the reviewer's.
    let mut changed = lifecycle.document.clone();
    for sandbox in &mut changed.spec.sandboxes[1..] {
        sandbox.agent.tools = Some(AgentTools {
            allow: vec!["read".into()],
        });
    }
    lifecycle
        .fixture
        .state
        .lock()
        .unwrap()
        .configuration_error_for
        .insert(
            "reviewer".into(),
            serde_json::json!({"error": {"stage":"start", "code":"start_failed", "message":"PRIVATE_SENTINEL"}}),
        );
    let inputs = tempfile::tempdir().unwrap();
    let input = inputs.path().join("deployment.yaml");
    fs::write(&input, changed.yaml().unwrap()).unwrap();
    let failed = Command::new(
        lifecycle
            .bundle
            .join("bin")
            .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
    )
    .args(["--progress", "off", "apply", "-o", "json", "--state-dir"])
    .arg(lifecycle.directory.path())
    .arg(&input)
    .arg("--non-interactive")
    .output()
    .unwrap();
    assert_eq!(failed.status.code(), Some(1));
    let stdout = String::from_utf8(failed.stdout).unwrap();
    let stderr = String::from_utf8(failed.stderr).unwrap();
    let report: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(report["outcome"], "failed");
    let message = report["error"]["message"].as_str().unwrap();
    for expected in [
        "sandbox/reviewer",
        "start_failed",
        "agent runtime is unknown",
    ] {
        assert!(message.contains(expected), "{message}");
    }
    for unexpected in [
        "sandbox/assistant",
        "sandbox/researcher",
        "PRIVATE_SENTINEL",
    ] {
        assert!(!stdout.contains(unexpected), "{stdout}");
        assert!(!stderr.contains(unexpected), "{stderr}");
    }
    let saved = lifecycle
        .directory
        .path()
        .join("diagnostics")
        .join("fabric-reviewer.json");
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(saved).unwrap()).unwrap();
    assert_eq!(saved["message"], "PRIVATE_SENTINEL");
    let after = sandbox_ids(&lifecycle);
    for name in ["researcher", "reviewer"] {
        assert_ne!(after[name], applied[name], "{name} was not replaced");
    }
    {
        let state = lifecycle.fixture.state.lock().unwrap();
        let assistant = &applied["assistant"];
        assert_eq!(&after["assistant"], assistant, "assistant was replaced");
        assert_eq!(
            state.fabric_configurations.get(assistant),
            Some(&configurations[assistant])
        );
        assert!(
            !state.fabric_stopped.contains(assistant),
            "assistant was stopped"
        );
        let researcher = &after["researcher"];
        assert!(state.fabric_configurations.contains_key(researcher));
        assert!(
            !state.fabric_stopped.contains(researcher),
            "researcher was stopped"
        );
        // Both replaced agents are started; the assistant's is neither
        // started nor stopped.
        let lifecycle_calls: Vec<_> = state.exec_sandboxes[calls..]
            .iter()
            .zip(&state.exec_calls[calls..])
            .filter_map(|(sandbox, command)| {
                command
                    .get(1)
                    .filter(|operation| ["start", "stop"].contains(&operation.as_str()))
                    .map(|operation| (sandbox.as_str(), operation.as_str()))
            })
            .collect();
        for name in ["researcher", "reviewer"] {
            assert!(
                lifecycle_calls.contains(&(name, "start")),
                "{lifecycle_calls:?}"
            );
        }
        assert!(
            lifecycle_calls
                .iter()
                .all(|(sandbox, _)| *sandbox != "assistant"),
            "{lifecycle_calls:?}"
        );
    }

    // The failed apply already updated the reviewer's configuration and
    // recorded no agent. Its failed start may have used the new sandbox's one
    // runtime, so the retry replaces that sandbox and creates the agent in it.
    // The researcher's replacement finished, so nothing else changes.
    lifecycle
        .fixture
        .state
        .lock()
        .unwrap()
        .configuration_error_for
        .clear();
    let plan = lifecycle
        .deployment
        .plan(&changed, &lifecycle.cancel)
        .await
        .unwrap();
    let changes: BTreeMap<_, _> = plan
        .changes
        .iter()
        .map(|change| (change.resource.as_str(), change.actions.clone()))
        .collect();
    assert_eq!(
        changes,
        BTreeMap::from([
            ("fabric_agent.reviewer", vec!["create".to_owned()]),
            (
                "openshell_sandbox.reviewer",
                vec!["delete".to_owned(), "create".to_owned()]
            ),
        ])
    );
    lifecycle
        .deployment
        .apply(&changed, &lifecycle.cancel)
        .await
        .unwrap();
    lifecycle.document = changed;
    let effects = lifecycle.fixture.state.lock().unwrap().effects;
    lifecycle.export_and_reapply_unchanged(effects).await;
    lifecycle.destroy();
}
