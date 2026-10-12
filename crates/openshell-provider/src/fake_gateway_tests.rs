// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The OpenShell backend against the fake gateway, without OpenTofu. Desired
//! rows come from the contract fixtures, converted as OpenTofu sends them.

use super::*;
use nemoclaw_backend::Backend;
use nemoclaw_test_fixtures::openshell::{Fixture, contract_rows as fixture_rows};
use serde_json::Value;
use std::sync::Arc;

fn client(fixture: &Fixture, secrets: Arc<dyn Secrets>) -> OpenShell {
    let connection = nemoclaw_openshell::Connection {
        endpoint: fixture.endpoint.clone(),
        credential_env: None,
        tls: None,
    };
    OpenShell::connect(&connection, secrets).unwrap()
}

/// Create each row and return the bound rows in the same order.
async fn create(client: &OpenShell, rows: &[(&str, Row)]) -> Vec<Row> {
    let mut bound = Vec::new();
    for (kind, row) in rows {
        let result = client.ensure(kind, row).await;
        assert!(result.error().is_none(), "{kind}: {:?}", result.error());
        bound.push(result.into_parts().0.unwrap());
    }
    bound
}

/// The bound sandbox row after creating the fixture's resources.
async fn create_sandbox(client: &OpenShell, name: &str) -> Row {
    let rows = fixture_rows(name);
    let bound = create(client, &rows).await;
    let index = rows
        .iter()
        .position(|(kind, _)| *kind == "sandbox")
        .unwrap();
    bound[index].clone()
}

fn key(row: &Row) -> String {
    format!("{}/{}", row["workspace"], row["name"])
}

/// Substitute the sandbox's id or remove one of its ownership labels.
fn substituted(original: &proto::Sandbox, field: &str) -> proto::Sandbox {
    let mut changed = original.clone();
    let metadata = changed.metadata.as_mut().unwrap();
    match field {
        "id" => metadata.id = "replacement".into(),
        "owner" => {
            metadata.labels.remove(OWNER).unwrap();
        }
        _ => {
            metadata.labels.remove(GENERATION).unwrap();
        }
    }
    changed
}

#[tokio::test]
async fn sandbox_teardown_requires_owned_identity_but_not_its_previous_configuration() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    let binding = create_sandbox(&client, "local").await;
    let key = key(&binding);
    let original = fixture.state.lock().unwrap().sandboxes[&key].clone();
    for field in ["id", "owner", "generation"] {
        fixture
            .state
            .lock()
            .unwrap()
            .sandboxes
            .insert(key.clone(), substituted(&original, field));
        assert!(client.remove("sandbox", &binding, true).await.is_err());
        assert_eq!(fixture.state.lock().unwrap().delete_calls, 0);
    }
    fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .insert(key.clone(), original.clone());
    fixture.state.lock().unwrap().fail_read = Some(("sandbox", tonic::Code::Unauthenticated));
    assert!(client.remove("sandbox", &binding, true).await.is_err());
    assert_eq!(fixture.state.lock().unwrap().delete_calls, 0);
    {
        let mut state = fixture.state.lock().unwrap();
        state.fail_read = None;
        state.sandboxes.get_mut(&key).unwrap().spec = None;
    }
    client.remove("sandbox", &binding, true).await.unwrap();
    assert!(!fixture.state.lock().unwrap().sandboxes.contains_key(&key));
    assert_eq!(fixture.state.lock().unwrap().delete_calls, 1);
    client.remove("sandbox", &binding, true).await.unwrap();
    assert_eq!(fixture.state.lock().unwrap().delete_calls, 1);
    {
        let mut state = fixture.state.lock().unwrap();
        state.sandboxes.insert(key, original);
        state.lose_delete = true;
    }
    let error = client.remove("sandbox", &binding, true).await.unwrap_err();
    assert!(!error.to_string().contains("secret-sentinel"));
    assert_eq!(fixture.state.lock().unwrap().delete_calls, 2);
    client.remove("sandbox", &binding, true).await.unwrap();
    assert_eq!(fixture.state.lock().unwrap().delete_calls, 2);
}

struct Keys;
impl Secrets for Keys {
    fn resolve(&self, _: &str) -> Result<String, ObservationError> {
        Ok("owned-fixture-credential".into())
    }
}

