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

#[tokio::test]
async fn ready_sandbox_teardown_needs_owned_identity_but_not_active_policy_status() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    let binding = create_sandbox(&client, "local").await;
    let key = key(&binding);
    let original = fixture.state.lock().unwrap().sandboxes[&key].clone();
    fixture.state.lock().unwrap().fail_read = Some(("policy", tonic::Code::Unavailable));
    assert!(client.read("sandbox", &binding, false).await.is_err());
    let observed = client
        .read("sandbox", &binding, true)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(observed, binding);
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
        .insert(key.clone(), original);
    client.remove("sandbox", &binding, true).await.unwrap();
    let state = fixture.state.lock().unwrap();
    assert_eq!(state.delete_calls, 1);
    assert!(!state.sandboxes.contains_key(&key));
}

struct Keys;
impl Secrets for Keys {
    fn resolve(&self, _: &str) -> Result<String, ObservationError> {
        Ok("owned-fixture-credential".into())
    }
}

#[tokio::test]
async fn gateway_validation_rejections_preserve_details_for_credential_free_mutations() {
    const DETAIL: &str = "network endpoint ambiguity validation failed: network policies 'nemoclaw-inference-qwen' endpoint[0] (model.namespace.svc.cluster.local:18888/v1/**) and '_provider_qwen' endpoint[0] (model.namespace.svc.cluster.local:18888/v1/**) overlap on port(s) 18888 with conflicting metadata: allowed_ips=[] vs [\"10.96.189.228/32\"]";
    for (rpc, kind, creating) in [
        ("CreateWorkspace", "workspace", true),
        ("CreateSandbox", "sandbox", true),
        ("DeleteProvider", "provider", false),
        ("DeleteProviderProfile", "provider_profile", false),
    ] {
        let fixture = Fixture::start().await;
        let client = client(&fixture, Arc::new(Keys));
        let rows = fixture_rows("hermes-auth");
        let mut bindings = std::collections::BTreeMap::new();
        for (row_kind, row) in &rows {
            if creating && *row_kind == kind {
                break;
            }
            let result = client.ensure(row_kind, row).await;
            assert!(result.error().is_none(), "{row_kind}: {:?}", result.error());
            bindings.insert(*row_kind, result.into_parts().0.unwrap());
        }
        let effects = fixture.state.lock().unwrap().effects;
        fixture.state.lock().unwrap().reject_rpc =
            Some((rpc, tonic::Code::FailedPrecondition, DETAIL.into()));
        let error = if creating {
            client
                .ensure(
                    kind,
                    &rows
                        .iter()
                        .find(|(row_kind, _)| *row_kind == kind)
                        .unwrap()
                        .1,
                )
                .await
                .error()
                .unwrap()
        } else {
            client
                .remove(kind, &bindings[kind], true)
                .await
                .unwrap_err()
        };
        let ObservationError::Rejected {
            operation,
            code,
            detail,
        } = error
        else {
            panic!("missing {rpc} rejection detail: {error}");
        };
        assert_eq!(operation, rpc);
        assert_eq!(code, "FailedPrecondition");
        assert_eq!(detail.as_ref(), DETAIL);
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.rejected_rpcs, [rpc]);
        assert_eq!(state.effects, effects);
    }
}

/// A Kubernetes gateway's sandboxes reach a model server in its cluster by
/// the Service's DNS name, and OpenShell decides which addresses that name
/// may reach. The profile then grants no address, and neither does the
/// sandbox's rule for it. The gateway composes the profile's rule into the
/// sandbox's policy and rejects ambiguous endpoints; composed from what this
/// fake gateway received, the policy has none. An address on one side only is
/// the ambiguity a cluster gateway reported for an earlier address grant.
#[tokio::test]
async fn a_service_name_profile_and_a_sandbox_without_grants_pass_endpoint_ambiguity_checks() {
    const HOST: &str = "qwen.models.svc.cluster.local";
    for name in ["local", "hermes-auth"] {
        let fixture = Fixture::start().await;
        let client = client(&fixture, Arc::new(Keys));
        let mut rows = fixture_rows(name);
        let mut registration = String::new();
        for (kind, row) in &mut rows {
            match *kind {
                "provider_profile" | "provider" => {
                    row.insert("endpoint".into(), format!("http://{HOST}:8000/v1"));
                    if *kind == "provider" {
                        registration = row["name"].clone();
                    }
                }
                "sandbox" => {
                    // The rule the SDK compiles for this endpoint.
                    let mut policy: Value = serde_json::from_str(&row["policy_json"]).unwrap();
                    let rules = policy["managed"].as_array_mut().unwrap();
                    assert_eq!(rules.len(), 1, "{name}");
                    for rule in rules {
                        rule["endpoints"] = serde_json::json!([{
                            "host": HOST, "port": 8000, "path": "/v1/**",
                            "protocol": "rest", "access": "full"
                        }]);
                    }
                    row.insert("policy_json".into(), policy.to_string());
                }
                _ => {}
            }
        }
        create(&client, &rows).await;
        let state = fixture.state.lock().unwrap();
        let [profile] = state.profiles.values().collect::<Vec<_>>()[..] else {
            panic!("{name}: one inference profile");
        };
        let [sandbox] = state.sandboxes.values().collect::<Vec<_>>()[..] else {
            panic!("{name}: one sandbox");
        };
        let policy = sandbox.spec.as_ref().unwrap().policy.clone().unwrap();
        let rule = &policy.network_policies[&profile.id];
        assert_eq!(rule.endpoints.len(), 1, "{name}");
        assert_eq!(profile.endpoints.len(), 1, "{name}");
        for endpoint in [&rule.endpoints[0], &profile.endpoints[0]] {
            assert_eq!((endpoint.host.as_str(), endpoint.port), (HOST, 8000));
            assert!(endpoint.allowed_ips.is_empty(), "{name}");
        }
        let rule_name = openshell_policy::provider_rule_name(&registration);
        let layer = openshell_policy::ProviderPolicyLayer {
            rule: proto::NetworkPolicyRule {
                name: rule_name.clone(),
                endpoints: profile.endpoints.clone(),
                binaries: profile.binaries.clone(),
            },
            rule_name,
        };
        let ambiguities = |policy: &proto::SandboxPolicy| {
            openshell_policy::find_endpoint_ambiguities(
                &openshell_policy::compose_effective_policy(policy, std::slice::from_ref(&layer)),
            )
        };
        assert_eq!(ambiguities(&policy), [], "{name}");
        let mut granted = policy.clone();
        granted
            .network_policies
            .get_mut(&profile.id)
            .unwrap()
            .endpoints[0]
            .allowed_ips = vec!["10.96.189.228/32".into()];
        let [ambiguity] = &ambiguities(&granted)[..] else {
            panic!("{name}: one ambiguity");
        };
        // Either rule may come first: the policy's rules are an unordered map.
        let [conflict] = &ambiguity.conflicts[..] else {
            panic!("{name}: one conflict");
        };
        assert!(
            [
                r#"allowed_ips=["10.96.189.228/32"] vs []"#,
                r#"allowed_ips=[] vs ["10.96.189.228/32"]"#
            ]
            .contains(&conflict.as_str()),
            "{name}: {conflict}"
        );
    }
}

