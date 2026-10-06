// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod observations;

use crate::{CancellationToken, Error};
use process_wrap::tokio::{CommandWrap, KillOnDrop};
use std::{collections::BTreeMap, path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::task::AbortOnDropHandle;

async fn capture(
    mut pipe: impl AsyncRead + Unpin,
    limit: usize,
    mut ui: Option<crate::tofu_ui::Ui>,
) -> std::io::Result<(Vec<u8>, bool, bool)> {
    let mut output = Vec::new();
    let mut overflow = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let count = pipe.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        if let Some(ui) = &mut ui {
            ui.feed(&buffer[..count]);
        }
        let available = limit.saturating_sub(output.len());
        output.extend_from_slice(&buffer[..count.min(available)]);
        overflow |= count > available;
    }
    let valid_ui = ui.is_none_or(|ui| ui.finish().is_ok());
    Ok((output, overflow, valid_ui))
}
pub(crate) async fn run(
    directory: &Path,
    binary: &Path,
    args: &[&str],
    overrides: &BTreeMap<String, String>,
    cancel: &CancellationToken,
) -> Result<Vec<u8>, Error> {
    run_with_progress(directory, binary, args, overrides, cancel, None).await
}
pub(crate) async fn run_with_progress(
    directory: &Path,
    binary: &Path,
    args: &[&str],
    overrides: &BTreeMap<String, String>,
    cancel: &CancellationToken,
    progress: Option<std::sync::Arc<dyn Fn(crate::Progress) + Send + Sync>>,
) -> Result<Vec<u8>, Error> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let mutation_progress = progress.clone();
    let redactions = std::sync::Arc::new(secret_values(overrides));
    let withhold_child_text = has_short_secret(&redactions);
    let progress = progress.map(|callback| {
        let redactions = redactions.clone();
        std::sync::Arc::new(move |mut event: crate::Progress| {
            // Omit opaque child identities uniformly; masking their matching
            // characters would disclose short values and collapse identities.
            if withhold_child_text {
                return;
            }
            match &mut event {
                crate::Progress::Resource {
                    address: Some(address),
                    ..
                } => {
                    redact(address, &redactions);
                }
                crate::Progress::Download(download) => {
                    redact(&mut download.resource, &redactions);
                    redact(&mut download.artifact, &redactions);
                    if let Some(layer) = &mut download.layer {
                        redact(layer, &redactions);
                    }
                }
                _ => {}
            }
            callback(event);
        }) as std::sync::Arc<dyn Fn(crate::Progress) + Send + Sync>
    });
    // Progress is optional: endpoint failures must not prevent an operation.
    let downloads = progress
        .as_ref()
        .and_then(|callback| crate::download::Listener::start(callback.clone()).ok());
    let mut command = CommandWrap::with_new(binary, |command| {
        command
            .args(args)
            .current_dir(directory)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear();
        command.envs(child_environment(std::env::vars_os()));
        command.envs(overrides);
        if let Some(downloads) = &downloads {
            command.env(crate::download::ENV, &downloads.endpoint);
        }
    });
    command.wrap(KillOnDrop);
    #[cfg(unix)]
    command.wrap(process_wrap::tokio::ProcessGroup::leader());
    #[cfg(windows)]
    command.wrap(process_wrap::tokio::JobObject);
    let mut child = command.spawn().map_err(|_| Error::Execution {
        operation: args.first().unwrap_or(&"command").to_string(),
        diagnostic: "cannot launch bundled executable".into(),
        postcondition_failures: None,
    })?;
    // This SDK fact is independent of optional child UI/download events and
    // their redaction or transport. A failed spawn cannot have changed resources.
    if args.first() == Some(&"apply")
        && let Some(callback) = mutation_progress
    {
        callback(crate::Progress::MutationStarted);
    }
    let stdout = AbortOnDropHandle::new(tokio::spawn(capture(
        child.stdout().take().expect("piped stdout"),
        64 * 1024 * 1024,
        progress.map(crate::tofu_ui::Ui::new),
    )));
    let stderr = AbortOnDropHandle::new(tokio::spawn(capture(
        child.stderr().take().expect("piped stderr"),
        16384,
        None,
    )));
    let status = tokio::select! {
        status=child.wait()=>status,
        ()=cancel.cancelled()=>{
            #[cfg(unix)] {let _=child.signal(2);}
            #[cfg(windows)] {let _=child.start_kill();}
            let _=tokio::time::timeout(Duration::from_secs(5),child.wait()).await;
            let _=child.start_kill();
            stdout.abort();stderr.abort();
            return Err(Error::Cancelled);
        }
    };
    // Clean up descendants even when their parent exited normally.
    let _ = child.start_kill();
    let capture = async {
        tokio::try_join!(
            async {
                stdout
                    .await
                    .map_err(|_| Error::State("stdout task failed"))?
                    .map_err(|_| Error::State("cannot read child stdout"))
            },
            async {
                stderr
                    .await
                    .map_err(|_| Error::State("stderr task failed"))?
                    .map_err(|_| Error::State("cannot read child stderr"))
            }
        )
    };
    let ((output, overflow, valid_ui), (mut diagnostic, mut diagnostic_overflow, _)) = tokio::select! {
        ()=cancel.cancelled()=>return Err(Error::Cancelled),
        result=tokio::time::timeout(Duration::from_secs(5),capture)=>result.map_err(|_|Error::State("child exited but its output streams did not close; retain state for reconciliation"))??,
    };
    if status.as_ref().is_ok_and(|status| status.success()) && !overflow {
        if !valid_ui {
            return Err(Error::State("invalid or unsupported OpenTofu UI stream"));
        }
        return Ok(output);
    }
    let postcondition_failures = if args.first() == Some(&"apply")
        && args.contains(&"-json")
        && status.as_ref().is_ok_and(|status| status.code() == Some(1))
        && valid_ui
        && diagnostic.is_empty()
        && !overflow
        && !diagnostic_overflow
    {
        observations::postcondition_failures(&output)
    } else {
        None
    };
    let mut message = String::from_utf8_lossy(&diagnostic).into_owned();
    diagnostic.fill(0);
    if message.is_empty() {
        for line in output.split(|byte| *byte == b'\n') {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(line)
                && value["type"] == "diagnostic"
            {
                for key in ["summary", "detail"] {
                    if let Some(text) = value["diagnostic"][key].as_str() {
                        if message.len() + text.len() + 1 > 16384 {
                            diagnostic_overflow = true;
                            break;
                        }
                        message.push_str(text);
                        message.push('\n');
                    }
                }
            }
        }
    }
    if withhold_child_text {
        message =
            "child diagnostic withheld because a credential is too short for safe redaction".into();
    } else {
        redact(&mut message, &redactions);
    }
    if overflow || diagnostic_overflow {
        message = "child output exceeds the supported limit".into();
    }
    Err(Error::Execution {
        operation: args.first().unwrap_or(&"command").to_string(),
        diagnostic: message.trim().into(),
        postcondition_failures,
    })
}