#[tokio::test]
async fn owning_api_reconciles_lost_create_reply_and_checks_conditional_updates() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(Keys));
    let rows = fixture_rows("hermes-auth");
    let [(_, workspace), (_, profile), (_, registration), ..] = rows.as_slice() else {
        panic!("hermes-auth declares a workspace, a profile, and a registration");
    };
    assert!(!registration["credential_env"].is_empty());
    let workspace = client.ensure("workspace", workspace).await;
    assert!(workspace.error().is_none());
    assert!(workspace.state().is_some());
    assert!(
        client
            .ensure("provider_profile", profile)
            .await
            .error()
            .is_none()
    );
    fixture.state.lock().unwrap().lose_create = true;
    let first = client.ensure("provider", registration).await;
    assert!(first.error().is_some());
    let effects = fixture.state.lock().unwrap().effects;
    let recovered = client.ensure("provider", registration).await;
    assert!(recovered.error().is_none());
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    let mut provider = recovered.into_parts().0.unwrap();
    let id = provider["id"].clone();
    let mut changed_endpoint = provider.clone();
    changed_endpoint.insert("endpoint".into(), "https://changed.example/v1".into());
    let effects = fixture.state.lock().unwrap().effects;
    assert!(
        client
            .ensure("provider", &changed_endpoint)
            .await
            .error()
            .is_some()
    );
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    provider.insert("credential_env".into(), "SECOND_KEY".into());
    let updated = client.ensure("provider", &provider).await;
    assert!(updated.error().is_none());
    assert_eq!(updated.into_parts().0.unwrap()["id"], id);
    assert_eq!(fixture.state.lock().unwrap().conditional_updates, 1);
    fixture.state.lock().unwrap().fail_read = Some(("provider", tonic::Code::Unauthenticated));
    let error = client.read("provider", &provider, false).await.unwrap_err();
    assert!(!error.to_string().contains("secret"));
    fixture.state.lock().unwrap().fail_read = None;
    for key in ["id", "owner", "generation"] {
        let mut substituted = provider.clone();
        substituted.insert(key.into(), "foreign".into());
        let effects = fixture.state.lock().unwrap().effects;
        assert!(
            client
                .remove("provider", &substituted, false)
                .await
                .is_err()
        );
        assert_eq!(fixture.state.lock().unwrap().effects, effects);
    }
    fixture.state.lock().unwrap().fail_read = Some(("provider", tonic::Code::Unavailable));
    let effects = fixture.state.lock().unwrap().effects;
    assert!(client.remove("provider", &provider, false).await.is_err());
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    fixture.state.lock().unwrap().fail_read = None;
    fixture.state.lock().unwrap().lose_delete = true;
    assert!(client.remove("provider", &provider, false).await.is_err());
    let effects = fixture.state.lock().unwrap().effects;
    assert!(client.remove("provider", &provider, false).await.is_ok());
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    assert!(
        client
            .remove("workspace", &workspace.into_parts().0.unwrap(), true)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn sandbox_launch_policy_and_provider_identity_survive_read_failures() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    let targets = fixture_rows("local");
    let rows = create(&client, &targets).await;
    let effects = fixture.state.lock().unwrap().effects;
    for ((kind, _), row) in targets.iter().zip(&rows) {
        assert!(client.ensure(kind, row).await.error().is_none());
    }
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    assert_ne!(rows[2]["id"], rows[0]["id"]);
    assert_eq!(
        fixture
            .state
            .lock()
            .unwrap()
            .sandboxes
            .values()
            .next()
            .unwrap()
            .spec
            .as_ref()
            .unwrap()
            .providers,
        [rows[2]["name"].clone()]
    );
    fixture.state.lock().unwrap().fail_read = Some(("policy", tonic::Code::NotFound));
    assert!(client.read("sandbox", &rows[3], false).await.is_err());
    fixture.state.lock().unwrap().fail_read = None;
    let key = key(&rows[3]);
    let command = |push: bool| {
        let mut state = fixture.state.lock().unwrap();
        let command = &mut state
            .sandboxes
            .get_mut(&key)
            .unwrap()
            .spec
            .as_mut()
            .unwrap()
            .command;
        if push {
            command.push("foreign".into());
        } else {
            command.pop();
        }
    };
    command(true);
    assert!(client.read("sandbox", &rows[3], false).await.is_err());
    command(false);
    for i in [3, 2, 1] {
        assert!(client.remove(targets[i].0, &rows[i], true).await.is_ok());
    }
    assert!(
        client
            .read("sandbox", &rows[3], false)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        client
            .read("workspace", &rows[0], false)
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn sandbox_exec_uses_the_bound_workspace_and_rejects_substituted_identity() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    let binding = create_sandbox(&client, "local").await;
    assert_ne!(binding["workspace"], "default");
    let command = vec!["fixture".into()];
    let mut incomplete = binding.clone();
    incomplete.remove("runtime_json");
    assert!(
        client
            .exec_bound(&incomplete, command.clone(), Default::default(), 5)
            .await
            .is_err(),
        "execution requires the retained image runtime binding"
    );
    assert!(fixture.state.lock().unwrap().exec_calls.is_empty());
    assert_eq!(
        client
            .exec_bound(&binding, command.clone(), Default::default(), 5)
            .await
            .unwrap(),
        (0, Vec::new())
    );
    let key = key(&binding);
    let original = fixture.state.lock().unwrap().sandboxes[&key].clone();
    for field in ["id", "owner", "generation"] {
        fixture
            .state
            .lock()
            .unwrap()
            .sandboxes
            .insert(key.clone(), substituted(&original, field));
        assert!(
            client
                .exec_bound(&binding, command.clone(), Default::default(), 5)
                .await
                .is_err()
        );
    }
    assert_eq!(fixture.state.lock().unwrap().exec_calls, vec![command]);
}

#[tokio::test]
async fn sandbox_exec_deadline_bounds_a_stream_that_never_finishes() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    let sandbox = create_sandbox(&client, "local").await;
    fixture.state.lock().unwrap().exec_stalled = true;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        client.exec_bound(&sandbox, vec!["fixture".into()], Default::default(), 1),
    )
    .await;
    assert!(
        result.is_ok(),
        "server accepted the deadline but never completed its stream"
    );
    assert!(result.unwrap().is_err());
}