#[tokio::test]
async fn credential_requests_reads_and_exec_keep_backend_rejection_text_private() {
    for rpc in [
        "CreateProvider",
        "UpdateProvider",
        "GetSandbox",
        "ExecSandbox",
    ] {
        let fixture = Fixture::start().await;
        let client = client(&fixture, Arc::new(Keys));
        let rows = fixture_rows("hermes-auth");
        let mut bindings = std::collections::BTreeMap::new();
        for (kind, row) in &rows {
            if rpc == "CreateProvider" && *kind == "provider" {
                break;
            }
            let result = client.ensure(kind, row).await;
            assert!(result.error().is_none(), "{kind}: {:?}", result.error());
            bindings.insert(*kind, result.into_parts().0.unwrap());
        }
        fixture.state.lock().unwrap().reject_rpc = Some((
            rpc,
            tonic::Code::FailedPrecondition,
            "PRIVATE_SENTINEL".into(),
        ));
        let error = match rpc {
            "CreateProvider" => client
                .ensure(
                    "provider",
                    &rows.iter().find(|(kind, _)| *kind == "provider").unwrap().1,
                )
                .await
                .error()
                .unwrap(),
            "UpdateProvider" => {
                let mut provider = bindings["provider"].clone();
                provider.insert("credential_env".into(), "SECOND_KEY".into());
                provider.insert(crate::credential::REGISTER.into(), "true".into());
                client.ensure("provider", &provider).await.error().unwrap()
            }
            "GetSandbox" => client
                .read("sandbox", &bindings["sandbox"], false)
                .await
                .unwrap_err(),
            _ => {
                let error = client
                    .exec_bound(
                        &bindings["sandbox"],
                        vec!["true".into()],
                        Default::default(),
                        5,
                    )
                    .await
                    .unwrap_err();
                let nemoclaw_backend::Error::Observation(error) = error else {
                    panic!("unexpected exec error: {error}");
                };
                error
            }
        };
        assert_eq!(error, ObservationError::Query, "{rpc}");
        assert!(!error.to_string().contains("PRIVATE_SENTINEL"));
        assert_eq!(fixture.state.lock().unwrap().rejected_rpcs, [rpc]);
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
    // A new variable alone sends nothing: the resource asks to register the
    // credential whenever its variable changes.
    provider.insert("credential_env".into(), "SECOND_KEY".into());
    let unregistered = client.ensure("provider", &provider).await;
    assert!(unregistered.error().is_none(), "{:?}", unregistered.error());
    assert_eq!(fixture.state.lock().unwrap().conditional_updates, 0);
    provider.insert(crate::credential::REGISTER.into(), "true".into());
    let updated = client.ensure("provider", &provider).await;
    assert!(updated.error().is_none(), "{:?}", updated.error());
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

/// An update whose exposure the gateway rejects leaves in place the endpoint
/// it would have removed, so a failed apply takes nothing away.
#[tokio::test]
async fn a_rejected_exposure_keeps_the_endpoints_the_update_would_remove() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    let created = create_sandbox(&client, "local").await;
    let with = |services: &str| {
        let mut row = created.clone();
        row.insert(services::FIELD.into(), services.into());
        row
    };
    let writer = with(r#"[{"name":"writer","target_port":7000}]"#);
    let result = client.update("sandbox", &writer, &created).await;
    assert!(result.error().is_none(), "{:?}", result.error());
    let bound = result.into_parts().0.unwrap();
    fixture.state.lock().unwrap().reject_rpc = Some((
        "ExposeService",
        tonic::Code::InvalidArgument,
        "invalid service name".into(),
    ));
    let research = with(r#"[{"name":"Research","target_port":8080}]"#);
    let result = client.update("sandbox", &research, &bound).await;
    assert!(
        matches!(result.error(), Some(ObservationError::Rejected { .. })),
        "{:?}",
        result.error()
    );
    let held: Vec<_> = fixture
        .state
        .lock()
        .unwrap()
        .services
        .keys()
        .map(|(_, _, name)| name.clone())
        .collect();
    assert_eq!(held, ["writer"], "the rejected update removed writer");
}

/// A sandbox in a terminal phase is observed, with the reason it exited, so
/// the plan can replace it; a running sandbox reports no exit.
#[tokio::test]
async fn an_exited_sandbox_is_observed_with_its_exit() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    let sandbox = create_sandbox(&client, "local").await;
    let observed = client
        .read("sandbox", &sandbox, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(observed[crate::EXITED], "");
    {
        let mut state = fixture.state.lock().unwrap();
        let status = state
            .sandboxes
            .get_mut(&key(&sandbox))
            .unwrap()
            .status
            .as_mut()
            .unwrap();
        status.phase = proto::SandboxPhase::Error as i32;
        status.exit_code = Some(1);
        status.conditions = vec![proto::SandboxCondition {
            r#type: "Ready".into(),
            status: "False".into(),
            reason: "ContainerExited".into(),
            message: "secret-bearing backend text".into(),
            ..Default::default()
        }];
    }
    let observed = client
        .read("sandbox", &sandbox, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        observed[crate::EXITED],
        "SANDBOX_PHASE_ERROR, reason ContainerExited, exit code 1"
    );
    // Teardown still observes the sandbox so it can delete it.
    assert!(
        client
            .read("sandbox", &sandbox, true)
            .await
            .unwrap()
            .is_some()
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
    incomplete.remove("launch_json");
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

/// What APF's admission interceptor does to a sandbox it governs: replace its
/// policy with the bundle's and record the bundle's provenance.
fn apf_admission(provenance: bool) -> Arc<dyn Fn(&mut proto::Sandbox) + Send + Sync> {
    Arc::new(move |sandbox: &mut proto::Sandbox| {
        let policy = sandbox.spec.as_mut().unwrap().policy.as_mut().unwrap();
        policy.network_policies.insert(
            "apf-bundle".into(),
            proto::NetworkPolicyRule {
                name: "apf-bundle".into(),
                endpoints: vec![proto::NetworkEndpoint {
                    host: "policy.example".into(),
                    port: 443,
                    ..Default::default()
                }],
                ..Default::default()
            },
        );
        if provenance {
            let annotations = &mut sandbox.metadata.as_mut().unwrap().annotations;
            for (key, value) in [
                ("bundle-id", "bundle"),
                ("signer-identity", "signer"),
                ("document-digest", "digest"),
                ("policy-version", "10"),
                ("provenance-token", "token"),
            ] {
                annotations.insert(format!("apf.nvidia.com/{key}"), value.into());
            }
        }
    })
}

/// The fixture's rows, with the sandbox APF-governed.
fn apf_rows() -> Vec<(&'static str, Row)> {
    let mut rows = fixture_rows("explicit-policy");
    for (kind, row) in &mut rows {
        if *kind == "sandbox" {
            row.insert(POLICY_AUTHORITY.into(), "apf".into());
        }
    }
    rows
}

#[tokio::test]
async fn an_apf_governed_sandbox_keeps_the_policy_apf_admitted() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    // Without APF's provenance, a replaced policy is not APF's.
    fixture.state.lock().unwrap().sandbox_admission = Some(apf_admission(false));
    let (sandbox, others): (Vec<_>, Vec<_>) = apf_rows()
        .into_iter()
        .partition(|(kind, _)| *kind == "sandbox");
    create(&client, &others).await;
    assert!(
        client
            .ensure("sandbox", &sandbox[0].1)
            .await
            .error()
            .is_some()
    );
    fixture.state.lock().unwrap().sandboxes.clear();
    // With it, the sandbox binds and records the loaded policy's hash.
    let (recorded, _) = apf_sandbox(&fixture, &client).await;
    assert_eq!(recorded[POLICY_AUTHORITY], "apf");
    assert_eq!(recorded[POLICY_PROVENANCE], "token");
    assert!(client.read("sandbox", &recorded, false).await.is_ok());
}

/// An APF-governed sandbox, bound with its loaded policy recorded, and the key
/// the fake gateway stores it under.
async fn apf_sandbox(fixture: &Fixture, client: &OpenShell) -> (Row, String) {
    let rows = apf_rows();
    fixture.state.lock().unwrap().sandbox_admission = Some(apf_admission(true));
    let sandbox = create(client, &rows)
        .await
        .into_iter()
        .zip(&rows)
        .find(|(_, (kind, _))| *kind == "sandbox")
        .unwrap()
        .0;
    let recorded = client
        .read("sandbox", &sandbox, false)
        .await
        .unwrap()
        .unwrap();
    assert!(!recorded[POLICY_HASH].is_empty());
    let key = format!("{}/{}", recorded["workspace"], recorded["name"]);
    (recorded, key)
}

/// What APF does when it issues its current bundle's policy to a sandbox: a
/// new policy and new provenance.
fn apf_reissue(token: &'static str) -> Arc<dyn Fn(&mut proto::Sandbox) + Send + Sync> {
    Arc::new(move |sandbox: &mut proto::Sandbox| {
        let policy = sandbox.spec.as_mut().unwrap().policy.as_mut().unwrap();
        policy.network_policies.insert(
            "apf-bundle-update".into(),
            proto::NetworkPolicyRule {
                name: "apf-bundle-update".into(),
                endpoints: vec![proto::NetworkEndpoint {
                    host: "update.example".into(),
                    port: 443,
                    ..Default::default()
                }],
                ..Default::default()
            },
        );
        let annotations = &mut sandbox.metadata.as_mut().unwrap().annotations;
        annotations.insert("apf.nvidia.com/provenance-token".into(), token.into());
        annotations.insert("apf.nvidia.com/policy-version".into(), "11".into());
    })
}

/// Load a changed policy into the sandbox as a direct update would, leaving its
/// provenance as it was.
fn change_loaded_policy(fixture: &Fixture, key: &str) {
    let mut changed = fixture.state.lock().unwrap().sandboxes[key]
        .spec
        .clone()
        .unwrap()
        .policy
        .unwrap();
    changed.network_policies.remove("apf-bundle");
    fixture.state.lock().unwrap().active_policy = Some(changed);
}

#[tokio::test]
async fn a_policy_apf_issues_to_a_governed_sandbox_is_adopted() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    let (recorded, key) = apf_sandbox(&fixture, &client).await;
    apf_reissue("token-2")(
        fixture
            .state
            .lock()
            .unwrap()
            .sandboxes
            .get_mut(&key)
            .unwrap(),
    );
    let observed = client
        .read("sandbox", &recorded, false)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(observed[POLICY_HASH], recorded[POLICY_HASH]);
    assert_eq!(observed[POLICY_PROVENANCE], "token-2");
}

#[tokio::test]
async fn a_policy_changed_outside_apf_is_reissued_in_place() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    let (recorded, key) = apf_sandbox(&fixture, &client).await;
    change_loaded_policy(&fixture, &key);
    // The change is not APF's: the observation asks for APF's policy again.
    let observed = client
        .read("sandbox", &recorded, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(observed[POLICY_PROVENANCE], "");
    // The update asks OpenShell for the sandbox's configuration without a
    // policy, so APF issues its bundle's policy to the same sandbox.
    fixture.state.lock().unwrap().config_update = Some(apf_reissue("token-2"));
    let created = fixture.state.lock().unwrap().created_sandboxes.len();
    let mut desired = recorded.clone();
    desired.insert(POLICY_PROVENANCE.into(), String::new());
    let result = client.ensure("sandbox", &desired).await;
    assert!(result.error().is_none(), "{:?}", result.error());
    let reissued = result.into_parts().0.unwrap();
    assert_eq!(reissued["id"], recorded["id"]);
    assert_eq!(reissued[POLICY_PROVENANCE], "token-2");
    assert_ne!(reissued[POLICY_HASH], recorded[POLICY_HASH]);
    let state = fixture.state.lock().unwrap();
    assert_eq!(state.created_sandboxes.len(), created);
    assert_eq!(state.config_updates.len(), 1);
    assert_eq!(state.config_updates[0].sandbox, recorded["name"]);
}

#[tokio::test]
async fn a_policy_changed_outside_apf_stays_unproven_until_apf_issues_it() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    let (recorded, key) = apf_sandbox(&fixture, &client).await;
    change_loaded_policy(&fixture, &key);
    // A refresh records the observation; the next one must not accept the
    // changed policy because it was recorded.
    let refreshed = client
        .read("sandbox", &recorded, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(refreshed[POLICY_HASH], recorded[POLICY_HASH]);
    let observed = client
        .read("sandbox", &refreshed, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(observed[POLICY_PROVENANCE], "");
    assert_eq!(observed[POLICY_HASH], recorded[POLICY_HASH]);
}

/// What OpenTofu plans for a sandbox read back as `observed`: the prior state
/// and the desired row the provider receives, without the values planned
/// unknown.
fn plan_sandbox(observed: &Row) -> (nemoclaw_tofu::State, Row) {
    use tf_provider::value::Value;
    let definition = definitions()
        .into_iter()
        .find(|definition| definition.kind == "sandbox")
        .unwrap();
    let prior: nemoclaw_tofu::State = observed
        .iter()
        .map(|(name, value)| (name.clone(), Value::Value(value.clone())))
        .collect();
    let (planned, _) = nemoclaw_tofu::plan_update(&definition, &prior, prior.clone());
    let desired = planned
        .iter()
        .filter_map(|(name, value)| match value {
            Value::Value(value) => Some((name.clone(), value.clone())),
            _ => None,
        })
        .collect();
    (planned, desired)
}

#[tokio::test]
async fn a_reissue_applies_only_values_its_plan_left_unknown() {
    use tf_provider::value::Value;
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    let (recorded, key) = apf_sandbox(&fixture, &client).await;
    change_loaded_policy(&fixture, &key);
    let observed = client
        .read("sandbox", &recorded, false)
        .await
        .unwrap()
        .unwrap();
    let (planned, desired) = plan_sandbox(&observed);
    // APF's reissue loads a new policy, so its hash is unknown until apply.
    assert_eq!(planned.get(POLICY_HASH), Some(&Value::Unknown));
    fixture.state.lock().unwrap().config_update = Some(apf_reissue("token-2"));
    let result = client.update("sandbox", &desired, &observed).await;
    assert!(result.error().is_none(), "{:?}", result.error());
    let applied = result.into_parts().0.unwrap();
    assert_ne!(applied[POLICY_HASH], recorded[POLICY_HASH]);
    for (name, value) in &planned {
        if let Value::Value(value) = value {
            assert_eq!(applied.get(name), Some(value), "{name}");
        }
    }
}

#[tokio::test]
async fn a_failed_reissue_leaves_the_policy_unproven() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    let (recorded, key) = apf_sandbox(&fixture, &client).await;
    change_loaded_policy(&fixture, &key);
    let observed = client
        .read("sandbox", &recorded, false)
        .await
        .unwrap()
        .unwrap();
    let (_, desired) = plan_sandbox(&observed);
    // The sandbox no longer reads back as the bound one while APF reissues.
    fixture.state.lock().unwrap().config_update = Some(Arc::new(|sandbox: &mut proto::Sandbox| {
        sandbox.metadata.as_mut().unwrap().id = "replaced".into();
    }));
    let (state, error) = client
        .update("sandbox", &desired, &observed)
        .await
        .into_parts();
    assert!(error.is_some());
    let state = state.unwrap();
    assert_eq!(state[POLICY_PROVENANCE], "");
    assert_eq!(state[POLICY_HASH], recorded[POLICY_HASH]);
}

#[tokio::test]
async fn a_governed_sandbox_without_provenance_is_reissued() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    let (recorded, key) = apf_sandbox(&fixture, &client).await;
    fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .get_mut(&key)
        .unwrap()
        .metadata
        .as_mut()
        .unwrap()
        .annotations
        .retain(|key, _| !key.starts_with("apf.nvidia.com/"));
    let observed = client
        .read("sandbox", &recorded, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(observed[POLICY_AUTHORITY], "apf");
    assert_eq!(observed[POLICY_PROVENANCE], "");
}

#[test]
fn a_governed_sandbox_whose_policy_is_not_apfs_plans_an_update() {
    use tf_provider::value::Value;
    let definition = definitions()
        .into_iter()
        .find(|definition| definition.kind == "sandbox")
        .unwrap();
    let state = |authority: &str, provenance: &str| -> nemoclaw_tofu::State {
        [
            (POLICY_AUTHORITY, authority),
            (POLICY_PROVENANCE, provenance),
            (POLICY_HASH, "sha256:recorded"),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), Value::Value(value.to_owned())))
        .collect()
    };
    // APF's reissue loads a new policy, so the plan knows neither its token
    // nor its hash.
    let (planned, replacements) =
        nemoclaw_tofu::plan_update(&definition, &state("apf", ""), state("apf", ""));
    assert_eq!(planned.get(POLICY_PROVENANCE), Some(&Value::Unknown));
    assert_eq!(planned.get(POLICY_HASH), Some(&Value::Unknown));
    assert!(replacements.is_empty());
    for (authority, provenance) in [("apf", "token"), ("", "")] {
        let (planned, _) = nemoclaw_tofu::plan_update(
            &definition,
            &state(authority, provenance),
            state(authority, provenance),
        );
        assert_eq!(
            planned.get(POLICY_PROVENANCE),
            Some(&Value::Value(provenance.to_owned()))
        );
        assert_eq!(
            planned.get(POLICY_HASH),
            Some(&Value::Value("sha256:recorded".to_owned()))
        );
    }
}

#[tokio::test]
async fn an_apf_governed_inference_resource_adopts_the_profile_apf_serves() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(Keys));
    let row = apf_credential_row(
        &client,
        &[
            ("api", "openai-completions"),
            ("credential_env", "NEMOCLAW_TEST_INFERENCE_KEY"),
        ],
    )
    .await;
    let name = row["name"].clone();
    adopts_the_apf_profile(
        &fixture,
        &client,
        "inference",
        &row,
        (
            &format!("nemoclaw-inference-{name}"),
            &nemoclaw_openshell::profile::inference_key_env(&name),
            &name,
        ),
        &[
            "id",
            "owner",
            "generation",
            "endpoint",
            "binaries_json",
            "credential_env",
        ],
    )
    .await;
}

