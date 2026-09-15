// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::Document;
use sha2::{Digest, Sha256};

const V0_REVISION: &str = "f47724f29838fe08898993fad1c8c6b7fcb3e080";
const V0_MANIFEST_SHA256: &str = "35c28e708e5a89a77a52fd91cbd587c1c39621014bed096464c36bbc37409b9b";

#[test]
fn hosted_openclaw_scenario_pins_the_v0_input_and_closest_v1_desired_state() {
    let v0 = include_bytes!("../fixtures/openclaw-nvidia-hosted/v0.yaml");
    let digest = Sha256::digest(v0)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    assert_eq!(digest, V0_MANIFEST_SHA256);
    assert_eq!(V0_REVISION.len(), 40);

    let v1 =
        Document::parse(include_bytes!("../fixtures/openclaw-nvidia-hosted/v1.yaml").as_slice())
            .unwrap();
    let gateway = &v1.spec.gateway;
    assert_eq!(gateway.management, "managed");
    assert_eq!(gateway.engine, "unix:///var/run/docker.sock");

    let provider = &v1.spec.inference_providers[0];
    assert_eq!(provider.provider, "openai");
    assert_eq!(provider.endpoint, "https://integrate.api.nvidia.com/v1");
    assert_eq!(
        provider.credential.as_ref().unwrap().env,
        "NVIDIA_INFERENCE_API_KEY"
    );
    assert!(provider.service.is_none());
    assert!(provider.ollama.is_none());

    let sandbox = &v1.spec.sandboxes[0];
    assert_eq!(sandbox.runtime.provider, "docker");
    assert_eq!(sandbox.network.tier, "isolated");
    let agent = &sandbox.agents[0];
    assert_eq!(agent.harness, "openclaw");
    assert_eq!(agent.inference.routes[0].provider_ref, provider.name);
    assert_eq!(
        agent.inference.routes[0].overrides.model,
        "nvidia/nemotron-3-super-120b-a12b"
    );
}

mod live {
    use super::{V0_MANIFEST_SHA256, V0_REVISION};
    use nemoclaw_sdk::{
        CancellationToken, Deployment,
        backend::Row,
        config::Document,
        openshell::{EnvironmentSecrets, OpenShell},
    };
    use serde_json::{Value, json};
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

