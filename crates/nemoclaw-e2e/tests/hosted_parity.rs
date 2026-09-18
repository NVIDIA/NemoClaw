// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::Document;
use serde_json::json;
use sha2::{Digest, Sha256};

const OPENCLAW_V0_REVISION: &str = "f47724f29838fe08898993fad1c8c6b7fcb3e080";
const OPENCLAW_V0_MANIFEST_SHA256: &str =
    "35c28e708e5a89a77a52fd91cbd587c1c39621014bed096464c36bbc37409b9b";
const HERMES_V0_REVISION: &str = "b6934c6300c4e1e175757e9281ae3a641d9a5b1f";
const HERMES_V0_MANIFEST_SHA256: &str =
    "692182cceaa8b9784d616176f9bf03c32af671e68c2e31b0ce15764957dc9be5";
const HERMES_V0_EXPORT_SHA256: &str =
    "6159d9351d25b4d30e6df80fdb700f144418eaae80a2385b9602e15f5412543a";

fn assert_source_manifest(bytes: &[u8], revision: &str, expected_sha256: &str) {
    let digest = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    assert_eq!(digest, expected_sha256);
    assert_eq!(revision.len(), 40);
    assert!(revision.bytes().all(|byte| byte.is_ascii_hexdigit()));
}

// This scenario compares separately authored current intent with a test-only
// projection. The raw export remains unchanged and never reaches deployment.
fn authored_document(raw: &[u8], current: &[u8]) -> Document {
    let document =
        Document::parse(current).expect("authored v1 input must use current agent syntax");
    let mut projected: serde_json::Value =
        serde_saphyr::from_str(std::str::from_utf8(raw).unwrap()).unwrap();
    let sandboxes = projected["spec"]["sandboxes"].as_array_mut().unwrap();
    assert_eq!(sandboxes.len(), 1, "hosted parity requires one sandbox");
    let sandbox = sandboxes[0].as_object_mut().unwrap();
    let agents = sandbox
        .remove("agents")
        .expect("raw v0 export requires its historical agents list");
    assert_eq!(agents.as_array().unwrap().len(), 1);
    assert!(!sandbox.contains_key("agent"));
    sandbox.insert("agent".into(), agents[0].clone());
    assert_eq!(
        Document::parse(projected.to_string().as_bytes()).unwrap(),
        document,
        "authored v1 configuration must preserve the raw export's portable intent"
    );
    document
}

#[test]
fn live_inputs_preserve_raw_export_and_require_matching_authored_intent() {
    for (raw, current) in [
        (
            include_bytes!("../fixtures/openclaw-nvidia-hosted/v0-export.yaml").as_slice(),
            include_bytes!("../fixtures/openclaw-nvidia-hosted/v1.yaml").as_slice(),
        ),
        (
            include_bytes!("../fixtures/hermes-nvidia-hosted/v0-export.yaml").as_slice(),
            include_bytes!("../fixtures/hermes-nvidia-hosted/v1.yaml").as_slice(),
        ),
    ] {
        let document = authored_document(raw, current);
        assert_eq!(document, Document::parse(current).unwrap());
        let mut changed = document.clone();
        changed.spec.sandboxes[0].agent.name = "different-agent".into();
        assert!(
            std::panic::catch_unwind(|| authored_document(raw, changed.yaml().unwrap().as_bytes()))
                .is_err()
        );
        assert!(std::panic::catch_unwind(|| authored_document(raw, raw)).is_err());
    }
}

