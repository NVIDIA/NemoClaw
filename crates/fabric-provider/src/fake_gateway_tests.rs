// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The agent's Fabric bridge client and backend against the fake OpenShell
//! gateway, without OpenTofu. Sandboxes come from the openshell provider's
//! contract fixtures.

use crate::{AgentBackend, AgentBridge as _};
use nemoclaw_backend::{Backend, EnvironmentSecrets, ObservationError, Row};
use nemoclaw_test_fixtures::openshell::{Fixture, contract_rows};
use openshell_core::proto;
use openshell_provider::{GENERATION, OWNER, OpenShell};
use std::sync::Arc;

fn client(fixture: &Fixture) -> OpenShell {
    let connection = nemoclaw_openshell::Connection {
        endpoint: fixture.endpoint.clone(),
        credential_env: None,
        tls: None,
    };
    OpenShell::connect(&connection, Arc::new(EnvironmentSecrets)).unwrap()
}

/// The bound sandbox row after creating the fixture's OpenShell resources.
async fn create_sandbox(client: &OpenShell, name: &str) -> Row {
    let mut sandbox = None;
    for (kind, row) in contract_rows(name) {
        let result = client.ensure(kind, &row).await;
        assert!(result.error().is_none(), "{kind}: {:?}", result.error());
        if kind == "sandbox" {
            sandbox = result.into_parts().0;
        }
    }
    sandbox.unwrap()
}

fn key(row: &Row) -> String {
    format!("{}/{}", row["workspace"], row["name"])
}

fn config() -> serde_json::Value {
    serde_json::json!({
        "schema_version": "fabric.agent/v1alpha1",
        "runtime": {},
        "metadata": {"name": "main"},
        "harness": {"adapter_id": "nvidia.fabric.openclaw"},
        "models": {"default": {"provider": "openai", "model": "fixture-model"}},
    })
}

/// The agent row configuring `sandbox`'s runtime.
fn desired(sandbox: &Row) -> Row {
    let mut desired = nemoclaw_fabric::agent::decompose(&config());
    desired.extend(
        [
            ("workspace", sandbox["workspace"].as_str()),
            ("sandbox", sandbox["name"].as_str()),
            ("owner", sandbox["owner"].as_str()),
            ("generation", sandbox["generation"].as_str()),
            ("sandbox_id", sandbox["id"].as_str()),
        ]
        .map(|(key, value)| (key.to_owned(), value.to_owned())),
    );
    desired
}

/// `agent` as refresh records it, with whether its runtime runs.
fn observed(agent: &Row, running: bool) -> Row {
    let mut row = agent.clone();
    row.insert("running".into(), running.to_string());
    row
}

fn operations(fixture: &Fixture, operation: &str) -> usize {
    fixture
        .state
        .lock()
        .unwrap()
        .exec_calls
        .iter()
        .filter(|command| command.get(1).is_some_and(|arg| arg == operation))
        .count()
}

#[tokio::test]
async fn an_agent_starts_once_its_bridge_serves_and_stops_when_removed() {
    let fixture = Fixture::start().await;
    let client = client(&fixture);
    let sandbox = create_sandbox(&client, "fabric-openclaw").await;
    let desired = desired(&sandbox);
    // Until `fabric-agent-ctl serve` listens, start is asked again.
    fixture.state.lock().unwrap().host_unavailable_starts = 2;
    let fabric = AgentBackend(client.clone());
    let started = fabric.ensure("agent", &desired).await;
    assert!(started.error().is_none(), "{:?}", started.error());
    let agent = started.into_parts().0.unwrap();
    let runtime_id = format!("fixture-runtime-{}", sandbox["id"]);
    assert_eq!(agent["runtime_id"], runtime_id);
    assert_eq!(operations(&fixture, "start"), 3);
    {
        let state = fixture.state.lock().unwrap();
        let command = state.exec_calls.last().unwrap();
        assert_eq!(
            command,
            &[
                "/opt/fabric/bin/fabric-agent-ctl",
                "start",
                "--agent",
                "main",
                "--config",
                "-"
            ]
        );
        let sent: serde_json::Value =
            serde_json::from_slice(state.exec_stdin.last().unwrap()).unwrap();
        assert_eq!(sent["metadata"]["name"], "main");
    }

    let parent = crate::configuration::fabric_binding(sandbox.clone()).unwrap();
    let reply = client
        .invoke_agent(&parent, &runtime_id, &serde_json::json!("hello"))
        .await
        .unwrap();
    assert_eq!(reply["output"]["message"], "hello");

    // Fabric starts another runtime in the same sandbox when asked.
    let again = fabric.ensure("agent", &desired).await;
    assert!(again.error().is_none(), "{:?}", again.error());
    let second = again.into_parts().0.unwrap();
    assert_eq!(second["runtime_id"], format!("{runtime_id}-1"));

    // After a start whose effects are unknown, Fabric refuses another one,
    // and the error says to replace the sandbox.
    fixture.state.lock().unwrap().configuration_error = Some(serde_json::json!({
        "error": {"stage": "start", "code": "start_failed", "message": "harness exited"}
    }));
    assert!(fabric.ensure("agent", &desired).await.error().is_some());
    fixture.state.lock().unwrap().configuration_error = None;
    let refused = fabric.ensure("agent", &desired).await;
    let message = refused.error().unwrap().to_string();
    assert!(message.contains("replace the sandbox"), "{message}");

    fabric.remove("agent", &agent, false).await.unwrap();
    assert_eq!(operations(&fixture, "stop"), 1);
    assert!(
        fixture
            .state
            .lock()
            .unwrap()
            .fabric_stopped
            .contains(&sandbox["id"])
    );
    // A runtime that is already stopped counts as stopped.
    fabric.remove("agent", &agent, false).await.unwrap();
}

