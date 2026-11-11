// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The existing hosted OpenClaw case's readiness after replacement on
//! caller-retained volumes. HCL provisions volumes; this probe owns the
//! intermediate destroy and document changes that require the SDK.
use fabric_provider::AgentBridge as _;
use nemoclaw_e2e::state::{runtime_id, sandbox_binding};
use nemoclaw_sdk::{
    CancellationToken, Deployment, EnvironmentSecrets,
    config::{AgentTools, Document},
};
use openshell_provider::OpenShell;
use serde_json::{Value, json};
use std::{env, fs, path::PathBuf, sync::Arc};

const NATIVE_STATE: &str =
    "/sandbox/artifacts/.fabric/state/nvidia.fabric.openclaw/assistant/state/openclaw.sqlite";

async fn command(
    client: &OpenShell,
    binding: &nemoclaw_sdk::backend::Row,
    args: &[&str],
) -> Vec<u8> {
    let (code, bytes) = client
        .exec_bound(
            binding,
            args.iter().map(|s| (*s).into()).collect(),
            Default::default(),
            60,
        )
        .await
        .unwrap();
    assert_eq!(code, 0, "sandbox command failed; output stays private");
    bytes
}

/// A native owner identity is inspected only in memory. Do not publish lease
/// payloads, authentication tables, configuration, or model responses.
async fn usable(
    document: &Document,
    state: &std::path::Path,
    shell: bool,
    marker: &str,
    history: Option<&str>,
) -> (String, String, String) {
    let connection = document.spec.gateway.connection();
    let client = OpenShell::connect(&connection, Arc::new(EnvironmentSecrets)).unwrap();
    let sandbox = sandbox_binding(state, "assistant");
    let binding = fabric_provider::fabric_binding(sandbox.clone()).unwrap();
    let runtime = runtime_id(state, "assistant");
    let nonce = format!("FRESH{}", random_hex());
    let inference_nonce = nonce.clone();
    let reply = client
        .invoke_agent(
            &binding,
            &runtime,
            &json!(format!("Reply with exactly {nonce}. Do not use tools.")),
        )
        .await
        .unwrap();
    assert_eq!(reply["status"], "succeeded");
    assert!(
        reply
            .pointer("/output/response")
            .and_then(Value::as_str)
            .unwrap()
            .contains(&nonce),
        "replacement must answer a fresh inference request"
    );
    // This reads OpenClaw's authoritative native lease, not Fabric readiness or
    // the presence of a database file. Every replacement must publish its owner.
    let identity = command(&client, &sandbox, &["node", "--input-type=module", "-e", r#"
import {DatabaseSync} from 'node:sqlite'; import {hostname} from 'node:os';
const db=new DatabaseSync(process.argv[1],{readOnly:true});
const row=db.prepare("select owner,expires_at,payload_json from state_leases where scope='gateway-owner'").get();
const owner=JSON.parse(row.payload_json).owner;
if(owner.host!==hostname() || row.expires_at<=Date.now()) process.exit(2);
process.kill(owner.pid,0); console.log(row.owner);
"#, NATIVE_STATE]).await;
    assert!(
        !identity.is_empty(),
        "native Gateway must own the retained state"
    );
    let nonce = format!("FILES{}", random_hex());
    let prompt = if shell {
        format!(
            "Use your native exec tool to run `cat /sandbox/workspace/lifecycle-marker && printf '{nonce}' > /sandbox/workspace/lifecycle-result`. Report the marker verbatim. Do not modify the marker."
        )
    } else {
        format!(
            "Use your native file tools to read /sandbox/workspace/lifecycle-marker and write exactly {nonce} to /sandbox/workspace/lifecycle-result. Report the marker verbatim. Do not modify the marker."
        )
    };
    let reply = client
        .invoke_agent(&binding, &runtime, &json!(prompt))
        .await
        .unwrap();
    assert_eq!(reply["status"], "succeeded");
    assert!(
        reply
            .pointer("/output/response")
            .and_then(Value::as_str)
            .unwrap()
            .contains(marker),
        "native tools must read retained data"
    );
    let result = command(
        &client,
        &sandbox,
        &["cat", "/sandbox/workspace/lifecycle-result"],
    )
    .await;
    assert_eq!(
        String::from_utf8(result).unwrap().trim(),
        nonce,
        "native tools must produce a fresh filesystem effect"
    );
    // Inspect only this nonce's native call and the preceding runtime's user
    // turn. A prompted tool name or a retained volume alone proves neither.
    command(&client, &sandbox, &["node", "--input-type=module", "-e", r#"
import {DatabaseSync} from 'node:sqlite'; import {zstdDecompressSync} from 'node:zlib';
const db=new DatabaseSync('/sandbox/artifacts/.fabric/state/nvidia.fabric.openclaw/assistant/agents/default/agent/openclaw-agent.sqlite',{readOnly:true});
const events=db.prepare('select event_json,event_zstd from transcript_events').all().map(row=>JSON.parse(row.event_json??zstdDecompressSync(row.event_zstd).toString()));
const [tool,nonce,history]=process.argv.slice(1);
const called=events.some(event=>event.message?.content?.some?.(part=>part.type==='toolCall' && part.name===tool && JSON.stringify(part.arguments).includes(nonce)));
const retained=!history || events.some(event=>event.message?.role==='user' && JSON.stringify(event.message.content).includes(history));
if(!called || !retained) process.exit(2);
"#, if shell {"exec"} else {"write"}, &nonce, history.unwrap_or("")]).await;
    assert_eq!(
        command(
            &client,
            &sandbox,
            &["cat", "/sandbox/artifacts/lifecycle-marker"]
        )
        .await,
        marker.as_bytes(),
        "caller artifacts must survive replacement"
    );
    (
        runtime,
        String::from_utf8(identity).unwrap(),
        inference_nonce,
    )
}

fn random_hex() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).unwrap();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[tokio::test]
#[ignore = "run by the docker-openclaw-nvidia HCL case with real images, retained volumes, a verified bundle, and hosted inference"]
async fn recreate_and_restore_establish_a_usable_openclaw_runtime() {
    let input = |key: &str| PathBuf::from(env::var(format!("NEMOCLAW_LIFECYCLE_{key}")).unwrap());
    let document = Document::parse(fs::File::open(input("CONFIG")).unwrap()).unwrap();
    assert_eq!(document.spec.sandboxes.len(), 1);
    assert_eq!(
        document.spec.sandboxes["assistant"]
            .harness
            .as_ref()
            .unwrap()
            .kind
            .as_str(),
        "nvidia.fabric.openclaw"
    );
    let state = input("STATE");
    let cli = input("CLI");
    let bundle = cli.parent().unwrap().parent().unwrap();
    let deployment = Deployment::new(&state, bundle);
    let cancel = CancellationToken::new();
    let marker = format!("RETAIN{}", random_hex());
    let client = OpenShell::connect(
        &document.spec.gateway.connection(),
        Arc::new(EnvironmentSecrets),
    )
    .unwrap();
    let binding = sandbox_binding(&state, "assistant");
    command(&client, &binding, &["sh", "-c", "printf '%s' \"$1\" > /sandbox/workspace/lifecycle-marker; printf '%s' \"$1\" > /sandbox/artifacts/lifecycle-marker", "sh", &marker]).await;
    let first = usable(&document, &state, true, &marker, None).await;
    assert!(
        deployment
            .plan(&document, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty(),
        "initial inference and native tools must leave reconciliation unchanged"
    );
    let first_sandbox = sandbox_binding(&state, "assistant");
    deployment.destroy(&cancel).await.unwrap();
    assert!(
        deployment
            .plan_destroy(&cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    deployment.apply(&document, &cancel).await.unwrap();
    let recreated = usable(&document, &state, true, &marker, Some(&first.2)).await;
    assert_ne!(
        first_sandbox["id"],
        sandbox_binding(&state, "assistant")["id"],
        "recreate must replace the sandbox"
    );
    assert_ne!(first.0, recreated.0);
    assert!(
        first.1 != recreated.1,
        "replacement must acquire a new native lease"
    );
    let mut restricted = document.clone();
    restricted
        .spec
        .sandboxes
        .get_mut("assistant")
        .unwrap()
        .agent
        .tools = Some(AgentTools {
        allow: vec!["read".into(), "write".into(), "edit".into()],
    });
    deployment.apply(&restricted, &cancel).await.unwrap();
    let changed = usable(&restricted, &state, false, &marker, Some(&recreated.2)).await;
    assert_ne!(recreated.0, changed.0);
    assert!(
        recreated.1 != changed.1,
        "configuration replacement must acquire its own native lease"
    );
    deployment.apply(&document, &cancel).await.unwrap();
    let restored = usable(&document, &state, true, &marker, Some(&changed.2)).await;
    assert_ne!(changed.0, restored.0);
    assert!(
        changed.1 != restored.1,
        "restored runtime must acquire its own native lease"
    );
    // The existing HCL case checks the restored plan and performs final
    // destroy. The live runner also owns cleanup after a failed probe.
}
