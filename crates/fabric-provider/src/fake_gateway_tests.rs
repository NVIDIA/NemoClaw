// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The agent bridge and configuration backend against the fake OpenShell
//! gateway, without OpenTofu. Sandboxes come from the openshell provider's
//! contract fixtures.

use crate::{AgentBackend, AgentBridge as _};
use nemoclaw_backend::{Backend, EnvironmentSecrets, ObservationError, Row};
use nemoclaw_test_fixtures::openshell::{Fixture, contract_rows};
use openshell_core::proto;
use openshell_provider::{GENERATION, OWNER, OpenShell};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

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

#[tokio::test]
async fn public_configuration_refresh_verifies_runtime_intent_without_mutation() {
    let fixture = Fixture::start().await;
    let client = client(&fixture);
    // Native startup can lag behind sandbox creation; SDK readiness waits separately.
    fixture.state.lock().unwrap().exec_exit = 2;
    let sandbox = create_sandbox(&client, "fabric-openclaw").await;
    fixture.state.lock().unwrap().exec_exit = 0;
    let mut desired = nemoclaw_fabric::agent::decompose(&serde_json::json!({
        "schema_version": "fabric.agent/v1alpha1",
        "runtime": {},
        "metadata": {"name": "main"},
        "harness": {"adapter_id": "nvidia.fabric.openclaw"},
        "models": {"default": {"provider": "openai", "model": "fixture-model"}},
    }));
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
    fixture.state.lock().unwrap().host_unavailable_checks = 1;
    let fabric = AgentBackend(client.clone());
    let configured = fabric.ensure("agent", &desired).await;
    assert!(configured.error().is_none(), "{:?}", configured.error());
    let binding = configured.into_parts().0.unwrap();
    let configures = |calls: &[Vec<String>]| {
        calls
            .iter()
            .filter(|command| command.get(1).is_some_and(|arg| arg == "configure"))
            .count()
    };
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(
            configures(&state.exec_calls),
            1,
            "only passive observation may be retried during host startup"
        );
        let index = state
            .exec_calls
            .iter()
            .position(|args| args.get(1).is_some_and(|arg| arg == "configure"))
            .unwrap();
        let command = &state.exec_calls[index];
        assert_eq!(
            &command[..4],
            [
                "/usr/local/bin/fabric-agent",
                "configure",
                "--agent",
                "main"
            ]
        );
        assert_eq!(command[4..6], ["--config", "-"]);
        let sent: serde_json::Value = serde_json::from_slice(&state.exec_stdin[index]).unwrap();
        assert_eq!(sent["metadata"]["name"], "main");
        assert_eq!(command[6], "--expected-generation");
        assert_eq!(command[7], "fixture:0");
        assert!(!command.iter().any(|arg| arg.contains("schema_version")));
    }
    fixture.state.lock().unwrap().health_report = Some(
        serde_json::json!({"supported":false,"report":null,"reason_code":"fabric_health_unsupported"}),
    );
    let effects = fixture.state.lock().unwrap().effects;
    let writes = configures(&fixture.state.lock().unwrap().exec_calls);
    fabric
        .read("agent", &binding, false)
        .await
        .unwrap()
        .unwrap();
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.effects, effects);
        assert_eq!(configures(&state.exec_calls), writes);
        assert!(
            state
                .exec_calls
                .iter()
                .any(|command| command.get(1).is_some_and(|arg| arg == "check"))
        );
    }
    fixture.state.lock().unwrap().exec_exit = 2;
    assert!(fabric.read("agent", &binding, false).await.is_err());
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    // An unavailable configuration observation does not prevent owned teardown.
    assert!(
        fabric
            .read("agent", &binding, true)
            .await
            .unwrap()
            .is_some()
    );
    fixture.state.lock().unwrap().exec_exit = 0;
    fabric.remove("agent", &binding, false).await.unwrap();
    {
        let state = fixture.state.lock().unwrap();
        assert!(state.fabric_configurations.is_empty());
        assert!(state.sandboxes.contains_key(&key(&sandbox)));
        assert!(
            state
                .exec_calls
                .iter()
                .any(|args| args.get(1).is_some_and(|arg| arg == "stop"))
        );
    }
    // Repeated removal is safe, and an already absent sandbox needs no bridge.
    fabric.remove("agent", &binding, false).await.unwrap();
    fixture.state.lock().unwrap().sandboxes.clear();
    let calls = fixture.state.lock().unwrap().exec_calls.len();
    fabric.remove("agent", &binding, false).await.unwrap();
    assert_eq!(fixture.state.lock().unwrap().exec_calls.len(), calls);
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
            client.ready(&binding, &CancellationToken::new()),
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
            for configure in [false, true] {
                let error = tokio::time::timeout(std::time::Duration::from_secs(2), async {
                    if configure {
                        client.configure_agent(&binding).await
                    } else {
                        client.ready(&binding, &CancellationToken::new()).await
                    }
                })
                .await
                .expect("a reported configuration rejection must not wait for startup timeout")
                .unwrap_err()
                .into_observation()
                .to_string();
                assert!(error.contains("configuration rejected"), "{error}");
                assert!(error.contains(expected), "{error}");
                assert!(error.contains("resources retained"), "{error}");
                assert!(!error.contains("PRIVATE_SENTINEL"), "{error}");
            }
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
            .ready(&binding, &CancellationToken::new())
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
            .ready(&binding, &CancellationToken::new())
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
