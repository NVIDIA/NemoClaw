// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{
    backend::Backend,
    compile::{Generations, targets},
    config::Document,
    openshell::{EnvironmentSecrets, OpenShell},
};
use std::sync::Arc;

#[tokio::test]
async fn owning_api_reconciles_lost_create_reply_and_checks_conditional_updates() {
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    struct Keys;
    impl nemoclaw_sdk::openshell::Secrets for Keys {
        fn resolve(&self, _: &str) -> Result<String, nemoclaw_sdk::ObservationError> {
            Ok("owned-fixture-credential".into())
        }
    }
    document.spec.inference_providers[0].endpoint = "https://models.example/v1".into();
    document.spec.inference_providers[0].credential =
        Some(serde_json::from_value(serde_json::json!({"env":"FIRST_KEY"})).unwrap());
    let client = OpenShell::connect(&document.spec.gateway, Arc::new(Keys)).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .into_iter()
        .map(|k| (k.into(), format!("{k}-generation")))
        .collect();
    let targets = targets(&document, &generations).unwrap();
    let workspace = client.ensure("workspace", &targets[0].values).await;
    assert!(workspace.error().is_none());
    assert!(workspace.state().is_some());
    assert!(
        client
            .ensure("provider_profile", &targets[1].values)
            .await
            .error()
            .is_none()
    );
    fixture.state.lock().unwrap().lose_create = true;
    let first = client.ensure("provider", &targets[2].values).await;
    assert!(first.error().is_some());
    let effects = fixture.state.lock().unwrap().effects;
    let recovered = client.ensure("provider", &targets[2].values).await;
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
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let client = OpenShell::connect(&document.spec.gateway, Arc::new(EnvironmentSecrets)).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .into_iter()
        .map(|k| (k.into(), format!("{k}-generation")))
        .collect();
    let targets = targets(&document, &generations).unwrap();
    let mut rows = Vec::new();
    for target in &targets {
        let result = client.ensure(&target.kind, &target.values).await;
        assert!(
            result.error().is_none(),
            "{}: {:?}",
            target.kind,
            result.error()
        );
        rows.push(result.into_parts().0.unwrap());
    }
    let effects = fixture.state.lock().unwrap().effects;
    for (target, row) in targets.iter().zip(&rows) {
        assert!(client.ensure(&target.kind, row).await.error().is_none());
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
        ["local"]
    );
    fixture.state.lock().unwrap().fail_read = Some(("policy", tonic::Code::NotFound));
    assert!(client.read("sandbox", &rows[3], false).await.is_err());
    fixture.state.lock().unwrap().fail_read = None;
    let key = format!("{}/{}", document.workspace(), rows[3]["name"]);
    fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .get_mut(&key)
        .unwrap()
        .spec
        .as_mut()
        .unwrap()
        .command
        .push("foreign".into());
    assert!(client.read("sandbox", &rows[3], false).await.is_err());
    fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .get_mut(&key)
        .unwrap()
        .spec
        .as_mut()
        .unwrap()
        .command
        .pop();
    for i in [3, 2, 1] {
        assert!(
            client
                .remove(&targets[i].kind, &rows[i], true)
                .await
                .is_ok()
        );
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
async fn sandbox_exec_deadline_bounds_a_stream_that_never_finishes() {
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let client = OpenShell::connect(&document.spec.gateway, Arc::new(EnvironmentSecrets)).unwrap();
    let generations = ["workspace", "provider", "sandbox"]
        .into_iter()
        .map(|k| (k.into(), format!("{k}-generation")))
        .collect();
    let mut sandbox = None;
    for target in targets(&document, &generations).unwrap() {
        let result = client.ensure(&target.kind, &target.values).await;
        assert!(result.error().is_none());
        if target.kind == "sandbox" {
            sandbox = result.into_parts().0;
        }
    }
    fixture.state.lock().unwrap().exec_stalled = true;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        client.exec_bound(
            &sandbox.unwrap(),
            vec!["fixture".into()],
            Default::default(),
            1,
        ),
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
        let gateway =
            nemoclaw_sdk::config::Gateway::External(nemoclaw_sdk::config::ExternalGateway {
                endpoint: fixture.endpoint.clone(),
                ..Default::default()
            });
        let client = OpenShell::connect(&gateway, Arc::new(EnvironmentSecrets)).unwrap();
        let mut desired: nemoclaw_sdk::backend::Row = [
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
        let mut document = Document::parse(
            include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
        )
        .unwrap();
        *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
        let client =
            OpenShell::connect(&document.spec.gateway, Arc::new(EnvironmentSecrets)).unwrap();
        let generations = ["workspace", "provider", "sandbox"]
            .into_iter()
            .map(|kind| (kind.into(), format!("{kind}-generation")))
            .collect();
        for target in targets(&document, &generations).unwrap() {
            if target.kind != failed_kind {
                assert!(
                    client
                        .ensure(&target.kind, &target.values)
                        .await
                        .error()
                        .is_none()
                );
                continue;
            }
            fixture.state.lock().unwrap().fail_after_create =
                Some((failed_kind, tonic::Code::Unavailable));
            let created = client.ensure(&target.kind, &target.values).await;
            assert!(created.error().is_some(), "{failed_kind}");
            let bound = created
                .into_parts()
                .0
                .expect("successful create must retain its identity on failed readback");
            assert!(!bound["id"].is_empty());
            let effects = fixture.state.lock().unwrap().effects;
            assert!(client.ensure(&target.kind, &bound).await.error().is_some());
            assert_eq!(fixture.state.lock().unwrap().effects, effects);
            fixture.state.lock().unwrap().fail_read = None;
            let recovered = client.ensure(&target.kind, &bound).await;
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

#[tokio::test]
async fn explicit_policy_and_proxy_reach_the_gateway_and_detect_drift() {
    let fixture = Fixture::start().await;
    let mut document =
        Document::parse(include_bytes!("../../../examples/explicit-policy.yaml").as_slice())
            .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let client = OpenShell::connect(&document.spec.gateway, Arc::new(EnvironmentSecrets)).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), format!("{k}-generation")))
        .into();
    let targets = targets(&document, &generations).unwrap();
    let mut rows = Vec::new();
    for target in &targets {
        let result = client.ensure(&target.kind, &target.values).await;
        assert!(
            result.error().is_none(),
            "{}: {:?}",
            target.kind,
            result.error()
        );
        rows.push(result.into_parts().0.unwrap());
    }
    let sandbox = &rows[3];
    let key = format!("{}/{}", document.workspace(), sandbox["name"]);
    let spec = fixture.state.lock().unwrap().sandboxes[&key]
        .spec
        .clone()
        .unwrap();
    assert_eq!(
        nemoclaw_sdk::openshell::policy_json(spec.policy.as_ref().unwrap()).unwrap(),
        sandbox["policy_json"]
    );
    assert_eq!(spec.command[0], "/usr/bin/env");
    assert!(
        spec.command
            .contains(&"HTTPS_PROXY=http://10.200.0.1:3128".into())
    );
    assert_eq!(spec.environment["NEMOCLAW_PROXY_PORT"], "3128");
    let effects = fixture.state.lock().unwrap().effects;
    assert!(client.ensure("sandbox", sandbox).await.error().is_none());
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    // A loaded revision must match the sandbox specification, not just its status.
    fixture.state.lock().unwrap().active_policy = Some(nemoclaw_sdk::openshell::policy());
    assert!(client.read("sandbox", sandbox, false).await.is_err());
    fixture.state.lock().unwrap().active_policy = None;
    // A coherent but different policy is observed as drift and never overwritten.
    fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .get_mut(&key)
        .unwrap()
        .spec
        .as_mut()
        .unwrap()
        .policy
        .as_mut()
        .unwrap()
        .network_policies
        .clear();
    let observed = client
        .read("sandbox", sandbox, false)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(observed["policy_json"], sandbox["policy_json"]);
    assert!(client.ensure("sandbox", sandbox).await.error().is_some());
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .get_mut(&key)
        .unwrap()
        .spec = Some(spec.clone());
    fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .get_mut(&key)
        .unwrap()
        .spec
        .as_mut()
        .unwrap()
        .environment
        .insert("NEMOCLAW_PROXY_PORT".into(), "9999".into());
    assert!(client.read("sandbox", sandbox, false).await.is_err());
    fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .get_mut(&key)
        .unwrap()
        .spec = Some(spec);
    assert!(client.remove("sandbox", sandbox, false).await.is_err());
    assert!(fixture.state.lock().unwrap().sandboxes.contains_key(&key));
    assert!(client.remove("sandbox", sandbox, true).await.is_ok());
}

#[tokio::test]
async fn agent_policy_refresh_verifies_native_policy_without_mutation() {
    let fixture = Fixture::start().await;
    let mut document =
        Document::parse(include_str!("../../../examples/fabric-openclaw.yaml").as_bytes()).unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    document.spec.sandboxes[0].agent.tools = Some(nemoclaw_sdk::config::AgentTools::ReadOnly {
        allow: [nemoclaw_sdk::config::AllowedTool::Read],
    });
    let client = OpenShell::connect(&document.spec.gateway, Arc::new(EnvironmentSecrets)).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), format!("{k}-generation")))
        .into();
    let targets = targets(&document, &generations).unwrap();
    let mut rows = Vec::new();
    // Native startup can lag behind sandbox creation; SDK readiness waits separately.
    fixture.state.lock().unwrap().exec_exit = 2;
    for target in &targets {
        let result = client.ensure(&target.kind, &target.values).await;
        assert!(result.error().is_none(), "{:?}", result.error());
        rows.push(result.into_parts().0.unwrap());
    }
    fixture.state.lock().unwrap().exec_exit = 0;
    let effects = fixture.state.lock().unwrap().effects;
    client
        .read("sandbox", &rows[3], false)
        .await
        .unwrap()
        .unwrap();
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.effects, effects);
        assert!(
            state
                .exec_calls
                .iter()
                .any(|c| c.iter().any(|a| a == "--inference"))
        );
    }
    fixture.state.lock().unwrap().exec_exit = 2;
    assert!(client.read("sandbox", &rows[3], false).await.is_err());
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    // An unavailable runtime cannot establish its tool restrictions either.
    let key = format!(
        "{}/{}",
        document.workspace(),
        document.spec.sandboxes[0].name
    );
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
        .phase = openshell_core::proto::SandboxPhase::Stopped as i32;
    assert!(client.read("sandbox", &rows[3], false).await.is_err());
    // Broken native configuration must not prevent deliberate teardown.
    assert!(
        client
            .read("sandbox", &rows[3], true)
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn native_provider_union_is_attached_and_attachment_drift_is_rejected() {
    let fixture = Fixture::start().await;
    let mut value: serde_json::Value = serde_json::to_value(
        Document::parse(include_str!("../../../examples/fabric-openclaw.yaml").as_bytes()).unwrap(),
    )
    .unwrap();
    value["spec"]["gateway"]["endpoint"] = serde_json::json!(fixture.endpoint);
    value["spec"]["inferenceProviders"].as_array_mut().unwrap().push(serde_json::json!({"name":"hosted", "provider":"openai", "endpoint":"http://172.20.0.1:19999/v1"}));
    let inference = &mut value["spec"]["sandboxes"][0]["agent"]["inference"];
    inference["default"] = serde_json::json!("primary");
    inference["routes"].as_array_mut().unwrap().push(serde_json::json!({"name":"smart","providerRef":"hosted","overrides":{"model":"smart-model"}}));
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let client = OpenShell::connect(&document.spec.gateway, Arc::new(EnvironmentSecrets)).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let targets = targets(&document, &generations).unwrap();
    for target in targets.iter().filter(|target| target.kind != "sandbox") {
        assert!(
            client
                .ensure(&target.kind, &target.values)
                .await
                .error()
                .is_none()
        );
    }
    let desired = &targets
        .iter()
        .find(|target| target.kind == "sandbox")
        .unwrap()
        .values;
    let mutation = client.ensure("sandbox", desired).await;
    assert!(mutation.error().is_none());
    let row = mutation.into_parts().0.unwrap();
    let key = format!(
        "{}/{}",
        document.workspace(),
        document.spec.sandboxes[0].name
    );
    {
        let mut state = fixture.state.lock().unwrap();
        let sandbox = state
            .sandboxes
            .get_mut(&key)
            .unwrap()
            .spec
            .as_mut()
            .unwrap();
        assert_eq!(sandbox.providers, vec!["local", "hosted"]);
        sandbox.providers.pop();
    }
    assert!(client.read("sandbox", &row, false).await.is_err());
}

#[tokio::test]
async fn terminal_startup_reports_phase_and_exit_without_echoing_backend_text() {
    let fixture = Fixture::start().await;
    let mut document =
        Document::parse(include_str!("../../../examples/fabric-openclaw.yaml").as_bytes()).unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let client = OpenShell::connect(&document.spec.gateway, Arc::new(EnvironmentSecrets)).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), format!("{key}-generation")))
        .into();
    let mut binding = None;
    for target in targets(&document, &generations).unwrap() {
        let result = client.ensure(&target.kind, &target.values).await;
        assert!(result.error().is_none());
        if target.kind == "sandbox" {
            binding = result.into_parts().0;
        }
    }
    let key = format!(
        "{}/{}",
        document.workspace(),
        document.spec.sandboxes[0].name
    );
    for phase in [
        openshell_core::proto::SandboxPhase::Error,
        openshell_core::proto::SandboxPhase::Completed,
    ] {
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
            status.conditions = vec![openshell_core::proto::SandboxCondition {
                reason: "secret-do-not-print".into(),
                message: "secret-do-not-print".into(),
                ..Default::default()
            }];
        }
        let error = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            client.ready(
                binding.as_ref().unwrap(),
                &nemoclaw_sdk::CancellationToken::new(),
            ),
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
