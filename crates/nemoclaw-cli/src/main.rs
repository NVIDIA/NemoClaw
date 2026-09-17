// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod args;
mod authoring;
mod dispatch;
mod io;
#[cfg(test)]
mod parity;
mod progress;
use args::{Cli, Command};
use clap::Parser;
use nemoclaw_sdk::{CancellationToken, config::Document};
use std::process::ExitCode;

async fn interrupt() {
    #[cfg(unix)]
    {
        if let Ok(mut termination) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=termination.recv()=>{}}
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    let cancel = CancellationToken::new();
    let signal = cancel.clone();
    let signals = tokio::spawn(async move {
        interrupt().await;
        signal.cancel();
    });
    let output_path = match &cli.command {
        Command::Export { output } => output.clone(),
        Command::Onboard { output, .. } => Some(output.clone()),
        _ => None,
    };
    let result = dispatch::run(cli, tokio::io::stdin(), &cancel).await;
    signals.abort();
    match result {
        Ok(dispatch::CommandResult::Onboard(authored)) => {
            let authoring::CompletionBoundary::GeneratedDesiredState =
                authored.completion_boundary();
            let path = output_path.expect("onboarding requires an output path");
            match Document::parse(authored.yaml().as_bytes())
                .map_err(std::io::Error::other)
                .and_then(|published| {
                    let credential_references = published.credential_names().join(", ");
                    io::write_output(Some(&path), authored.yaml().as_bytes(), std::io::sink())?;
                    Ok(credential_references)
                }) {
                Ok(credential_references) => {
                    eprintln!("Credential references: {credential_references}");
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("{error}");
                    ExitCode::FAILURE
                }
            }
        }
        Ok(dispatch::CommandResult::OnboardExit) => ExitCode::SUCCESS,
        Ok(result) => {
            match result.render().and_then(|output| {
                io::write_output(
                    output_path.as_deref(),
                    output.as_bytes(),
                    std::io::stdout().lock(),
                )?;
                Ok(())
            }) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("{error}");
                    ExitCode::FAILURE
                }
            }
        }
        Err(error) => {
            eprintln!("{}", dispatch::render_error(error.as_ref()));
            ExitCode::FAILURE
        }
    }
}
