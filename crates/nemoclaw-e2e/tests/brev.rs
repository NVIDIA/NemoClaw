// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    CancellationToken, Change, Deployment, OperationResult, Outcome,
    backend::Row,
    config::Document,
    openshell::{EnvironmentSecrets, OpenShell},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

fn explicit_path(name: &str) -> PathBuf {
    let path = PathBuf::from(std::env::var_os(name).expect(name));
    assert!(path.is_absolute(), "{name} must be an absolute path");
    path
}

fn assert_changes(actual: &[Change], expected: &[&str], action: &str) {
    assert!(
        actual
            .iter()
            .all(|change| change.actions == [action.to_owned()]),
        "unexpected change action: {actual:?}"
    );
    assert_eq!(
        actual
            .iter()
            .map(|change| change.resource.as_str())
            .collect::<BTreeSet<_>>(),
        expected.iter().copied().collect::<BTreeSet<_>>()
    );
}

fn docker_inventory() -> Value {
    let inventory = [
        ("containers", vec!["ps", "--all", "--quiet", "--no-trunc"]),
        ("networks", vec!["network", "ls", "--quiet", "--no-trunc"]),
        ("volumes", vec!["volume", "ls", "--quiet"]),
    ]
    .into_iter()
    .map(|(kind, arguments)| {
        let output = Command::new("docker").args(arguments).output().unwrap();
        assert!(
            output.status.success(),
            "docker {kind} inventory failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut ids = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        ids.sort();
        (kind.into(), json!(ids))
    })
    .collect::<serde_json::Map<_, _>>();
    Value::Object(inventory)
}

fn bindings(directory: &Path) -> (Value, Row) {
    let state: Value =
        serde_json::from_slice(&fs::read(directory.join("terraform.tfstate")).unwrap()).unwrap();
    let mut ids = serde_json::Map::new();
    let mut sandbox = None;
    for resource in state["resources"].as_array().unwrap() {
        let instances = resource["instances"].as_array().unwrap();
        assert_eq!(instances.len(), 1);
        let attributes = &instances[0]["attributes"];
        ids.insert(
            format!(
                "{}.{}",
                resource["type"].as_str().unwrap(),
                resource["name"].as_str().unwrap()
            ),
            attributes["id"].clone(),
        );
        if resource["type"] == "nemoclaw_sandbox" {
            assert!(
                sandbox
                    .replace(serde_json::from_value(attributes.clone()).unwrap())
                    .is_none(),
                "expected one sandbox binding"
            );
        }
    }
    (Value::Object(ids), sandbox.unwrap())
}

async fn exec(client: &OpenShell, binding: &Row, command: Vec<String>) -> Vec<u8> {
    let (exit, output) = client
        .exec_bound(binding, command, Row::new(), 360)
        .await
        .unwrap();
    assert_eq!(exit, 0, "sandbox command failed");
    output
}

async fn runtime_id(client: &OpenShell, binding: &Row) -> String {
    let output = exec(
        client,
        binding,
        [
            "/opt/fabric/bin/python",
            "-c",
            "import socket; s=socket.socket(socket.AF_UNIX); s.connect('/sandbox/fabric.sock'); s.sendall(b'{\"operation\":\"check\"}\\n'); print(s.makefile().readline())",
        ]
        .map(String::from)
        .to_vec(),
    )
    .await;
    let value: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(value["ready"], true);
    value["runtime_id"].as_str().unwrap().into()
}

async fn openclaw_reply(client: &OpenShell, binding: &Row, agent: &str, key: &str) -> Vec<u8> {
    let params = json!({
        "agentId": agent,
        "sessionKey": format!("agent:{agent}:{key}"),
        "message": "Reply with exactly the word FOUR.",
        "idempotencyKey": key,
        "deliver": false
    })
    .to_string();
    exec(
        client,
        binding,
        [
            "openclaw",
            "gateway",
            "call",
            "agent",
            "--params",
            &params,
            "--expect-final",
            "--json",
            "--timeout",
            "280000",
        ]
        .map(String::from)
        .to_vec(),
    )
    .await
}

fn confirmed_openclaw_reply(response: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(response) else {
        return false;
    };
    let Some(payloads) = value["result"]["payloads"].as_array() else {
        return false;
    };
    value["status"] == "ok"
        && value["error"].is_null()
        && !payloads.is_empty()
        && payloads.iter().all(|payload| payload["isError"] != true)
        && payloads[0]["text"].as_str().is_some_and(|text| {
            text.trim()
                .trim_end_matches(['.', '!'])
                .eq_ignore_ascii_case("FOUR")
        })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a fresh owned bare Brev AMD64 VM, hosted inference credential, explicit config, unused state path, and verified bundle; destroys workloads and retains deployment storage"]
async fn bare_brev_hosted_openclaw_lifecycle() {
    assert_eq!(std::env::consts::ARCH, "x86_64");
    let config = explicit_path("NEMOCLAW_LIVE_BREV_CONFIG");
    let directory = explicit_path("NEMOCLAW_LIVE_BREV_STATE");
    let bundle = explicit_path("NEMOCLAW_TEST_BUNDLE");
    let document = Document::parse(fs::File::open(&config).unwrap()).unwrap();
    assert_eq!(document.spec.gateway.management, "managed");
    assert_eq!(document.spec.sandboxes[0].runtime.provider, "docker");
    assert_eq!(
        document
            .sandbox_harness(&document.spec.sandboxes[0])
            .unwrap()
            .kind,
        "openclaw"
    );
    let providers = document.selected_inference_providers().unwrap();
    assert_eq!(providers.len(), 1);
    assert!(providers[0].service_ref.is_none());
    fs::create_dir(&directory).expect("Brev test requires a new state directory");
    let deployment = Deployment::new(&directory, &bundle);
    let cancel = CancellationToken::new();

    let before_plan = docker_inventory();
    let plan = deployment.plan(&document, &cancel).await.unwrap();
    assert_eq!(plan.outcome, Outcome::Planned);
    let image_resource = plan
        .changes
        .iter()
        .find(|change| change.resource.starts_with("docker_image.image_"))
        .expect("plan must include the immutable managed gateway image")
        .resource
        .clone();
    assert_changes(
        &plan.changes,
        &[
            "docker_container.managed_gateway_runtime",
            image_resource.as_str(),
            "nemoclaw_gateway_storage.runtime",
        ],
        "create",
    );
    assert_eq!(
        plan.deferred,
        ["OpenShell registration and sandbox require the managed gateway"]
    );
    assert!(plan.retained.is_empty());
    assert!(plan.health.is_empty());
    assert_eq!(docker_inventory(), before_plan, "plan mutated Docker");

    let executable = bundle
        .join("bin")
        .join(nemoclaw_sdk::bundle::executable("nemoclaw"));
    // The hosted runtime must outlive the real CLI process. Do not replace this
    // with an in-process apply: the reply below is intentionally requested only
    // after the apply command has exited.
    let apply = Command::new(executable)
        .args(["apply", "--state-dir"])
        .arg(&directory)
        .arg(&config)
        .output()
        .unwrap();
    assert!(
        apply.status.success(),
        "apply failed: {}",
        String::from_utf8_lossy(&apply.stderr)
    );
    let applied: OperationResult = serde_json::from_slice(&apply.stdout).unwrap();
    assert_eq!(applied.outcome, Outcome::Succeeded);
    assert_changes(
        &applied.changes,
        &[
            "docker_container.managed_gateway_runtime",
            image_resource.as_str(),
            "nemoclaw_gateway_storage.runtime",
            "nemoclaw_provider.inference_hosted-nvidia-prod",
            "nemoclaw_provider_profile.inference_hosted-nvidia-prod",
            "nemoclaw_sandbox.assistant",
            "nemoclaw_workspace.deployment",
        ],
        "create",
    );
    assert!(applied.deferred.is_empty());
    assert!(applied.retained.is_empty());
    assert_eq!(applied.health.len(), 1);
    assert!(applied.health[0].health.allows_apply_completion());

    let client = OpenShell::connect(&document.spec.gateway, Arc::new(EnvironmentSecrets)).unwrap();
    client
        .verify_gateway(&document.spec.sandboxes[0].runtime.provider)
        .await
        .unwrap();
    let (before, binding) = bindings(&directory);
    let hosted_runtime = runtime_id(&client, &binding).await;
    let response = openclaw_reply(
        &client,
        &binding,
        &document.spec.sandboxes[0].agent.name,
        &format!("{}-brev", document.metadata.uid),
    )
    .await;
    assert!(
        confirmed_openclaw_reply(&response),
        "no confirmed hosted agent reply"
    );

    let proof_path = "/sandbox/workspace/brev-reconciliation-proof";
    let create_proof = format!("printf preserved > {proof_path}");
    let output = exec(
        &client,
        &binding,
        vec!["sh".into(), "-c".into(), create_proof],
    )
    .await;
    assert!(output.is_empty());
    let denial = exec(
        &client,
        &binding,
        [
            "/opt/fabric/bin/python",
            "-c",
            "import urllib.error,urllib.request\ntry: urllib.request.urlopen('https://example.com',timeout=15)\nexcept urllib.error.URLError as e:\n assert '403' in str(e), str(e)\n print('policy-denied-403')\nelse: raise AssertionError('undeclared egress was allowed')",
        ]
        .map(String::from)
        .to_vec(),
    )
    .await;
    assert_eq!(
        String::from_utf8(denial).unwrap().trim(),
        "policy-denied-403"
    );

    let unchanged = deployment.apply(&document, &cancel).await.unwrap();
    assert_eq!(unchanged.outcome, Outcome::Succeeded);
    assert!(unchanged.changes.is_empty());
    let exported = deployment.export(&cancel).await.unwrap();
    assert_eq!(exported, document);
    assert!(
        deployment
            .apply(&exported, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(bindings(&directory).0, before);
    assert_eq!(runtime_id(&client, &binding).await, hosted_runtime);
    let proof = exec(
        &client,
        &binding,
        ["cat", proof_path].map(String::from).to_vec(),
    )
    .await;
    assert_eq!(String::from_utf8(proof).unwrap(), "preserved");

    let removed = [
        "docker_container.managed_gateway_runtime",
        image_resource.as_str(),
        "nemoclaw_provider.inference_hosted-nvidia-prod",
        "nemoclaw_provider_profile.inference_hosted-nvidia-prod",
        "nemoclaw_sandbox.assistant",
    ];
    let retained = vec![
        "nemoclaw_workspace.deployment".into(),
        "nemoclaw_gateway_storage.runtime".into(),
    ];
    let destroy_plan = deployment.plan_destroy(&cancel).await.unwrap();
    assert_eq!(destroy_plan.outcome, Outcome::Planned);
    assert_changes(&destroy_plan.changes, &removed, "delete");
    assert!(destroy_plan.deferred.is_empty());
    assert_eq!(destroy_plan.retained, retained);
    assert!(destroy_plan.health.is_empty());
    let destroyed = deployment.destroy(&cancel).await.unwrap();
    assert_eq!(destroyed.outcome, Outcome::Destroyed);
    assert_changes(&destroyed.changes, &removed, "delete");
    assert!(destroyed.deferred.is_empty());
    assert_eq!(
        destroyed.retained,
        vec![
            "nemoclaw_workspace.deployment".into(),
            "nemoclaw_gateway_storage.runtime".into(),
        ]
    );
    assert!(destroyed.health.is_empty());
    fs::write(
        directory.join("brev-proof.json"),
        serde_json::to_vec_pretty(&json!({
            "schemaVersion": 1,
            "passed": true,
            "platform": "linux_amd64",
            "planWasReadOnly": true,
            "hostedAgentReply": true,
            "undeclaredEgressDenied": true,
            "workspaceFilePreserved": true,
            "resourceIdentitiesPreserved": true,
            "runtimeIdentityPreserved": true,
            "exportReapplyUnchanged": true,
            "workloadsDestroyed": true,
            "workspaceAndGatewayStorageRetained": true
        }))
        .unwrap(),
    )
    .unwrap();
}
