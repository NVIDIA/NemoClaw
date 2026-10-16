// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The reference dummy agent through a complete managed Docker deployment.
//!
//! The dummy implements the image's bridge contract, including native health,
//! without Fabric, a model, or credentials. It shows that NemoClaw's side of
//! the readiness path completes apply when an image reports health; it does
//! not qualify a production adapter's health.

use fabric_provider::AgentBridge as _;
use nemoclaw_sdk::{
    CancellationToken, Deployment, OperationResult, Outcome,
    backend::Row,
    config::{ComputeDriver, Document, Gateway},
};
use openshell_provider::{EnvironmentSecrets, OpenShell};
use serde_json::Value;
use std::{fs, path::Path, process::Command, sync::Arc};

fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}

/// The deployment's only sandbox binding, from its OpenTofu state.
fn sandbox_binding(directory: &Path) -> Row {
    let state: Value =
        serde_json::from_slice(&fs::read(directory.join("terraform.tfstate")).unwrap()).unwrap();
    let mut sandboxes = state["resources"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|resource| {
            resource["mode"] == "managed" && resource["type"] == "openshell_sandbox"
        });
    let sandbox = sandboxes.next().expect("one sandbox binding");
    assert!(sandboxes.next().is_none(), "expected one sandbox binding");
    // Convert typed refs to the row fields the gateway client expects.
    let mut attributes = sandbox["instances"][0]["attributes"].clone();
    nemoclaw_openshell::flatten("openshell_sandbox", &mut attributes);
    attributes
        .as_object()
        .unwrap()
        .iter()
        .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
        .collect()
}

async fn runtime_id(client: &OpenShell, binding: &Row) -> String {
    let snapshot = client.agent_snapshot(binding).await.unwrap();
    assert_eq!(snapshot.runtime_state, "running");
    let identity = snapshot
        .runtime_id
        .expect("a running runtime has an identity");
    assert!(!identity.trim().is_empty());
    identity
}

/// Send one request through the image's bridge and return the agent's reply.
async fn invoke(client: &OpenShell, binding: &Row, agent: &str, message: &str) -> Value {
    let input = serde_json::json!({ "message": message }).to_string();
    let (exit, output) = client
        .exec_input(
            binding,
            ["fabric-agent", "invoke", "--agent", agent, "--input", "-"]
                .map(String::from)
                .to_vec(),
            Row::new(),
            60,
            input.into_bytes(),
        )
        .await
        .unwrap();
    assert_eq!(
        exit,
        0,
        "invoke failed: {}",
        String::from_utf8_lossy(&output)
    );
    serde_json::from_slice(&output).unwrap()
}

/// IDs of the engine's objects of `kind` matching `filter`.
fn docker_objects(engine: &str, kind: &str, filter: &str) -> Vec<String> {
    let mut command = Command::new("docker");
    command.args(["--host", engine, kind, "ls", "--quiet", "--filter", filter]);
    if kind == "container" {
        command.arg("--all");
    }
    let output = command.output().unwrap();
    assert!(output.status.success(), "docker {kind} ls failed");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::to_owned)
        .collect()
}

/// Keeps the state directory when the test fails, so `nemoclaw destroy` can
/// still remove what it created.
struct KeepOnFailure(Option<tempfile::TempDir>);