fn secret_values(overrides: &BTreeMap<String, String>) -> Vec<String> {
    let mut secrets = Vec::new();
    for (name, value) in overrides.iter().filter(|(_, value)| !value.is_empty()) {
        if !matches!(
            name.as_str(),
            "TF_IN_AUTOMATION" | "TF_INPUT" | "TF_CLI_CONFIG_FILE" | "CHECKPOINT_DISABLE"
        ) {
            secrets.push(value.clone());
        }
    }
    secrets.sort_unstable();
    secrets.dedup();
    secrets
}

fn has_short_secret(secrets: &[String]) -> bool {
    // This is a diagnostic-disclosure threshold, not a credential-strength rule.
    secrets
        .iter()
        .any(|secret| !secret.is_empty() && secret.chars().take(8).count() < 8)
}

fn redact(text: &mut String, secrets: &[String]) {
    if has_short_secret(secrets) {
        *text = "[redacted]".into();
        return;
    }
    // Search only the original input. Merge every overlapping match, including
    // self-overlaps, so neither replacement text nor a credential suffix leaks.
    // Include existing markers in the same union without exempting credentials
    // that contain or overlap a marker.
    let mut matches = text.char_indices().filter_map(|(start, _)| {
        secrets
            .iter()
            .filter(|secret| !secret.is_empty() && text[start..].starts_with(secret.as_str()))
            .map(|secret| start + secret.len())
            .chain(
                text[start..]
                    .starts_with("[redacted]")
                    .then_some(start + 10),
            )
            .max()
            .map(|end| (start, end))
    });
    let Some((start, mut end)) = matches.next() else {
        return;
    };
    let mut output = text[..start].to_owned();
    output.push_str("[redacted]");
    for (start, next_end) in matches {
        if start > end {
            output.push_str(&text[end..start]);
            output.push_str("[redacted]");
        }
        end = end.max(next_end);
    }
    output.push_str(&text[end..]);
    *text = output;
}

