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
    run_with_progress(directory, binary, args, overrides, cancel, None, None).await
}
/// Runs `binary` until it exits or `cancel` is cancelled. A cancelled command
/// is interrupted; see the cancellation branch for how long it may take to
/// stop, which `force_stop` cuts short.
pub(crate) async fn run_with_progress(
    directory: &Path,
    binary: &Path,
    args: &[&str],
    overrides: &BTreeMap<String, String>,
    cancel: &CancellationToken,
    force_stop: Option<&CancellationToken>,
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
        && let Some(callback) = &mutation_progress
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
        DIAGNOSTIC_LIMIT,
        None,
    )));
    let status = tokio::select! {
        status=child.wait()=>status,
        ()=cancel.cancelled()=>{
            // Only OpenTofu gets the interrupt. Its provider plugins share its
            // process group, and one that doesn't ignore the interrupt would
            // end in the middle of its operation; OpenTofu stops them itself.
            #[cfg(unix)] {
                if let Some(pid) = child.id().and_then(|pid| i32::try_from(pid).ok()) {
                    let _ = nix::sys::signal::kill(
                        nix::unistd::Pid::from_raw(pid),
                        nix::sys::signal::Signal::SIGINT,
                    );
                }
            }
            #[cfg(windows)] {let _=child.start_kill();}
            // An interrupted OpenTofu apply starts no further resource
            // operations and saves the state once those in progress finish,
            // which takes as long as the slowest of them. Ending it sooner can
            // leave a resource without a binding, so an apply gets as long as
            // it needs unless the caller stops it now. Other commands get 5 s.
            let apply = cfg!(unix) && args.first() == Some(&"apply");
            if apply && let Some(callback) = &mutation_progress {
                callback(crate::Progress::Stopping);
            }
            let force_stop = async {
                match force_stop {
                    Some(token) => token.cancelled().await,
                    None => std::future::pending::<()>().await,
                }
            };
            // `None` when the caller stopped the command or its time ran out.
            let ended = tokio::select! {
                ended = async {
                    if apply {
                        Some(child.wait().await)
                    } else {
                        tokio::time::timeout(Duration::from_secs(5), child.wait()).await.ok()
                    }
                } => ended,
                () = force_stop => None,
            };
            let _=child.start_kill();
            let _=tokio::time::timeout(Duration::from_secs(5),child.wait()).await;
            let mut diagnostic = Vec::new();
            if matches!(ended, Some(Ok(_))) {
                // Deliver the events OpenTofu printed while it stopped.
                let _=tokio::time::timeout(Duration::from_secs(5), async {
                    let _=stdout.await;
                    if let Ok(Ok((bytes, _, _))) = stderr.await {
                        diagnostic = bytes;
                    }
                }).await;
            }
            if apply
                && let Some(callback) = &mutation_progress
                && let Some(ended) = &ended
                && let Some(message) = abnormal_stop(ended, &diagnostic, &redactions)
            {
                callback(crate::Progress::Warning { message });
            }
            diagnostic.fill(0);
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
    let ((output, overflow, valid_ui), (mut diagnostic, diagnostic_overflow, _)) = tokio::select! {
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
    let stderr_text = String::from_utf8_lossy(&diagnostic).into_owned();
    diagnostic.fill(0);
    let message = if overflow || diagnostic_overflow {
        // Output cut at its capture limit can end inside a credential that
        // redaction then no longer matches, so none of it is shown.
        "child output exceeds the supported limit".into()
    } else if withhold_child_text {
        "child diagnostic withheld because a credential is too short for safe redaction".into()
    } else if stderr_text.is_empty() {
        let diagnostics = output
            .split(|byte| *byte == b'\n')
            .filter_map(|line| serde_json::from_slice::<serde_json::Value>(line).ok())
            .filter(|value| value["type"] == "diagnostic")
            .map(|value| {
                ["summary", "detail"]
                    .map(|key| value["diagnostic"][key].as_str().map(str::to_owned))
            })
            .collect::<Vec<_>>();
        fit_diagnostics(diagnostics, &redactions, DIAGNOSTIC_LIMIT)
    } else {
        let mut message = stderr_text;
        redact(&mut message, &redactions);
        message
    };
    Err(Error::Execution {
        operation: args.first().unwrap_or(&"command").to_string(),
        diagnostic: message.trim().into(),
        postcondition_failures,
    })
}

/// How an interrupted apply ended when OpenTofu didn't stop by itself, which
/// can leave its state without the resources it created; `None` when it
/// stopped by itself, with status 1, or finished first, with status 0.
fn abnormal_stop(
    ended: &std::io::Result<std::process::ExitStatus>,
    diagnostic: &[u8],
    redactions: &[String],
) -> Option<String> {
    let how = match ended {
        Ok(status) => match status.code() {
            Some(0 | 1) => return None,
            Some(code) => format!("exited with status {code}"),
            None => {
                #[cfg(unix)]
                let signal = std::os::unix::process::ExitStatusExt::signal(status);
                #[cfg(not(unix))]
                let signal: Option<i32> = None;
                match signal {
                    Some(signal) => format!("was ended by signal {signal}"),
                    None => format!("ended with {status}"),
                }
            }
        },
        Err(_) => "could not be observed stopping and was killed".into(),
    };
    let mut message = format!(
        "OpenTofu {how} while stopping the cancelled apply, so its state may lack resources it created."
    );
    // Redact before shortening, so a cut can't leave part of a credential.
    let mut reported = String::from_utf8_lossy(diagnostic).trim().to_owned();
    if !reported.is_empty() && !has_short_secret(redactions) {
        redact(&mut reported, redactions);
        message.push_str(" It reported: ");
        message.extend(reported.chars().take(2048));
    }
    Some(message)
}

/// The most bytes of child diagnostics that a failed command's error carries.
const DIAGNOSTIC_LIMIT: usize = 16384;

/// Joins whole diagnostics, each a summary and a detail, in order while they
/// fit in `limit` bytes, so a long diagnostic cannot hide the others. The
/// first that doesn't fit keeps its summary, and one too long to fit even
/// alone also keeps as much of its detail as fits, cut after a whole line when
/// one fits. A final marker counts what was left out.
///
/// Each diagnostic is redacted before it is measured or cut, so a cut cannot
/// leave the start of a credential that no longer matches. `limit` must leave
/// room for a marker.
fn fit_diagnostics(
    diagnostics: Vec<[Option<String>; 2]>,
    secrets: &[String],
    limit: usize,
) -> String {
    let kib = limit / 1024;
    let plural = |count: usize| if count == 1 { "" } else { "s" };
    let omitted = |count: usize| match count {
        0 => String::new(),
        count => format!(
            "\n[{count} more diagnostic{} left out to keep this error within {kib} KiB; fix these and rerun to see the rest]",
            plural(count)
        ),
    };
    let cut = |count: usize| match count {
        0 => format!("\n[rest of this diagnostic left out to keep this error within {kib} KiB]"),
        count => format!(
            "\n[rest of this diagnostic and {count} more diagnostic{} left out to keep this error within {kib} KiB; fix these and rerun to see the rest]",
            plural(count)
        ),
    };
    let diagnostics = diagnostics
        .into_iter()
        .filter(|parts| parts.iter().flatten().any(|part| !part.is_empty()))
        .collect::<Vec<_>>();
    let total = diagnostics.len();
    let mut message = String::new();
    for (index, mut parts) in diagnostics.into_iter().enumerate() {
        // This diagnostic and those after it.
        let count = total - index;
        for part in parts.iter_mut().flatten() {
            redact(part, secrets);
        }
        // The text is the summary, then the detail on the next line.
        let summary = parts[0].as_ref().map_or(0, String::len);
        let text = parts
            .iter()
            .flatten()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("\n");
        let separator = if message.is_empty() { "" } else { "\n" };
        let used = message.len() + separator.len();
        if used + text.len() + omitted(count - 1).len() <= limit {
            message.push_str(separator);
            message.push_str(&text);
            continue;
        }
        let marker = cut(count - 1);
        let room = limit.saturating_sub(used + marker.len()).min(text.len());
        let end = if summary > room {
            if message.is_empty() {
                text.floor_char_boundary(room)
            } else {
                0
            }
        } else if text.len() + omitted(count - 1).len() <= limit {
            // It would fit in an error of its own, so its detail isn't cut.
            summary
        } else {
            match text.as_bytes()[..room]
                .iter()
                .rposition(|byte| *byte == b'\n')
            {
                Some(line) if line > summary => line,
                // Redaction already ran, so a cut inside a line is safe.
                _ => text.floor_char_boundary(room),
            }
        };
        // Trailing line breaks add nothing, and a cut of only whitespace
        // keeps nothing, so the diagnostic is counted instead.
        let kept = text[..end].trim_end();
        if kept.trim_start().is_empty() {
            message.push_str(&omitted(count));
        } else {
            message.push_str(separator);
            message.push_str(kept);
            message.push_str(&marker);
        }
        return message;
    }
    message
}

fn secret_values(overrides: &BTreeMap<String, String>) -> Vec<String> {
    let mut secrets = Vec::new();
    for (name, value) in overrides.iter().filter(|(_, value)| !value.is_empty()) {
        // The diagnostics directory is named in errors so users can find
        // Fabric's message; it is a path in the caller's own state. A pod's
        // API server address is not a credential, and credential references
        // cannot use its names.
        if !matches!(
            name.as_str(),
            "TF_IN_AUTOMATION" | "TF_INPUT" | "TF_CLI_CONFIG_FILE" | "CHECKPOINT_DISABLE"
        ) && name != nemoclaw_backend::DIAGNOSTICS_ENV
            && !crate::kubernetes::POD_VARIABLES.contains(&name.as_str())
        {
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
            ("KUBERNETES_SERVICE_HOST", "10.96.0.1"),
            ("KUBERNETES_SERVICE_PORT", "443"),
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
            // Errors name files in it, so it stays readable.
            (
                nemoclaw_backend::DIAGNOSTICS_ENV.into(),
                "/state/diagnostics".into(),
            ),
        ]));
        assert_eq!(secrets, ["a-long-credential"]);
    }

    /// A pod's API server address is not a credential, and its three-digit
    /// port must not withhold every child diagnostic; other values passed
    /// beside it still are secrets.
    #[test]
    fn the_pods_api_server_address_is_not_a_secret() {
        let secrets = secret_values(&BTreeMap::from([
            ("KUBERNETES_SERVICE_HOST".into(), "10.96.0.1".into()),
            ("KUBERNETES_SERVICE_PORT".into(), "443".into()),
            ("CUSTOM_CREDENTIAL".into(), "a-long-credential".into()),
        ]));
        assert_eq!(secrets, ["a-long-credential"]);
        assert!(!has_short_secret(&secrets));
        assert_eq!(
            secret_values(&BTreeMap::from([("SHORT_CREDENTIAL".into(), "443".into())])),
            ["443"]
        );
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
    let directory = tempfile::tempdir().unwrap();
    let binary = directory.path().join("tofu");
    crate::executable::write_executable(
        &binary,
        r##"#!/bin/sh
printf '%s\n' '{"type":"version","ui":"1.2"}' '{"type":"diagnostic","diagnostic":{"severity":"error","summary":"Resource postcondition failed","snippet":{"context":"data.example_readiness.main.lifecycle.postcondition[0]"}}}'
exit "$3"
"##,
    );
    for (exit, expected) in [("1", true), ("2", false)] {
        let error = run_with_progress(
            directory.path(),
            &binary,
            &["apply", "-json", exit],
            &BTreeMap::new(),
            &CancellationToken::new(),
            None,
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
                None,
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

    /// An interrupted apply waits until OpenTofu exits by itself, which takes
    /// as long as the resource operations in progress, and reports that it is
    /// stopping.
    ///
    /// Catches an SDK that kills OpenTofu after a fixed grace period: a Helm
    /// install in progress then stays `pending-install`, and resources already
    /// created can be missing from the state.
    #[tokio::test]
    async fn an_interrupted_apply_waits_until_opentofu_exits() {
        let directory = tempfile::tempdir().unwrap();
        // `sh apply` runs this script from the working directory. On an
        // interrupt it takes 5.2 s, longer than the former 5 s grace, to
        // finish. It waits in short foreground sleeps: a shell that waits for a
        // background child can miss the interrupt. The wait ends after 30 s,
        // because a shell started with interrupts ignored cannot trap them.
        std::fs::write(
            directory.path().join("apply"),
            "trap 'sleep 5.2; : > finished; exit 1' INT\n: > ready\n\
             i=0; while [ $i -lt 300 ]; do sleep 0.1; i=$((i + 1)); done\n",
        )
        .unwrap();
        let token = CancellationToken::new();
        let interrupt = token.clone();
        let ready = directory.path().join("ready");
        tokio::spawn(async move {
            for _ in 0..300 {
                if ready.exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            interrupt.cancel();
        });
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = events.clone();
        let result = run_with_progress(
            directory.path(),
            Path::new("/bin/sh"),
            &["apply", "-json"],
            &Default::default(),
            &token,
            None,
            Some(std::sync::Arc::new(move |event| {
                recorded.lock().unwrap().push(event)
            })),
        )
        .await;
        assert!(matches!(result, Err(Error::Cancelled)), "{result:?}");
        assert!(
            directory.path().join("finished").exists(),
            "OpenTofu was stopped before it finished the operations in progress"
        );
        assert!(
            events.lock().unwrap().contains(&crate::Progress::Stopping),
            "the caller was not told that the apply is stopping"
        );
        assert!(
            !events
                .lock()
                .unwrap()
                .iter()
                .any(|event| matches!(event, crate::Progress::Warning { .. })),
            "an apply that stopped by itself was reported as ending abnormally"
        );
    }

    /// Waits until `directory` holds `ready`, then cancels `token`.
    fn cancel_when_ready(directory: &Path, token: &CancellationToken) {
        let (ready, interrupt) = (directory.join("ready"), token.clone());
        tokio::spawn(async move {
            for _ in 0..300 {
                if ready.exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            interrupt.cancel();
        });
    }

    /// Catches an interrupt sent to OpenTofu's whole process group. Provider
    /// plugins share that group, and a plugin that doesn't ignore the
    /// interrupt ends in the middle of its operation, so OpenTofu can't
    /// record what it created.
    #[tokio::test]
    async fn an_interrupted_apply_lets_provider_operations_in_progress_finish() {
        let directory = tempfile::tempdir().unwrap();
        // `apply` stands in for OpenTofu and runs `provider` in the foreground,
        // in its process group. A shell runs its trap only after the
        // foreground command ends.
        std::fs::write(
            directory.path().join("apply"),
            "trap 'exit 1' INT\nsh provider\nexit 1\n",
        )
        .unwrap();
        std::fs::write(
            directory.path().join("provider"),
            "trap ': > interrupted; exit 1' INT\n: > ready\n\
             i=0; while [ $i -lt 10 ]; do sleep 0.1; i=$((i + 1)); done\n: > finished\n",
        )
        .unwrap();
        let token = CancellationToken::new();
        cancel_when_ready(directory.path(), &token);
        let result = run_with_progress(
            directory.path(),
            Path::new("/bin/sh"),
            &["apply", "-json"],
            &Default::default(),
            &token,
            None,
            None,
        )
        .await;
        assert!(matches!(result, Err(Error::Cancelled)), "{result:?}");
        assert!(
            !directory.path().join("interrupted").exists(),
            "the interrupt reached a provider plugin"
        );
        assert!(
            directory.path().join("finished").exists(),
            "the provider's operation in progress did not finish"
        );
    }

    /// Catches an interrupted apply whose OpenTofu crashes or is killed
    /// without anyone learning of it: its state can then lack the resources
    /// it created, and the caller sees only `Cancelled`.
    #[tokio::test]
    async fn an_interrupted_apply_that_ends_abnormally_warns_without_disclosing_secrets() {
        for (ending, reported) in [
            ("exit 2", "exited with status 2"),
            ("kill -KILL $$", "was ended by signal 9"),
        ] {
            let directory = tempfile::tempdir().unwrap();
            std::fs::write(
                directory.path().join("apply"),
                format!(
                    "trap 'printf \"panic: %s\\n\" \"$CUSTOM_CREDENTIAL\" >&2; {ending}' INT\n\
                     : > ready\ni=0; while [ $i -lt 300 ]; do sleep 0.1; i=$((i + 1)); done\n"
                ),
            )
            .unwrap();
            let token = CancellationToken::new();
            cancel_when_ready(directory.path(), &token);
            let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let recorded = events.clone();
            let result = run_with_progress(
                directory.path(),
                Path::new("/bin/sh"),
                &["apply", "-json"],
                &[("CUSTOM_CREDENTIAL".into(), "secret-sentinel".into())].into(),
                &token,
                None,
                Some(std::sync::Arc::new(move |event| {
                    recorded.lock().unwrap().push(event)
                })),
            )
            .await;
            assert!(matches!(result, Err(Error::Cancelled)), "{result:?}");
            let warnings: Vec<String> = events
                .lock()
                .unwrap()
                .iter()
                .filter_map(|event| match event {
                    crate::Progress::Warning { message } => Some(message.clone()),
                    _ => None,
                })
                .collect();
            assert!(
                matches!(warnings.as_slice(), [warning]
                    if warning.contains(reported) && warning.contains("panic: [redacted]")),
                "{ending}: {warnings:?}"
            );
            assert!(!format!("{warnings:?}").contains("secret-sentinel"));
        }
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
    // The shell replaces itself with sleep: an interrupt that reaches a forked
    // sleep before it starts doesn't stop it, so the shell would wait out the
    // cancellation grace period instead of exiting.
    let task = tokio::spawn(async move {
        run_with_progress(directory.path(), Path::new("/bin/sh"),
            &["-c", r#"printf '%s\n' '{"type":"version","ui":"1.0"}' '{"type":"apply_start","hook":{"resource":{"resource_type":"openshell_sandbox"},"action":"create"}}'; exec sleep 100"#],
            &Default::default(), &stop, None, Some(progress)).await
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
        &CancellationToken::new(), None, Some(std::sync::Arc::new(|_| {}))).await.unwrap_err();
    assert!(error.to_string().contains("provider failed"));
    assert!(error.to_string().contains("[redacted]"));
    assert!(!error.to_string().contains("secret-sentinel"));
}

/// OpenTofu diagnostics past the error's 16 KiB: report those that fit and
/// count the rest instead of withholding them all (#14399). Edge cases run
/// in process; the scripted OpenTofu checks the wiring.
#[cfg(test)]
mod diagnostic_limit_tests {
    use super::*;

    const LIMIT: usize = 16384;

    /// `count` numbered lines of `width` bytes, so a cut shows which survived.
    fn detail(service: usize, count: usize, width: usize) -> String {
        (0..count)
            .map(|line| {
                let mut text = format!("s{service} line {line:05} ");
                while text.len() < width {
                    text.push('x');
                }
                text
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn diagnostic(summary: &str, detail: String) -> [Option<String>; 2] {
        [Some(summary.into()), Some(detail)]
    }

    fn joined(diagnostics: &[[Option<String>; 2]]) -> String {
        diagnostics
            .iter()
            .map(|parts| {
                parts
                    .iter()
                    .flatten()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn fit(diagnostics: &[[Option<String>; 2]], secrets: &[String]) -> String {
        let message = fit_diagnostics(diagnostics.to_vec(), secrets, LIMIT);
        assert!(
            message.len() <= LIMIT,
            "the error has {} bytes",
            message.len()
        );
        message
    }

    #[test]
    fn diagnostics_that_fill_the_limit_exactly_are_reported_unchanged() {
        let mut diagnostics: Vec<_> = (0..3)
            .map(|service| {
                diagnostic(
                    &format!("service {service} failed readiness"),
                    detail(service, 40, 99),
                )
            })
            .collect();
        let summary = "service 3 failed readiness";
        let used = joined(&diagnostics).len() + 1 + summary.len() + 1;
        diagnostics.push(diagnostic(summary, "y".repeat(LIMIT - used)));
        let expected = joined(&diagnostics);
        assert_eq!(expected.len(), LIMIT);
        assert!(
            fit(&diagnostics, &[]) == expected,
            "the diagnostics changed"
        );
    }

    /// A later error's summary still shows after warnings that fill the error.
    #[test]
    fn the_first_diagnostic_that_does_not_fit_keeps_its_summary() {
        let mut diagnostics: Vec<_> = (0..3)
            .map(|service| {
                diagnostic(
                    &format!("service {service} warning"),
                    detail(service, 50, 99),
                )
            })
            .collect();
        diagnostics.push(diagnostic("Error: gateway unreachable", detail(3, 50, 99)));
        diagnostics.push(diagnostic("Error: another", detail(4, 5, 99)));
        let message = fit(&diagnostics, &[]);
        let kept = joined(&diagnostics[..3]);
        assert!(
            message.starts_with(&format!("{kept}\n")),
            "the first three are not whole"
        );
        let rest: Vec<_> = message[kept.len() + 1..].lines().collect();
        assert_eq!(rest[0], "Error: gateway unreachable");
        assert_eq!(
            rest.len(),
            2,
            "only the summary and one marker follow: {rest:?}"
        );
        assert!(
            rest[1].contains("1 more diagnostic"),
            "the omitted count is missing: {rest:?}"
        );
    }

    #[test]
    fn an_oversized_diagnostic_keeps_its_summary_and_the_whole_lines_that_fit() {
        let diagnostics = vec![
            diagnostic("service 0 failed readiness", detail(0, 10, 99)),
            diagnostic("vLLM exited during startup", detail(1, 400, 99)),
            diagnostic("service 2 failed readiness", detail(2, 10, 99)),
        ];
        let message = fit(&diagnostics, &[]);
        let first = joined(&diagnostics[..1]);
        assert!(
            message.starts_with(&format!("{first}\n")),
            "the first diagnostic is not whole"
        );
        let mut lines = message[first.len() + 1..].lines();
        assert_eq!(lines.next(), Some("vLLM exited during startup"));
        let original: Vec<_> = detail(1, 400, 99).lines().map(str::to_owned).collect();
        let kept: Vec<_> = lines
            .by_ref()
            .take_while(|line| line.starts_with("s1 line "))
            .collect();
        assert_eq!(
            kept,
            original[..kept.len()],
            "the kept detail is not whole lines from its start"
        );
        assert!(
            kept.len() > 100,
            "only {} lines of the oversized detail fit",
            kept.len()
        );
        assert!(
            message
                .lines()
                .last()
                .unwrap()
                .contains("1 more diagnostic")
        );
        assert!(
            !message.contains("service 2"),
            "a diagnostic after the cut one was kept"
        );
    }

    #[test]
    fn an_oversized_single_line_detail_is_cut_inside_the_line() {
        let message = fit(&[diagnostic("provider crashed", "é".repeat(LIMIT))], &[]);
        let lines: Vec<_> = message.lines().collect();
        assert_eq!(lines[0], "provider crashed");
        assert!(
            lines[1].len() > LIMIT - 200,
            "only {} bytes of the detail fit",
            lines[1].len()
        );
        assert!(lines[1].chars().all(|character| character == 'é'));
        assert!(
            lines[2].contains("rest of this diagnostic"),
            "{:?}",
            lines[2]
        );
    }

    /// Redaction runs before the cut: a credential the cut would split leaves
    /// no prefix, and credentials that grow to `[redacted]` still fit.
    #[test]
    fn redaction_before_the_cut_hides_split_and_growing_credentials() {
        let credential = (0..40)
            .map(|line| format!("credential-line-{line:02}"))
            .collect::<Vec<_>>()
            .join("\n");
        // Unredacted, the cut would land inside the credential.
        let detail = format!(
            "{}\n{credential}\n{}",
            detail(0, 160, 99),
            detail(1, 40, 99)
        );
        let message = fit(
            &[diagnostic("vLLM exited", detail)],
            std::slice::from_ref(&credential),
        );
        assert!(
            !message.contains("credential-line"),
            "part of the credential leaked"
        );

        let short = "abcdefgh".to_owned();
        let detail = vec![short.as_str(); 1800].join("\n");
        assert!(detail.len() < LIMIT, "the unredacted detail must fit");
        let message = fit(&[diagnostic("s", detail)], std::slice::from_ref(&short));
        assert!(
            !message.replace("[redacted]", "").contains(&short),
            "a credential leaked"
        );
        assert!(
            message.contains("rest of this diagnostic"),
            "the grown detail was not cut"
        );
    }

    /// Absent and empty summaries and details, multibyte text, and earlier
    /// diagnostics that leave a few bytes or none never exceed the limit or
    /// show an empty cut.
    #[test]
    fn any_mix_of_diagnostics_stays_within_the_limit() {
        // The byte arithmetic doesn't depend on the limit's size, so small
        // limits keep this fast; other tests cover 16 KiB.
        let mut full = 0;
        for limit in [256, 512] {
            let summaries = [
                None,
                Some(String::new()),
                Some("summary".into()),
                Some("é".repeat(limit / 2)),
            ];
            let details = [
                None,
                Some(String::new()),
                Some("short".into()),
                Some("日本".repeat(limit / 3)),
                Some(vec!["é".repeat(7); limit / 8].join("\n")),
            ];
            // From a first diagnostic that leaves no room at all down to one
            // that leaves room for part of the next.
            for fill in (limit - 230..=limit - 6).rev() {
                let first = "é".repeat(fill / 2) + &"x".repeat(fill % 2);
                for summary in &summaries {
                    for detail in &details {
                        for third in [false, true] {
                            let mut diagnostics = vec![[Some("first".into()), Some(first.clone())]];
                            diagnostics.push([summary.clone(), detail.clone()]);
                            if third {
                                diagnostics.push([Some("third".into()), None]);
                            }
                            let message = fit_diagnostics(diagnostics, &[], limit);
                            let case = format!(
                                "limit {limit}, fill {fill}, {:?}, {:?}, {third}",
                                summary.as_ref().map(String::len),
                                detail.as_ref().map(String::len)
                            );
                            assert!(message.len() <= limit, "{} bytes: {case}", message.len());
                            assert!(
                                !message.contains("\n\n[rest") && !message.starts_with("[rest"),
                                "an empty cut: {case}"
                            );
                            assert!(
                                message.matches("left out").count() <= 1,
                                "more than one marker: {case}"
                            );
                            if message.starts_with(&format!("first\n{first}\n["))
                                && !message.contains("[rest")
                            {
                                full += 1;
                            }
                        }
                    }
                }
            }
        }
        assert!(
            full > 0,
            "no case filled the error so the next diagnostic had no room"
        );
    }

    /// Runs a fake OpenTofu plan that reports `diagnostics` and fails, and
    /// returns the error's diagnostic.
    #[cfg(unix)]
    async fn failed_plan(script: &str, output: &str, secret: Option<&str>) -> String {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("output"), output).unwrap();
        let binary = directory.path().join("tofu");
        crate::executable::write_executable(&binary, format!("#!/bin/sh\n{script}\nexit 1\n"));
        let overrides = secret
            .map(|secret| BTreeMap::from([("CUSTOM_CREDENTIAL".into(), secret.into())]))
            .unwrap_or_default();
        let error = run_with_progress(
            directory.path(),
            &binary,
            &["plan", "-json"],
            &overrides,
            &CancellationToken::new(),
            None,
            Some(std::sync::Arc::new(|_| {})),
        )
        .await
        .unwrap_err();
        let Error::Execution { diagnostic, .. } = error else {
            panic!("expected the plan's failure, got {error:?}");
        };
        diagnostic
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn opentofu_diagnostics_past_the_limit_keep_those_that_fit_and_count_the_rest() {
        let secret = "secret-sentinel-value";
        let diagnostics: Vec<_> = (0..6)
            .map(|service| {
                let mut detail = detail(service, 50, 99);
                if service == 1 || service == 4 {
                    detail.push_str(&format!("\nkey={secret}"));
                }
                diagnostic(&format!("service {service} failed readiness"), detail)
            })
            .collect();
        let mut lines = vec![serde_json::json!({"type": "version", "ui": "1.2"}).to_string()];
        for [summary, detail] in &diagnostics {
            lines.push(
                serde_json::json!({
                    "type": "diagnostic",
                    "diagnostic": {"severity": "error", "summary": summary, "detail": detail}
                })
                .to_string(),
            );
        }
        let message = failed_plan("cat output", &(lines.join("\n") + "\n"), Some(secret)).await;
        let kept = joined(&diagnostics[..3]).replace(secret, "[redacted]");
        assert!(
            message.starts_with(&format!("{kept}\n")),
            "the first three diagnostics are not reported whole and in order: {message}"
        );
        let rest: Vec<_> = message[kept.len() + 1..].lines().collect();
        assert_eq!(rest[0], "service 3 failed readiness");
        assert_eq!(
            rest.len(),
            2,
            "more than a summary and the omitted count follow: {rest:?}"
        );
        assert!(
            rest[1].contains("2 more diagnostics"),
            "the omitted count is missing: {rest:?}"
        );
        assert!(!message.contains(secret), "a credential leaked");
        assert!(message.len() <= LIMIT, "the error exceeds the limit");
    }

    /// Cut stderr can end inside a credential, so it is still withheld.
    #[cfg(unix)]
    #[tokio::test]
    async fn stderr_past_the_limit_is_still_withheld() {
        let message = failed_plan("cat output >&2", &"provider crashed\n".repeat(2000), None).await;
        assert_eq!(message, "child output exceeds the supported limit");
    }
}

// An unrelated credential must not erase a safe diagnostic produced by a
// provider. The native CLI tests retain the untrusted-response/redaction boundary.
#[cfg(all(test, any(unix, windows)))]
#[tokio::test]
async fn unrelated_credentials_preserve_native_context_through_json_capture() {
    let directory = tempfile::tempdir().unwrap();
    let summary = "Fabric configuration failed";
    let detail = "sandbox/assistant start failed (lifecycle_adapter_start_failed); agent runtime is unavailable; resources retained";
    let lines = [
        serde_json::json!({"type": "version", "ui": "1.0"}).to_string(),
        serde_json::json!({
            "type": "diagnostic",
            "diagnostic": {"severity": "error", "summary": summary, "detail": detail}
        })
        .to_string(),
    ];
    #[cfg(unix)]
    let binary = {
        let path = directory.path().join("diagnostic-child");
        crate::executable::write_executable(
            &path,
            format!(
                "#!/bin/sh\nprintf '%s\\n' '{}' '{}'\nexit 1\n",
                lines[0], lines[1]
            ),
        );
        path
    };
    #[cfg(windows)]
    let binary = {
        let path = directory.path().join("diagnostic-child.cmd");
        std::fs::write(
            &path,
            format!(
                "@echo off\r\necho {}\r\necho {}\r\nexit /b 1\r\n",
                lines[0], lines[1]
            ),
        )
        .unwrap();
        path
    };
    let received = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let events = received.clone();
    let error = run_with_progress(
        directory.path(),
        &binary,
        &["apply", "-json"],
        &[(
            "CUSTOM_CREDENTIAL".into(),
            "inert-credential-for-context-check".into(),
        )]
        .into(),
        &CancellationToken::new(),
        None,
        Some(std::sync::Arc::new(move |event| {
            events.lock().unwrap().push(event)
        })),
    )
    .await
    .unwrap_err();
    let Error::Execution {
        operation,
        diagnostic,
        postcondition_failures,
    } = error
    else {
        panic!("expected the child execution failure");
    };
    assert_eq!(operation, "apply");
    assert_eq!(diagnostic, format!("{summary}\n{detail}"));
    assert!(postcondition_failures.is_none());
    assert!(
        received
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, crate::Progress::MutationStarted))
    );
}

#[cfg(all(test, unix))]
#[tokio::test]
async fn progress_resource_addresses_redact_credentials() {
    let directory = tempfile::tempdir().unwrap();
    let received = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let events = received.clone();
    run_with_progress(directory.path(), Path::new("/bin/sh"),
        &["-c", r#"printf '%s\n' '{"type":"version","ui":"1.0"}' '{"type":"apply_start","hook":{"resource":{"resource_type":"openshell_sandbox","addr":"openshell_sandbox.secret-sentinel"},"action":"create"}}'"#],
        &[("CUSTOM_CREDENTIAL".into(), "secret-sentinel".into())].into(),
        &CancellationToken::new(),
        None,
        Some(std::sync::Arc::new(move |event| events.lock().unwrap().push(event))))
        .await.unwrap();
    let events = format!("{:?}", received.lock().unwrap());
    assert!(events.contains("openshell_sandbox.[redacted]"));
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
        None,
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
            &["-c", r#"test -n "$CUSTOM_CREDENTIAL" && printf '%s\n' '{"type":"version","ui":"1.0"}' '{"type":"apply_start","hook":{"resource":{"resource_type":"openshell_sandbox","addr":"openshell_sandbox.alpha"},"action":"create"}}'"#],
            &[("CUSTOM_CREDENTIAL".into(), secret.into())].into(), &CancellationToken::new(), None,
            Some(std::sync::Arc::new(move |event| events.lock().unwrap().push(event)))).await.unwrap();
        assert!(
            received.lock().unwrap().is_empty(),
            "short credentials must not expose child progress text"
        );
    }
    assert!(messages.windows(2).all(|pair| pair[0] == pair[1]));
}
