// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use clap::Parser;
use nemoclaw_onboarding::{Source, author};
use nemoclaw_sdk::CancellationToken;
use std::{io::IsTerminal, path::PathBuf, process::ExitCode};

#[derive(Debug, Parser)]
#[command(
    name = "nemoclaw-onboarding",
    version,
    about = "Run an example NemoClaw authoring experience",
    long_about = "Run an example terminal frontend over nemoclaw-authoring. This command generates desired-state YAML only; it does not resolve credentials, plan, or apply a deployment."
)]
struct Cli {
    /// Write generated YAML to a new file; existing files are never overwritten.
    #[arg(short, long, value_name = "FILE", default_value = "deployment.yaml")]
    output: PathBuf,
    /// YAML defaults for a new deployment.
    #[arg(value_name = "FILE")]
    template: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    if !std::io::stdin().is_terminal() {
        eprintln!("the example onboarding TUI requires a terminal on stdin");
        return ExitCode::FAILURE;
    }

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
    let source = cli
        .template
        .as_deref()
        .map_or(Source::Defaults, Source::Template);
    let result = author(source, &cli.output, &cancel).await;
    signals.abort();
    match result {
        Ok(saved) => {
            if saved {
                eprintln!("Authored desired state: {}", cli.output.display());
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn interrupt() -> std::io::Result<impl std::future::Future<Output = ()>> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut interruption = signal(SignalKind::interrupt())?;
        let mut termination = signal(SignalKind::terminate())?;
        Ok(async move {
            tokio::select! { _ = interruption.recv() => {}, _ = termination.recv() => {} }
        })
    }
    #[cfg(not(unix))]
    {
        Ok(async {
            let _ = tokio::signal::ctrl_c().await;
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::{CommandFactory, error::ErrorKind};

    #[test]
    fn example_command_exposes_only_generation_inputs() {
        Cli::command().debug_assert();
        let cli = Cli::try_parse_from([
            "nemoclaw-onboarding",
            "--output",
            "draft.yaml",
            "template.yaml",
        ])
        .unwrap();
        assert_eq!(cli.output, PathBuf::from("draft.yaml"));
        assert_eq!(cli.template, Some(PathBuf::from("template.yaml")));
        for unsupported in [
            "--edit",
            "--apply",
            "--state-dir",
            "--bundle",
            "--non-interactive",
        ] {
            assert_eq!(
                Cli::try_parse_from(["nemoclaw-onboarding", unsupported])
                    .err()
                    .unwrap()
                    .kind(),
                ErrorKind::UnknownArgument
            );
        }
    }
}
