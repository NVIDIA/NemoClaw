// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{CancellationToken, Deployment, config::Document};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

macro_rules! harness_test {
    ($name:ident, $harness:literal) => {
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        #[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
        async fn $name() {
            harness_reconciles_configuration_and_protects_sandbox_identity($harness).await;
        }
    };
}

// Every harness's example compiles, passes the Fabric planner, and exports
// in the SDK's tests. OpenClaw covers the harness-independent checks here,
// and Pi its route roles.
harness_test!(harness_openclaw, "nvidia.fabric.openclaw");
harness_test!(harness_pi, "nvidia.fabric.pi");

async fn harness_reconciles_configuration_and_protects_sandbox_identity(harness: &str) {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    // Keep passive discovery deterministic across apply and export. Connection
    // failures can otherwise vary between transport errors and timeouts.
    let catalog_path = "/v1/models";
    let unexpected = Arc::new(Mutex::new(Vec::new()));
    let seen = unexpected.clone();
    let catalog = nemoclaw_e2e::http_fixture::Fixture::start_tcp(move |request| {
        if request.method == "GET" && request.path == catalog_path {
            Some((503, Vec::new()))
        } else {
            seen.lock()
                .unwrap()
                .push(format!("{} {}", request.method, request.path));
            Some((400, Vec::new()))
        }
    })
    .await;
    document.spec.inference_providers[0].endpoint = format!("{}/v1", catalog.endpoint);
    document.spec.sandboxes[0].harness.as_mut().unwrap().kind = harness.parse().unwrap();
    if harness == "nvidia.fabric.pi" {
        let pi = Document::parse(
            include_str!("../../nemoclaw-sdk/tests/fixtures/config/fabric-pi.yaml").as_bytes(),
        )
        .unwrap();
        document.spec.sandboxes[0]
            .agent
            .inference
            .as_mut()
            .unwrap()
            .routes[0]
            .overrides = pi.spec.sandboxes[0]
            .agent
            .inference
            .as_ref()
            .unwrap()
            .routes[0]
            .overrides
            .clone();
    }
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    fixture.state.lock().unwrap().inference_exit = 1;
    deployment.apply(&document, &cancel).await.unwrap();
    assert_eq!(
        *unexpected.lock().unwrap(),
        Vec::<String>::new(),
        "only the model catalog may be requested"
    );
    assert!(
        !fixture
            .state
            .lock()
            .unwrap()
            .exec_calls
            .iter()
            .flatten()
            .any(|arg| arg.contains("inference-probe")
                || arg.contains("pi-probe")
                || arg == "probe"
                || arg == "--message")
    );
    let state = fs::read(directory.path().join("terraform.tfstate")).unwrap();
    let effects = fixture.state.lock().unwrap().effects;
    assert_eq!(effects, 4);
    let writes = || {
        fixture
            .state
            .lock()
            .unwrap()
            .exec_calls
            .iter()
            .filter(|command| {
                command
                    .get(1)
                    .is_some_and(|arg| matches!(arg.as_str(), "configure" | "prepare" | "invoke"))
            })
            .count()
    };
    let initial_writes = writes();
    assert!(
        deployment
            .apply(&document, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(deployment.export(&cancel).await.unwrap(), document);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    assert_eq!(
        writes(),
        initial_writes,
        "unchanged apply must not rewrite runtime configuration"
    );
    nemoclaw_e2e::assert_same_deployment_state(
        &fs::read(directory.path().join("terraform.tfstate")).unwrap(),
        &state,
    );
    assert!(
        fixture
            .state
            .lock()
            .unwrap()
            .exec_calls
            .iter()
            .all(|command| !command
                .iter()
                .any(|arg| arg == "invoke" || arg == "--message"))
    );
    if harness != "nvidia.fabric.pi" {
        let mut changed_model = document.clone();
        changed_model.spec.sandboxes[0]
            .agent
            .inference
            .as_mut()
            .unwrap()
            .routes[0]
            .overrides
            .model = "another-model".into();
        let sandboxes = fixture.state.lock().unwrap().sandboxes.clone();
        let planned = deployment.plan(&changed_model, &cancel).await.unwrap();
        assert_eq!(planned.changes.len(), 1, "{harness}");
        assert_eq!(
            planned.changes[0].resource,
            "fabric_agent_configuration.assistant"
        );
        assert_eq!(
            writes(),
            initial_writes,
            "plan must not configure {harness}"
        );
        let applied = deployment.apply(&changed_model, &cancel).await.unwrap();
        assert_eq!(applied.changes, planned.changes);
        assert_eq!(writes(), initial_writes + 1);
        assert_eq!(fixture.state.lock().unwrap().sandboxes, sandboxes);
        assert_eq!(fixture.state.lock().unwrap().effects, effects);
        assert_eq!(deployment.export(&cancel).await.unwrap(), changed_model);
        assert!(
            deployment
                .apply(&changed_model, &cancel)
                .await
                .unwrap()
                .changes
                .is_empty()
        );
        assert_eq!(writes(), initial_writes + 1);
        deployment.apply(&document, &cancel).await.unwrap();
    }
    let initial_writes = writes();
    if harness == "nvidia.fabric.pi" {
        let mut changed_model = document.clone();
        changed_model.spec.sandboxes[0]
            .agent
            .inference
            .as_mut()
            .unwrap()
            .routes[0]
            .overrides
            .model = "another-custom-model".into();
        changed_model.spec.sandboxes[0]
            .agent
            .inference
            .as_mut()
            .unwrap()
            .routes[0]
            .overrides
            .settings
            .get_or_insert_with(Default::default)
            .entry("model_metadata".to_owned())
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .unwrap()
            .insert(
                "annotation".into(),
                serde_json::json!("${runtime.value} %{native}"),
            );
        let planned = deployment.plan(&changed_model, &cancel).await.unwrap();
        assert!(planned.changes.iter().any(|change| change.resource
            == format!(
                "fabric_agent_configuration.{}",
                document.spec.sandboxes[0].name
            )));
        assert_eq!(writes(), initial_writes, "plan must not configure Pi");
        let before = fs::read(directory.path().join("terraform.tfstate")).unwrap();
        let state = fixture.state.clone();
        let guarded = Deployment::new(directory.path(), &bundle).with_progress(
            std::sync::Arc::new(move |event| {
                if event == nemoclaw_sdk::Progress::Applying {
                    state.lock().unwrap().driver = Some("podman".into());
                }
            }),
        );
        let error = guarded.apply(&changed_model, &cancel).await.unwrap_err();
        assert!(
            matches!(&error, nemoclaw_sdk::Error::Execution { operation, .. } if operation == "apply"),
            "{error}"
        );
        assert_eq!(
            writes(),
            initial_writes,
            "incompatible gateway must block Pi writes"
        );
        nemoclaw_e2e::assert_same_managed_resources(
            &fs::read(directory.path().join("terraform.tfstate")).unwrap(),
            &before,
        );
        fixture.state.lock().unwrap().driver = None;

        let applied = deployment.apply(&changed_model, &cancel).await.unwrap();
        assert_eq!(
            writes(),
            initial_writes + 1,
            "apply configures Pi exactly once"
        );
        assert!(applied.changes.iter().all(|change| {
            !change
                .actions
                .iter()
                .any(|action| action == "delete" || action == "create")
        }));
        assert_eq!(deployment.export(&cancel).await.unwrap(), changed_model);
        let calls = fixture.state.lock().unwrap().exec_calls.clone();
        let configured = calls
            .iter()
            .rev()
            .find(|command| command.get(1).is_some_and(|arg| arg == "configure"))
            .unwrap();
        assert_eq!(configured[0], "/usr/local/bin/fabric-agent");
        assert!(configured.iter().any(|arg| arg == "--config"));
        let config = fixture
            .state
            .lock()
            .unwrap()
            .fabric_configurations
            .values()
            .next()
            .unwrap()
            .clone();
        assert_eq!(config["schema_version"], "fabric.agent/v1alpha1");
        assert_eq!(config["harness"]["adapter_id"], harness);
        for role in ["primary", "default"] {
            assert_eq!(config["models"][role]["model"], "another-custom-model");
            assert_eq!(
                config["models"][role]["settings"]["model_metadata"]["annotation"],
                "${runtime.value} %{native}"
            );
        }
        assert!(
            !calls
                .iter()
                .any(|command| command.get(1).is_some_and(|arg| arg == "prepare"))
        );
        deployment.apply(&document, &cancel).await.unwrap();
    }
    let effects = fixture.state.lock().unwrap().effects;
    let sandboxes = fixture.state.lock().unwrap().sandboxes.clone();
    let before_writes = writes();
    let mut changed = document.clone();
    changed.spec.sandboxes[0].harness.as_mut().unwrap().kind =
        if harness == "nvidia.fabric.langchain.deepagents" {
            "nvidia.fabric.hermes".parse().unwrap()
        } else {
            "nvidia.fabric.langchain.deepagents".parse().unwrap()
        };
    changed.spec.sandboxes[0].harness.as_mut().unwrap().config = None;
    changed.spec.inference_providers[0].api = None;
    changed.spec.sandboxes[0]
        .agent
        .inference
        .as_mut()
        .unwrap()
        .routes[0]
        .overrides
        .settings = None;
    // An adapter change selects different image-scoped executable grants and
    // provider attachments. It cannot replace the retained sandbox implicitly.
    let state = fs::read(directory.path().join("terraform.tfstate")).unwrap();
    for error in [
        deployment.plan(&changed, &cancel).await.unwrap_err(),
        deployment.apply(&changed, &cancel).await.unwrap_err(),
    ] {
        assert!(
            matches!(&error, nemoclaw_sdk::Error::SandboxChangeRefused { sandbox, action: "replace" } if sandbox == &document.spec.sandboxes[0].name),
            "{error}"
        );
    }
    assert_eq!(writes(), before_writes);
    assert_eq!(fixture.state.lock().unwrap().sandboxes, sandboxes);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    assert_eq!(
        fs::read(directory.path().join("terraform.tfstate")).unwrap(),
        state
    );
    assert_eq!(deployment.export(&cancel).await.unwrap(), document);

    let state = fs::read(directory.path().join("terraform.tfstate")).unwrap();
    let before_writes = writes();
    let mut replacement = document.clone();
    replacement.spec.sandboxes[0].image.ref_ = format!("replacement@sha256:{}", "a".repeat(64));
    assert!(
        deployment.plan(&replacement, &cancel).await.is_err(),
        "{harness} sandbox replacement must be refused during plan"
    );
    assert!(
        deployment.apply(&replacement, &cancel).await.is_err(),
        "{harness} sandbox replacement must be refused during apply"
    );
    assert_eq!(writes(), before_writes);
    assert_eq!(fixture.state.lock().unwrap().sandboxes, sandboxes);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    assert_eq!(
        fs::read(directory.path().join("terraform.tfstate")).unwrap(),
        state
    );
    fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .values_mut()
        .next()
        .unwrap()
        .spec
        .as_mut()
        .unwrap()
        .environment
        .insert("OPENAI_API_KEY".into(), "changed".into());
    assert!(deployment.export(&cancel).await.is_err());
    assert!(deployment.plan(&document, &cancel).await.is_err());
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    assert_eq!(
        fs::read(directory.path().join("terraform.tfstate")).unwrap(),
        state
    );
    // Restore the deliberately corrupted observation before tearing down the original deployment.
    fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .values_mut()
        .next()
        .unwrap()
        .spec
        .as_mut()
        .unwrap()
        .environment = sandboxes
        .values()
        .next()
        .unwrap()
        .spec
        .as_ref()
        .unwrap()
        .environment
        .clone();
    deployment.destroy(&cancel).await.unwrap();
    assert!(fixture.state.lock().unwrap().sandboxes.is_empty());
    assert!(fixture.state.lock().unwrap().providers.is_empty());
    assert_eq!(
        *unexpected.lock().unwrap(),
        Vec::<String>::new(),
        "only the model catalog may be requested"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn missing_runtime_declaration_stops_planning_without_recreation() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    deployment.apply(&document, &cancel).await.unwrap();
    let path = directory.path().join("terraform.tfstate");
    let mut state: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for resource in state["resources"].as_array_mut().unwrap() {
        let field = match resource["type"].as_str().unwrap() {
            "openshell_provider_registration" => "provider_type",
            "openshell_sandbox" => "agent_runtime",
            _ => continue,
        };
        resource["instances"][0]["attributes"]
            .as_object_mut()
            .unwrap()
            .remove(field);
    }
    fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();
    let before = fs::read(&path).unwrap();
    fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .values_mut()
        .next()
        .unwrap()
        .metadata
        .as_mut()
        .unwrap()
        .labels
        .remove("nemoclaw.nvidia.com/agent-runtime");
    assert!(deployment.plan(&document, &cancel).await.is_err());
    assert!(deployment.apply(&document, &cancel).await.is_err());
    assert!(deployment.export(&cancel).await.is_err());
    assert_eq!(fixture.state.lock().unwrap().effects, 4);
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn failed_configuration_reports_safe_runtime_state_and_recovers_without_recreation() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    deployment.apply(&document, &cancel).await.unwrap();
    let original = fixture.state.lock().unwrap().sandboxes.clone();
    let sandbox_id = original
        .values()
        .next()
        .unwrap()
        .metadata
        .as_ref()
        .unwrap()
        .id
        .clone();
    let effects = fixture.state.lock().unwrap().effects;
    document.spec.sandboxes[0]
        .agent
        .inference
        .as_mut()
        .unwrap()
        .routes[0]
        .overrides
        .model = "changed-model".into();
    fixture.state.lock().unwrap().configuration_error = Some(serde_json::json!({
        "error": {"stage":"start", "code":"lifecycle_adapter_start_failed", "runtime_state":"unavailable", "message":"native-secret-must-not-escape"}
    }));
    let error = deployment
        .apply(&document, &cancel)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("lifecycle_adapter_start_failed"), "{error}");
    assert!(error.contains("sandbox/assistant"), "{error}");
    assert!(error.contains("agent runtime is unavailable"), "{error}");
    assert!(!error.contains("native-secret"), "{error}");
    assert!(
        fixture
            .state
            .lock()
            .unwrap()
            .fabric_stopped
            .contains(&sandbox_id)
    );
    assert_eq!(fixture.state.lock().unwrap().sandboxes, original);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    fixture.state.lock().unwrap().configuration_error = None;
    deployment.apply(&document, &cancel).await.unwrap();
    assert!(
        !fixture
            .state
            .lock()
            .unwrap()
            .fabric_stopped
            .contains(&sandbox_id)
    );
    assert_eq!(fixture.state.lock().unwrap().sandboxes, original);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    assert_eq!(deployment.export(&cancel).await.unwrap(), document);
    deployment.destroy(&cancel).await.unwrap();
}
