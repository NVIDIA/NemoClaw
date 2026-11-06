// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Several OpenClaw agents in one deployment, each in its own sandbox, through
//! the SDK and the bundle's CLI against the fixture gateway: one agent's
//! rejected start, another owner's label on one sandbox, and a first apply
//! killed while their sandboxes are created. The HCL integration scenario
//! kubernetes-external-three-agents owns one agent's replacement and restart
//! leaving the others unchanged.
use crate::deployment::Lifecycle;
use nemoclaw_e2e::openshell::State;
use nemoclaw_sdk::config::{AgentTools, Document};
use std::{collections::BTreeMap, fs, process::Command};

/// Three OpenClaw agents from the example, each in its own sandbox and with
/// its own model: assistant, researcher, and reviewer.
fn three_agents() -> Document {
    let mut document =
        Document::parse(include_str!("../../../../../examples/fabric-openclaw.yaml").as_bytes())
            .unwrap();
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
    let lifecycle = Lifecycle::start(&three_agents().yaml().unwrap()).await;
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
    let remaining = report["remainingState"].as_str().unwrap();
    assert!(
        remaining.contains("Changes may already have been made"),
        "{remaining}"
    );
    let message = report["error"]["message"].as_str().unwrap();
    for expected in [
        "sandbox/reviewer",
        "start_failed",
        "agent runtime is unknown",
        "resources retained",
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
        // Checking the other agents' runtimes reads them; nothing starts,
        // stops, or invokes one.
        assert!(
            state.exec_calls[calls..]
                .iter()
                .all(|command| command.get(1).is_some_and(|operation| operation == "check")),
            "{operation} changed an agent runtime"
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

/// A first apply whose OpenTofu is killed. Unix only: the test ends
/// OpenTofu's process group, which the SDK creates there.
#[cfg(unix)]
mod killed_apply {
    use super::three_agents;
    use crate::deployment::Lifecycle;
    use std::{
        collections::BTreeSet,
        fs,
        path::Path,
        process::Command,
        time::{Duration, Instant},
    };

    /// Polls `done` every 20 ms until it holds, failing with `what` after 60 s.
    async fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(60);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting until {what}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// The ID of every resource instance in OpenTofu's state file.
    fn bound_ids(state: &Path) -> BTreeSet<String> {
        let Ok(bytes) = fs::read(state) else {
            return BTreeSet::new();
        };
        let Ok(state) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            return BTreeSet::new();
        };
        state["resources"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|resource| resource["instances"].as_array().into_iter().flatten())
            .filter_map(|instance| instance["attributes"]["id"].as_str().map(str::to_owned))
            .collect()
    }

    /// Ends OpenTofu, which holds `state` open while it applies, with the
    /// providers in its process group, at once: as a crash or an out-of-memory
    /// kill would, without the interrupt that lets OpenTofu save its state first.
    fn kill_opentofu(state: &Path) {
        let found = Command::new("lsof").arg("-t").arg(state).output().unwrap();
        let pid = String::from_utf8(found.stdout).unwrap();
        let pid = pid.trim();
        assert!(
            !pid.is_empty() && !pid.contains('\n'),
            "expected one process holding {}, found {pid:?}",
            state.display()
        );
        // The SDK starts OpenTofu as the leader of its own process group.
        let killed = Command::new("sh")
            .args(["-c", "kill -s KILL -- \"-$0\"", pid])
            .status()
            .unwrap();
        assert!(
            killed.success(),
            "cannot kill OpenTofu's process group {pid}"
        );
    }

    /// A first apply whose OpenTofu is killed keeps a binding for every gateway
    /// object that OpenTofu saved. During an apply, OpenTofu saves its state when
    /// a resource finishes at least 20 s after the last save (its minimum
    /// `TF_STATE_PERSIST_INTERVAL`). The fixture holds the three sandbox
    /// creations past that interval and then lets one finish; OpenTofu is killed
    /// once it has saved that sandbox, while it waits for the other two.
    ///
    /// Catches a pinned OpenTofu whose saved state in a new state directory holds
    /// only the latest change (opentofu/opentofu#4809, before 1.12.12), which
    /// loses the workspace and provider bindings.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
    async fn a_killed_first_apply_keeps_a_binding_for_every_object_it_saved() {
        let lifecycle = Lifecycle::start(&three_agents().yaml().unwrap()).await;
        let fixture = &lifecycle.fixture;
        fixture.state.lock().unwrap().sandbox_create_permits = Some(0);
        let saved = lifecycle.directory.path().join("terraform.tfstate");
        let sandbox_ids = || -> BTreeSet<String> {
            let state = fixture.state.lock().unwrap();
            state
                .sandboxes
                .values()
                .map(|sandbox| sandbox.metadata.as_ref().unwrap().id.clone())
                .collect()
        };
        let kill = async {
            wait_until("all three sandbox creations are held", || {
                fixture.state.lock().unwrap().active_sandbox_creates == 3
            })
            .await;
            // OpenTofu started the interval when it saved the first created
            // resource, before the sandboxes, which depend on it.
            tokio::time::sleep(Duration::from_secs(21)).await;
            fixture.state.lock().unwrap().sandbox_create_permits = Some(1);
            wait_until("OpenTofu saved a state with the released sandbox", || {
                let created = sandbox_ids();
                !created.is_empty() && bound_ids(&saved).is_superset(&created)
            })
            .await;
            kill_opentofu(&saved);
        };
        let applying = lifecycle
            .deployment
            .apply(&lifecycle.document, &lifecycle.cancel);
        tokio::pin!(applying);
        let result = tokio::select! {
            result = &mut applying => panic!("the apply ended before OpenTofu was killed: {result:?}"),
            () = kill => applying.await,
        };
        assert!(result.is_err(), "the killed apply succeeded");
        assert_eq!(sandbox_ids().len(), 1, "one sandbox creation was released");
        let created: BTreeSet<String> = {
            let state = fixture.state.lock().unwrap();
            let workspaces = state
                .workspaces
                .values()
                .map(|workspace| &workspace.metadata);
            let providers = state.providers.values().map(|provider| &provider.metadata);
            let sandboxes = state.sandboxes.values().map(|sandbox| &sandbox.metadata);
            workspaces
                .chain(providers)
                .chain(sandboxes)
                .map(|metadata| metadata.as_ref().unwrap().id.clone())
                .collect()
        };
        let bound = bound_ids(&saved);
        let unbound: Vec<&String> = created.difference(&bound).collect();
        assert!(
            unbound.is_empty(),
            "the killed first apply lost the bindings of gateway objects {unbound:?}"
        );
    }
}
