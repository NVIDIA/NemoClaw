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
// Baseline grants follow NVIDIA/OpenShell crates/openshell-supervisor/src/lib.rs
// at 7e7a8d5610f336f5f7f9f60da0951adbf295475d (Apache-2.0).
// 2026-09-17: compare image-dependent proxy additions without changing authored
// grants, accepting unrelated paths, or upgrading explicit read-only grants.
pub(super) fn loaded_policy_matches(
    loaded: &proto::SandboxPolicy,
    expected: &str,
) -> Result<bool, ObservationError> {
    let actual = policy_json(loaded)?;
    if actual == expected {
        return Ok(true);
    }
    let mut baseline = row_policy(&[("policy_json".into(), expected.into())].into())?;
    if baseline.network_policies.is_empty() {
        return Ok(false);
    }
    let Some(observed) = &loaded.filesystem else {
        return Ok(false);
    };
    let fs = baseline
        .filesystem
        .get_or_insert_with(|| proto::FilesystemPolicy {
            include_workdir: true,
            ..Default::default()
        });
    // OpenShell adds only paths present in the sandbox image. Host filesystem
    // probes cannot establish that set; accept only observed, known additions.
    for (paths, writable) in [
        (
            &[
                "/usr",
                "/lib",
                "/etc",
                "/app",
                "/var/log",
                "/proc",
                "/dev/urandom",
            ][..],
            false,
        ),
        (&["/tmp", "/dev/null"][..], true),
    ] {
        for path in paths {
            let observed_paths = if writable {
                &observed.read_write
            } else {
                &observed.read_only
            };
            if observed_paths.iter().any(|p| p == path)
                && !fs.read_only.iter().chain(&fs.read_write).any(|p| p == path)
            {
                if writable {
                    &mut fs.read_write
                } else {
                    &mut fs.read_only
                }
                .push((*path).into());
            }
        }
    }
    Ok(policy_json(&baseline)? == actual)
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
        // BSD printenv accepts one variable name; GNU printenv also accepts several.
        for (key, expected) in [
            ("HTTP_PROXY", "http://proxy.internal:3129"),
            ("HTTPS_PROXY", "http://proxy.internal:3129"),
            ("http_proxy", "http://proxy.internal:3129"),
            ("https_proxy", "http://proxy.internal:3129"),
            ("NO_PROXY", "localhost,127.0.0.1,::1,proxy.internal"),
            ("no_proxy", "localhost,127.0.0.1,::1,proxy.internal"),
            ("NODE_USE_ENV_PROXY", "1"),
        ] {
            let output = std::process::Command::new(&command[0])
                .args(&command[1..command.len() - 3])
                .args(["/usr/bin/printenv", key])
                .env(key, "injected-value")
                .output()
                .unwrap();
            assert!(output.status.success(), "{key}");
            assert_eq!(
                String::from_utf8(output.stdout).unwrap(),
                format!("{expected}\n"),
                "{key} must override the injected value",
            );
        }
    }
}
