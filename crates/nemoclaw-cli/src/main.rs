// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod args;
mod credentials;
mod deployment;
mod dispatch;
mod formatting;
mod io;
mod onboarding;
#[cfg(test)]
mod onboarding_scenarios;
mod progress;
use args::Cli;
use clap::Parser;
use nemoclaw_sdk::CancellationToken;
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
    let output_format = cli.command.output_format();
    let cancel = CancellationToken::new();
    let signal = cancel.clone();
    let signals = tokio::spawn(async move {
        interrupt().await;
        signal.cancel();
    });
    let output_path = match &cli.command {
        args::Command::Export { output } => output.clone(),
        _ => None,
    };
    let result = dispatch::run(cli, tokio::io::stdin(), &cancel).await;
    signals.abort();
    match result {
        Ok(dispatch::CommandResult::OnboardExit) => ExitCode::SUCCESS,
        Ok(result) => {
            match formatting::render(result, output_format).and_then(|output| {
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
            eprintln!("{}", formatting::render_error(error.as_ref()));
            ExitCode::FAILURE
        }
    }
}