/// Caller variables a child needs to run at all: finding programs and its
/// home and temporary directories, Windows system settings, proxies and
/// trusted certificates, and the SSH agent for SSH placement. Everything else,
/// including unrelated credentials, stays in the caller. A deployment passes
/// what its providers need explicitly, such as resolved credential references
/// and a Kubernetes target's listed variables.
const PLATFORM_VARIABLES: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TZ",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "USERPROFILE",
    "USERNAME",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "COMMONPROGRAMFILES",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "SSH_AUTH_SOCK",
];

/// The caller's variables a child inherits: the platform set above, names
/// compared without case as Windows does.
fn child_environment(
    caller: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> Vec<(String, String)> {
    caller
        .into_iter()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .filter(|(name, _)| {
            let upper = name.to_ascii_uppercase();
            PLATFORM_VARIABLES.contains(&upper.as_str()) && inherited_variable(name)
        })
        .collect()
}

fn inherited_variable(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    ![
        "TF_",
        "TOFU_",
        "PLUGIN_",
        "HELM_",
        "KUBE_",
        "NEMOCLAW_INTERNAL_",
        "NEMOCLAW_MANAGED_K8S_",
    ]
    .iter()
    .any(|prefix| upper.starts_with(prefix))
        && upper != crate::kubernetes::STATE_ENV
        && upper != "KUBECONFIG"
}

#[cfg(test)]
mod environment_tests {
    use super::*;

    fn names(environment: &[(String, String)]) -> Vec<&str> {
        environment.iter().map(|(name, _)| name.as_str()).collect()
    }

    fn caller(variables: &[(&str, &str)]) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
        variables
            .iter()
            .map(|(name, value)| ((*name).into(), (*value).into()))
            .collect()
    }

    #[test]
    fn a_child_gets_only_platform_variables_from_the_caller() {
        let environment = child_environment(caller(&[
            ("PATH", "/usr/bin"),
            ("HOME", "/home/me"),
            ("HTTPS_PROXY", "http://proxy.example:3128"),
            ("SSL_CERT_FILE", "/etc/ssl/ca.pem"),
            ("SSH_AUTH_SOCK", "/run/ssh.sock"),
            ("AWS_PROFILE", "dev"),
            ("NVIDIA_INFERENCE_API_KEY", "nvapi-unrelated"),
            ("GITHUB_TOKEN", "x"),
            ("TF_LOG", "trace"),
            ("KUBECONFIG", "/other"),
        ]));
        assert_eq!(
            names(&environment),
            [
                "PATH",
                "HOME",
                "HTTPS_PROXY",
                "SSL_CERT_FILE",
                "SSH_AUTH_SOCK"
            ]
        );
    }

    #[test]
    fn windows_names_match_without_case() {
        let environment = child_environment(caller(&[
            ("Path", "C:\\Windows"),
            ("SystemRoot", "C:\\Windows"),
        ]));
        assert_eq!(names(&environment), ["Path", "SystemRoot"]);
    }

    /// Unrelated short credentials in the caller's environment no longer hide
    /// a child's diagnostic: only values passed on purpose are secrets.
    #[test]
    fn only_passed_values_are_secrets() {
        let secrets = secret_values(&BTreeMap::from([
            ("TF_IN_AUTOMATION".into(), "1".into()),
            ("CUSTOM_CREDENTIAL".into(), "a-long-credential".into()),
        ]));
        assert_eq!(secrets, ["a-long-credential"]);
    }
}

#[cfg(test)]
#[test]
fn kubernetes_connection_environment_requires_explicit_operation_overrides() {
    for name in [
        crate::kubernetes::STATE_ENV,
        crate::kubernetes::TOKEN_ENV,
        crate::kubernetes::CA_ENV,
        crate::kubernetes::CERT_ENV,
        crate::kubernetes::KEY_ENV,
        "TF_VAR_nemoclaw_kubeconfig",
        "HELM_NAMESPACE",
        "HELM_DRIVER",
        "HELM_REGISTRY_CONFIG",
        "KUBE_HOST",
        "KUBE_TOKEN",
        "KUBECONFIG",
    ] {
        assert!(!inherited_variable(name));
        assert!(!inherited_variable(&name.to_ascii_lowercase()));
    }
    for name in [
        "PATH",
        "HOME",
        "NVIDIA_INFERENCE_API_KEY",
        "OPERATOR_KUBECONFIG",
    ] {
        assert!(inherited_variable(name));
    }
}