fn assert_hosted_document(document: &Document, harness: &str, runtime_root: &str) {
    let gateway = &document.spec.gateway;
    assert_eq!(gateway.management, "managed");
    assert_eq!(gateway.engine, "unix:///var/run/docker.sock");
    assert_eq!(gateway.image, nemoclaw_sdk::config::DEFAULT_GATEWAY_IMAGE);

    let provider = &document.spec.inference_providers[0];
    assert_eq!(provider.name, "hosted-nvidia-prod");
    assert_eq!(provider.provider, "openai");
    assert_eq!(provider.endpoint, "https://integrate.api.nvidia.com/v1");
    assert_eq!(
        provider.credential.as_ref().unwrap().env,
        "NVIDIA_INFERENCE_API_KEY"
    );
    assert!(provider.service.is_none());
    assert!(provider.ollama.is_none());

    let sandbox = &document.spec.sandboxes[0];
    let expected_image = if harness == "hermes" {
        nemoclaw_sdk::config::DEFAULT_HERMES_IMAGE
    } else {
        nemoclaw_sdk::config::DEFAULT_AGENT_IMAGE
    };
    assert_eq!(sandbox.image.ref_, expected_image);
    assert_eq!(sandbox.runtime.provider, "docker");
    assert!(sandbox.network.tier.is_empty());
    let explicit = &sandbox.network.policy.as_ref().unwrap().explicit;
    let process = explicit.process.as_ref().unwrap();
    assert_eq!(process.run_as_user.as_deref(), Some("1000"));
    assert_eq!(process.run_as_group.as_deref(), Some("1000"));
    let read_only = explicit
        .filesystem_policy
        .as_ref()
        .unwrap()
        .read_only
        .as_ref()
        .unwrap();
    for root in [runtime_root, "/opt/fabric", "/opt/nemoclaw"] {
        assert!(
            read_only.iter().any(|path| path == root),
            "raw export policy must grant the v1 runtime root {root}"
        );
    }
    let agent = &sandbox.agent;
    assert_eq!(document.sandbox_harness(sandbox).unwrap().kind, harness);
    let inference = document.agent_inference(agent).unwrap();
    assert_eq!(
        inference.routes[0].provider_ref.as_deref(),
        Some(provider.name.as_str())
    );
    assert_eq!(
        inference.routes[0].overrides.model,
        "nvidia/nemotron-3-super-120b-a12b"
    );
}

#[test]
fn hosted_openclaw_scenario_rejects_legacy_export_and_preserves_authored_intent() {
    assert_source_manifest(
        include_bytes!("../fixtures/openclaw-nvidia-hosted/v0.yaml"),
        OPENCLAW_V0_REVISION,
        OPENCLAW_V0_MANIFEST_SHA256,
    );
    let raw = include_bytes!("../fixtures/openclaw-nvidia-hosted/v0-export.yaml");
    assert!(
        Document::parse(raw.as_slice()).is_err(),
        "legacy agents lists require explicit reauthoring"
    );
    let v1 = authored_document(
        raw,
        include_bytes!("../fixtures/openclaw-nvidia-hosted/v1.yaml"),
    );
    assert_hosted_document(&v1, "openclaw", "/app");
}

#[test]
fn hosted_hermes_scenario_rejects_legacy_export_and_preserves_authored_intent() {
    assert_source_manifest(
        include_bytes!("../fixtures/hermes-nvidia-hosted/v0.yaml"),
        HERMES_V0_REVISION,
        HERMES_V0_MANIFEST_SHA256,
    );
    let export = include_bytes!("../fixtures/hermes-nvidia-hosted/v0-export.yaml");
    let export_digest = Sha256::digest(export)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    assert_eq!(export_digest, HERMES_V0_EXPORT_SHA256);
    assert!(
        Document::parse(export.as_slice()).is_err(),
        "legacy agents lists require explicit reauthoring"
    );
    let v1 = authored_document(
        export,
        include_bytes!("../fixtures/hermes-nvidia-hosted/v1.yaml"),
    );
    assert_hosted_document(&v1, "hermes", "/opt/hermes");
    let harness = v1.sandbox_harness(&v1.spec.sandboxes[0]).unwrap();
    assert_eq!(
        serde_json::to_value(harness.interfaces.as_ref().unwrap()).unwrap(),
        json!({"api":{"port":8643}})
    );
}

#[cfg(target_os = "linux")]
mod live {
    use nemoclaw_sdk::{
        CancellationToken, Change, Deployment, OperationResult, Outcome,
        backend::Row,
        config::Document,
        openshell::{EnvironmentSecrets, OpenShell},
    };
    use serde_json::Value;
    use std::{
        collections::BTreeMap,
        fs,
        path::{Path, PathBuf},
        sync::Arc,
    };

    fn explicit_path(name: &str) -> PathBuf {
        let path = PathBuf::from(std::env::var_os(name).expect(name));
        assert!(path.is_absolute(), "{name} must be absolute");
        path
    }

    fn changes(resources: &[&str], action: &str) -> Vec<Change> {
        resources
            .iter()
            .map(|resource| Change {
                resource: (*resource).into(),
                actions: vec![action.into()],
            })
            .collect()
    }