#[tokio::test]
async fn reading_an_agent_finds_a_runtime_that_no_longer_runs() {
    let fixture = Fixture::start().await;
    let client = client(&fixture);
    let sandbox = create_sandbox(&client, "fabric-openclaw").await;
    let fabric = AgentBackend(client.clone());
    let started = fabric.ensure("agent", &desired(&sandbox)).await;
    assert!(started.error().is_none(), "{:?}", started.error());
    let agent = started.into_parts().0.unwrap();
    let set_reason = |reason: Option<&str>| {
        fixture.state.lock().unwrap().fabric_check_reason = reason.map(str::to_owned);
    };

    // A runtime that passes its check, an adapter without health checks, and
    // a probe that could not finish all count as running.
    assert_eq!(agent["running"], "true");
    for reason in [None, Some("unsupported_adapter"), Some("probe_timeout")] {
        set_reason(reason);
        assert_eq!(
            fabric.read("agent", &agent, false).await.unwrap(),
            Some(observed(&agent, true)),
            "{reason:?}"
        );
    }
    // Reading only checks: nothing starts, stops, or answers a request.
    assert_eq!(operations(&fixture, "check"), 3);
    assert_eq!(operations(&fixture, "start"), 1);
    assert_eq!(
        operations(&fixture, "stop") + operations(&fixture, "invoke"),
        0
    );

    // A runtime whose adapter reports it unhealthy no longer runs.
    set_reason(Some("harness_exited"));
    let stopped = Some(observed(&agent, false));
    assert_eq!(fabric.read("agent", &agent, false).await.unwrap(), stopped);
    set_reason(None);

    // Nor does a runtime Fabric no longer has.
    let runtimes = std::mem::take(&mut fixture.state.lock().unwrap().fabric_runtimes);
    assert_eq!(fabric.read("agent", &agent, false).await.unwrap(), stopped);
    fixture.state.lock().unwrap().fabric_runtimes = runtimes;

    // Nor one whose sandbox no longer serves its bridge.
    {
        let mut state = fixture.state.lock().unwrap();
        state.exec_exit = 1;
        state.exec_response = Some(
            br#"{"operation":"check","status":"failed","changed":false,"result":null,"error":{"code":"host_unavailable","stage":"transport","message":"m","effects":"none"}}
"#
            .to_vec(),
        );
    }
    assert_eq!(fabric.read("agent", &agent, false).await.unwrap(), stopped);
    {
        let mut state = fixture.state.lock().unwrap();
        state.exec_exit = 0;
        state.exec_response = None;
    }

    // A check Fabric refuses is an error, not a missing runtime.
    {
        let mut state = fixture.state.lock().unwrap();
        state.exec_exit = 1;
        state.exec_response = Some(
            br#"{"operation":"check","status":"failed","changed":false,"result":null,"error":{"code":"wrong_agent","stage":"check","message":"m","effects":"none"}}
"#
            .to_vec(),
        );
    }
    assert!(fabric.read("agent", &agent, false).await.is_err());
    {
        let mut state = fixture.state.lock().unwrap();
        state.exec_exit = 0;
        state.exec_response = None;
    }

    // Removing the agent reads only its sandbox.
    let checks = operations(&fixture, "check");
    assert_eq!(
        fabric.read("agent", &agent, true).await.unwrap(),
        Some(agent.clone())
    );
    assert_eq!(operations(&fixture, "check"), checks);

    // A sandbox that exited took its runtime with it.
    fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .get_mut(&key(&sandbox))
        .unwrap()
        .status
        .as_mut()
        .unwrap()
        .phase = proto::SandboxPhase::Error as i32;
    assert_eq!(fabric.read("agent", &agent, false).await.unwrap(), stopped);
    assert_eq!(operations(&fixture, "check"), checks);
}