#[cfg(test)]
#[cfg(unix)]
#[tokio::test]
async fn only_normal_apply_failure_can_establish_postcondition_evidence() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let binary = directory.path().join("tofu");
    std::fs::write(
        &binary,
        r##"#!/bin/sh
printf '%s\n' '{"type":"version","ui":"1.2"}' '{"type":"diagnostic","diagnostic":{"severity":"error","summary":"Resource postcondition failed","snippet":{"context":"data.example_readiness.main.lifecycle.postcondition[0]"}}}'
exit "$3"
"##,
    )
    .unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    for (exit, expected) in [("1", true), ("2", false)] {
        let error = run_with_progress(
            directory.path(),
            &binary,
            &["apply", "-json", exit],
            &BTreeMap::new(),
            &CancellationToken::new(),
            Some(std::sync::Arc::new(|_| {})),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(error, Error::Execution { postcondition_failures, .. } if postcondition_failures.is_some() == expected)
        );
    }
}

#[cfg(test)]
#[tokio::test]
#[cfg(target_os = "linux")]
async fn cancelling_a_running_command_kills_its_background_child() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("child.pid");
    let token = CancellationToken::new();
    let cancellation = token.clone();
    let observed = marker.clone();
    let watcher = tokio::spawn(async move {
        for _ in 0..300 {
            if observed.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        cancellation.cancel();
    });
    let result = run(
        directory.path(),
        Path::new("/bin/sh"),
        &[
            "-c",
            "sleep 100 & echo $! > \"$1\"; wait",
            "fixture",
            marker.to_str().unwrap(),
        ],
        &Default::default(),
        &token,
    )
    .await;
    watcher.await.unwrap();
    assert!(matches!(result, Err(Error::Cancelled)));
    let pid = std::fs::read_to_string(marker).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let stat = std::fs::read_to_string(format!("/proc/{}/stat", pid.trim()));
            if stat.is_err() || stat.unwrap().split_whitespace().nth(2) == Some("Z") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("background child must terminate after cancellation");
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn mutation_boundary_survives_child_failure_and_short_secret_redaction() {
        // macOS has no /bin/false. `sh <operation>` starts and then fails
        // because the empty working directory has no such script.
        for (operation, binary, cancelled, expected) in [
            ("plan", "/bin/sh", false, false),
            ("apply", "/bin/sh", false, true),
            ("apply", "/missing-nemoclaw-binary", false, false),
            ("apply", "/bin/sh", true, false),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let token = CancellationToken::new();
            if cancelled {
                token.cancel();
            }
            let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let captured = events.clone();
            let result = run_with_progress(
                directory.path(),
                Path::new(binary),
                &[operation],
                &[("CUSTOM_CREDENTIAL".into(), "a".into())].into(),
                &token,
                Some(std::sync::Arc::new(move |event| {
                    captured.lock().unwrap().push(event)
                })),
            )
            .await;
            assert!(result.is_err());
            assert_eq!(
                *events.lock().unwrap(),
                if expected {
                    vec![crate::Progress::MutationStarted]
                } else {
                    vec![]
                },
                "{operation}, {binary}, cancelled={cancelled}"
            );
        }
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn failed_children_do_not_echo_referenced_secrets() {
        let directory = tempfile::tempdir().unwrap();
        let error = run(
            directory.path(),
            Path::new("/bin/sh"),
            &["-c", "printf '%s' \"$CUSTOM_CREDENTIAL\" >&2; exit 1"],
            &[("CUSTOM_CREDENTIAL".into(), "secret-sentinel".into())].into(),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert!(!error.to_string().contains("secret-sentinel"));
        assert!(error.to_string().contains("[redacted]"));
    }
    #[tokio::test]
    #[cfg(unix)]
    async fn already_cancelled_operations_do_not_spawn_a_child() {
        let directory = tempfile::tempdir().unwrap();
        let token = CancellationToken::new();
        token.cancel();
        assert!(matches!(
            run(
                directory.path(),
                Path::new("/bin/sh"),
                &["-c", "sleep 100"],
                &Default::default(),
                &token
            )
            .await,
            Err(crate::Error::Cancelled)
        ));
    }
}

#[cfg(all(test, target_os = "linux"))]
#[tokio::test]
async fn exited_parent_cannot_leave_capture_waiting_for_an_escaped_descendant() {
    let directory = tempfile::tempdir().unwrap();
    // The parent must not exit until the child leaves its process group.
    // Otherwise ordinary group cleanup can win the race and close the pipes.
    let script = r#"
import os, time
ready, notify = os.pipe()
pid = os.fork()
if pid == 0:
    os.close(ready)
    os.setsid()
    with open('escaped.pid', 'w') as marker:
        marker.write(str(os.getpid()))
    os.write(notify, b'1')
    os.close(notify)
    time.sleep(30)
else:
    os.close(notify)
    assert os.read(ready, 1) == b'1'
    os.close(ready)
"#;
    let result = tokio::time::timeout(
        Duration::from_secs(7),
        run(
            directory.path(),
            Path::new("/usr/bin/python3"),
            &["-c", script],
            &Default::default(),
            &CancellationToken::new(),
        ),
    )
    .await;
    if let Ok(pid) = std::fs::read_to_string(directory.path().join("escaped.pid")) {
        let _ = std::process::Command::new("kill")
            .args(["-KILL", pid.trim()])
            .status();
    }
    assert!(
        result.is_ok(),
        "capture outlived the exited command without a bound"
    );
    assert!(matches!(
        result.unwrap(),
        Err(Error::State(
            "child exited but its output streams did not close; retain state for reconciliation"
        ))
    ));
}

#[cfg(all(test, unix))]
#[tokio::test]
async fn progress_arrives_before_exit_and_cancellation_still_works() {
    let directory = tempfile::tempdir().unwrap();
    let token = CancellationToken::new();
    let stop = token.clone();
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let progress = std::sync::Arc::new(move |event| {
        send.send(event).unwrap();
    });
    let task = tokio::spawn(async move {
        run_with_progress(directory.path(), Path::new("/bin/sh"),
            &["-c", r#"printf '%s\n' '{"type":"version","ui":"1.0"}' '{"type":"apply_start","hook":{"resource":{"resource_type":"nemoclaw_sandbox"},"action":"create"}}'; sleep 100"#],
            &Default::default(), &stop, Some(progress)).await
    });
    let event = tokio::time::timeout(Duration::from_secs(2), receive.recv()).await;
    token.cancel();
    assert!(matches!(task.await.unwrap(), Err(Error::Cancelled)));
    assert!(matches!(
        event.unwrap().unwrap(),
        crate::Progress::Resource {
            resource: "sandbox",
            status: "started",
            ..
        }
    ));
}

#[cfg(all(test, unix))]
#[tokio::test]
async fn json_diagnostics_preserve_failures_and_redact_credentials() {
    let directory = tempfile::tempdir().unwrap();
    let error = run_with_progress(directory.path(), Path::new("/bin/sh"),
        &["-c", r#"printf '%s\n' '{"type":"version","ui":"1.0"}' '{"type":"diagnostic","diagnostic":{"summary":"provider failed","detail":"secret-sentinel"}}'; exit 1"#],
        &[("CUSTOM_CREDENTIAL".into(), "secret-sentinel".into())].into(),
        &CancellationToken::new(), Some(std::sync::Arc::new(|_| {}))).await.unwrap_err();
    assert!(error.to_string().contains("provider failed"));
    assert!(error.to_string().contains("[redacted]"));
    assert!(!error.to_string().contains("secret-sentinel"));
}

#[cfg(all(test, unix))]
#[tokio::test]
async fn progress_resource_addresses_redact_credentials() {
    let directory = tempfile::tempdir().unwrap();
    let received = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let events = received.clone();
    run_with_progress(directory.path(), Path::new("/bin/sh"),
        &["-c", r#"printf '%s\n' '{"type":"version","ui":"1.0"}' '{"type":"apply_start","hook":{"resource":{"resource_type":"nemoclaw_sandbox","addr":"nemoclaw_sandbox.secret-sentinel"},"action":"create"}}'"#],
        &[("CUSTOM_CREDENTIAL".into(), "secret-sentinel".into())].into(),
        &CancellationToken::new(),
        Some(std::sync::Arc::new(move |event| events.lock().unwrap().push(event))))
        .await.unwrap();
    let events = format!("{:?}", received.lock().unwrap());
    assert!(events.contains("nemoclaw_sandbox.[redacted]"));
    assert!(!events.contains("secret-sentinel"));
}

#[cfg(all(test, unix))]
#[tokio::test]
async fn early_failure_keeps_stderr_even_without_a_ui_version() {
    let directory = tempfile::tempdir().unwrap();
    let error = run_with_progress(
        directory.path(),
        Path::new("/bin/sh"),
        &["-c", "echo launch-failed >&2; exit 1"],
        &Default::default(),
        &CancellationToken::new(),
        Some(std::sync::Arc::new(|_| {})),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("launch-failed"));
}

#[cfg(test)]
mod redaction_tests {
    use super::redact;

    #[test]
    fn colliding_credentials_do_not_rescan_the_replacement_marker() {
        let mut text = "request rejected: secret-sentinel; token=redacted".to_owned();
        redact(&mut text, &["secret-sentinel".into(), "redacted".into()]);
        assert_eq!(text, "request rejected: [redacted]; token=[redacted]");
    }

    #[test]
    fn existing_markers_do_not_nest_or_exempt_credentials_containing_them() {
        let mut text = "already [redacted]; next secret-sentinel".to_owned();
        redact(&mut text, &["redacted".into(), "secret-sentinel".into()]);
        assert_eq!(text, "already [redacted]; next [redacted]");
        let mut text = "token=[redacted]-credential-suffix".to_owned();
        redact(&mut text, &["[redacted]-credential-suffix".into()]);
        assert_eq!(text, "token=[redacted]");
    }

    #[test]
    fn overlapping_credentials_are_fully_hidden_in_any_order() {
        for secrets in [
            vec!["abcdefghij".into(), "fghijklmno".into()],
            vec!["fghijklmno".into(), "abcdefghij".into()],
        ] {
            let mut text = "before abcdefghijklmno after".to_owned();
            redact(&mut text, &secrets);
            assert_eq!(text, "before [redacted] after");
        }
        let mut repeated = "before ababababab after".to_owned();
        redact(&mut repeated, &["abababab".into()]);
        assert_eq!(repeated, "before [redacted] after");
    }

    #[test]
    fn short_credentials_hide_the_field_without_disclosing_match_positions() {
        for secret in ["a", "b", "c", "notseen", "éééé"] {
            for input in [
                "Resource replacement would discard sandbox files",
                "XYZ",
                secret,
            ] {
                let mut text = input.to_owned();
                redact(&mut text, &[secret.into()]);
                assert_eq!(text, "[redacted]");
            }
        }
    }

    #[test]
    fn long_unicode_credentials_and_empty_values_preserve_unrelated_text() {
        let mut text = "原因: 密碼測試密碼測試 / safe".to_owned();
        redact(&mut text, &[String::new(), "密碼測試密碼測試".into()]);
        assert_eq!(text, "原因: [redacted] / safe");
    }
}

#[cfg(all(test, unix))]
#[tokio::test]
async fn short_credentials_withhold_child_text_without_preventing_execution() {
    let directory = tempfile::tempdir().unwrap();
    let mut messages = Vec::new();
    for secret in ["a", "c", "z"] {
        for script in [
            "printf '%s' 'Resource replacement would discard sandbox files' >&2; exit 1",
            r#"printf '%s\n' '{"type":"diagnostic","diagnostic":{"summary":"Resource replacement","detail":"would discard sandbox files"}}'; exit 1"#,
            "printf '%s' \"$CUSTOM_CREDENTIAL\" >&2; exit 1",
        ] {
            let error = run(
                directory.path(),
                Path::new("/bin/sh"),
                &["-c", script],
                &[("CUSTOM_CREDENTIAL".into(), secret.into())].into(),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
            let Error::Execution { diagnostic, .. } = error else {
                panic!("expected child failure")
            };
            assert_eq!(
                diagnostic,
                "child diagnostic withheld because a credential is too short for safe redaction"
            );
            messages.push(diagnostic);
        }
        let received = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let events = received.clone();
        run_with_progress(directory.path(), Path::new("/bin/sh"),
            &["-c", r#"test -n "$CUSTOM_CREDENTIAL" && printf '%s\n' '{"type":"version","ui":"1.0"}' '{"type":"apply_start","hook":{"resource":{"resource_type":"nemoclaw_sandbox","addr":"nemoclaw_sandbox.alpha"},"action":"create"}}'"#],
            &[("CUSTOM_CREDENTIAL".into(), secret.into())].into(), &CancellationToken::new(),
            Some(std::sync::Arc::new(move |event| events.lock().unwrap().push(event)))).await.unwrap();
        assert!(
            received.lock().unwrap().is_empty(),
            "short credentials must not expose child progress text"
        );
    }
    assert!(messages.windows(2).all(|pair| pair[0] == pair[1]));
}
