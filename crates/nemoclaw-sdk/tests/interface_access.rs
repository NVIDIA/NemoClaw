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
                launcher: None,
                sign_in: SignIn::TokenInUrlFragment,
            },
            InterfaceAccess {
                sandbox: "reviewer".into(),
                interface: "api".into(),
                port: Some(8642),
                token_path: Some(
                    "/sandbox/artifacts/.fabric/hermes/runtimes/rt-hermes-1/interfaces/api.token"
                        .into()
                ),
                launcher: None,
                sign_in: SignIn::BearerToken,
            },
        ]
    );
    // The JSON result carries the same facts under one key.
    let json = serde_json::to_value(&result).unwrap();
    assert_eq!(
        json["interfaces"][1]["tokenPath"],
        "/sandbox/artifacts/.fabric/hermes/runtimes/rt-hermes-1/interfaces/api.token"
    );
    assert_eq!(json["interfaces"][1]["signIn"], "bearer_token");
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
            launcher: None,
            sign_in: SignIn::None,
        }]
    );
}

/// Deep Agents Code's terminal has no port or token: apply reports its launcher
/// for the current runtime, which a person runs with `openshell sandbox exec`.
#[tokio::test]
async fn apply_reports_a_terminal_interface_with_its_launcher() {
    let mut value = crate::support::fixture("local.yaml");
    value["spec"]["sandboxes"]["assistant"]["harness"] = json!({
        "kind": "nvidia.fabric.langchain.deepagents-code",
        "settings": {"approval_mode": "auto", "interfaces": {"terminal": {}}}});
    let document = Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap();
    let launcher =
        "/sandbox/artifacts/.fabric/deepagents-code/runtimes/rt-dcode-1/interfaces/terminal";
    let result = apply(&document, &[("assistant", "rt-dcode-1")]).await;
    assert_eq!(
        result.interfaces,
        [InterfaceAccess {
            sandbox: "assistant".into(),
            interface: "terminal".into(),
            port: None,
            token_path: None,
            launcher: Some(launcher.into()),
            sign_in: SignIn::SandboxExec,
        }]
    );
    let json = serde_json::to_value(&result).unwrap();
    assert_eq!(
        json["interfaces"],
        json!([{"sandbox": "assistant", "interface": "terminal", "launcher": launcher, "signIn": "sandbox_exec"}])
    );

    // A disabled terminal is not reported.
    value["spec"]["sandboxes"]["assistant"]["harness"]["settings"]["interfaces"]["terminal"] =
        json!({"enabled": false});
    let document = Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap();
    assert!(
        apply(&document, &[("assistant", "rt-dcode-1")])
            .await
            .interfaces
            .is_empty()
    );
}

/// Without a runtime ID in the state, the launcher's path isn't known.
#[tokio::test]
async fn a_terminal_without_a_recorded_runtime_reports_no_launcher() {
    let mut value = crate::support::fixture("local.yaml");
    value["spec"]["sandboxes"]["assistant"]["harness"] = json!({
        "kind": "nvidia.fabric.langchain.deepagents-code",
        "settings": {"approval_mode": "yolo", "interfaces": {"terminal": {"enabled": true}}}});
    let document = Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap();
    let result = apply(&document, &[("assistant", "")]).await;
    assert_eq!(result.interfaces.len(), 1);
    assert_eq!(result.interfaces[0].launcher, None);
    assert_eq!(result.interfaces[0].sign_in, SignIn::SandboxExec);
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
