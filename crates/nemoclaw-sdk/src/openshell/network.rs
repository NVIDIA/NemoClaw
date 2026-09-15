// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Proxy variable selection follows NVIDIA/NemoClaw agents/hermes/start.sh at
// be46805b51b0d626466538e9f8fe56c8ad157549 (Apache-2.0).
// 2026-09-15: apply the selection with an argv-only wrapper and verify it on read.
use super::*;
use crate::config::{ExplicitPolicy, Proxy};

fn canonical(policy: &proto::SandboxPolicy) -> Result<String, ObservationError> {
    let mut policy = policy.clone();
    if let Some(fs) = &mut policy.filesystem {
        fs.read_only.sort();
        fs.read_write.sort();
    }
    let mut value = openshell_policy::sandbox_policy_to_json_value(&policy)
        .map_err(|_| ObservationError::Incomplete)?;
    value
        .as_object_mut()
        .ok_or(ObservationError::Incomplete)?
        .entry("network_policies")
        .or_insert_with(|| serde_json::json!({}));
    // Refuse fields the SDK cannot retain, including credential bindings and middleware.
    let typed: ExplicitPolicy =
        serde_json::from_value(value.clone()).map_err(|_| ObservationError::Incomplete)?;
    let decoded = typed.to_proto().map_err(|_| ObservationError::Incomplete)?;
    if decoded != policy {
        return Err(ObservationError::Incomplete);
    }
    value.sort_all_objects();
    Ok(value.to_string())
}
pub fn policy_json(policy: &proto::SandboxPolicy) -> Result<String, ObservationError> {
    if policy_matches(policy) {
        return Ok(String::new());
    }
    canonical(policy)
}
pub(super) fn row_policy(row: &Row) -> Result<proto::SandboxPolicy, ObservationError> {
    match row.get("policy_json").map(String::as_str).unwrap_or("") {
        "" => Ok(policy()),
        text => {
            let policy: ExplicitPolicy =
                serde_json::from_str(text).map_err(|_| ObservationError::Query)?;
            policy.to_proto().map_err(|_| ObservationError::Query)
        }
    }
}
pub(super) fn row_proxy(row: &Row) -> Result<Option<Proxy>, ObservationError> {
    let host = row.get("proxy_host").map(String::as_str).unwrap_or("");
    let port = row.get("proxy_port").map(String::as_str).unwrap_or("");
    if host.is_empty() && port.is_empty() {
        return Ok(None);
    }
    let proxy = Proxy {
        host: host.into(),
        port: port.parse().map_err(|_| ObservationError::Query)?,
    };
    proxy.validate().map_err(|_| ObservationError::Query)?;
    if proxy.port.to_string() != port {
        return Err(ObservationError::Query);
    }
    Ok(Some(proxy))
}
pub(super) fn launch_environment(name: &str, runtime: &str, proxy: Option<&Proxy>) -> Row {
    let mut env = environment(name, runtime);
    if let Some(proxy) = proxy {
        env.insert("NEMOCLAW_PROXY_HOST".into(), proxy.host.clone());
        env.insert("NEMOCLAW_PROXY_PORT".into(), proxy.port.to_string());
    }
    env
}
pub(super) fn launch_command(runtime: &str, proxy: Option<&Proxy>) -> Vec<String> {
    let command = command(runtime);
    let Some(proxy) = proxy else {
        return command;
    };
    // The supervisor injects its own proxy environment before exec. Apply the
    // retained agent selection afterwards, without a shell or image rebuild.
    let url = format!("http://{}:{}", proxy.host, proxy.port);
    let bypass = format!("localhost,127.0.0.1,::1,{}", proxy.host);
    let mut wrapped = vec!["/usr/bin/env".into()];
    for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
        wrapped.push(format!("{key}={url}"));
    }
    for key in ["NO_PROXY", "no_proxy"] {
        wrapped.push(format!("{key}={bypass}"));
    }
    wrapped.push("NODE_USE_ENV_PROXY=1".into());
    wrapped.extend(command);
    wrapped
}
pub(super) fn observed_proxy(env: &Row) -> Result<Option<Proxy>, ObservationError> {
    row_proxy(
        &[
            (
                "proxy_host".into(),
                env.get("NEMOCLAW_PROXY_HOST").cloned().unwrap_or_default(),
            ),
            (
                "proxy_port".into(),
                env.get("NEMOCLAW_PROXY_PORT").cloned().unwrap_or_default(),
            ),
        ]
        .into(),
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn proxy_selection_overrides_injected_environment_at_exec_without_a_shell() {
        let proxy = Proxy {
            host: "proxy.internal".into(),
            port: 3129,
        };
        let command = launch_command("fabric-openclaw", Some(&proxy));
        let output = std::process::Command::new(&command[0])
            .args(&command[1..command.len() - 3])
            .args([
                "/usr/bin/printenv",
                "HTTP_PROXY",
                "https_proxy",
                "NO_PROXY",
                "NODE_USE_ENV_PROXY",
            ])
            .env("HTTP_PROXY", "http://injected:3128")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            "http://proxy.internal:3129\nhttp://proxy.internal:3129\nlocalhost,127.0.0.1,::1,proxy.internal\n1\n"
        );
    }
}
