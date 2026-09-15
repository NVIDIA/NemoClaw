// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod args;
use args::{Cli, Command};
use clap::Parser;
use nemoclaw_sdk::{CancellationToken, Deployment, Error, config::Document};
use std::{io::Write, path::PathBuf, process::ExitCode};
use tokio::io::AsyncReadExt;

async fn document(
    file: Option<PathBuf>,
    cancel: &CancellationToken,
) -> Result<Document, Box<dyn std::error::Error>> {
    if let Some(path) = file.filter(|path| path != std::path::Path::new("-")) {
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
                .apply(&document(Some(file), cancel).await?, cancel)
                .await?
        }
        Command::Export { .. } => return Ok(deployment.export(cancel).await?.yaml()?),
        Command::Destroy => deployment.destroy(cancel).await?,
    };
    Ok(format!("{}\n", serde_json::to_string(&result)?))
}
fn write_output(path: Option<&std::path::Path>, bytes: &[u8]) -> std::io::Result<()> {
    match path {
        Some(path) => {
            let parent = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(std::path::Path::new("."));
            let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
            temporary.write_all(bytes)?;
            temporary.persist(path).map_err(|error| error.error)?;
            Ok(())
        }
        None => std::io::stdout().write_all(bytes),
    }
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
    let output_path = match &cli.command {
        Command::Export { output } => output.clone(),
        _ => None,
    };
    let result = run(cli, &cancel).await;
    signals.abort();
    match result {
        Ok(output) => match write_output(output_path.as_deref(), output.as_bytes()) {
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
