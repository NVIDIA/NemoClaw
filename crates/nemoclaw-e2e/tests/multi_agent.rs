// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Several OpenClaw agents in one deployment, each in its own sandbox, through
//! the SDK and the bundle's CLI against the fixture gateway.
use crate::deployment::Lifecycle;
use nemoclaw_e2e::openshell::State;
use nemoclaw_sdk::config::{AgentTools, Document};
use std::{collections::BTreeMap, fs, process::Command};

/// Three OpenClaw agents from the example, each in its own sandbox and with
/// its own model: assistant, researcher, and reviewer.
fn three_agents() -> Document {
    let mut document =
        Document::parse(include_str!("../../../examples/fabric-openclaw.yaml").as_bytes()).unwrap();
    let primary = document.spec.sandboxes["assistant"].clone();
    for (name, model) in [("researcher", "qwen3:8b"), ("reviewer", "qwen3:14b")] {
        let mut sandbox = primary.clone();
        sandbox.agent.name = name.into();
        sandbox.agent.inference.as_mut().unwrap().routes[0]
            .overrides
            .model = model.into();
        document.spec.sandboxes.insert(name.into(), sandbox);
    }
    document
}

/// The `start` and `stop` operations run in sandboxes since exec call `from`,
/// as (sandbox, operation).
fn lifecycle_calls(state: &State, from: usize) -> Vec<(&str, &str)> {
    state.exec_sandboxes[from..]
        .iter()
        .zip(&state.exec_calls[from..])
        .filter_map(|(sandbox, command)| {
            command
                .get(1)
                .filter(|operation| ["start", "stop"].contains(&operation.as_str()))
                .map(|operation| (sandbox.as_str(), operation.as_str()))
        })
        .collect()
}

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
    let mut lifecycle = Lifecycle::start(&three_agents().yaml().unwrap()).await;
    lifecycle.apply().await;
    let applied = sandbox_ids(&lifecycle);
    let (configurations, calls) = {
        let state = lifecycle.fixture.state.lock().unwrap();
        (state.fabric_configurations.clone(), state.exec_calls.len())
    };

    // Narrowing the researcher's and reviewer's tools replaces both sandboxes.
    // Fabric then starts the researcher's agent and rejects the reviewer's.
    let mut changed = lifecycle.document.clone();
    for name in ["researcher", "reviewer"] {
        changed.spec.sandboxes.get_mut(name).unwrap().agent.tools = Some(AgentTools {
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
        let lifecycle_calls = lifecycle_calls(&state, calls);
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

// The three agents share one provider registration and the workspace. Removing
// one agent's sandbox must stop only that agent and keep what the others use.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn removing_one_agent_stops_only_its_runtime_and_keeps_shared_registrations() {
    let mut lifecycle = Lifecycle::start(&three_agents().yaml().unwrap()).await;
    lifecycle.apply().await;
    let applied = sandbox_ids(&lifecycle);
    let workspace = lifecycle.document.workspace();
    let (configurations, providers, profiles, workspaces, calls) = {
        let state = lifecycle.fixture.state.lock().unwrap();
        let registrations: Vec<_> = state
            .providers
            .values()
            .map(|provider| provider.metadata.as_ref().unwrap().name.clone())
            .collect();
        assert_eq!(registrations.len(), 1, "{registrations:?}");
        // Each sandbox runs its own agent with its own model, and attaches the
        // shared registration.
        for sandbox in lifecycle.document.sandboxes() {
            let configuration = &state.fabric_configurations[&applied[sandbox.name]];
            assert_eq!(configuration["metadata"]["name"], sandbox.agent.name);
            let model = &sandbox.agent.inference.as_ref().unwrap().routes[0]
                .overrides
                .model;
            assert_eq!(configuration["models"]["default"]["model"], *model);
            let key = format!("{workspace}/{}", sandbox.name);
            assert_eq!(
                state.sandboxes[&key].spec.as_ref().unwrap().providers,
                registrations
            );
        }
        (
            state.fabric_configurations.clone(),
            state.providers.clone(),
            state.profiles.clone(),
            state.workspaces.clone(),
            state.exec_calls.len(),
        )
    };

    let mut reduced = lifecycle.document.clone();
    reduced
        .spec
        .sandboxes
        .retain(|name, _| name != "researcher");
    let plan = lifecycle
        .deployment
        .plan(&reduced, &lifecycle.cancel)
        .await
        .unwrap();
    let changes: BTreeMap<_, _> = plan
        .changes
        .iter()
        .map(|change| (change.resource.as_str(), change.actions.clone()))
        .collect();
    let delete = vec!["delete".to_owned()];
    assert_eq!(
        changes,
        BTreeMap::from([
            ("fabric_agent.researcher", delete.clone()),
            ("openshell_sandbox.researcher", delete.clone()),
            ("terraform_data.agent_researcher", delete),
        ])
    );
    lifecycle
        .deployment
        .apply(&reduced, &lifecycle.cancel)
        .await
        .unwrap();

    let mut remaining = applied.clone();
    remaining.remove("researcher");
    assert_eq!(sandbox_ids(&lifecycle), remaining);
    let effects = {
        let state = lifecycle.fixture.state.lock().unwrap();
        assert_eq!(
            lifecycle_calls(&state, calls),
            [("researcher", "stop")],
            "only the researcher's agent may be stopped or started"
        );
        for id in remaining.values() {
            assert_eq!(
                state.fabric_configurations.get(id),
                Some(&configurations[id])
            );
            assert!(!state.fabric_stopped.contains(id), "{id} was stopped");
        }
        assert!(
            state.providers == providers,
            "provider registrations changed"
        );
        assert!(state.profiles == profiles, "provider profiles changed");
        assert!(state.workspaces == workspaces, "the workspace changed");
        state.effects
    };
    lifecycle.document = reduced;
    lifecycle.export_and_reapply_unchanged(effects).await;
    lifecycle.destroy();
}

// The relabeled sandbox is the gateway's report of another owner's object at
// the researcher's address. Every operation that reads it must stop before it
// changes anything, including the other two agents.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn a_foreign_owner_on_one_agent_stops_planning_without_touching_the_others() {
    let lifecycle = Lifecycle::start(&three_agents().yaml().unwrap()).await;
    let effects = lifecycle.apply().await;
    let saved = |file: &str| fs::read(lifecycle.directory.path().join(file)).unwrap();
    let (tofu_state, intent) = (saved("terraform.tfstate"), saved("intent.json"));
    let key = format!("{}/researcher", lifecycle.document.workspace());
    let (owned, relabeled, calls) = {
        let mut state = lifecycle.fixture.state.lock().unwrap();
        let owned = state.sandboxes.clone();
        state
            .sandboxes
            .get_mut(&key)
            .unwrap()
            .metadata
            .as_mut()
            .unwrap()
            .labels
            .insert("nemoclaw.nvidia.com/uid".into(), "foreign".into());
        (owned, state.sandboxes.clone(), state.exec_calls.len())
    };

    // Each operation stops at the researcher's observation, before it changes
    // the saved state, the gateway, or any sandbox.
    let refused = |operation: &str, error: Option<nemoclaw_sdk::Error>| {
        let error = error.unwrap_or_else(|| panic!("{operation} accepted a foreign owner"));
        assert!(
            error.to_string().contains("observed ownership"),
            "{operation}: {error}"
        );
        assert!(
            saved("terraform.tfstate") == tofu_state,
            "{operation} changed terraform.tfstate"
        );
        assert!(
            saved("intent.json") == intent,
            "{operation} changed intent.json"
        );
        let state = lifecycle.fixture.state.lock().unwrap();
        assert_eq!(state.effects, effects, "{operation} changed the gateway");
        assert!(
            state.sandboxes == relabeled,
            "{operation} changed a sandbox"
        );
        assert_eq!(
            state.exec_calls.len(),
            calls,
            "{operation} ran a command in a sandbox"
        );
    };
    let (deployment, document, cancel) = (
        &lifecycle.deployment,
        &lifecycle.document,
        &lifecycle.cancel,
    );
    refused("plan", deployment.plan(document, cancel).await.err());
    refused("plan_destroy", deployment.plan_destroy(cancel).await.err());
    refused("export", deployment.export(cancel).await.err());
    refused("apply", deployment.apply(document, cancel).await.err());
    refused("destroy", deployment.destroy(cancel).await.err());

    lifecycle.fixture.state.lock().unwrap().sandboxes = owned;
    lifecycle.destroy();
}
