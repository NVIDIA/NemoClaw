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

mod live {
    use nemoclaw_sdk::{
        CancellationToken, Deployment,
        backend::Row,
        config::Document,
        openshell::{EnvironmentSecrets, OpenShell},
    };
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};
    use std::{
        collections::BTreeMap,
        fs,
        path::{Path, PathBuf},
        process::Command,
        sync::Arc,
        time::{SystemTime, UNIX_EPOCH},
    };

    const SCENARIO: &str = "openclaw-nvidia-hosted-linux-docker";

    struct Evidence {
        path: PathBuf,
        value: Value,
    }

    impl Evidence {
        fn record(&mut self, name: &str, value: impl serde::Serialize) {
            self.value[name] = serde_json::to_value(value).unwrap();
            self.save();
        }

        fn save(&self) {
            let bytes = serde_json::to_vec_pretty(&self.value).unwrap();
            assert_redacted(&bytes);
            fs::write(&self.path, bytes).unwrap();
        }
    }

    impl Drop for Evidence {
        fn drop(&mut self) {
            self.value["finishedEpoch"] = json!(now());
            self.save();
        }
    }

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    fn explicit(name: &str) -> PathBuf {
        let path = PathBuf::from(std::env::var_os(name).expect(name));
        assert!(path.is_absolute(), "{name} must be absolute");
        path
    }

    fn assert_revision(name: &str, value: &str) {
        assert_eq!(value.len(), 40, "{name} must be a full Git revision");
        assert!(
            value.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "{name} must be hexadecimal"
        );
    }

    fn output(command: &mut Command) -> Vec<u8> {
        let result = command.output().unwrap();
        assert_redacted(&result.stdout);
        assert_redacted(&result.stderr);
        assert!(
            result.status.success(),
            "command failed with status {}",
            result.status
        );
        result.stdout
    }

    fn text(command: &mut Command) -> String {
        String::from_utf8(output(command)).unwrap().trim().into()
    }

    fn assert_redacted(bytes: &[u8]) {
        let text = String::from_utf8_lossy(bytes);
        assert!(
            !text.contains("nvapi-"),
            "evidence contains an NVIDIA API key"
        );
        if let Ok(secret) = std::env::var("NVIDIA_INFERENCE_API_KEY") {
            assert!(!secret.is_empty());
            assert!(
                !text.contains(&secret),
                "evidence contains the live credential"
            );
        }
    }

    fn sha256(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn v0_artifact_audit(bytes: &[u8], source: Option<&str>) -> Value {
        assert_redacted(bytes);
        let mut audit = json!({"sha256": sha256(bytes)});
        if let Some(source) = source.filter(|source| !source.trim().is_empty()) {
            audit["source"] = json!(source);
        }
        audit
    }

    #[test]
    fn standalone_v0_artifact_does_not_require_pipeline_provenance() {
        let bytes = include_bytes!("../fixtures/openclaw-nvidia-hosted/v0-export.yaml");
        let digest = sha256(bytes);
        let without_source = v0_artifact_audit(bytes, None);
        assert_eq!(without_source["sha256"], digest);
        assert!(without_source.get("source").is_none());

        assert_eq!(
            v0_artifact_audit(bytes, Some("optional audit note"))["source"],
            "optional audit note"
        );
    }

    #[test]
    fn aligned_export_uses_immutable_v1_default_images() {
        validate_immutable_image(
            "default agent image",
            nemoclaw_sdk::config::DEFAULT_AGENT_IMAGE,
        );
        validate_gateway_image(nemoclaw_sdk::config::DEFAULT_GATEWAY_IMAGE);
        assert!(
            std::panic::catch_unwind(|| validate_gateway_image(
                "ghcr.io/nvidia/openshell/gateway@sha256:3d08ad1e7d839a2ffb9ac85a66102b96dd6bc042c3a6f1eaa31351998fd65792"
            ))
            .is_err()
        );
    }

    fn validate_immutable_image(name: &str, image: &str) {
        let (repository, digest) = image
            .rsplit_once("@sha256:")
            .unwrap_or_else(|| panic!("{name} must use an immutable SHA-256 digest"));
        assert!(
            !repository.is_empty(),
            "{name} repository must not be empty"
        );
        assert!(
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "{name} must use a lowercase SHA-256 digest"
        );
    }

    fn validate_gateway_image(image: &str) {
        validate_immutable_image("live gateway image", image);
        assert_eq!(
            image,
            nemoclaw_sdk::config::DEFAULT_GATEWAY_IMAGE,
            "live managed gateway must use the SDK-pinned image"
        );
    }

    fn validate_scenario_document(document: &Document) {
        assert_eq!(document.spec.gateway.management, "managed");
        assert_eq!(document.spec.gateway.engine, "unix:///var/run/docker.sock");
        validate_gateway_image(&document.spec.gateway.image);
        let provider = &document.spec.inference_providers[0];
        assert_eq!(provider.provider, "openai");
        assert_eq!(provider.endpoint, "https://integrate.api.nvidia.com/v1");
        assert_eq!(
            provider.credential.as_ref().map(|value| value.env.as_str()),
            Some("NVIDIA_INFERENCE_API_KEY")
        );
        let sandbox = &document.spec.sandboxes[0];
        assert_eq!(
            sandbox.image.ref_,
            nemoclaw_sdk::config::DEFAULT_AGENT_IMAGE
        );
        validate_immutable_image("default agent image", &sandbox.image.ref_);
        assert_eq!(sandbox.runtime.provider, "docker");
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
        let agent = &sandbox.agent;
        assert_eq!(document.sandbox_harness(sandbox).unwrap().kind, "openclaw");
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
                    ids.insert(address.clone(), attributes["id"].as_str().unwrap().into())
                        .is_none()
                );
                if address == "nemoclaw_sandbox.agent" {
                    sandbox = Some(serde_json::from_value(attributes.clone()).unwrap());
                }
            }
        }
        (ids, sandbox)
    }

    fn environment() -> Value {
        let docker = |args: &[&str]| text(Command::new("docker").args(args));
        json!({
            "os": std::env::consts::OS,
            "architecture": std::env::consts::ARCH,
            "kernel": text(Command::new("uname").args(["-sr"])),
            "hostRelease": host_release(),
            "dockerClientVersion": docker(&["version", "--format", "{{.Client.Version}}"]),
            "dockerServerVersion": docker(&["version", "--format", "{{.Server.Version}}"]),
            "dockerServerOs": docker(&["version", "--format", "{{.Server.Os}}"]),
            "dockerServerArchitecture": docker(&["version", "--format", "{{.Server.Arch}}"]),
            "dockerDaemonId": docker(&["info", "--format", "{{.ID}}"]),
        })
    }

    fn host_release() -> String {
        if std::env::consts::OS == "macos" {
            return format!(
                "macos:{}",
                text(Command::new("sw_vers").arg("-productVersion"))
            );
        }
        let release = fs::read_to_string("/etc/os-release").unwrap();
        let field = |name: &str| {
            release
                .lines()
                .find_map(|line| line.strip_prefix(&format!("{name}=")))
                .map(|value| value.trim_matches('"'))
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| panic!("/etc/os-release must contain {name}"))
        };
        format!("{}:{}", field("ID"), field("VERSION_ID"))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires redacted raw NEMOCLAW_LIVE_V0_EXPORT and separately authored NEMOCLAW_LIVE_V1_CONFIG, owned fresh Docker state, a verified bundle, and NVIDIA_INFERENCE_API_KEY; creates and destroys only that deployment"]
    async fn authored_v1_intent_preserves_v0_export_through_hosted_openclaw_lifecycle() {
        let gate = std::env::var("NEMOCLAW_RUN_LIVE_HOSTED_PARITY").unwrap();
        let qualification_candidate = match gate.as_str() {
            "issue-11810" => {
                assert_eq!(
                    std::env::consts::OS,
                    "linux",
                    "qualification requires Linux"
                );
                true
            }
            "issue-11810-local-feedback" => false,
            _ => panic!("set an issue-specific live gate"),
        };
        let credential = std::env::var("NVIDIA_INFERENCE_API_KEY")
            .expect("dedicated NVIDIA_INFERENCE_API_KEY must be supplied by the environment");
        assert!(
            !credential.is_empty() && !credential.contains(['\r', '\n']),
            "the dedicated credential must be nonempty and single-line"
        );
        drop(credential);
        let v1_revision = std::env::var("NEMOCLAW_LIVE_V1_REVISION").unwrap();
        assert_revision("NEMOCLAW_LIVE_V1_REVISION", &v1_revision);
        assert_eq!(
            text(Command::new("git").args(["rev-parse", "HEAD"])),
            v1_revision
        );
        let source_status = text(Command::new("git").args(["status", "--short"]));
        if qualification_candidate {
            assert!(
                source_status.is_empty(),
                "qualified live evidence requires a clean v1 checkout"
            );
        }

        let v0_export_path = explicit("NEMOCLAW_LIVE_V0_EXPORT");
        let v1_config_path = explicit("NEMOCLAW_LIVE_V1_CONFIG");
        let directory = explicit("NEMOCLAW_LIVE_HOSTED_STATE");
        let bundle = explicit("NEMOCLAW_TEST_BUNDLE");
        let v0_export_bytes = fs::read(v0_export_path).unwrap();
        let v0_source = std::env::var("NEMOCLAW_LIVE_V0_SOURCE").ok();
        let mut v0_export_evidence = v0_artifact_audit(&v0_export_bytes, v0_source.as_deref());
        v0_export_evidence["redactedYaml"] =
            json!(String::from_utf8(v0_export_bytes.clone()).unwrap());
        let v1_config_bytes = fs::read(v1_config_path).unwrap();
        assert_redacted(&v1_config_bytes);
        let document = super::authored_document(&v0_export_bytes, &v1_config_bytes);
        let v1_config_evidence = json!({
            "sha256": sha256(&v1_config_bytes),
            "redactedYaml": String::from_utf8(v1_config_bytes).unwrap(),
            "source": "explicitly authored current configuration",
        });
        validate_scenario_document(&document);
        let image = &document.spec.sandboxes[0].image.ref_;
        assert_eq!(
            text(Command::new("docker").args([
                "image",
                "inspect",
                image,
                "--format",
                "{{index .RepoDigests 0}}"
            ])),
            *image,
            "the exact default agent image must exist in the owned Docker daemon"
        );

        let ownership: Value = serde_json::from_slice(
            &fs::read(directory.join("ownership.json"))
                .expect("state directory must contain the explicit ownership marker"),
        )
        .unwrap();
        assert_eq!(ownership["scenario"], SCENARIO);
        assert_eq!(ownership["deploymentUid"], document.metadata.uid);
        assert_eq!(ownership["owned"], true);
        let fresh = !directory.join("terraform.tfstate").exists()
            && !directory.join("runtime/terraform.tfstate").exists();
        if qualification_candidate {
            assert!(fresh, "qualification requires fresh owned state");
        }

        let current_environment = environment();

        let mut evidence = Evidence {
            path: directory.join("openclaw-nvidia-hosted-parity.json"),
            value: json!({
                "scenario": SCENARIO,
                "parentIssue": "NVIDIA/NemoClaw#11810",
                "passed": false,
                "qualified": false,
                "qualificationCandidate": qualification_candidate,
                "qualificationNote": "qualification requires review of the curated input and lifecycle evidence",
                "resumedAfterFailedApply": !fresh,
                "startedEpoch": now(),
                "v1Revision": v1_revision,
                "v1SourceWorktreeClean": source_status.is_empty(),
                "credentialInputs": {"NVIDIA_INFERENCE_API_KEY": "environment reference; value omitted"},
                "v0Export": v0_export_evidence,
                "v1Configuration": v1_config_evidence,
                "input": {
                    "contract": "explicit-v1-authoring-preserves-v0-intent",
                    "legacyProjectionEqualsAuthoredV1": true,
                    "v1Input": serde_json::to_value(&document).unwrap()
                },
                "environment": current_environment,
                "externalDependencies": {
                    "inferenceEndpoint": "https://integrate.api.nvidia.com/v1",
                    "credentialIssuer": "NVIDIA API key issuer; revoke separately",
                    "containerEngine": "owned local Docker daemon"
                },
                "commands": [
                    "SDK plan",
                    "SDK apply",
                    "OpenShell real-agent probe",
                    "SDK unchanged plan",
                    "SDK unchanged apply",
                    "nemoclaw export --state-dir <owned-state>",
                    "SDK apply <exported-yaml>",
                    "SDK plan_destroy",
                    "nemoclaw destroy --state-dir <owned-state>"
                ],
            }),
        };
        evidence.save();
        evidence.record(
            "bundle",
            serde_json::from_slice::<Value>(&fs::read(bundle.join("manifest.json")).unwrap())
                .unwrap(),
        );

        let deployment = Deployment::new(&directory, &bundle);
        let cancel = CancellationToken::new();
        if fresh {
            let plan = deployment.plan(&document, &cancel).await.unwrap();
            assert!(!plan.changes.is_empty());
            evidence.record("initialPlan", plan);
        } else {
            evidence.record(
                "recovery",
                "reapplied identical pending intent after the recorded failed apply",
            );
        }

        let apply = deployment.apply(&document, &cancel).await.unwrap();
        assert!(!apply.changes.is_empty());
        evidence.record("initialApply", apply);
        let (before, sandbox) = state_bindings(&directory);
        assert_eq!(
            before.keys().map(String::as_str).collect::<Vec<_>>(),
            [
                "nemoclaw_gateway_storage.runtime",
                "nemoclaw_managed_gateway.runtime",
                "nemoclaw_provider.inference",
                "nemoclaw_provider_profile.inference",
                "nemoclaw_sandbox.agent",
                "nemoclaw_workspace.deployment",
            ]
        );
        evidence.record("resourceIdentities", &before);

        let client =
            OpenShell::connect(&document.spec.gateway, Arc::new(EnvironmentSecrets)).unwrap();
        let reply = client.agent_response(&sandbox.unwrap()).await.unwrap();
        assert!(reply.trim_matches(['.', '!']).eq_ignore_ascii_case("FOUR"));
        evidence.record(
            "realAgentVerification",
            json!({"confirmed": true, "reply": reply}),
        );

        let unchanged_plan = deployment.plan(&document, &cancel).await.unwrap();
        assert!(unchanged_plan.changes.is_empty());
        evidence.record("unchangedPlan", unchanged_plan);
        let unchanged_apply = deployment.apply(&document, &cancel).await.unwrap();
        assert!(unchanged_apply.changes.is_empty());
        assert_eq!(state_bindings(&directory).0, before);
        evidence.record("unchangedApply", unchanged_apply);

        let cli = bundle
            .join("bin")
            .join(nemoclaw_sdk::bundle::executable("nemoclaw"));
        let exported_bytes = output(
            Command::new(&cli)
                .args(["export", "--state-dir"])
                .arg(&directory),
        );
        let exported = Document::parse(exported_bytes.as_slice()).unwrap();
        assert_eq!(exported, document);
        evidence.record(
            "desiredStateComparison",
            json!({
                "authoredV1EqualsV1Export": true,
                "v1ExportSha256": sha256(&exported_bytes)
            }),
        );
        fs::write(directory.join("exported.yaml"), &exported_bytes).unwrap();
        let reapplied = deployment.apply(&exported, &cancel).await.unwrap();
        assert!(reapplied.changes.is_empty());
        assert_eq!(state_bindings(&directory).0, before);
        evidence.record("exportReapply", reapplied);

        let destroy_plan = deployment.plan_destroy(&cancel).await.unwrap();
        assert_eq!(
            destroy_plan.retained,
            [
                "nemoclaw_workspace.deployment",
                "nemoclaw_gateway_storage.runtime"
            ]
        );
        evidence.record("destroyPlan", destroy_plan);
        let destroy: Value = serde_json::from_slice(&output(
            Command::new(&cli)
                .args(["destroy", "--state-dir"])
                .arg(&directory),
        ))
        .unwrap();
        evidence.record("destroy", destroy);

        let (retained, sandbox) = state_bindings(&directory);
        assert!(sandbox.is_none());
        assert_eq!(retained.len(), 2);
        for address in [
            "nemoclaw_gateway_storage.runtime",
            "nemoclaw_workspace.deployment",
        ] {
            assert_eq!(retained.get(address), before.get(address));
        }
        evidence.record("retainedResourceIdentities", retained);
        evidence.record(
            "lifecycle",
            "v1 destroy removed workloads and retained owned workspace and gateway storage",
        );
        evidence.record(
            "verdict",
            "separately authored v1 intent matches the raw v0 export projection; its lifecycle and agent behavior are verified",
        );
        evidence.record("passed", true);
    }
}