/// A profile APF's interceptor serves under `id`, whose one credential the
/// sandbox sees in `variable`.
fn apf_served(id: &str, variable: &str, source: &str) -> proto::ProviderProfile {
    proto::ProviderProfile {
        id: id.into(),
        credentials: vec![proto::ProviderProfileCredential {
            name: variable.into(),
            env_vars: vec![variable.into()],
            required: true,
            ..Default::default()
        }],
        binaries: vec![proto::NetworkBinary {
            path: "/usr/local/bin/python3.99".into(),
        }],
        source: source.into(),
        ..Default::default()
    }
}

/// A credential resource's row under APF, after creating its workspace: the
/// fixture's inference registration, its kind-specific fields replaced by
/// `fields`.
async fn apf_credential_row(client: &OpenShell, fields: &[(&str, &str)]) -> Row {
    let rows = fixture_rows("explicit-policy");
    let row = |kind: &str| rows.iter().find(|(k, _)| *k == kind).unwrap().1.clone();
    create(client, &[("workspace", row("workspace"))]).await;
    let mut credential = row("provider");
    for field in [
        "api",
        "credential_source",
        "cluster_source",
        "provider_type",
        "id",
    ] {
        credential.remove(field);
    }
    credential.insert(
        "binaries_json".into(),
        row("provider_profile")["binaries_json"].clone(),
    );
    credential.insert("policy_authority".into(), "apf".into());
    credential.extend(fields.iter().map(|(k, v)| ((*k).into(), (*v).into())));
    credential
}

