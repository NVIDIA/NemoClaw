// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{CancellationToken, Error};
use process_wrap::tokio::{CommandWrap, KillOnDrop};
use std::{collections::BTreeMap, path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt};

async fn capture(
    mut pipe: impl AsyncRead + Unpin,
    limit: usize,
) -> std::io::Result<(Vec<u8>, bool)> {
    let mut output = Vec::new();
    let mut overflow = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let count = pipe.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let available = limit.saturating_sub(output.len());
        output.extend_from_slice(&buffer[..count.min(available)]);
        overflow |= count > available;
    }
    Ok((output, overflow))
}
pub(crate) async fn run(
    directory: &Path,
    binary: &Path,
    args: &[&str],
    overrides: &BTreeMap<String, String>,
    cancel: &CancellationToken,
) -> Result<Vec<u8>, Error> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
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
    let stdout = tokio::spawn(capture(
        child.stdout().take().expect("piped stdout"),
        64 * 1024 * 1024,
    ));
    let stderr = tokio::spawn(capture(child.stderr().take().expect("piped stderr"), 16384));
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
    let ((output, overflow), (mut diagnostic, diagnostic_overflow)) = tokio::try_join!(
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
    )?;
    if status.is_ok_and(|status| status.success()) && !overflow {
        return Ok(output);
    }
    let mut message = String::from_utf8_lossy(&diagnostic).into_owned();
    diagnostic.fill(0);
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

#[cfg(test)]
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
