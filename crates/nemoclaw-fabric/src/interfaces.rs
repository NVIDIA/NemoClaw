// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! How a person reaches an agent's native interfaces, by Fabric's P0
//! convention (NVIDIA/NeMo-Fabric#547): the configuration chooses each HTTP
//! interface's loopback port, and an interface's adapter-generated token is
//! at `<artifact root>/.fabric/<adapter>/runtimes/<runtime-id>/interfaces/<name>.token`.
//! An agent whose configuration sets `runtime.keep_state` keeps its native
//! state in the folder Fabric names after it,
//! `<artifact root>/.fabric/state/<adapter id>/<agent name>`, so its
//! `interfaces` directory is there for every runtime.
//! Fabric's descriptors don't yet say which interfaces have a token or how a
//! person signs in (NVIDIA/NeMo-Fabric#565), so this lists the P0 adapters'.
//! None of this reads or carries a token.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How a person signs in to an interface once it is forwarded.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignIn {
    /// Open `http://127.0.0.1:PORT/#token=TOKEN`, as OpenClaw's Control UI takes.
    TokenInUrlFragment,
    /// Send `Authorization: Bearer TOKEN`, as Hermes's API server takes.
    BearerToken,
    /// None: anyone who can reach the port can use the interface.
    None,
    /// The adapter's documentation says; NemoClaw doesn't know this interface.
    AdapterDocumented,
}

/// Where an enabled interface listens and how a person signs in to it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceAccess {
    pub sandbox: String,
    pub interface: String,
    /// The loopback port in the sandbox, for an HTTP interface.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// The token file in the sandbox, for an interface that has one, when the
    /// runtime's ID is known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_path: Option<String>,
    pub sign_in: SignIn,
    /// For an interface that a terminal UI connects to: the command that
    /// opens it in the sandbox, with `TOKEN` in place of the interface's
    /// token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<String>,
}

struct Convention {
    /// The adapter's directory under `.fabric`.
    directory: &'static str,
    token: bool,
    sign_in: SignIn,
    /// The harness's terminal UI command that connects to the interface at
    /// its port.
    terminal: Option<TerminalCommand>,
}

/// Builds a terminal UI command from the interface's port.
type TerminalCommand = fn(u16) -> String;

/// OpenClaw's terminal UI is a client of the Gateway that serves the Control
/// UI, and takes the Control UI's token (<https://docs.openclaw.ai/cli/tui>).
fn openclaw_tui(port: u16) -> String {
    format!("openclaw tui --url ws://127.0.0.1:{port} --token TOKEN")
}

/// What the P0 adapters' READMEs document for each interface, and the
/// terminal UI that the harness's own CLI connects to it.
fn convention(adapter_id: &str, interface: &str) -> Option<Convention> {
    let (directory, token, sign_in, terminal): (_, _, _, Option<TerminalCommand>) =
        match (adapter_id, interface) {
            ("nvidia.fabric.openclaw", "dashboard") => (
                "openclaw",
                true,
                SignIn::TokenInUrlFragment,
                Some(openclaw_tui),
            ),
            ("nvidia.fabric.hermes", "api") => ("hermes", true, SignIn::BearerToken, None),
            ("nvidia.fabric.hermes", "dashboard") => ("hermes", false, SignIn::None, None),
            _ => return None,
        };
    Some(Convention {
        directory,
        token,
        sign_in,
        terminal,
    })
}

/// A name that is safe as a path component and in a printed command.
fn safe(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.starts_with('.')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

/// The interfaces an agent's Fabric configuration enables, in name order: each
/// one present under `harness.settings.interfaces` without `enabled: false`.
/// `runtime_id` is the ID Fabric gave the running agent; without it, no token
/// path is known.
pub fn access(
    sandbox: &str,
    configuration: &Value,
    runtime_id: Option<&str>,
) -> Vec<InterfaceAccess> {
    let adapter_id = configuration
        .pointer("/harness/adapter_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let artifacts = configuration
        .pointer("/runtime/artifacts")
        .and_then(Value::as_str)
        .filter(|root| root.starts_with('/') && !root.split('/').any(|part| part == ".."));
    let runtime_id = runtime_id.filter(|id| safe(id));
    let kept_state = (configuration.pointer("/runtime/keep_state") == Some(&Value::Bool(true)))
        .then(|| {
            configuration
                .pointer("/metadata/name")
                .and_then(Value::as_str)
        })
        .flatten()
        .filter(|agent| safe(agent) && safe(adapter_id));
    let Some(interfaces) = configuration
        .pointer("/harness/settings/interfaces")
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    interfaces
        .iter()
        .filter(|(name, settings)| {
            safe(name) && settings.is_object() && settings["enabled"] != Value::Bool(false)
        })
        .map(|(name, settings)| {
            let convention = convention(adapter_id, name);
            let interfaces = match (&convention, artifacts, kept_state, runtime_id) {
                (Some(_), Some(root), Some(agent), _) => Some(format!(
                    "{}/.fabric/state/{adapter_id}/{agent}/interfaces",
                    root.trim_end_matches('/'),
                )),
                (Some(convention), Some(root), None, Some(runtime)) => Some(format!(
                    "{}/.fabric/{}/runtimes/{runtime}/interfaces",
                    root.trim_end_matches('/'),
                    convention.directory
                )),
                _ => None,
            };
            let token_path = interfaces
                .filter(|_| {
                    convention
                        .as_ref()
                        .is_some_and(|convention| convention.token)
                })
                .map(|directory| format!("{directory}/{name}.token"));
            let port = settings["port"]
                .as_u64()
                .and_then(|port| u16::try_from(port).ok())
                .filter(|port| *port != 0);
            let terminal = convention
                .as_ref()
                .and_then(|convention| convention.terminal)
                .zip(port)
                .map(|(command, port)| command(port));
            InterfaceAccess {
                sandbox: sandbox.into(),
                interface: name.clone(),
                port,
                token_path,
                sign_in: convention
                    .map_or(SignIn::AdapterDocumented, |convention| convention.sign_in),
                terminal,
            }
        })
        .collect()
}