/// NemoClaw adopts the profile APF serves for a credential resource of `kind`
/// and never imports or deletes one.
async fn adopts_the_apf_profile(
    fixture: &Fixture,
    client: &OpenShell,
    kind: &str,
    row: &Row,
    (profile_id, variable, registration): (&str, &str, &str),
    read_back: &[&str],
) {
    let profile_key = format!("{}/{profile_id}", row["workspace"]);
    let set_profile = |profile: proto::ProviderProfile| {
        fixture
            .state
            .lock()
            .unwrap()
            .profiles
            .insert(profile_key.clone(), profile);
    };
    let fails = || async {
        crate::composite::ensure(client, kind, row)
            .await
            .error()
            .is_some()
    };
    assert!(fails().await, "{kind}: nothing to adopt");
    set_profile(apf_served(profile_id, variable, "user"));
    assert!(fails().await, "{kind}: an imported profile is not APF's");
    set_profile(apf_served(
        profile_id,
        "OTHER_KEY",
        "interceptor/apf-policy-adapter",
    ));
    assert!(
        fails().await,
        "{kind}: the sandbox would not find its credential"
    );
    set_profile(apf_served(
        profile_id,
        variable,
        "interceptor/apf-policy-adapter",
    ));
    let mutation = crate::composite::ensure(client, kind, row).await;
    assert!(mutation.error().is_none(), "{kind}: {:?}", mutation.error());
    let bound = mutation.into_parts().0.unwrap();
    let provider_key = format!("{}/{registration}", row["workspace"]);
    {
        let state = fixture.state.lock().unwrap();
        assert!(
            !state
                .rpcs
                .iter()
                .any(|rpc| rpc.contains("ImportProviderProfiles")),
            "{kind}"
        );
        assert_eq!(state.providers[&provider_key].r#type, profile_id, "{kind}");
        assert!(
            state.providers[&provider_key]
                .credentials
                .contains_key(variable),
            "{kind}"
        );
    }
    let observed = crate::composite::read(client, kind, &bound, false)
        .await
        .unwrap()
        .unwrap();
    for field in read_back {
        assert_eq!(observed[*field], bound[*field], "{kind}: {field}");
    }
    // APF changing the variable is drift NemoClaw reports, not adopts.
    set_profile(apf_served(
        profile_id,
        "OTHER_KEY",
        "interceptor/apf-policy-adapter",
    ));
    assert!(
        crate::composite::read(client, kind, &bound, false)
            .await
            .is_err(),
        "{kind}"
    );
    set_profile(apf_served(
        profile_id,
        variable,
        "interceptor/apf-policy-adapter",
    ));
    crate::composite::remove(client, kind, &bound, false)
        .await
        .unwrap();
    let state = fixture.state.lock().unwrap();
    assert!(!state.providers.contains_key(&provider_key), "{kind}");
    assert!(state.profiles.contains_key(&profile_key), "{kind}");
}

#[tokio::test]
async fn an_apf_governed_api_resource_adopts_the_profile_apf_serves() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(Keys));
    // The profile delivers the key in the chosen variable, or the derived one.
    for (name, sandbox_env, variable) in [
        ("booking", "", "NEMOCLAW_API_BOOKING_KEY"),
        ("flights", "FLIGHTS_KEY", "FLIGHTS_KEY"),
    ] {
        let row = apf_credential_row(
            &client,
            &[
                ("name", name),
                ("endpoints_json", r#"["https://booking.example.com/mcp"]"#),
                ("credential_env", "NEMOCLAW_TEST_BOOKING_KEY"),
                ("sandbox_env", sandbox_env),
                ("auth_style", ""),
                ("header_name", ""),
            ],
        )
        .await;
        // APF's profile sets the endpoint's rules, so neither policy has an effect.
        let mut mcp = row.clone();
        mcp.insert(
            nemoclaw_openshell::api::MCP_POLICY.into(),
            r#"{"rules":[{"allow":{"method":"tools/call","tool":"get_quote"}}]}"#.into(),
        );
        assert!(crate::composite::validate_api(&mcp, &[]).is_err());
        let mut rest = row.clone();
        rest.insert(
            "endpoints_json".into(),
            r#"["https://booking.example.com"]"#.into(),
        );
        rest.insert(
            nemoclaw_openshell::api::REST_POLICY.into(),
            r#"{"rules":[{"allow":{"method":"GET","path":"/quotes"}}]}"#.into(),
        );
        assert!(crate::composite::validate_api(&rest, &[]).is_err());
        adopts_the_apf_profile(
            &fixture,
            &client,
            "api",
            &row,
            (&format!("nemoclaw-api-{name}"), variable, name),
            &[
                "id",
                "owner",
                "generation",
                "endpoints_json",
                "binaries_json",
                "auth_style",
                "header_name",
                "credential_env",
                "sandbox_env",
            ],
        )
        .await;
    }
}

