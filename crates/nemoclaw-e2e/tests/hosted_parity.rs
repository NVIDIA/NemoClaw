// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::Document;
use sha2::{Digest, Sha256};

const V0_REVISION: &str = "f47724f29838fe08898993fad1c8c6b7fcb3e080";
const V0_MANIFEST_SHA256: &str = "35c28e708e5a89a77a52fd91cbd587c1c39621014bed096464c36bbc37409b9b";
const CURRENT_EXPORT_SOURCE_REVISION: &str = "0a361a239c18dd4a56c34b4ca66dc32a3139bddd";
const TARGET_PARSER_REVISION: &str = "9d446d51803ea6e3c6aaa286cee57c611173f214";
const CURRENT_OPENCLAW_EXPORT_SHA256: &str =
    "ec8f98186b2e18982bfce180627ecb79e35719b6a52088ad527282825f1705f4";
const CURRENT_HERMES_EXPORT_SHA256: &str =
    "f178a06e9638ba2406850ad0abc1e2dd6eafe51823807f1348b071146f4dd151";
const LIVE_NETWORK_POLICY_EXPORT_SHA256: &str =
    "fba807339f35f49e71426a22935fcc1088d53451b38272e38891b1b1f1d70560";

fn sha256(raw: &[u8]) -> String {
    Sha256::digest(raw)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[test]
fn current_single_agent_exports_parse_without_rewriting() {
    assert_eq!(CURRENT_EXPORT_SOURCE_REVISION.len(), 40);
    assert_eq!(TARGET_PARSER_REVISION.len(), 40);

    let openclaw_raw = include_bytes!("../fixtures/current-config-exports/openclaw.yaml");
    assert_eq!(sha256(openclaw_raw), CURRENT_OPENCLAW_EXPORT_SHA256);
    let openclaw =
        Document::parse(openclaw_raw.as_slice()).expect("current OpenClaw export must parse raw");
    let openclaw_sandbox = &openclaw.spec.sandboxes[0];
    assert_eq!(
        openclaw.sandbox_harness(openclaw_sandbox).unwrap().kind,
        "openclaw"
    );
    assert_eq!(openclaw_sandbox.agent.name, "primary");
    let openclaw_policy = &openclaw_sandbox.network.policy.as_ref().unwrap().explicit;
    assert_eq!(openclaw_policy.version, 1);
    assert!(openclaw_policy.network_policies.contains_key("api"));
    assert!(
        openclaw_policy
            .filesystem_policy
            .as_ref()
            .unwrap()
            .read_only
            .as_ref()
            .unwrap()
            .iter()
            .any(|path| path == "/app")
    );
    assert_eq!(
        openclaw.sandbox_inference(openclaw_sandbox).unwrap().routes[0]
            .overrides
            .model,
        "gpt-5"
    );
    assert_eq!(
        openclaw.spec.inference_providers[0]
            .credential
            .as_ref()
            .unwrap()
            .env,
        "OPENAI_API_KEY"
    );

    let hermes_raw = include_bytes!("../fixtures/current-config-exports/hermes.yaml");
    assert_eq!(sha256(hermes_raw), CURRENT_HERMES_EXPORT_SHA256);
    let hermes =
        Document::parse(hermes_raw.as_slice()).expect("current Hermes export must parse raw");
    let hermes_sandbox = &hermes.spec.sandboxes[0];
    assert_eq!(
        hermes.sandbox_harness(hermes_sandbox).unwrap().kind,
        "hermes"
    );
    assert_eq!(hermes_sandbox.agent.name, "primary");
    assert!(hermes_sandbox.agent.auth.is_some());
    assert!(
        hermes_sandbox
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
            .unwrap()
            .iter()
            .any(|path| path == "/opt/hermes")
    );
    assert_eq!(
        hermes.sandbox_inference(hermes_sandbox).unwrap().routes[0]
            .overrides
            .model,
        "moonshotai/kimi-k2.6"
    );
    assert_eq!(
        hermes.spec.inference_providers[0]
            .credential
            .as_ref()
            .unwrap()
            .env,
        "NOUS_API_KEY"
    );

    let live_raw = include_bytes!("../fixtures/current-config-exports/network-policy-live.yaml");
    assert_eq!(sha256(live_raw), LIVE_NETWORK_POLICY_EXPORT_SHA256);
    let live = Document::parse(live_raw.as_slice()).expect("live OpenClaw export must parse raw");
    let live_sandbox = &live.spec.sandboxes[0];
    assert_eq!(live_sandbox.name, "e2e-net-policy");
    assert_eq!(live_sandbox.agent.name, "primary");
    assert_eq!(live.sandbox_harness(live_sandbox).unwrap().kind, "openclaw");
    assert_eq!(live_sandbox.runtime.provider, "docker");
    assert!(
        live_sandbox
            .network
            .policy
            .as_ref()
            .unwrap()
            .explicit
            .network_policies
            .contains_key("nvidia")
    );
    let live_inference = live.sandbox_inference(live_sandbox).unwrap();
    assert_eq!(
        live_inference.routes[0].provider_ref.as_deref(),
        Some("hosted-compatible-endpoint")
    );
    assert_eq!(
        live_inference.routes[0].overrides.model,
        "nvidia/nvidia/nemotron-3-ultra"
    );
    assert_eq!(
        live.spec.inference_providers[0]
            .credential
            .as_ref()
            .unwrap()
            .env,
        "COMPATIBLE_API_KEY"
    );
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
    let digest = sha256(v0);
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
    assert!(provider.service_ref.is_none());

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
    assert_eq!(v1.sandbox_harness(sandbox).unwrap().kind, "openclaw");
    let inference = v1.sandbox_inference(sandbox).unwrap();
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

        let generations = ["workspace", "provider", "sandbox", "managed_gateway"]
            .map(|kind| (kind.into(), "a".repeat(32)))
            .into();
        let mut runtime: Vec<_> = nemoclaw_sdk::compile::runtime_targets(&document, &generations)
            .unwrap()
            .into_iter()
            .filter(|target| !target.address.starts_with("data."))
            .map(|target| target.address)
            .collect();
        runtime.sort();
        let runtime_create = changes(
            &runtime.iter().map(String::as_str).collect::<Vec<_>>(),
            "create",
        );
        let plan = deployment.plan(&document, &cancel).await.unwrap();
        assert_eq!(
            plan,
            OperationResult {
                outcome: Outcome::Planned,
                changes: runtime_create.clone(),
                deferred: vec![
                    "OpenShell registration and sandbox require the managed gateway".into()
                ],
                retained: vec![],
                health: vec![],
            }
        );
        let applied = deployment.apply(&document, &cancel).await.unwrap();
        assert_eq!(applied.outcome, Outcome::Succeeded);
        let mut expected = runtime_create;
        expected.extend(changes(
            &[
                "nemoclaw_provider.inference_hosted-nvidia-prod",
                "nemoclaw_provider_profile.inference_hosted-nvidia-prod",
                "nemoclaw_sandbox.assistant",
                "nemoclaw_workspace.deployment",
            ],
            "create",
        ));
        assert_eq!(applied.changes, expected);
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

        let mut removed = changes(
            &[
                "nemoclaw_provider.inference_hosted-nvidia-prod",
                "nemoclaw_provider_profile.inference_hosted-nvidia-prod",
                "nemoclaw_sandbox.assistant",
            ],
            "delete",
        );
        removed.extend(changes(
            &runtime
                .iter()
                .filter(|address| address.as_str() != "nemoclaw_gateway_storage.runtime")
                .map(String::as_str)
                .collect::<Vec<_>>(),
            "delete",
        ));
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
