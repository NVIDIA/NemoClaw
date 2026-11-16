// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! After apply, the result tells a person how to reach each enabled agent
//! interface: the port to forward, where its token is, and how to sign in.
//! Scripted OpenTofu supplies the runtime IDs that the provider records; this
//! does not establish that the interfaces serve.

#![cfg(unix)]

use crate::scripted_tofu::{Scripted, placeholder_generations, plan_json};
use nemoclaw_sdk::{
    CancellationToken, InterfaceAccess, Outcome, SignIn, compile, config::Document,
};
use serde_json::{Value, json};

/// Two sandboxes: OpenClaw with its dashboard, and Hermes with its API server
/// and a disabled dashboard.
fn document() -> Document {
    let mut value = crate::support::fixture("local.yaml");
    let mut hermes = value["spec"]["sandboxes"]["assistant"].clone();
    hermes["harness"] = json!({"kind": "nvidia.fabric.hermes", "settings": {"interfaces": {
        "api": {"port": 8642}, "dashboard": {"enabled": false, "port": 9119}}}});
    value["spec"]["sandboxes"]["reviewer"] = hermes;
    value["spec"]["sandboxes"]["assistant"]["harness"]["settings"] =
        json!({"interfaces": {"dashboard": {"port": 18789}}});
    Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap()
}

/// `show -json` state recording each sandbox's agent and the runtime ID Fabric
/// gave it, as the Fabric provider's state does.
fn agents_state(runtimes: &[(&str, &str)]) -> String {
    let resources: Vec<Value> = runtimes
        .iter()
        .map(|(sandbox, runtime)| {
            json!({"address": format!("fabric_agent.{sandbox}"), "mode": "managed",
                "values": {"id": format!("agent-{sandbox}"), "name": "main", "runtime_id": runtime,
                    "sandbox": {"name": sandbox, "workspace": "w", "id": format!("sandbox-{sandbox}")}}})
        })
        .collect();
    json!({"format_version": "1.0", "values": {"root_module": {"resources": resources}}})
        .to_string()
}

async fn apply(document: &Document, runtimes: &[(&str, &str)]) -> nemoclaw_sdk::OperationResult {
    let scripted = Scripted::new();
    let declared = compile::targets(document, &placeholder_generations()).unwrap();
    scripted.set("root.apply.plan", plan_json(&declared, "create"));
    scripted.set("root.state", agents_state(runtimes));
    let result = scripted
        .deployment(&scripted.path("unused-kubeconfig"))
        .apply(document, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result.outcome, Outcome::Succeeded);
    result
}

#[tokio::test]
async fn apply_reports_each_enabled_interface_with_its_token_path_and_sign_in() {
    let result = apply(
        &document(),
        &[("assistant", "rt-openclaw-1"), ("reviewer", "rt-hermes-1")],
    )
    .await;
    assert_eq!(
        result.interfaces,
        [
            InterfaceAccess {
                sandbox: "assistant".into(),
                interface: "dashboard".into(),
                port: Some(18789),
                token_path: Some(
                    "/sandbox/artifacts/.fabric/openclaw/runtimes/rt-openclaw-1/interfaces/dashboard.token"
                        .into()
                ),
                    sign_in: SignIn::TokenInUrlFragment,
                terminal: Some("openclaw tui --url ws://127.0.0.1:18789 --token TOKEN".into()),
            },
            InterfaceAccess {
                sandbox: "reviewer".into(),
                interface: "api".into(),
                port: Some(8642),
                // Hermes keeps its state, with the token, in the agent's folder.
                token_path: Some(
                    "/sandbox/artifacts/.fabric/state/nvidia.fabric.hermes/main/interfaces/api.token"
                        .into()
                ),
                    sign_in: SignIn::BearerToken,
                terminal: None,
            },
        ]
    );
    // The JSON result carries the same facts under one key.
    let json = serde_json::to_value(&result).unwrap();
    assert_eq!(
        json["interfaces"][1]["tokenPath"],
        "/sandbox/artifacts/.fabric/state/nvidia.fabric.hermes/main/interfaces/api.token"
    );
    assert_eq!(json["interfaces"][1]["signIn"], "bearer_token");
    assert_eq!(
        json["interfaces"][0]["terminal"],
        "openclaw tui --url ws://127.0.0.1:18789 --token TOKEN"
    );
}

/// An agent that keeps its state has one token path for every runtime, so it is
/// known even before a runtime ID is recorded.
#[tokio::test]
async fn an_agent_that_keeps_its_state_reports_its_token_without_a_runtime_id() {
    let result = apply(&document(), &[("assistant", ""), ("reviewer", "")]).await;
    let hermes = result
        .interfaces
        .iter()
        .find(|access| access.sandbox == "reviewer")
        .unwrap();
    assert_eq!(
        hermes.token_path.as_deref(),
        Some("/sandbox/artifacts/.fabric/state/nvidia.fabric.hermes/main/interfaces/api.token")
    );
    let openclaw = result
        .interfaces
        .iter()
        .find(|access| access.sandbox == "assistant")
        .unwrap();
    assert_eq!(openclaw.token_path, None);
    // The terminal command names no token file, so it needs no runtime ID.
    assert_eq!(
        openclaw.terminal.as_deref(),
        Some("openclaw tui --url ws://127.0.0.1:18789 --token TOKEN")
    );
}

/// Hermes's dashboard has no token or sign-in: the forward is its access control.
#[tokio::test]
async fn an_interface_without_a_token_reports_no_token_path() {
    let mut value = serde_json::to_value(document()).unwrap();
    value["spec"]["sandboxes"]["reviewer"]["harness"]["settings"] =
        json!({"interfaces": {"dashboard": {"port": 9119}}});
    value["spec"]["sandboxes"]["assistant"]["harness"]
        .as_object_mut()
        .unwrap()
        .remove("settings");
    let document = Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap();
    let result = apply(
        &document,
        &[("assistant", "rt-openclaw-1"), ("reviewer", "rt-hermes-1")],
    )
    .await;
    assert_eq!(
        result.interfaces,
        [InterfaceAccess {
            sandbox: "reviewer".into(),
            interface: "dashboard".into(),
            port: Some(9119),
            token_path: None,
            sign_in: SignIn::None,
            terminal: None,
        }]
    );
}

/// Without interfaces, the result has none and its JSON omits the key.
#[tokio::test]
async fn a_deployment_without_interfaces_reports_none() {
    let document = Document::parse(
        serde_json::to_vec(&crate::support::fixture("local.yaml"))
            .unwrap()
            .as_slice(),
    )
    .unwrap();
    let result = apply(&document, &[("assistant", "rt-openclaw-1")]).await;
    assert!(result.interfaces.is_empty());
    assert!(
        serde_json::to_value(&result)
            .unwrap()
            .get("interfaces")
            .is_none()
    );
}