#[tokio::test]
async fn an_agent_whose_runtime_stopped_starts_again_in_its_sandbox() {
    let fixture = Fixture::start().await;
    let client = client(&fixture);
    let sandbox = create_sandbox(&client, "fabric-openclaw").await;
    let fabric = AgentBackend(client.clone());
    let agent = fabric
        .ensure("agent", &desired(&sandbox))
        .await
        .into_parts()
        .0
        .unwrap();
    let first = agent["runtime_id"].clone();

    // Updating a running agent, such as for a newer image catalog, keeps its
    // runtime.
    let kept = fabric.ensure("agent", &agent).await.into_parts().0.unwrap();
    assert_eq!(kept, agent);
    assert_eq!(operations(&fixture, "start"), 1);

    // The runtime stops; refresh records it, and the next apply plans the
    // agent's running state anew.
    fixture.state.lock().unwrap().fabric_runtimes.clear();
    let mut planned = fabric.read("agent", &agent, false).await.unwrap().unwrap();
    assert_eq!(planned["running"], "false");
    planned.remove("running");
    let started = fabric.ensure("agent", &planned).await;
    assert!(started.error().is_none(), "{:?}", started.error());
    let restarted = started.into_parts().0.unwrap();
    // Fabric stops the recorded runtime, then starts one in the same sandbox.
    assert_eq!(operations(&fixture, "stop"), 1);
    assert_eq!(operations(&fixture, "start"), 2);
    assert_eq!(restarted["id"], sandbox["id"]);
    assert_eq!(restarted["running"], "true");
    assert_ne!(restarted["runtime_id"], first);
    assert!(
        fixture
            .state
            .lock()
            .unwrap()
            .fabric_runtimes
            .contains_key(&restarted["runtime_id"])
    );
}

#[tokio::test]
async fn removing_an_agent_whose_sandbox_exited_stops_nothing() {
    for phase in [proto::SandboxPhase::Error, proto::SandboxPhase::Completed] {
        let fixture = Fixture::start().await;
        let client = client(&fixture);
        let sandbox = create_sandbox(&client, "fabric-openclaw").await;
        let desired = desired(&sandbox);
        let fabric = AgentBackend(client.clone());
        let started = fabric.ensure("agent", &desired).await;
        assert!(started.error().is_none(), "{:?}", started.error());
        let agent = started.into_parts().0.unwrap();
        // The sandbox exits on its own, taking its runtime with it.
        fixture
            .state
            .lock()
            .unwrap()
            .sandboxes
            .get_mut(&key(&sandbox))
            .unwrap()
            .status
            .as_mut()
            .unwrap()
            .phase = phase as i32;
        fabric.remove("agent", &agent, true).await.unwrap();
        assert_eq!(operations(&fixture, "stop"), 0, "{}", phase.as_str_name());
    }
}

#[tokio::test]
async fn terminal_startup_reports_phase_and_exit_without_echoing_backend_text() {
    let fixture = Fixture::start().await;
    let client = client(&fixture);
    let binding = create_sandbox(&client, "fabric-openclaw").await;
    let key = key(&binding);
    for phase in [proto::SandboxPhase::Error, proto::SandboxPhase::Completed] {
        {
            let mut state = fixture.state.lock().unwrap();
            let status = state
                .sandboxes
                .get_mut(&key)
                .unwrap()
                .status
                .as_mut()
                .unwrap();
            status.phase = phase as i32;
            status.exit_code = Some(1);
            status.conditions = vec![proto::SandboxCondition {
                reason: "secret-do-not-print".into(),
                message: "secret-do-not-print".into(),
                ..Default::default()
            }];
        }
        let error = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            client.start_agent(&binding, &config()),
        )
        .await
        .expect("terminal phases must fail immediately")
        .unwrap_err()
        .to_string();
        assert!(error.contains(phase.as_str_name()), "{error}");
        assert!(error.contains("exit code 1"), "{error}");
        assert!(!error.contains("secret-do-not-print"));
    }
}