#[tokio::test]
async fn a_sandbox_without_apf_authority_refuses_an_apf_policy() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    fixture.state.lock().unwrap().sandbox_admission = Some(apf_admission(true));
    let rows = fixture_rows("explicit-policy");
    let (sandbox_rows, others): (Vec<_>, Vec<_>) =
        rows.into_iter().partition(|(kind, _)| *kind == "sandbox");
    create(&client, &others).await;
    assert!(
        client
            .ensure("sandbox", &sandbox_rows[0].1)
            .await
            .error()
            .is_some()
    );
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
    let expected = nemoclaw_openshell::runtime::Launch::from_json(&sandbox["launch_json"])
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
    // Once recorded, the loaded policy's hash must not change.
    let recorded = client
        .read("sandbox", &sandbox, false)
        .await
        .unwrap()
        .unwrap();
    assert!(!recorded["policy_hash"].is_empty());
    assert!(client.read("sandbox", &recorded, false).await.is_ok());
    let mut widened = spec.policy.clone().unwrap();
    widened
        .filesystem
        .as_mut()
        .unwrap()
        .read_only
        .push("/opt/extra".into());
    fixture.state.lock().unwrap().active_policy = Some(widened);
    assert!(client.read("sandbox", &recorded, false).await.is_err());
    fixture.state.lock().unwrap().active_policy = None;
    assert!(client.read("sandbox", &recorded, false).await.is_ok());
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
    // A sandbox is replaceable: removing it needs no teardown.
    assert!(client.remove("sandbox", &sandbox, false).await.is_ok());
    assert!(!fixture.state.lock().unwrap().sandboxes.contains_key(&key));
}

/// `bound` with its policy input changed by `edit`.
fn with_policy(bound: &Row, edit: impl FnOnce(&mut Value)) -> Row {
    let mut policy: Value = serde_json::from_str(&bound["policy_json"]).unwrap();
    edit(&mut policy);
    let mut row = bound.clone();
    row.insert("policy_json".into(), policy.to_string());
    row
}

/// The explicit-policy fixture's documentation rule.
fn documentation(policy: &mut Value) -> &mut Value {
    &mut policy["explicit"]["network_policies"]["documentation"]
}

/// What OpenTofu plans when `bound`'s policy input becomes `desired`'s: the
/// planned state, the row the provider then receives, and whether the change
/// replaces the sandbox.
fn plan_policy(bound: &Row, desired: &Row) -> (nemoclaw_tofu::State, Row, bool) {
    use tf_provider::value::Value;
    let definition = definitions()
        .into_iter()
        .find(|definition| definition.kind == "sandbox")
        .unwrap();
    let state = |row: &Row| -> nemoclaw_tofu::State {
        row.iter()
            .map(|(name, value)| (name.clone(), Value::Value(value.clone())))
            .collect()
    };
    let (planned, replacements) =
        nemoclaw_tofu::plan_update(&definition, &state(bound), state(desired));
    let row = planned
        .iter()
        .filter_map(|(name, value)| match value {
            Value::Value(value) => Some((name.clone(), value.clone())),
            _ => None,
        })
        .collect();
    (planned, row, !replacements.is_empty())
}

/// OpenShell changes a running sandbox's network rules and middleware, but
/// applies its filesystem, Landlock, and process settings only when it
/// starts. So a change to the rules, a binding, or a managed grant plans an
/// in-place update whose new revision's hash is unknown, and any other policy
/// change, or one to a policy APF governs, plans a replacement.
#[test]
fn only_network_rule_changes_update_a_sandbox_in_place() {
    let (_, mut bound) = fixture_rows("explicit-policy")
        .into_iter()
        .find(|(kind, _)| *kind == "sandbox")
        .unwrap();
    bound.insert(POLICY_HASH.into(), "sha256:recorded".into());
    let in_place: [fn(&mut Value); 4] = [
        |policy| {
            documentation(policy)["endpoints"][0]["rules"][0]["allow"]["path"] =
                "/reference/**".into()
        },
        |policy| {
            policy["explicit"]["network_policies"]["search"] = serde_json::json!({
                "name": "search",
                "endpoints": [{"host": "search.example.com", "port": 443}],
                "binaries": [{"path": "/usr/bin/curl"}]
            })
        },
        |policy| {
            policy["explicit"]["network_middlewares"] = serde_json::json!({"guard": {
                "middleware": "decision-guard", "order": 10, "config": {"mode": "block"},
                "endpoints": {"include": ["docs.example.com"]}
            }})
        },
        |policy| policy["managed"][0]["endpoints"][0]["path"] = "/v2/**".into(),
    ];
    for edit in in_place {
        let desired = with_policy(&bound, edit);
        let (planned, _, replaced) = plan_policy(&bound, &desired);
        assert!(!replaced, "{}", desired["policy_json"]);
        assert_eq!(
            planned.get(POLICY_HASH),
            Some(&tf_provider::value::Value::Unknown)
        );
    }
    let replacing: [fn(&mut Value); 4] = [
        |policy| {
            policy["explicit"]["filesystem_policy"]["read_write"]
                .as_array_mut()
                .unwrap()
                .push("/data".into())
        },
        |policy| {
            policy["explicit"]["filesystem_policy"]["read_only"]
                .as_array_mut()
                .unwrap()
                .pop();
        },
        |policy| policy["explicit"]["landlock"]["compatibility"] = "hard_requirement".into(),
        |policy| policy["explicit"]["process"]["run_as_user"] = "10002".into(),
    ];
    for edit in replacing {
        let desired = with_policy(&bound, edit);
        assert!(
            plan_policy(&bound, &desired).2,
            "{}",
            desired["policy_json"]
        );
    }
    // APF issues a governed sandbox's policy, so NemoClaw changes none in place.
    let mut governed = bound.clone();
    governed.insert(POLICY_AUTHORITY.into(), "apf".into());
    let desired = with_policy(&governed, in_place[0]);
    assert!(plan_policy(&governed, &desired).2);
}

/// A changed network rule reaches the running sandbox as its next policy
/// revision, which keeps the paths OpenShell added when it started, and the
/// sandbox records the new policy input. The binding keeps the sandbox and
/// records the new revision's hash, the next observation finds it unchanged,
/// a later revision with other rules is drift, and teardown needs only the
/// sandbox's identity.
#[tokio::test]
async fn a_changed_network_rule_updates_the_running_sandbox() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    let bound = create_sandbox(&client, "explicit-policy").await;
    let key = key(&bound);
    let changed = with_policy(&bound, |policy| {
        documentation(policy)["endpoints"][0]["rules"][0]["allow"]["path"] = "/reference/**".into()
    });
    let (_, desired, replaced) = plan_policy(&bound, &changed);
    assert!(!replaced);
    let result = client.update("sandbox", &desired, &bound).await;
    assert!(result.error().is_none(), "{:?}", result.error());
    let updated = result.into_parts().0.unwrap();
    assert_eq!(updated["id"], bound["id"]);
    assert_eq!(updated["policy_json"], changed["policy_json"]);
    assert!(!updated[POLICY_HASH].is_empty());
    assert_ne!(updated[POLICY_HASH], bound[POLICY_HASH]);
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(
            state.created_sandboxes.len(),
            1,
            "the change replaced the sandbox"
        );
        assert_eq!(state.delete_calls, 0);
        let sent = state.config_updates.last().unwrap().policy.clone().unwrap();
        let rule = &sent.network_policies["documentation"].endpoints[0].rules[0];
        assert_eq!(rule.allow.as_ref().unwrap().path, "/reference/**");
        assert!(
            sent.filesystem
                .unwrap()
                .read_only
                .contains(&"/var/log".to_owned()),
            "the revision dropped a path OpenShell added"
        );
        let annotations = &state.sandboxes[&key].metadata.as_ref().unwrap().annotations;
        assert_eq!(annotations[agent::POLICY], changed["policy_json"]);
    }
    assert_eq!(
        client
            .read("sandbox", &updated, false)
            .await
            .unwrap()
            .unwrap(),
        updated
    );
    // Another revision, as `openshell policy set` would store, is drift.
    let external = {
        let mut state = fixture.state.lock().unwrap();
        let id = updated["id"].clone();
        let revisions = state.policy_revisions.get_mut(&id).unwrap();
        let mut revision = revisions.last().unwrap().clone();
        revision.version += 1;
        revision.policy_hash = "fixture:external".into();
        revision.policy.as_mut().unwrap().network_policies.clear();
        revisions.push(revision);
        id
    };
    assert!(matches!(
        client.read("sandbox", &updated, false).await,
        Err(ObservationError::BindingMismatch)
    ));
    // Teardown reads the sandbox's identity, not its policy.
    assert!(
        client
            .read("sandbox", &updated, true)
            .await
            .unwrap()
            .is_some()
    );
    client.remove("sandbox", &updated, true).await.unwrap();
    let state = fixture.state.lock().unwrap();
    assert!(!state.sandboxes.contains_key(&key));
    assert!(state.policy_revisions.contains_key(&external));
}

