// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::args::Cli;
use std::{
    ffi::OsString,
    process::{ExitCode, ExitStatus, Stdio},
    sync::Arc,
};

pub(crate) async fn run(cli: &Cli, args: &[OsString]) -> ExitCode {
    match execute(cli, args).await {
        Ok(status) => {
            #[cfg(unix)]
            let code = {
                use std::os::unix::process::ExitStatusExt;
                status
                    .code()
                    .unwrap_or_else(|| 128 + status.signal().unwrap_or(1))
            };
            #[cfg(not(unix))]
            let code = status.code().unwrap_or(1);
            ExitCode::from(u8::try_from(code).unwrap_or(1))
        }
        Err(error) => {
            eprintln!("OpenShell failed: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn execute(cli: &Cli, args: &[OsString]) -> Result<ExitStatus, Box<dyn std::error::Error>> {
    let deployment = crate::deployment::create(
        &cli.state_dir,
        cli.bundle_dir.as_deref(),
        &nemoclaw_sdk::CancellationToken::new(),
        Arc::new(|_| {}),
    )?;
    let mut process = deployment.openshell()?;
    let help = args.is_empty()
        || args
            .iter()
            .any(|arg| matches!(arg.to_str(), Some("--help" | "-h" | "--version" | "-V")));
    if !help && let Some(registration) = process.registration().await? {
        if !matches!(args, [gateway, login] if (gateway == "gateway" || gateway == "gw") && login == "login")
        {
            return Err(format!(
                "OIDC login is required; run {} -- gateway login",
                crate::formatting::RenderContext::new(cli).deployment_command("osh")
            )
            .into());
        }
        // `gateway add` performs the initial login itself. Do not immediately
        // launch a second browser or repeat a client-credentials exchange.
        let registration: Vec<_> = registration.into_iter().map(OsString::from).collect();
        return child(process.command(), &registration).await;
    }
    child(process.command(), args).await
}

async fn child(
    command: &mut tokio::process::Command,
    args: &[OsString],
) -> Result<ExitStatus, Box<dyn std::error::Error>> {
    // Keep the foreground process group and inherited terminal for native TUIs.
    // Register before spawning, so a signal cannot leave an unobserved child.
    #[cfg(unix)]
    let (mut interrupt, mut terminate) = {
        use tokio::signal::unix::{SignalKind, signal};
        (
            signal(SignalKind::interrupt())?,
            signal(SignalKind::terminate())?,
        )
    };
    let mut child = command
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    loop {
        #[cfg(unix)]
        {
            use nix::{
                sys::signal::{Signal, kill},
                unistd::Pid,
            };
            let signal = tokio::select! {
                status = child.wait() => return Ok(status?),
                _ = interrupt.recv() => Signal::SIGINT,
                _ = terminate.recv() => Signal::SIGTERM,
            };
            if let Some(id) = child.id().and_then(|id| i32::try_from(id).ok()) {
                // A terminal also sends the signal to the foreground child;
                // forwarding covers signals addressed to NemoClaw alone.
                let _ = kill(Pid::from_raw(id), signal);
            }
        }
        #[cfg(not(unix))]
        {
            return Ok(child.wait().await?);
        }
    }
}
