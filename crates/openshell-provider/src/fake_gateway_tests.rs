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

/// The bearer token the forward below supplies.
const FORWARD_TOKEN: &str = "forward-token-sentinel";

/// A forward that supplies a bearer token and TLS files, as `SdkKubernetes`
/// does, to a fixture gateway that requires them.
struct Forward {
    endpoint: String,
    tls: [String; 3],
}

#[async_trait::async_trait]
impl KubernetesConnector for Forward {
    async fn open(&self, _: &str) -> Result<KubernetesConnection, ObservationError> {
        Ok(KubernetesConnection {
            endpoint: self.endpoint.clone(),
            token: Some(FORWARD_TOKEN.into()),
            tls: Some(self.tls.clone()),
            forward: Box::new(()),
        })
    }
}

/// A fixture gateway that requires mutual TLS and the forward's token, and a
/// client that reaches it as a managed Kubernetes gateway. The TLS files are
/// written to `directory`.
async fn forwarded(directory: &std::path::Path) -> (Fixture, OpenShell) {
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
        tls,
    };
    let client = GatewayClient::default()
        .with_kubernetes(Arc::new(forward))
        .connect(&GatewayConnection::Kubernetes("{}".into()))
        .await
        .unwrap();
    (fixture, client)
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
    let (fixture, client) = forwarded(directory.path()).await;
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
    let (fixture, client) = forwarded(directory.path()).await;
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
