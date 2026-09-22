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
use std::{io::IsTerminal, process::ExitCode};

fn interrupt() -> std::io::Result<impl std::future::Future<Output = ()>> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        // Install both handlers before dispatch can print a prompt. Registration
        // inside the spawned task leaves a window for default signal handling.
        let mut interruption = signal(SignalKind::interrupt())?;
        let mut termination = signal(SignalKind::terminate())?;
        Ok(async move {
            tokio::select! {_=interruption.recv()=>{},_=termination.recv()=>{}}
        })
    }
    #[cfg(not(unix))]
    {
        Ok(async {
            let _ = tokio::signal::ctrl_c().await;
        })
    }
}
#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    let requires_terminal_input = cli.command.requires_terminal_input();
    if requires_terminal_input && !std::io::stdin().is_terminal() {
        eprintln!(
            "interactive onboarding requires a terminal on stdin; use --non-interactive for scripts"
        );
        return ExitCode::FAILURE;
    }
    let output_format = cli.command.output_format();
    let cancel = CancellationToken::new();
    let signal = cancel.clone();
    let interruption = match interrupt() {
        Ok(interruption) => interruption,
        Err(error) => {
            eprintln!("cannot listen for interruption: {error}");
            return ExitCode::FAILURE;
        }
    };
    let signals = tokio::spawn(async move {
        interruption.await;
        signal.cancel();
    });
    let output_path = match &cli.command {
        args::Command::Export { output } => output.clone(),
        _ => None,
    };
    #[cfg(unix)]
    let result = if requires_terminal_input {
        match io::TerminalInput::open() {
            Ok(stdin) => dispatch::run(cli, stdin, &cancel).await,
            Err(error) => Err(error.into()),
        }
    } else {
        dispatch::run(cli, tokio::io::stdin(), &cancel).await
    };
    #[cfg(not(unix))]
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