#[tokio::test]
async fn rejected_configuration_stops_startup_without_exec_and_preserves_bindings() {
    use proto::{ConfigurationAdmissionState, SandboxConfigurationAdmission, SandboxPhase};
    let fixture = Fixture::start().await;
    let client = client(&fixture);
    let binding = create_sandbox(&client, "local").await;
    let key = key(&binding);
    let effects = fixture.state.lock().unwrap().effects;
    for (message, expected) in [
        (
            "Effective configuration could not be activated; replace the policy or repair attached providers",
            "replace the policy or repair attached providers",
        ),
        (
            "Effective provider configuration is invalid; repair credential bindings, attached providers, or their policy layers",
            "repair credential bindings",
        ),
        ("PRIVATE_SENTINEL", "inspect the sandbox configuration"),
    ] {
        for phase in [SandboxPhase::Starting, SandboxPhase::Ready] {
            {
                let mut state = fixture.state.lock().unwrap();
                let status = state
                    .sandboxes
                    .get_mut(&key)
                    .unwrap()
                    .status
                    .as_mut()
                    .unwrap();
                status.phase = phase as i32;
                status.configuration_admission = Some(SandboxConfigurationAdmission {
                    instance_id: "PRIVATE_SENTINEL".into(),
                    state: ConfigurationAdmissionState::Rejected as i32,
                    error: message.into(),
                    ..Default::default()
                });
            }
            let error = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                client.start_agent(&binding, &config()),
            )
            .await
            .expect("a reported configuration rejection must not wait for startup timeout")
            .unwrap_err()
            .into_observation()
            .to_string();
            assert!(error.contains("configuration rejected"), "{error}");
            assert!(error.contains(expected), "{error}");
            assert!(error.contains("resources retained"), "{error}");
            assert!(!error.contains("PRIVATE_SENTINEL"), "{error}");
            assert_eq!(fixture.state.lock().unwrap().effects, effects);
            assert!(fixture.state.lock().unwrap().exec_calls.is_empty());
        }
    }
    // Identity and access failures take precedence over a rejection reported
    // for a substituted or unreadable sandbox.
    let original = fixture.state.lock().unwrap().sandboxes[&key].clone();
    for field in ["id", "owner", "generation"] {
        let mut changed = original.clone();
        let metadata = changed.metadata.as_mut().unwrap();
        match field {
            "id" => metadata.id = "other".into(),
            "owner" => {
                metadata.labels.insert(OWNER.into(), "other".into());
            }
            _ => {
                metadata.labels.insert(GENERATION.into(), "other".into());
            }
        }
        fixture
            .state
            .lock()
            .unwrap()
            .sandboxes
            .insert(key.clone(), changed);
        let error = client
            .start_agent(&binding, &config())
            .await
            .unwrap_err()
            .into_observation();
        assert_eq!(error, ObservationError::BindingMismatch);
    }
    fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .insert(key.clone(), original);
    for (code, expected) in [
        (
            tonic::Code::Unauthenticated,
            ObservationError::Authentication,
        ),
        (tonic::Code::PermissionDenied, ObservationError::Permission),
        (tonic::Code::Unavailable, ObservationError::Transport),
    ] {
        fixture.state.lock().unwrap().fail_read = Some(("sandbox", code));
        let error = client
            .start_agent(&binding, &config())
            .await
            .unwrap_err()
            .into_observation();
        assert_eq!(error, expected);
    }
    fixture.state.lock().unwrap().fail_read = None;
    // Planning must retain a nonterminal rejected sandbox so attached providers
    // can be repaired, and teardown must remain independent of admission.
    fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .get_mut(&key)
        .unwrap()
        .status
        .as_mut()
        .unwrap()
        .phase = SandboxPhase::Starting as i32;
    assert_eq!(
        client.read("sandbox", &binding, false).await.unwrap(),
        Some(binding.clone())
    );
    client.remove("sandbox", &binding, true).await.unwrap();
    assert_eq!(fixture.state.lock().unwrap().delete_calls, 1);
}