    fn validate_v0_proof(proof: &Value) {
        assert_eq!(proof["scenario"], SCENARIO);
        assert_eq!(proof["revision"], V0_REVISION);
        assert_eq!(proof["manifestSha256"], V0_MANIFEST_SHA256);
        assert_eq!(proof["target"], "ubuntu-repo-cloud-openclaw");
        assert_eq!(proof["platform"]["os"], "linux");
        assert!(
            proof["platform"]["architecture"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        );
        assert!(
            proof["platform"]["kernel"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        );
        assert_eq!(proof["runtime"]["containerEngine"], "docker");
        for field in [
            "dockerClientVersion",
            "dockerServerVersion",
            "dockerDaemonId",
        ] {
            assert!(
                proof["runtime"][field]
                    .as_str()
                    .is_some_and(|value| !value.is_empty())
            );
        }
        assert_eq!(proof["model"]["id"], "nvidia/nemotron-3-super-120b-a12b");
        for field in [
            "passed",
            "realAgentResponse",
            "destroyed",
            "ownedResourcesOnly",
            "redacted",
        ] {
            assert_eq!(proof[field], true, "v0 proof must establish {field}");
        }
        for field in [
            "input",
            "platform",
            "runtime",
            "images",
            "model",
            "artifacts",
        ] {
            assert!(
                proof[field]
                    .as_object()
                    .is_some_and(|value| !value.is_empty()),
                "v0 proof must record nonempty {field}"
            );
        }
        assert!(
            proof["commands"]
                .as_array()
                .is_some_and(|value| !value.is_empty()),
            "v0 proof must record nonempty commands"
        );
    }

    fn complete_v0_proof() -> Value {
        json!({
            "scenario": SCENARIO,
            "revision": V0_REVISION,
            "manifestSha256": V0_MANIFEST_SHA256,
            "target": "ubuntu-repo-cloud-openclaw",
            "passed": true,
            "realAgentResponse": true,
            "destroyed": true,
            "ownedResourcesOnly": true,
            "redacted": true,
            "input": {"credentialRefs": ["NVIDIA_INFERENCE_API_KEY"]},
            "platform": {"os": "linux", "architecture": "amd64", "kernel": "Linux"},
            "runtime": {
                "containerEngine": "docker",
                "dockerClientVersion": "1",
                "dockerServerVersion": "1",
                "dockerDaemonId": "owned-daemon"
            },
            "images": {"sandbox": "image@sha256:digest"},
            "model": {"id": "nvidia/nemotron-3-super-120b-a12b"},
            "commands": ["redacted focused command"],
            "artifacts": {"proof.json": "sha256"}
        })
    }

    #[test]
    fn v0_proof_requires_real_agent_destroy_and_reproducibility_evidence() {
        validate_v0_proof(&complete_v0_proof());
        for missing in ["realAgentResponse", "destroyed", "ownedResourcesOnly"] {
            let mut incomplete = complete_v0_proof();
            incomplete[missing] = json!(false);
            assert!(std::panic::catch_unwind(|| validate_v0_proof(&incomplete)).is_err());
        }
    }

    fn validate_live_document(document: &Document) {
        let mut expected = Document::parse(
            include_bytes!("../fixtures/openclaw-nvidia-hosted/v1.yaml").as_slice(),
        )
        .unwrap();
        assert_ne!(document.metadata.uid, expected.metadata.uid);
        expected.metadata.uid.clone_from(&document.metadata.uid);
        expected.spec.gateway.endpoint = document.spec.gateway.endpoint.clone();
        expected.spec.gateway.network_cidr = document.spec.gateway.network_cidr.clone();
        assert_eq!(
            document, &expected,
            "live input changed the parity contract"
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
            "dockerClientVersion": docker(&["version", "--format", "{{.Client.Version}}"]),
            "dockerServerVersion": docker(&["version", "--format", "{{.Server.Version}}"]),
            "dockerServerOs": docker(&["version", "--format", "{{.Server.Os}}"]),
            "dockerServerArchitecture": docker(&["version", "--format", "{{.Server.Arch}}"]),
            "dockerDaemonId": docker(&["info", "--format", "{{.ID}}"]),
        })
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires the exact live parity gate, owned fresh Linux/Docker state, a verified bundle, redacted v0 proof, and NVIDIA_INFERENCE_API_KEY; creates and destroys only that deployment"]
    async fn pinned_v0_and_v1_hosted_openclaw_lifecycles_produce_a_parity_verdict() {
        assert_eq!(std::env::consts::OS, "linux", "scenario requires Linux");
        assert_eq!(
            std::env::var("NEMOCLAW_RUN_LIVE_HOSTED_PARITY").as_deref(),
            Ok("issue-11810"),
            "set the issue-specific live acknowledgement"
        );
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
        assert!(
            text(Command::new("git").args(["status", "--short"])).is_empty(),
            "live evidence requires a clean v1 checkout"
        );

        let config = explicit("NEMOCLAW_LIVE_HOSTED_CONFIG");
        let directory = explicit("NEMOCLAW_LIVE_HOSTED_STATE");
        let bundle = explicit("NEMOCLAW_TEST_BUNDLE");
        let v0_proof_path = explicit("NEMOCLAW_LIVE_V0_PROOF");
        let document = Document::parse(fs::File::open(&config).unwrap()).unwrap();
        validate_live_document(&document);

        let ownership: Value = serde_json::from_slice(
            &fs::read(directory.join("ownership.json"))
                .expect("state directory must contain the explicit ownership marker"),
        )
        .unwrap();
        assert_eq!(ownership["scenario"], SCENARIO);
        assert_eq!(ownership["deploymentUid"], document.metadata.uid);
        assert_eq!(ownership["owned"], true);
        assert!(
            !directory.join("terraform.tfstate").exists()
                && !directory.join("runtime/terraform.tfstate").exists(),
            "this entrypoint requires fresh owned state"
        );

        let v0_proof_bytes = fs::read(v0_proof_path).unwrap();
        assert_redacted(&v0_proof_bytes);
        let v0_proof: Value = serde_json::from_slice(&v0_proof_bytes).unwrap();
        validate_v0_proof(&v0_proof);

        let mut evidence = Evidence {
            path: directory.join("openclaw-nvidia-hosted-parity.json"),
            value: json!({
                "scenario": SCENARIO,
                "parentIssue": "NVIDIA/NemoClaw#11810",
                "passed": false,
                "startedEpoch": now(),
                "revisions": {"v0": V0_REVISION, "v1": v1_revision},
                "v0ManifestSha256": V0_MANIFEST_SHA256,
                "credentialInputs": {"NVIDIA_INFERENCE_API_KEY": "environment reference; value omitted"},
                "v0Proof": v0_proof,
                "v1Input": serde_json::to_value(&document).unwrap(),
                "environment": environment(),
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
        let plan = deployment.plan(&document, &cancel).await.unwrap();
        assert!(!plan.changes.is_empty());
        evidence.record("initialPlan", plan);

        let apply = deployment.apply(&document, &cancel).await.unwrap();
        assert!(!apply.changes.is_empty());
        evidence.record("initialApply", apply);
        let (before, sandbox) = state_bindings(&directory);
        assert_eq!(before.len(), 6);
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
            "architecturalDifference",
            "v0 personal policy allows reviewed general web access; the closest v1 fixture uses isolated inference-only routing",
        );
        evidence.record(
            "verdict",
            "Equivalent with an intentional architectural difference",
        );
        evidence.record("passed", true);
    }
}