/// A sandbox that fails to load the changed policy gets the one it ran
/// before back, so the binding stays as recorded, the next observation finds
/// it so, and the next plan proposes the change again.
#[tokio::test]
async fn a_policy_the_sandbox_cannot_load_is_restored() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    let bound = create_sandbox(&client, "explicit-policy").await;
    let changed = with_policy(&bound, |policy| {
        documentation(policy)["endpoints"][0]["rules"][0]["allow"]["path"] = "/reference/**".into()
    });
    let (_, desired, _) = plan_policy(&bound, &changed);
    fixture.state.lock().unwrap().policy_loads = [proto::PolicyStatus::Failed].into();
    let (state, error) = client
        .update("sandbox", &desired, &bound)
        .await
        .into_parts();
    assert!(
        matches!(
            error,
            Some(ObservationError::SandboxConfigurationRejected { .. })
        ),
        "{error:?}"
    );
    let recorded = state.unwrap();
    assert_eq!(recorded, bound);
    {
        let state = fixture.state.lock().unwrap();
        let sent: Vec<_> = state
            .config_updates
            .iter()
            .map(|update| update.annotations[agent::POLICY].clone())
            .collect();
        assert_eq!(
            sent,
            [changed["policy_json"].clone(), bound["policy_json"].clone()]
        );
    }
    assert_eq!(
        client
            .read("sandbox", &recorded, false)
            .await
            .unwrap()
            .unwrap(),
        bound
    );
    assert!(!plan_policy(&recorded, &changed).2);
}

/// An update whose reply is lost after the gateway stored the new policy
/// fails, and OpenTofu keeps the binding as it was. The next observation
/// finds the new policy input and the revision the sandbox loaded for it
/// together, so it records them instead of reporting drift, and the change
/// then plans nothing more.
#[tokio::test]
async fn an_update_whose_reply_was_lost_reads_back_as_applied() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    let bound = create_sandbox(&client, "explicit-policy").await;
    let changed = with_policy(&bound, |policy| {
        documentation(policy)["endpoints"][0]["rules"][0]["allow"]["path"] = "/reference/**".into()
    });
    let (_, desired, _) = plan_policy(&bound, &changed);
    fixture.state.lock().unwrap().lose_policy_update = true;
    let (state, error) = client
        .update("sandbox", &desired, &bound)
        .await
        .into_parts();
    assert!(error.is_some());
    assert!(state.is_none(), "{state:?}");
    let observed = client
        .read("sandbox", &bound, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(observed["id"], bound["id"]);
    assert_eq!(observed["policy_json"], changed["policy_json"]);
    assert!(!observed[POLICY_HASH].is_empty());
    assert_ne!(observed[POLICY_HASH], bound[POLICY_HASH]);
    let (planned, _, replaced) = plan_policy(&observed, &changed);
    assert!(!replaced);
    assert_eq!(
        planned.get(POLICY_HASH),
        Some(&tf_provider::value::Value::Value(
            observed[POLICY_HASH].clone()
        ))
    );
}

/// A sandbox that is still starting when it is created records its loaded
/// policy's hash before the apply returns, so a path added to the policy after
/// the first apply is drift, as it is after the second.
#[tokio::test]
async fn a_new_sandbox_records_its_loaded_policy_before_the_first_apply_returns() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    fixture.state.lock().unwrap().sandbox_phase = Some(proto::SandboxPhase::Starting);
    let state = fixture.state.clone();
    let ready = tokio::spawn(async move {
        while state.lock().unwrap().sandboxes.is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        for sandbox in state.lock().unwrap().sandboxes.values_mut() {
            sandbox.status.as_mut().unwrap().phase = proto::SandboxPhase::Ready as i32;
        }
    });
    let bound = create_sandbox(&client, "explicit-policy").await;
    ready.await.unwrap();
    assert!(!bound["policy_hash"].is_empty(), "{bound:?}");
    // The first plan finds nothing changed.
    let observed = client
        .read("sandbox", &bound, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(observed, bound);
    // OpenShell loads a policy with one more read-only path.
    let mut widened = fixture.state.lock().unwrap().sandboxes[&key(&bound)]
        .spec
        .clone()
        .unwrap()
        .policy
        .unwrap();
    widened
        .filesystem
        .as_mut()
        .unwrap()
        .read_only
        .push("/var/tmp".into());
    fixture.state.lock().unwrap().active_policy = Some(widened);
    assert!(matches!(
        client.read("sandbox", &bound, false).await,
        Err(ObservationError::BindingMismatch)
    ));
}

/// A sandbox that exited, or whose configuration OpenShell rejected, never
/// loads a policy, so creating it doesn't wait; the agent reports why.
#[tokio::test]
async fn a_new_sandbox_that_exits_while_starting_is_not_waited_for() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    {
        let mut state = fixture.state.lock().unwrap();
        state.sandbox_phase = Some(proto::SandboxPhase::Error);
        state.sandbox_conditions = vec![proto::SandboxCondition {
            r#type: "Ready".into(),
            status: "False".into(),
            reason: "ContainerExited".into(),
            ..Default::default()
        }];
    }
    let started = std::time::Instant::now();
    let bound = create_sandbox(&client, "explicit-policy").await;
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    assert!(bound["policy_hash"].is_empty());
}

/// A sandbox that has not loaded its policy by the deadline is observed as it
/// is, as before, rather than failing an apply that the agent's own startup
/// wait would still complete.
#[tokio::test]
async fn a_sandbox_that_is_slow_to_start_is_observed_unrecorded_after_the_deadline() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    let bound = create_sandbox(&client, "explicit-policy").await;
    fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .get_mut(&key(&bound))
        .unwrap()
        .status
        .as_mut()
        .unwrap()
        .phase = proto::SandboxPhase::Starting as i32;
    let patience = std::time::Duration::from_millis(600);
    let started = std::time::Instant::now();
    let observed = client
        .read_back_sandbox(&bound, &bound, false, patience)
        .await
        .unwrap()
        .unwrap();
    assert!(started.elapsed() >= patience);
    assert!(observed["policy_hash"].is_empty());
}

/// The fake gateway, except that asking for a sandbox's phase fails with an
/// infrastructure error a set number of times.
struct PhaseUnavailable {
    inner: Arc<dyn crate::transport::OpenShellGateway>,
    failure: ObservationError,
    failures_left: std::sync::atomic::AtomicUsize,
    checks: std::sync::atomic::AtomicUsize,
}

