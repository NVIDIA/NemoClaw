// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
        for (name, value) in std::env::vars_os() {
            let upper = name.to_string_lossy().to_ascii_uppercase();
            if !["TF_", "TOFU_", "PLUGIN_", "NEMOCLAW_INTERNAL_"]
                .iter()
                .any(|prefix| upper.starts_with(prefix))
            {
                command.env(name, value);
            }
        }
        command.envs(overrides);
        if let Some(downloads) = &downloads {
            command.env("NEMOCLAW_INTERNAL_PROGRESS_ENDPOINT", &downloads.endpoint);
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
    })?;
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
    if status.is_ok_and(|status| status.success()) && !overflow {
        if !valid_ui {
            return Err(Error::State("invalid or unsupported OpenTofu UI stream"));
        }
        return Ok(output);
    }
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
    for (name, value) in overrides.iter().filter(|(_, value)| !value.is_empty()) {
        if !matches!(
            name.as_str(),
            "TF_IN_AUTOMATION" | "TF_INPUT" | "TF_CLI_CONFIG_FILE" | "CHECKPOINT_DISABLE"
        ) {
            message = message.replace(value, "[redacted]");
        }
    }
    for (name, value) in std::env::vars() {
        let upper = name.to_ascii_uppercase();
        if !value.is_empty()
            && ["KEY", "TOKEN", "SECRET", "PASSWORD"]
                .iter()
                .any(|part| upper.contains(part))
        {
            message = message.replace(&value, "[redacted]");
        }
    }
    if overflow || diagnostic_overflow {
        message = "child output exceeds the supported limit".into();
    }
    Err(Error::Execution {
        operation: args.first().unwrap_or(&"command").to_string(),
        diagnostic: message.trim().into(),
    })
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
    let result=tokio::time::timeout(Duration::from_secs(7),run(directory.path(),Path::new("/usr/bin/python3"),&["-c", "import os,time; pid=os.fork(); (os.setsid(),open('escaped.pid','w').write(str(os.getpid())),time.sleep(30)) if pid==0 else None"],&Default::default(),&CancellationToken::new())).await;
    if let Ok(pid) = std::fs::read_to_string(directory.path().join("escaped.pid")) {
        let _ = std::process::Command::new("kill")
            .args(["-KILL", pid.trim()])
            .status();
    }
    assert!(
        result.is_ok(),
        "capture outlived the exited command without a bound"
    );
    assert!(result.unwrap().is_err());
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
