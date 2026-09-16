// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{CancellationToken, Deployment, Outcome, config::Document};
use std::{fs, path::PathBuf, process::Command};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
async fn sdk_apply_cli_export_sdk_reapply_and_cli_destroy_share_state() {
    lifecycle(include_str!(
        "../../nemoclaw-sdk/tests/fixtures/config/local.yaml"
    ))
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
async fn explicit_network_sdk_apply_cli_export_reapply_and_destroy_preserve_intent() {
    lifecycle(include_str!("../../../examples/explicit-policy.yaml")).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
async fn inference_settings_sdk_apply_export_reapply_and_drift() {
    lifecycle(include_str!("../../../examples/inference-tuning.yaml")).await;
    lifecycle(include_str!("../../../examples/hermes-auth.yaml")).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
async fn multiple_agents_cli_export_reapply_and_policy_drift() {
    let mut document =
        Document::parse(include_str!("../../../examples/fabric-openclaw.yaml").as_bytes()).unwrap();
    let primary = document.spec.sandboxes[0].agents[0].clone();
    for name in ["reader", "reviewer", "auditor"] {
        let mut agent = primary.clone();
        agent.name = name.into();
        agent.tools = Some(nemoclaw_sdk::config::AgentTools::ReadOnly {
            allow: [nemoclaw_sdk::config::AllowedTool::Read],
        });
        document.spec.sandboxes[0].agents.push(agent);
    }
    lifecycle(&document.yaml().unwrap()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
async fn tool_disclosure_cli_export_reapply_and_drift() {
    for mode in [
        nemoclaw_sdk::config::ToolDisclosure::Direct,
        nemoclaw_sdk::config::ToolDisclosure::Progressive,
    ] {
        let mut document =
            Document::parse(include_str!("../../../examples/fabric-openclaw.yaml").as_bytes())
                .unwrap();
        document.spec.sandboxes[0].agents[0].tools =
            Some(nemoclaw_sdk::config::AgentTools::Disclosure { disclosure: mode });
        // Exercise the existing launch-setting drift assertions as well as export/reapply.
        document.spec.inference_providers[0].api =
            Some(nemoclaw_sdk::config::InferenceApi::OpenaiCompletions);
        lifecycle(&document.yaml().unwrap()).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
async fn execution_settings_cli_export_reapply_and_drift() {
    for heartbeat in [None, Some("0m"), Some("30m")] {
        let mut document =
            Document::parse(include_str!("../../../examples/fabric-openclaw.yaml").as_bytes())
                .unwrap();
        document.spec.sandboxes[0].agents[0].execution =
            Some(nemoclaw_sdk::config::AgentExecution {
                timeout_seconds: Some(900),
                heartbeat_every: heartbeat.map(String::from),
            });
        lifecycle(&document.yaml().unwrap()).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
async fn observability_cli_export_reapply_and_drift() {
    let mut document =
        Document::parse(include_str!("../../../examples/fabric-openclaw.yaml").as_bytes()).unwrap();
    document.spec.sandboxes[0].agents[0].observability = Some(
        serde_json::from_value(serde_json::json!({
        "otlp":{"enabled":true,"endpoint":"http://host.openshell.internal:4318",
                "serviceName":"agent ${fixture} %{literal}","sampleRate":0.5}}))
        .unwrap(),
    );
    lifecycle(&document.yaml().unwrap()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
async fn openclaw_interfaces_sdk_lifecycle_preserves_intent_and_rejects_drift() {
    lifecycle(include_str!("../../../examples/openclaw-dashboard.yaml")).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
async fn hermes_interfaces_sdk_export_reapply_and_drift() {
    lifecycle(include_str!("../../../examples/hermes-interfaces.yaml")).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
async fn web_search_cli_export_reapply_and_destroy() {
    let mut document =
        Document::parse(include_str!("../../../examples/fabric-openclaw.yaml").as_bytes()).unwrap();
    document.spec.integrations = serde_json::from_value(serde_json::json!({
        "search":{"kind":"webSearch","provider":"brave","credential":{"env":"SEARCH_KEY"}}
    }))
    .unwrap();
    document.spec.sandboxes[0].agents[0].integration_refs = vec!["search".into()];
    lifecycle(&document.yaml().unwrap()).await;
    document.spec.sandboxes[0].integrations = std::mem::take(&mut document.spec.integrations);
    lifecycle(&document.yaml().unwrap()).await;
    let sandbox = &mut document.spec.sandboxes[0];
    sandbox.agents[0].integration_refs.clear();
    sandbox.agents[0].integrations = std::mem::take(&mut sandbox.integrations);
    lifecycle(&document.yaml().unwrap()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
async fn provider_definitions_export_reapply_and_destroy_in_their_authored_scope() {
    for input in [
        include_str!("../../../examples/fabric-openclaw.yaml"),
        include_str!("../../../examples/hermes-auth.yaml"),
    ] {
        let mut document = Document::parse(input.as_bytes()).unwrap();
        document.spec.sandboxes[0].inference_providers =
            std::mem::take(&mut document.spec.inference_providers);
        document.spec.inference_providers.push(
            serde_json::from_value(serde_json::json!({
                "name":"unused", "provider":"openai", "endpoint":"https://unused.example.test/v1",
                "credential":{"env":"UNUSED_KEY"}
            }))
            .unwrap(),
        );
        lifecycle(&document.yaml().unwrap()).await;
        let sandbox = &mut document.spec.sandboxes[0];
        let provider = sandbox.inference_providers.remove(0);
        let route = &mut sandbox.agents[0].inference.routes[0];
        route.provider_ref = None;
        route.provider = Some(provider);
        lifecycle(&document.yaml().unwrap()).await;
    }
}

async fn lifecycle(input: &str) {
    lifecycle_with_ownership(input, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
async fn optional_management_plan_export_reapply_preserves_resources() {
    lifecycle_with_ownership(include_str!("../../../examples/explicit-policy.yaml"), true).await;
}

async fn lifecycle_with_ownership(input: &str, declare_ownership: bool) {
    let bundle =
        PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").expect("explicit bundle path"));
    assert!(bundle.is_absolute());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(input.as_bytes()).unwrap();
    if let Some(policy) = &mut document.spec.sandboxes[0].network.policy {
        policy
            .explicit
            .network_policies
            .get_mut("documentation")
            .unwrap()
            .endpoints[0]
            .rules
            .as_mut()
            .unwrap()[0]
            .allow
            .path = Some("/docs/${file}/%{literal}".into());
    }
    document.spec.gateway.endpoint = fixture.endpoint.clone();
    let has_search = !document.spec.sandboxes[0]
        .integration_bindings(&document.spec.integrations)
        .unwrap()
        .is_empty();
    struct FixtureSecrets;
    impl nemoclaw_sdk::openshell::Secrets for FixtureSecrets {
        fn resolve(&self, name: &str) -> Result<String, nemoclaw_sdk::ObservationError> {
            assert!(["NOUS_API_KEY", "SEARCH_KEY"].contains(&name));
            Ok("fixture-only-inference-key".into())
        }
    }
    let deployment = Deployment::new(directory.path(), &bundle)
        .with_secrets(std::sync::Arc::new(FixtureSecrets));
    let cancel = CancellationToken::new();
    let planning = deployment.plan(&document, &cancel).await.unwrap();
    assert_eq!(planning.outcome, Outcome::Planned);
    assert_eq!(fixture.state.lock().unwrap().effects, 0);
    fixture.state.lock().unwrap().lose_create = true;
    assert!(deployment.apply(&document, &cancel).await.is_err());
    let record: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.path().join("intent.json")).unwrap()).unwrap();
    assert_eq!(record["pending"], true);
    let mut changed = document.clone();
    changed.spec.sandboxes[0].agents[0].inference.routes[0]
        .overrides
        .model = "changed".into();
    assert!(deployment.apply(&changed, &cancel).await.is_err());
    let applied = deployment.apply(&document, &cancel).await;
    assert!(applied.is_ok(), "{applied:?}");
    let effects = fixture.state.lock().unwrap().effects;
    assert_eq!(effects, if has_search { 6 } else { 4 });
    if declare_ownership {
        document.inference_provider_mut().unwrap().management =
            Some(nemoclaw_sdk::config::Management::External);
        document.spec.sandboxes[0]
            .network
            .proxy
            .as_mut()
            .unwrap()
            .management = Some(nemoclaw_sdk::config::ExternalManagement::External);
        assert!(
            deployment
                .plan(&document, &cancel)
                .await
                .unwrap()
                .changes
                .is_empty()
        );
        assert!(
            deployment
                .apply(&document, &cancel)
                .await
                .unwrap()
                .changes
                .is_empty()
        );
        assert_eq!(fixture.state.lock().unwrap().effects, effects);
    }
    let exported = Command::new(
        bundle
            .join("bin")
            .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
    )
    .args(["export", "--state-dir"])
    .arg(directory.path())
    .output()
    .unwrap();
    assert!(
        exported.status.success(),
        "{}",
        String::from_utf8_lossy(&exported.stderr)
    );
    let exported = Document::parse(exported.stdout.as_slice()).unwrap();
    assert_eq!(exported, document);
    assert!(
        deployment
            .apply(&exported, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    if has_search {
        let state_bytes = fs::read(directory.path().join("terraform.tfstate")).unwrap();
        let key = format!("{}/nemoclaw-brave", document.workspace());
        let profile = fixture.state.lock().unwrap().profiles[&key].clone();
        fixture
            .state
            .lock()
            .unwrap()
            .profiles
            .get_mut(&key)
            .unwrap()
            .endpoints
            .clear();
        assert!(deployment.plan(&document, &cancel).await.is_err());
        assert!(deployment.export(&cancel).await.is_err());
        assert_eq!(
            fs::read(directory.path().join("terraform.tfstate")).unwrap(),
            state_bytes
        );
        fixture.state.lock().unwrap().profiles.insert(key, profile);
        let sandbox_key = format!(
            "{}/{}",
            document.workspace(),
            document.spec.sandboxes[0].name
        );
        fixture
            .state
            .lock()
            .unwrap()
            .sandboxes
            .get_mut(&sandbox_key)
            .unwrap()
            .spec
            .as_mut()
            .unwrap()
            .providers
            .clear();
        assert!(deployment.plan(&document, &cancel).await.is_err());
        assert!(deployment.export(&cancel).await.is_err());
        fixture
            .state
            .lock()
            .unwrap()
            .sandboxes
            .get_mut(&sandbox_key)
            .unwrap()
            .spec
            .as_mut()
            .unwrap()
            .providers = vec!["brave-search".into()];
        assert_eq!(deployment.export(&cancel).await.unwrap(), document);
    }
    if document.spec.sandboxes[0].agents.len() > 1 {
        let state = fs::read(directory.path().join("terraform.tfstate")).unwrap();
        let mut broadened = document.clone();
        broadened.spec.sandboxes[0].agents[1].tools = None;
        assert!(deployment.plan(&broadened, &cancel).await.is_err());
        fixture.state.lock().unwrap().exec_exit = 2;
        assert!(deployment.plan(&document, &cancel).await.is_err());
        assert!(deployment.export(&cancel).await.is_err());
        assert_eq!(fixture.state.lock().unwrap().effects, effects);
        assert_eq!(
            fs::read(directory.path().join("terraform.tfstate")).unwrap(),
            state
        );
        fixture.state.lock().unwrap().exec_exit = 0;
        assert_eq!(deployment.export(&cancel).await.unwrap(), document);
    }
    if document.inference_provider().unwrap().api.is_some()
        || document.spec.sandboxes[0].agents[0].auth.is_some()
        || document.spec.sandboxes[0].agents[0].execution.is_some()
        || document.spec.sandboxes[0].agents[0].observability.is_some()
    {
        let key = format!(
            "{}/{}",
            document.workspace(),
            document.spec.sandboxes[0].name
        );
        let original = fixture.state.lock().unwrap().sandboxes[&key]
            .spec
            .as_ref()
            .unwrap()
            .environment["NEMOCLAW_INFERENCE_CONFIG"]
            .clone();
        assert!(!original.contains("fixture-only-inference-key"));
        assert!(
            fixture
                .state
                .lock()
                .unwrap()
                .exec_calls
                .iter()
                .any(|cmd| cmd.ends_with(&["--inference".into(), original.clone()]))
        );
        let mut changed = document.clone();
        if let Some(execution) = &mut changed.spec.sandboxes[0].agents[0].execution {
            execution.timeout_seconds = Some(1200);
        } else if let Some(observability) = &mut changed.spec.sandboxes[0].agents[0].observability {
            observability.otlp.as_mut().unwrap().sample_rate = 1.into();
        } else {
            changed.inference_provider_mut().unwrap().api = Some(
                if document.inference_provider().unwrap().api
                    == Some(nemoclaw_sdk::config::InferenceApi::OpenaiCompletions)
                {
                    nemoclaw_sdk::config::InferenceApi::OpenaiResponses
                } else {
                    nemoclaw_sdk::config::InferenceApi::OpenaiCompletions
                },
            );
        }
        assert!(deployment.plan(&changed, &cancel).await.is_err());
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
            .remove("NEMOCLAW_INFERENCE_CONFIG");
        assert!(deployment.export(&cancel).await.is_err());
        assert!(deployment.plan(&document, &cancel).await.is_err());
        assert_eq!(fixture.state.lock().unwrap().effects, effects);
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
            .insert("NEMOCLAW_INFERENCE_CONFIG".into(), original);
    }
    if document.spec.sandboxes[0].network.policy.is_some() {
        let mut changed = document.clone();
        changed.spec.sandboxes[0]
            .network
            .proxy
            .as_mut()
            .unwrap()
            .port = 3129;
        assert!(deployment.plan(&changed, &cancel).await.is_err());
        assert_eq!(fixture.state.lock().unwrap().effects, effects);
        let key = format!(
            "{}/{}",
            document.workspace(),
            document.spec.sandboxes[0].name
        );
        let original = fixture.state.lock().unwrap().sandboxes[&key]
            .spec
            .as_ref()
            .unwrap()
            .policy
            .clone();
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
        assert!(deployment.export(&cancel).await.is_err());
        assert!(deployment.plan(&document, &cancel).await.is_err());
        assert_eq!(fixture.state.lock().unwrap().effects, effects);
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
            .policy = original;
    }
    let preview = deployment.plan_destroy(&cancel).await.unwrap();
    assert_eq!(preview.changes.len(), if has_search { 5 } else { 3 });
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    let destroyed = Command::new(
        bundle
            .join("bin")
            .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
    )
    .args(["destroy", "--state-dir"])
    .arg(directory.path())
    .output()
    .unwrap();
    assert!(
        destroyed.status.success(),
        "{}",
        String::from_utf8_lossy(&destroyed.stderr)
    );
    assert!(
        deployment
            .destroy(&cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(fixture.state.lock().unwrap().workspaces.len(), 1);
    assert_eq!(
        deployment
            .apply(&document, &cancel)
            .await
            .unwrap()
            .changes
            .len(),
        if has_search { 5 } else { 3 }
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
async fn readiness_and_observation_failures_retain_bindings_and_recover_without_recreation() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    document.spec.gateway.endpoint = fixture.endpoint.clone();
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    fixture.state.lock().unwrap().exec_exit = 2;
    assert!(deployment.apply(&document, &cancel).await.is_err());
    let state_path = directory.path().join("terraform.tfstate");
    let established = fs::read(&state_path).unwrap();
    let effects = fixture.state.lock().unwrap().effects;
    assert_eq!(effects, 4);
    let intent: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.path().join("intent.json")).unwrap()).unwrap();
    assert_eq!(intent["pending"], false);
    assert_eq!(intent["succeeded"], false);
    fixture.state.lock().unwrap().exec_exit = 0;
    assert!(
        deployment
            .apply(&document, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(fs::read(&state_path).unwrap(), established);
    fixture.state.lock().unwrap().fail_read = Some(("provider", tonic::Code::Unavailable));
    assert!(deployment.export(&cancel).await.is_err());
    assert!(deployment.plan(&document, &cancel).await.is_err());
    assert!(deployment.apply(&document, &cancel).await.is_err());
    assert_eq!(fs::read(&state_path).unwrap(), established);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    fixture.state.lock().unwrap().fail_read = None;
    fixture.state.lock().unwrap().exec_truncated = true;
    assert!(deployment.export(&cancel).await.is_err());
    fixture.state.lock().unwrap().exec_truncated = false;
    assert_eq!(deployment.export(&cancel).await.unwrap(), document);
    fixture.state.lock().unwrap().lose_delete = true;
    assert!(deployment.destroy(&cancel).await.is_err());
    assert!(deployment.apply(&document, &cancel).await.is_err());
    assert_eq!(
        deployment.destroy(&cancel).await.unwrap().outcome,
        Outcome::Destroyed
    );
    assert_eq!(fixture.state.lock().unwrap().workspaces.len(), 1);
    assert!(fixture.state.lock().unwrap().providers.is_empty());
    assert!(fixture.state.lock().unwrap().sandboxes.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
async fn destroy_does_not_require_the_inference_credential_or_rewrite_its_reference() {
    struct Credential;
    impl nemoclaw_sdk::openshell::Secrets for Credential {
        fn resolve(&self, name: &str) -> Result<String, nemoclaw_sdk::ObservationError> {
            assert_eq!(name, "NEMOCLAW_TEST_REMOVED_INFERENCE_KEY");
            Ok("fixture-inference-secret".into())
        }
    }
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    document.spec.gateway.endpoint = fixture.endpoint.clone();
    document.spec.inference_providers[0].endpoint = "https://inference.example.test/v1".into();
    document.spec.inference_providers[0].credential = Some(nemoclaw_sdk::config::Credential {
        env: "NEMOCLAW_TEST_REMOVED_INFERENCE_KEY".into(),
    });
    let cancel = CancellationToken::new();
    Deployment::new(directory.path(), &bundle)
        .with_secrets(std::sync::Arc::new(Credential))
        .apply(&document, &cancel)
        .await
        .unwrap();
    let deployment = Deployment::new(directory.path(), &bundle);
    let effects = fixture.state.lock().unwrap().effects;
    assert_eq!(
        deployment
            .plan_destroy(&cancel)
            .await
            .unwrap()
            .changes
            .len(),
        3
    );
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    assert_eq!(
        deployment.destroy(&cancel).await.unwrap().outcome,
        Outcome::Destroyed
    );
    let record: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.path().join("intent.json")).unwrap()).unwrap();
    assert_eq!(record["document"], serde_json::to_value(&document).unwrap());
    assert!(fixture.state.lock().unwrap().providers.is_empty());
    assert!(fixture.state.lock().unwrap().sandboxes.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
async fn unreachable_remote_inference_fails_the_sandbox_probe_without_recreation() {
    struct Secret;
    impl nemoclaw_sdk::openshell::Secrets for Secret {
        fn resolve(&self, reference: &str) -> Result<String, nemoclaw_sdk::ObservationError> {
            assert_eq!(reference, "MODEL_TOKEN");
            Ok("fixture-remote-model-token".into())
        }
    }
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    document.spec.gateway.endpoint = fixture.endpoint.clone();
    document.spec.inference_providers[0].endpoint = "https://unreachable.invalid/v1".into();
    document.spec.inference_providers[0].credential = Some(nemoclaw_sdk::config::Credential {
        env: "MODEL_TOKEN".into(),
    });
    let deployment =
        Deployment::new(directory.path(), &bundle).with_secrets(std::sync::Arc::new(Secret));
    let cancel = CancellationToken::new();
    fixture.state.lock().unwrap().inference_exit = 1;
    deployment.plan(&document, &cancel).await.unwrap();
    assert_eq!(fixture.state.lock().unwrap().effects, 0);
    assert!(
        fixture.state.lock().unwrap().exec_calls.is_empty(),
        "plan ran an active inference probe"
    );
    let error = deployment.apply(&document, &cancel).await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("inference through the sandbox failed")
    );
    let state_path = directory.path().join("terraform.tfstate");
    let bound = fs::read(&state_path).unwrap();
    assert!(!String::from_utf8_lossy(&bound).contains("fixture-remote-model-token"));
    let effects = fixture.state.lock().unwrap().effects;
    assert_eq!(effects, 4);
    fixture.state.lock().unwrap().inference_exit = 0;
    assert!(
        deployment
            .apply(&document, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(fs::read(&state_path).unwrap(), bound);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    assert_eq!(deployment.export(&cancel).await.unwrap(), document);
    deployment.destroy(&cancel).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE; exercises a slow graceful sandbox stop"]
async fn destroy_waits_for_graceful_sandbox_stop_without_retrying() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    document.spec.gateway.endpoint = fixture.endpoint.clone();
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    deployment.apply(&document, &cancel).await.unwrap();
    fixture.state.lock().unwrap().delete_delay = std::time::Duration::from_secs(31);
    assert_eq!(
        deployment.destroy(&cancel).await.unwrap().outcome,
        Outcome::Destroyed
    );
    let state = fixture.state.lock().unwrap();
    assert!(state.sandboxes.is_empty());
    assert_eq!(state.workspaces.len(), 1); // Destroy retains the owned workspace.
    assert_eq!(state.delete_calls, 1);
}