#[tokio::test]
async fn incomplete_desired_ownership_is_rejected_before_any_create() {
    for missing in ["owner", "generation", "name"] {
        let fixture = Fixture::start().await;
        let client = client(&fixture, Arc::new(EnvironmentSecrets));
        let mut desired: Row = [
            ("name".into(), "workspace".into()),
            ("owner".into(), "owner".into()),
            ("generation".into(), "generation".into()),
        ]
        .into();
        desired.remove(missing);
        assert!(client.ensure("workspace", &desired).await.error().is_some());
        assert_eq!(
            fixture.state.lock().unwrap().effects,
            0,
            "missing {missing} must not leave an unowned resource"
        );
    }
}

#[tokio::test]
async fn failed_readback_retains_each_created_identity_until_explicit_recovery() {
    for failed_kind in ["workspace", "provider_profile", "provider", "sandbox"] {
        let fixture = Fixture::start().await;
        let client = client(&fixture, Arc::new(EnvironmentSecrets));
        for (kind, row) in fixture_rows("local") {
            if kind != failed_kind {
                assert!(client.ensure(kind, &row).await.error().is_none());
                continue;
            }
            fixture.state.lock().unwrap().fail_after_create =
                Some((failed_kind, tonic::Code::Unavailable));
            let created = client.ensure(kind, &row).await;
            assert!(created.error().is_some(), "{failed_kind}");
            let bound = created
                .into_parts()
                .0
                .expect("successful create must retain its identity on failed readback");
            assert!(!bound["id"].is_empty());
            let effects = fixture.state.lock().unwrap().effects;
            assert!(client.ensure(kind, &bound).await.error().is_some());
            assert_eq!(fixture.state.lock().unwrap().effects, effects);
            fixture.state.lock().unwrap().fail_read = None;
            let recovered = client.ensure(kind, &bound).await;
            assert!(
                recovered.error().is_none(),
                "{failed_kind}: {:?}",
                recovered.error()
            );
            assert_eq!(recovered.into_parts().0.unwrap()["id"], bound["id"]);
            assert_eq!(fixture.state.lock().unwrap().effects, effects);
            break;
        }
    }
}