    fn state_bindings(directory: &Path) -> (BTreeMap<String, String>, Option<Row>) {
        let mut ids = BTreeMap::new();
        let mut sandbox = None;
        for relative in ["terraform.tfstate", "runtime/terraform.tfstate"] {
            let path = directory.join(relative);
            if !path.exists() {
                continue;
            }
            let state: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            for resource in state["resources"].as_array().into_iter().flatten() {
                let instances = resource["instances"].as_array().unwrap();
                assert_eq!(instances.len(), 1);
                let attributes = &instances[0]["attributes"];
                let address = format!(
                    "{}.{}",
                    resource["type"].as_str().unwrap(),
                    resource["name"].as_str().unwrap()
                );
                assert!(
                    ids.insert(address, attributes["id"].as_str().unwrap().into())
                        .is_none()
                );
                if resource["type"] == "nemoclaw_sandbox" {
                    assert!(sandbox.is_none(), "scenario must have exactly one sandbox");
                    sandbox = Some(serde_json::from_value(attributes.clone()).unwrap());
                }
            }
        }
        (ids, sandbox)
    }

    fn initial_plan() -> OperationResult {
        OperationResult {
            outcome: Outcome::Planned,
            changes: changes(
                &[
                    "nemoclaw_gateway_storage.runtime",
                    "nemoclaw_managed_gateway.runtime",
                ],
                "create",
            ),
            deferred: vec!["OpenShell registration and sandbox require the managed gateway".into()],
            retained: vec![],
            health: vec![],
        }
    }

    fn removed_resources() -> Vec<Change> {
        changes(
            &[
                "nemoclaw_provider.inference_hosted-nvidia-prod",
                "nemoclaw_provider_profile.inference_hosted-nvidia-prod",
                "nemoclaw_sandbox.assistant",
                "nemoclaw_managed_gateway.runtime",
            ],
            "delete",
        )
    }

    fn retained_resources() -> Vec<String> {
        vec![
            "nemoclaw_workspace.deployment".into(),
            "nemoclaw_gateway_storage.runtime".into(),
        ]
    }

    async fn apply_initial(
        deployment: &Deployment,
        document: &Document,
        cancel: &CancellationToken,
    ) {
        assert_eq!(
            deployment.plan(document, cancel).await.unwrap(),
            initial_plan()
        );
        let applied = deployment.apply(document, cancel).await.unwrap();
        assert_eq!(applied.outcome, Outcome::Succeeded);
        assert_eq!(
            applied.changes,
            changes(
                &[
                    "nemoclaw_gateway_storage.runtime",
                    "nemoclaw_managed_gateway.runtime",
                    "nemoclaw_provider.inference_hosted-nvidia-prod",
                    "nemoclaw_provider_profile.inference_hosted-nvidia-prod",
                    "nemoclaw_sandbox.assistant",
                    "nemoclaw_workspace.deployment",
                ],
                "create",
            )
        );
        assert!(applied.deferred.is_empty());
        assert!(applied.retained.is_empty());
        assert_eq!(applied.health.len(), 1);
        assert_eq!(applied.health[0].sandbox, "assistant");
        assert_eq!(applied.health[0].agents, ["primary"]);
        assert!(applied.health[0].health.allows_apply_completion());
    }