#[async_trait::async_trait]
impl crate::transport::OpenShellGateway for PhaseUnavailable {
    async fn observe(
        &self,
        kind: &str,
        workspace: &str,
        name: &str,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        self.inner.observe(kind, workspace, name, removing).await
    }
    async fn create(&self, kind: &str, want: &Row) -> Result<String, ObservationError> {
        self.inner.create(kind, want).await
    }
    async fn update_provider(&self, want: &Row, live: &Row) -> Result<(), ObservationError> {
        self.inner.update_provider(want, live).await
    }
    async fn delete_bound_sandbox(&self, want: &Row) -> Result<(), ObservationError> {
        self.inner.delete_bound_sandbox(want).await
    }
    async fn reissue_policy(&self, want: &Row) -> Result<(), ObservationError> {
        self.inner.reissue_policy(want).await
    }
    async fn update_policy(&self, want: &Row) -> Result<proto::SandboxPolicy, ObservationError> {
        self.inner.update_policy(want).await
    }
    async fn set_policy(
        &self,
        row: &Row,
        policy: proto::SandboxPolicy,
    ) -> Result<(), ObservationError> {
        self.inner.set_policy(row, policy).await
    }
    async fn service(
        &self,
        workspace: &str,
        sandbox: &Row,
        name: &str,
    ) -> Result<Option<crate::services::Endpoint>, ObservationError> {
        self.inner.service(workspace, sandbox, name).await
    }
    async fn expose_service(
        &self,
        workspace: &str,
        sandbox: &Row,
        exposure: &crate::services::Exposure,
    ) -> Result<(), ObservationError> {
        self.inner
            .expose_service(workspace, sandbox, exposure)
            .await
    }
    async fn delete_service(
        &self,
        workspace: &str,
        sandbox: &Row,
        name: &str,
    ) -> Result<(), ObservationError> {
        self.inner.delete_service(workspace, sandbox, name).await
    }
    async fn delete(
        &self,
        kind: &str,
        workspace: &str,
        name: &str,
    ) -> Result<(), ObservationError> {
        self.inner.delete(kind, workspace, name).await
    }
    async fn gateway_capabilities(
        &self,
    ) -> Result<nemoclaw_openshell::GatewayCapabilities, ObservationError> {
        self.inner.gateway_capabilities().await
    }
    async fn sandbox_phase(
        &self,
        binding: &Row,
        check_configuration: bool,
    ) -> Result<crate::transport::SandboxPhase, nemoclaw_backend::Error> {
        use std::sync::atomic::Ordering::SeqCst;
        self.checks.fetch_add(1, SeqCst);
        let failing = self
            .failures_left
            .try_update(SeqCst, SeqCst, |left| left.checked_sub(1))
            .is_ok();
        if failing {
            return Err(self.failure.clone().into());
        }
        self.inner.sandbox_phase(binding, check_configuration).await
    }
    async fn exec(
        &self,
        binding: &Row,
        command: Vec<String>,
        environment: Row,
        seconds: u32,
        stdin: Vec<u8>,
    ) -> Result<(i32, Vec<u8>), nemoclaw_backend::Error> {
        self.inner
            .exec(binding, command, environment, seconds, stdin)
            .await
    }
}

fn starting_sandbox_client(
    client: &OpenShell,
    failure: ObservationError,
    failures: usize,
) -> (OpenShell, Arc<PhaseUnavailable>) {
    let gateway = Arc::new(PhaseUnavailable {
        inner: client.gateway.clone(),
        failure,
        failures_left: failures.into(),
        checks: 0.into(),
    });
    (OpenShell::with_gateway(gateway.clone()), gateway)
}

/// A transport or authentication failure while asking for the phase says
/// nothing about the sandbox. Waiting for its policy goes on until the
/// deadline, and the readback then fails, so the sandbox is recorded as partial
/// and never as complete without a policy hash.
#[tokio::test]
async fn a_phase_check_that_keeps_failing_never_records_a_sandbox_as_complete() {
    for failure in [
        ObservationError::Transport,
        ObservationError::Authentication,
    ] {
        let fixture = Fixture::start().await;
        let client = client(&fixture, Arc::new(EnvironmentSecrets));
        let bound = create_sandbox(&client, "explicit-policy").await;
        fixture
            .state
            .lock()
            .unwrap()
            .sandboxes
            .get_mut(&key(&bound))
            .unwrap()
            .status
            .as_mut()
            .unwrap()
            .phase = proto::SandboxPhase::Starting as i32;
        let (flaky, gateway) = starting_sandbox_client(&client, failure.clone(), usize::MAX);
        let patience = std::time::Duration::from_millis(900);
        let started = std::time::Instant::now();
        let result = flaky
            .read_back_sandbox(&bound, &bound, false, patience)
            .await;
        assert_eq!(result, Err(failure));
        assert!(started.elapsed() >= patience);
        // It kept asking, rather than giving up at the first failure.
        assert!(gateway.checks.load(std::sync::atomic::Ordering::SeqCst) > 1);
    }
}

/// A phase check that fails once or twice and then answers lets the wait
/// finish, and the sandbox records the policy it loaded.
#[tokio::test]
async fn a_transient_phase_check_failure_does_not_end_the_wait_for_the_policy() {
    let fixture = Fixture::start().await;
    let client = client(&fixture, Arc::new(EnvironmentSecrets));
    let bound = create_sandbox(&client, "explicit-policy").await;
    let name = key(&bound);
    fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .get_mut(&name)
        .unwrap()
        .status
        .as_mut()
        .unwrap()
        .phase = proto::SandboxPhase::Starting as i32;
    let state = fixture.state.clone();
    let ready = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        state
            .lock()
            .unwrap()
            .sandboxes
            .get_mut(&name)
            .unwrap()
            .status
            .as_mut()
            .unwrap()
            .phase = proto::SandboxPhase::Ready as i32;
    });
    let (flaky, _) = starting_sandbox_client(&client, ObservationError::Transport, 2);
    let observed = flaky
        .read_back_sandbox(&bound, &bound, false, std::time::Duration::from_secs(30))
        .await
        .unwrap()
        .unwrap();
    ready.await.unwrap();
    assert!(!observed["policy_hash"].is_empty(), "{observed:?}");
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

/// The bearer token the gateway from `forwarded` requires.
const FORWARD_TOKEN: &str = "forward-token-sentinel";

/// A forward that supplies a bearer token and TLS files, as `SdkKubernetes`
/// does, to a fixture gateway that requires them.
#[derive(Clone)]
struct Forward {
    endpoint: String,
    token: String,
    tls: [String; 3],
}

#[async_trait::async_trait]
impl KubernetesConnector for Forward {
    async fn open(&self, _: &str) -> Result<KubernetesConnection, ObservationError> {
        Ok(KubernetesConnection {
            endpoint: self.endpoint.clone(),
            token: Some(self.token.clone()),
            tls: Some(self.tls.clone()),
            forward: Box::new(()),
        })
    }
}

impl Forward {
    /// The client a new provider process opens to the gateway through this
    /// forward.
    async fn client(self) -> OpenShell {
        GatewayClient::default()
            .with_kubernetes(Arc::new(self))
            .connect(&GatewayConnection::Kubernetes("{}".into()))
            .await
            .unwrap()
    }
}

