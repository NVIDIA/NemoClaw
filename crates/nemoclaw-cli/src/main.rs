// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use clap::{Parser, Subcommand};
use nemoclaw_sdk::{CancellationToken, Deployment, Error, config::Document};
use std::{io::Write, path::PathBuf, process::ExitCode};
use tokio::io::AsyncReadExt;

#[derive(Parser)]
#[command(
    name = "nemoclaw",
    version,
    about = "Manage an agent deployment from desired state"
)]
struct Cli {
    #[arg(long, global = true, default_value = ".nemoclaw")]
    state_dir: PathBuf,
    #[arg(long = "bundle", alias = "bundle-dir", global = true)]
    bundle_dir: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Preview configuration changes without changing runtime resources.
    Plan {
        #[arg(long, conflicts_with = "file")]
        destroy: bool,
        #[arg(long)]
        file: Option<PathBuf>,
    },
    /// Apply a configuration read from a file or standard input.
    Apply {
        #[arg(long)]
        file: Option<PathBuf>,
    },
    /// Export observed configuration without secret values.
    Export,
    /// Remove owned workloads while retaining persistent data.
    Destroy,
}
async fn document(
    file: Option<PathBuf>,
    cancel: &CancellationToken,
) -> Result<Document, Box<dyn std::error::Error>> {
    if let Some(path) = file {
        return Ok(Document::parse(std::fs::File::open(path)?)?);
    }
    let mut bytes = Vec::new();
    let mut input = tokio::io::stdin().take(nemoclaw_sdk::config::MAX_DOCUMENT_BYTES + 1);
    tokio::select! {()=cancel.cancelled()=>return Err(Error::Cancelled.into()),result=input.read_to_end(&mut bytes)=>{result?;}}
    Ok(Document::parse(bytes.as_slice())?)
}
async fn run(cli: Cli, cancel: &CancellationToken) -> Result<String, Box<dyn std::error::Error>> {
    let bundle = match cli.bundle_dir {
        Some(path) => path,
        None => std::env::current_exe()?
            .parent()
            .and_then(|p| p.parent())
            .ok_or(Error::Bundle("cannot locate runtime bundle"))?
            .into(),
    };
    let deployment = Deployment::new(&cli.state_dir, &bundle);
    let result = match cli.command {
        Command::Plan { destroy: true, .. } => deployment.plan_destroy(cancel).await?,
        Command::Plan { file, .. } => {
            deployment
                .plan(&document(file, cancel).await?, cancel)
                .await?
        }
        Command::Apply { file } => {
            deployment
                .apply(&document(file, cancel).await?, cancel)
                .await?
        }
        Command::Export => return Ok(deployment.export(cancel).await?.yaml()?),
        Command::Destroy => deployment.destroy(cancel).await?,
    };
    Ok(format!("{}\n", serde_json::to_string(&result)?))
}
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
    let result = run(cli, &cancel).await;
    signals.abort();
    match result {
        Ok(output) => match std::io::stdout().write_all(output.as_bytes()) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{error}");
                ExitCode::FAILURE
            }
        },
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