    async fn destroy(deployment: &Deployment, cancel: &CancellationToken) -> Vec<String> {
        let removed = removed_resources();
        let retained = retained_resources();
        assert_eq!(
            deployment.plan_destroy(cancel).await.unwrap(),
            OperationResult {
                outcome: Outcome::Planned,
                changes: removed.clone(),
                deferred: vec![],
                retained: retained.clone(),
                health: vec![],
            }
        );
        assert_eq!(
            deployment.destroy(cancel).await.unwrap(),
            OperationResult {
                outcome: Outcome::Destroyed,
                changes: removed,
                deferred: vec![],
                retained: retained.clone(),
                health: vec![],
            }
        );
        retained
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires NEMOCLAW_LIVE_V0_EXPORT, NEMOCLAW_LIVE_V1_CONFIG, an unused NEMOCLAW_LIVE_HOSTED_STATE path, NEMOCLAW_TEST_BUNDLE, and NVIDIA_INFERENCE_API_KEY; creates and destroys this owned deployment"]
    async fn authored_v1_intent_preserves_v0_export_through_hosted_openclaw_lifecycle() {
        let raw = fs::read(explicit_path("NEMOCLAW_LIVE_V0_EXPORT")).unwrap();
        let yaml = fs::read(explicit_path("NEMOCLAW_LIVE_V1_CONFIG")).unwrap();
        let document = super::authored_document(&raw, &yaml);
        let directory = explicit_path("NEMOCLAW_LIVE_HOSTED_STATE");
        let bundle = explicit_path("NEMOCLAW_TEST_BUNDLE");
        fs::create_dir(&directory).expect("test requires a new state directory");
        let deployment = Deployment::new(&directory, &bundle);
        let cancel = CancellationToken::new();

        apply_initial(&deployment, &document, &cancel).await;
        assert_eq!(
            deployment.plan(&document, &cancel).await.unwrap(),
            OperationResult {
                outcome: Outcome::Planned,
                changes: vec![],
                deferred: vec![],
                retained: vec![],
                health: vec![],
            }
        );
        let exported = deployment.export(&cancel).await.unwrap();
        assert_eq!(exported, document);
        let reapplied = deployment.apply(&exported, &cancel).await.unwrap();
        assert_eq!(reapplied.outcome, Outcome::Succeeded);
        assert!(reapplied.changes.is_empty());
        assert!(reapplied.deferred.is_empty());
        destroy(&deployment, &cancel).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires the curated Hermes hosted inputs, an unused NEMOCLAW_LIVE_HOSTED_STATE path, NEMOCLAW_TEST_BUNDLE, and NVIDIA_INFERENCE_API_KEY; creates and destroys this owned deployment"]
    async fn authored_v1_intent_preserves_v0_export_through_hosted_hermes_lifecycle() {
        let raw = fs::read(explicit_path("NEMOCLAW_LIVE_V0_EXPORT")).unwrap();
        let yaml = fs::read(explicit_path("NEMOCLAW_LIVE_V1_CONFIG")).unwrap();
        let document = super::authored_document(&raw, &yaml);
        super::assert_hosted_document(&document, "hermes", "/opt/hermes");
        let directory = explicit_path("NEMOCLAW_LIVE_HOSTED_STATE");
        let bundle = explicit_path("NEMOCLAW_TEST_BUNDLE");
        fs::create_dir(&directory).expect("test requires a new state directory");
        let deployment = Deployment::new(&directory, &bundle);
        let cancel = CancellationToken::new();

        apply_initial(&deployment, &document, &cancel).await;
        let (before, sandbox) = state_bindings(&directory);
        assert_eq!(
            before.keys().map(String::as_str).collect::<Vec<_>>(),
            [
                "nemoclaw_gateway_storage.runtime",
                "nemoclaw_managed_gateway.runtime",
                "nemoclaw_provider.inference_hosted-nvidia-prod",
                "nemoclaw_provider_profile.inference_hosted-nvidia-prod",
                "nemoclaw_sandbox.assistant",
                "nemoclaw_workspace.deployment",
            ]
        );
        let client =
            OpenShell::connect(&document.spec.gateway, Arc::new(EnvironmentSecrets)).unwrap();
        let reply = client.agent_response(&sandbox.unwrap()).await.unwrap();
        assert!(reply.trim_matches(['.', '!']).eq_ignore_ascii_case("FOUR"));

        assert_eq!(
            deployment.plan(&document, &cancel).await.unwrap(),
            OperationResult {
                outcome: Outcome::Planned,
                changes: vec![],
                deferred: vec![],
                retained: vec![],
                health: vec![],
            }
        );
        let unchanged = deployment.apply(&document, &cancel).await.unwrap();
        assert_eq!(unchanged.outcome, Outcome::Succeeded);
        assert!(unchanged.changes.is_empty());
        assert!(unchanged.deferred.is_empty());
        assert_eq!(state_bindings(&directory).0, before);

        let exported = deployment.export(&cancel).await.unwrap();
        assert_eq!(exported, document);
        let reapplied = deployment.apply(&exported, &cancel).await.unwrap();
        assert_eq!(reapplied.outcome, Outcome::Succeeded);
        assert!(reapplied.changes.is_empty());
        assert!(reapplied.deferred.is_empty());
        assert_eq!(state_bindings(&directory).0, before);

        let retained = destroy(&deployment, &cancel).await;
        let (after, sandbox) = state_bindings(&directory);
        assert!(sandbox.is_none());
        assert_eq!(
            after,
            before
                .into_iter()
                .filter(|(address, _)| retained.contains(address))
                .collect()
        );
    }
}