impl Drop for KeepOnFailure {
    fn drop(&mut self) {
        if std::thread::panicking()
            && let Some(state) = self.0.take()
        {
            eprintln!("kept the deployment state at {}", state.keep().display());
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified bundle, the dummy image on local Docker, and an owned managed-gateway document; creates Docker resources and retains gateway storage"]
async fn the_dummy_agent_completes_a_managed_docker_lifecycle() {
    let config = required("NEMOCLAW_TEST_DUMMY_DOCUMENT");
    let bundle = std::path::PathBuf::from(required("NEMOCLAW_TEST_BUNDLE"));
    let document = Document::parse(fs::File::open(&config).unwrap()).unwrap();
    assert!(matches!(document.spec.gateway, Gateway::Managed(_)));
    assert_eq!(
        document.spec.gateway.runtime().provider,
        ComputeDriver::Docker
    );
    let sandbox = &document.spec.sandboxes[0];
    let harness = document.sandbox_harness(sandbox).unwrap();
    assert_eq!(harness.kind, "org.nemoclaw.dummy".parse().unwrap());
    // The dummy replies with this setting, so the reply shows that apply
    // delivered the authored native settings to the running agent.
    let configured_reply = harness
        .settings
        .as_ref()
        .and_then(|settings| settings.get("reply"))
        .and_then(|reply| reply.as_str())
        .expect("the document sets harness.settings.reply")
        .to_owned();
    let resource = format!("openshell_sandbox.{}", sandbox.name);
    let Gateway::Managed(gateway) = &document.spec.gateway else {
        unreachable!()
    };
    let engine = gateway.engine.clone();
    let state = KeepOnFailure(Some(tempfile::tempdir().unwrap()));
    let state_path = state.0.as_ref().unwrap().path().to_owned();
    let deployment = Deployment::new(&state_path, &bundle);
    let cancel = CancellationToken::new();

    let plan = deployment.plan(&document, &cancel).await.unwrap();
    assert_eq!(plan.outcome, Outcome::Planned);
    // One plan creates the managed gateway and the sandbox it will serve.
    assert!(
        plan.changes
            .iter()
            .any(|change| change.resource == resource),
        "plan must create the sandbox: {:?}",
        plan.changes
    );
    assert!(
        plan.changes
            .iter()
            .any(|change| change.resource == "openshell_gateway_storage.runtime"),
        "plan must create the gateway storage: {:?}",
        plan.changes
    );

    // The bundled CLI's exit status is what an operator sees.
    let apply = Command::new(
        bundle
            .join("bin")
            .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
    )
    .args(["apply", "-o", "json", "--progress", "off", "--state-dir"])
    .arg(&state_path)
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
    assert!(
        applied
            .changes
            .iter()
            .any(|change| change.resource == resource),
        "apply must create the sandbox: {:?}",
        applied.changes
    );
    assert_eq!(applied.health.len(), 1);
    assert!(applied.health[0].health.allows_apply_completion());

    let client = OpenShell::connect(
        &document.spec.gateway.connection(),
        Arc::new(EnvironmentSecrets),
    )
    .unwrap();
    let binding = fabric_provider::fabric_binding(sandbox_binding(&state_path)).unwrap();
    let runtime = runtime_id(&client, &binding).await;
    let reply = invoke(&client, &binding, &sandbox.agent.name, "dummy-lifecycle").await;
    assert_eq!(reply["status"], "succeeded", "{reply}");
    assert_eq!(
        reply["result"]["fabric_result"]["status"], "succeeded",
        "{reply}"
    );
    assert_eq!(
        reply["result"]["fabric_result"]["output"]["message"], configured_reply,
        "{reply}"
    );

    let unchanged = deployment.apply(&document, &cancel).await.unwrap();
    assert_eq!(unchanged.outcome, Outcome::Succeeded);
    assert!(unchanged.changes.is_empty(), "{:?}", unchanged.changes);
    let exported = deployment.export(&cancel).await.unwrap();
    assert_eq!(exported, document);
    let reapplied = deployment.apply(&exported, &cancel).await.unwrap();
    assert_eq!(reapplied.outcome, Outcome::Succeeded);
    assert!(reapplied.changes.is_empty(), "{:?}", reapplied.changes);
    assert_eq!(
        runtime_id(&client, &binding).await,
        runtime,
        "unchanged applies must keep the running agent"
    );

    let destroyed = deployment.destroy(&cancel).await.unwrap();
    assert_eq!(destroyed.outcome, Outcome::Destroyed);
    assert!(
        destroyed
            .changes
            .iter()
            .any(|change| change.resource == resource),
        "destroy must remove the sandbox: {:?}",
        destroyed.changes
    );
    // The gateway is gone too, so an unanswered agent would not show that the
    // sandbox is; Docker must hold none of the gateway's sandbox objects.
    let sandbox_objects = format!(
        "label=openshell.ai/sandbox-namespace={}-gateway",
        document.workspace()
    );
    for kind in ["container", "volume"] {
        assert_eq!(
            docker_objects(&engine, kind, &sandbox_objects),
            Vec::<String>::new(),
            "destroy left sandbox {kind}s"
        );
    }
    let mut retained = destroyed.retained.clone();
    retained.sort();
    assert_eq!(
        retained,
        [
            "openshell_gateway_storage.runtime",
            "openshell_workspace.deployment"
        ]
    );
    // Retained gateway storage is still on the engine.
    assert!(
        !docker_objects(
            &engine,
            "volume",
            &format!("label=nemoclaw.nvidia.com/uid={}", document.metadata.uid)
        )
        .is_empty(),
        "destroy removed the retained gateway storage"
    );
}

#[test]
fn sandbox_binding_preserves_the_workspace_from_its_typed_reference() {
    let directory = tempfile::tempdir().unwrap();
    let state = serde_json::json!({
        "resources": [{
            "mode": "managed",
            "type": "openshell_sandbox",
            "instances": [{"attributes": {
                "name": "assistant",
                "id": "sandbox-id",
                "owner": "owner",
                "generation": "generation",
                "workspace": {
                    "type": "openshell_workspace",
                    "name": "workspace",
                    "id": "workspace-id",
                    "owner": "owner",
                    "generation": "workspace-generation"
                }
            }}]
        }]
    });
    fs::write(
        directory.path().join("terraform.tfstate"),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    assert_eq!(
        sandbox_binding(directory.path()),
        Row::from([
            ("name".into(), "assistant".into()),
            ("id".into(), "sandbox-id".into()),
            ("owner".into(), "owner".into()),
            ("generation".into(), "generation".into()),
            ("workspace".into(), "workspace".into()),
        ])
    );
}