/// The policy the fake images declare.
fn image_policy() -> proto::SandboxPolicy {
    let manifest: Value =
        serde_json::from_str(include_str!("../../../image/fabric/runtime.json")).unwrap();
    let policy: nemoclaw_openshell::policy::ExplicitPolicy =
        serde_json::from_value(manifest["policy"].clone()).unwrap();
    policy.to_proto().unwrap()
}

#[tokio::test]
async fn explicit_policy_reaches_the_gateway_and_detects_drift() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    let sandbox = create_sandbox(&client, "explicit-policy").await;
    let key = key(&sandbox);
    let spec = fixture.state.lock().unwrap().sandboxes[&key]
        .spec
        .clone()
        .unwrap();
    let expected = nemoclaw_openshell::runtime::RuntimeBinding::from_json(&sandbox["runtime_json"])
        .unwrap()
        .policy(&serde_json::from_str(&sandbox["policy_json"]).unwrap())
        .unwrap();
    assert_eq!(
        policy_json(spec.policy.as_ref().unwrap()).unwrap(),
        policy_json(&expected).unwrap()
    );
    assert!(!spec.command.iter().any(|arg| arg.contains("PROXY=")));
    assert!(!spec.environment.keys().any(|key| key.contains("PROXY")));
    let effects = fixture.state.lock().unwrap().effects;
    assert!(client.ensure("sandbox", &sandbox).await.error().is_none());
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    // A loaded revision must match the sandbox specification, not just its status.
    fixture.state.lock().unwrap().active_policy = Some(image_policy());
    assert!(client.read("sandbox", &sandbox, false).await.is_err());
    fixture.state.lock().unwrap().active_policy = None;
    // A coherent but different policy is observed as drift and never overwritten.
    let edit = |change: &dyn Fn(&mut proto::SandboxSpec)| {
        let mut state = fixture.state.lock().unwrap();
        change(
            state
                .sandboxes
                .get_mut(&key)
                .unwrap()
                .spec
                .as_mut()
                .unwrap(),
        );
    };
    edit(&|spec| spec.policy.as_mut().unwrap().network_policies.clear());
    assert!(client.read("sandbox", &sandbox, false).await.is_err());
    assert!(client.ensure("sandbox", &sandbox).await.error().is_some());
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    edit(&|current| *current = spec.clone());
    edit(&|spec| {
        spec.environment
            .insert("NEMOCLAW_PROXY_PORT".into(), "9999".into());
    });
    assert!(client.read("sandbox", &sandbox, false).await.is_err());
    edit(&|current| *current = spec.clone());
    assert!(client.remove("sandbox", &sandbox, false).await.is_err());
    assert!(fixture.state.lock().unwrap().sandboxes.contains_key(&key));
    assert!(client.remove("sandbox", &sandbox, true).await.is_ok());
}

#[tokio::test]
async fn native_provider_union_is_attached_and_attachment_drift_is_rejected() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(Keys));
    let rows = fixture_rows("multiple-providers");
    let desired = rows
        .iter()
        .find(|(kind, row)| {
            *kind == "sandbox"
                && serde_json::from_str::<Vec<String>>(&row["provider_names_json"])
                    .unwrap()
                    .len()
                    == 2
        })
        .map(|(_, row)| row.clone())
        .expect("multiple-providers attaches two providers to one sandbox");
    let registrations: Vec<_> = rows
        .into_iter()
        .filter(|(kind, _)| *kind != "sandbox")
        .collect();
    create(&client, &registrations).await;
    let mutation = client.ensure("sandbox", &desired).await;
    assert!(mutation.error().is_none());
    let row = mutation.into_parts().0.unwrap();
    {
        let mut state = fixture.state.lock().unwrap();
        let sandbox = state
            .sandboxes
            .get_mut(&key(&desired))
            .unwrap()
            .spec
            .as_mut()
            .unwrap();
        assert_eq!(
            sandbox.providers,
            serde_json::from_str::<Vec<String>>(&desired["provider_names_json"]).unwrap()
        );
        sandbox.providers.pop();
    }
    assert!(client.read("sandbox", &row, false).await.is_err());
}