/// A fixture gateway that requires mutual TLS and `FORWARD_TOKEN`, and a
/// forward that supplies them. The TLS files are written to `directory`.
async fn forwarded(directory: &std::path::Path) -> (Fixture, Forward) {
    use rcgen::{
        BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
        KeyUsagePurpose,
    };
    use tonic::transport::{Certificate, Identity, ServerTlsConfig};
    let key = KeyPair::generate().unwrap();
    let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign];
    let ca = params.self_signed(&key).unwrap().pem();
    let issuer = Issuer::new(params, key);
    let leaf = |usage| {
        let key = KeyPair::generate().unwrap();
        let mut params = CertificateParams::new(vec!["127.0.0.1".into()]).unwrap();
        params.extended_key_usages = vec![usage];
        (
            params.signed_by(&key, &issuer).unwrap().pem(),
            key.serialize_pem(),
        )
    };
    let (server, server_key) = leaf(ExtendedKeyUsagePurpose::ServerAuth);
    let fixture = Fixture::start_with_tls(Some(
        ServerTlsConfig::new()
            .identity(Identity::from_pem(server, server_key))
            .client_ca_root(Certificate::from_pem(&ca)),
    ))
    .await;
    fixture.state.lock().unwrap().expected_bearer = Some(format!("Bearer {FORWARD_TOKEN}"));
    let (certificate, certificate_key) = leaf(ExtendedKeyUsagePurpose::ClientAuth);
    let tls = [
        ("ca", ca),
        ("tls.crt", certificate),
        ("tls.key", certificate_key),
    ]
    .map(|(name, content)| {
        let path = directory.join(name);
        std::fs::write(&path, content).unwrap();
        path.to_str().unwrap().to_owned()
    });
    let forward = Forward {
        endpoint: fixture.endpoint.clone(),
        token: FORWARD_TOKEN.into(),
        tls,
    };
    (fixture, forward)
}

/// A certificate authority unrelated to the fixture gateway's, and a client
/// certificate it signed, written to `directory` as `[ca, tls.crt, tls.key]`.
fn unrelated_tls(directory: &std::path::Path) -> [String; 3] {
    use rcgen::{
        BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
        KeyUsagePurpose,
    };
    let key = KeyPair::generate().unwrap();
    let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign];
    let ca = params.self_signed(&key).unwrap().pem();
    let issuer = Issuer::new(params, key);
    let key = KeyPair::generate().unwrap();
    let mut params = CertificateParams::new(vec!["127.0.0.1".into()]).unwrap();
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
    let certificate = params.signed_by(&key, &issuer).unwrap().pem();
    [
        ("ca", ca),
        ("tls.crt", certificate),
        ("tls.key", key.serialize_pem()),
    ]
    .map(|(name, content)| {
        let path = directory.join(name);
        std::fs::write(&path, content).unwrap();
        path.to_str().unwrap().to_owned()
    })
}

/// A TLS failure names which side refused which certificate: a CA that did
/// not sign the gateway's certificate, or a client certificate the gateway
/// does not accept. Neither reaches the gateway's API.
#[tokio::test]
async fn a_tls_failure_names_the_refused_certificate() {
    let directory = tempfile::tempdir().unwrap();
    let (fixture, forward) = forwarded(directory.path()).await;
    let unrelated = tempfile::tempdir().unwrap();
    let [other_ca, other_certificate, other_key] = unrelated_tls(unrelated.path());
    let [ca, certificate, key] = forward.tls.clone();
    let rows = fixture_rows("hermes-auth");
    let (_, workspace) = rows.iter().find(|(kind, _)| *kind == "workspace").unwrap();
    // The fixture's certificate names 127.0.0.1, not localhost.
    let elsewhere = forward.endpoint.replace("127.0.0.1", "localhost");
    for (case, endpoint, tls, expected) in [
        (
            "an untrusted server certificate",
            forward.endpoint.clone(),
            [other_ca, certificate.clone(), key.clone()],
            "the gateway's TLS server certificate is not signed by the configured certificate authority",
        ),
        (
            "a server certificate for another host",
            elsewhere,
            [ca.clone(), certificate, key],
            "the gateway's TLS server certificate does not name the endpoint's host",
        ),
        (
            "a refused client certificate",
            forward.endpoint.clone(),
            [ca, other_certificate, other_key],
            "the gateway refused the TLS client certificate",
        ),
    ] {
        let client = Forward {
            endpoint,
            tls,
            ..forward.clone()
        }
        .client()
        .await;
        let error = client.ensure("workspace", workspace).await.error();
        assert_eq!(
            error.as_ref().map(ToString::to_string).as_deref(),
            Some(expected),
            "{case}: {error:?}"
        );
    }
    assert_eq!(fixture.state.lock().unwrap().effects, 0);
}

/// A provider's credential variable through a managed Kubernetes gateway
/// resolves from this process's environment, as it does on a direct
/// connection. The forward holds only the gateway's own credentials.
#[tokio::test]
async fn a_managed_kubernetes_gateway_resolves_provider_credentials_from_the_environment() {
    // Every test process has a non-empty PATH; a test cannot set a variable
    // safely while other tests run.
    let value = std::env::var("PATH").unwrap();
    assert!(!value.is_empty());
    let directory = tempfile::tempdir().unwrap();
    let (fixture, forward) = forwarded(directory.path()).await;
    let client = forward.client().await;
    let mut rows = fixture_rows("hermes-auth");
    let (_, registration) = rows
        .iter_mut()
        .find(|(kind, _)| *kind == "provider")
        .unwrap();
    assert!(!registration["credential_env"].is_empty());
    registration.insert("credential_env".into(), "PATH".into());
    let rows: Vec<_> = rows
        .into_iter()
        .filter(|(kind, _)| *kind != "sandbox")
        .collect();
    create(&client, &rows).await;
    let state = fixture.state.lock().unwrap();
    let [provider] = state.providers.values().collect::<Vec<_>>()[..] else {
        panic!("one provider");
    };
    assert_eq!(provider.credentials.values().collect::<Vec<_>>(), [&value]);
}

/// The forward's names for its token and TLS files are not variables a
/// provider can name: each resolves from the environment, where it is unset,
/// so the provider fails before the gateway sees it.
#[tokio::test]
async fn a_providers_credential_variable_never_resolves_to_the_forwards_credentials() {
    let directory = tempfile::tempdir().unwrap();
    let (fixture, forward) = forwarded(directory.path()).await;
    let client = forward.client().await;
    let rows = fixture_rows("hermes-auth");
    let [(_, workspace), (_, profile), (_, registration), ..] = rows.as_slice() else {
        panic!("hermes-auth declares a workspace, a profile, and a registration");
    };
    create(
        &client,
        &[
            ("workspace", workspace.clone()),
            ("provider_profile", profile.clone()),
        ],
    )
    .await;
    for name in ["token", "ca", "certificate", "key"] {
        assert!(std::env::var_os(name).is_none(), "{name}");
        let mut named = registration.clone();
        named.insert("credential_env".into(), name.into());
        let result = client.ensure("provider", &named).await;
        assert_eq!(
            result.error(),
            Some(ObservationError::Authentication),
            "{name}"
        );
    }
    assert!(fixture.state.lock().unwrap().providers.is_empty());
}

/// A managed gateway that refuses the forward's token refuses every call, so
/// nothing changes, and the provider reports an authentication failure without
/// state. A `GatewayClient` keeps the client it opened for its process's
/// lifetime, so a refreshed token takes effect in the next command's provider
/// process, modeled here by a new one.
#[tokio::test]
async fn a_refused_forward_token_is_an_authentication_failure_without_effects() {
    let directory = tempfile::tempdir().unwrap();
    let (fixture, forward) = forwarded(directory.path()).await;
    fixture.state.lock().unwrap().expected_bearer = Some("Bearer fresh-token-sentinel".into());
    let rows = fixture_rows("hermes-auth");
    let (_, workspace) = rows.iter().find(|(kind, _)| *kind == "workspace").unwrap();
    let stale = Forward {
        token: "stale-token-sentinel".into(),
        ..forward.clone()
    }
    .client()
    .await;
    // An authentication failure carries no gateway text, so it cannot echo
    // the token.
    assert_eq!(
        stale.ensure("workspace", workspace).await.into_parts(),
        (None, Some(ObservationError::Authentication))
    );
    assert_eq!(fixture.state.lock().unwrap().effects, 0);
    let fresh = Forward {
        token: "fresh-token-sentinel".into(),
        ..forward
    }
    .client()
    .await;
    let result = fresh.ensure("workspace", workspace).await;
    assert!(result.error().is_none(), "{:?}", result.error());
    assert_eq!(fixture.state.lock().unwrap().effects, 1);
}
