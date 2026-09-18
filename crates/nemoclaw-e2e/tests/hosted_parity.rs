// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::Document;
use sha2::{Digest, Sha256};

const V0_REVISION: &str = "f47724f29838fe08898993fad1c8c6b7fcb3e080";
const V0_MANIFEST_SHA256: &str = "35c28e708e5a89a77a52fd91cbd587c1c39621014bed096464c36bbc37409b9b";

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
    let raw = include_bytes!("../fixtures/openclaw-nvidia-hosted/v0-export.yaml");
    let current = include_bytes!("../fixtures/openclaw-nvidia-hosted/v1.yaml");
    let document = authored_document(raw, current);
    assert_eq!(document, Document::parse(current.as_slice()).unwrap());
    let mut changed = document.clone();
    changed.spec.sandboxes[0].agent.name = "different-agent".into();
    assert!(
        std::panic::catch_unwind(|| authored_document(raw, changed.yaml().unwrap().as_bytes()))
            .is_err()
    );
    assert!(std::panic::catch_unwind(|| authored_document(raw, raw)).is_err());
}

#[test]
fn hosted_openclaw_scenario_rejects_legacy_export_and_preserves_authored_intent() {
    let v0 = include_bytes!("../fixtures/openclaw-nvidia-hosted/v0.yaml");
    let digest = Sha256::digest(v0)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    assert_eq!(digest, V0_MANIFEST_SHA256);
    assert_eq!(V0_REVISION.len(), 40);

    let raw = include_bytes!("../fixtures/openclaw-nvidia-hosted/v0-export.yaml");
    assert!(
        Document::parse(raw.as_slice()).is_err(),
        "legacy agents lists require explicit reauthoring"
    );
    let v1 = authored_document(
        raw,
        include_bytes!("../fixtures/openclaw-nvidia-hosted/v1.yaml"),
    );
    let gateway = &v1.spec.gateway;
    assert_eq!(gateway.management, "managed");
    assert_eq!(gateway.engine, "unix:///var/run/docker.sock");
    assert_eq!(gateway.image, nemoclaw_sdk::config::DEFAULT_GATEWAY_IMAGE);

    let provider = &v1.spec.inference_providers[0];
    assert_eq!(provider.name, "hosted-nvidia-prod");
    assert_eq!(provider.provider, "openai");
    assert_eq!(provider.endpoint, "https://integrate.api.nvidia.com/v1");
    assert_eq!(
        provider.credential.as_ref().unwrap().env,
        "NVIDIA_INFERENCE_API_KEY"
    );
    assert!(provider.service.is_none());
    assert!(provider.ollama.is_none());

    let sandbox = &v1.spec.sandboxes[0];
    assert_eq!(
        sandbox.image.ref_,
        nemoclaw_sdk::config::DEFAULT_AGENT_IMAGE
    );
    assert_eq!(sandbox.runtime.provider, "docker");
    assert!(sandbox.network.tier.is_empty());
    let process = sandbox
        .network
        .policy
        .as_ref()
        .unwrap()
        .explicit
        .process
        .as_ref()
        .unwrap();
    assert_eq!(process.run_as_user.as_deref(), Some("1000"));
    assert_eq!(process.run_as_group.as_deref(), Some("1000"));
    let read_only = sandbox
        .network
        .policy
        .as_ref()
        .unwrap()
        .explicit
        .filesystem_policy
        .as_ref()
        .unwrap()
        .read_only
        .as_ref()
        .unwrap();
    for runtime_root in ["/app", "/opt/fabric", "/opt/nemoclaw"] {
        assert!(
            read_only.iter().any(|path| path == runtime_root),
            "raw export policy must grant the v1 runtime root {runtime_root}"
        );
    }
    let agent = &sandbox.agent;
    assert_eq!(v1.sandbox_harness(sandbox).unwrap().kind, "openclaw");
    let inference = v1.agent_inference(agent).unwrap();
    assert_eq!(
        inference.routes[0].provider_ref.as_deref(),
        Some(provider.name.as_str())
    );
    assert_eq!(
        inference.routes[0].overrides.model,
        "nvidia/nemotron-3-super-120b-a12b"
    );
}

#[cfg(target_os = "linux")]
mod live {
    use nemoclaw_sdk::{CancellationToken, Change, Deployment, OperationResult, Outcome};
    use std::{fs, path::PathBuf};

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

        let plan = deployment.plan(&document, &cancel).await.unwrap();
        assert_eq!(
            plan,
            OperationResult {
                outcome: Outcome::Planned,
                changes: changes(
                    &[
                        "nemoclaw_gateway_storage.runtime",
                        "nemoclaw_managed_gateway.runtime",
                    ],
                    "create"
                ),
                deferred: vec![
                    "OpenShell registration and sandbox require the managed gateway".into()
                ],
                retained: vec![],
                health: vec![],
            }
        );
        let applied = deployment.apply(&document, &cancel).await.unwrap();
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
                "create"
            )
        );
        assert!(applied.deferred.is_empty());
        assert!(applied.retained.is_empty());
        assert_eq!(applied.health.len(), 1);
        assert_eq!(applied.health[0].sandbox, "assistant");
        assert_eq!(applied.health[0].agents, ["primary"]);
        assert!(applied.health[0].health.allows_apply_completion());

        let unchanged = deployment.plan(&document, &cancel).await.unwrap();
        assert_eq!(
            unchanged,
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

        let removed = changes(
            &[
                "nemoclaw_provider.inference_hosted-nvidia-prod",
                "nemoclaw_provider_profile.inference_hosted-nvidia-prod",
                "nemoclaw_sandbox.assistant",
                "nemoclaw_managed_gateway.runtime",
            ],
            "delete",
        );
        let retained = vec![
            "nemoclaw_workspace.deployment".into(),
            "nemoclaw_gateway_storage.runtime".into(),
        ];
        let destroy_plan = deployment.plan_destroy(&cancel).await.unwrap();
        assert_eq!(
            destroy_plan,
            OperationResult {
                outcome: Outcome::Planned,
                changes: removed.clone(),
                deferred: vec![],
                retained: retained.clone(),
                health: vec![],
            }
        );
        let destroyed = deployment.destroy(&cancel).await.unwrap();
        assert_eq!(
            destroyed,
            OperationResult {
                outcome: Outcome::Destroyed,
                changes: removed,
                deferred: vec![],
                retained,
                health: vec![],
            }
        );
    }
}
