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

    // Reading an agent checks its sandbox and leaves the runtime alone.
    let calls = fixture.state.lock().unwrap().exec_calls.len();
    assert_eq!(
        fabric.read("agent", &agent, false).await.unwrap(),
        Some(agent.clone())
    );
    assert_eq!(fixture.state.lock().unwrap().exec_calls.len(), calls);

    let parent = crate::configuration::fabric_binding(sandbox.clone()).unwrap();
    let reply = client
        .invoke_agent(&parent, &runtime_id, &serde_json::json!("hello"))
        .await
        .unwrap();
    assert_eq!(reply["output"]["message"], "hello");

    // A sandbox runs one runtime: another start is refused with guidance.
    let again = fabric.ensure("agent", &desired).await;
    let message = again.error().unwrap().to_string();
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
