// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod args;
mod dispatch;
mod io;
mod progress;
use args::{Cli, Command};
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
    let cancel = CancellationToken::new();
    let signal = cancel.clone();
    let signals = tokio::spawn(async move {
        interrupt().await;
        signal.cancel();
    });
    let output_path = match &cli.command {
        Command::Export { output } => output.clone(),
        _ => None,
    };
    let result = dispatch::run(cli, tokio::io::stdin(), &cancel)
        .await
        .and_then(dispatch::CommandResult::render);
    signals.abort();
    match result {
        Ok(output) => match io::write_output(
            output_path.as_deref(),
            output.as_bytes(),
            std::io::stdout().lock(),
        ) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{error}");
                ExitCode::FAILURE
            }
        },
        Err(error) => {
            eprintln!("{}", dispatch::render_error(error.as_ref()));
            ExitCode::FAILURE
        }
    }
}
