// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{
    args::{Cli, Command},
    io::document,
};
use nemoclaw_sdk::{CancellationToken, Deployment, Error, OperationResult, config::Document};
use tokio::io::AsyncRead;

pub(crate) enum CommandResult {
    Export(Box<Document>),
    Operation(OperationResult),
}
impl CommandResult {
    pub(crate) fn render(self) -> Result<String, Box<dyn std::error::Error>> {
        match self {
            Self::Export(document) => Ok(document.yaml()?),
            Self::Operation(result) => Ok(format!("{}\n", serde_json::to_string(&result)?)),
        }
    }
}

pub(crate) async fn run<R: AsyncRead + Unpin>(
    cli: Cli,
    stdin: R,
    cancel: &CancellationToken,
) -> Result<CommandResult, Box<dyn std::error::Error>> {
    let bundle = match cli.bundle_dir {
        Some(path) => path,
        None => std::env::current_exe()?
            .parent()
            .and_then(|p| p.parent())
            .ok_or(Error::Bundle("cannot locate runtime bundle"))?
            .into(),
    };
    let mut deployment = Deployment::new(&cli.state_dir, &bundle);
    if cli.verbose {
        deployment = deployment.with_progress(std::sync::Arc::new(|event| {
            if let nemoclaw_sdk::Progress::Completed {
                operation,
                elapsed,
                outcome,
            } = event
            {
                use std::io::Write;
                let _ = writeln!(
                    std::io::stderr().lock(),
                    "{operation} {outcome} {:.3}s",
                    elapsed.as_secs_f64()
                );
            }
        }));
    }
    let result = match cli.command {
        Command::Plan { destroy: true, .. } => deployment.plan_destroy(cancel).await?,
        Command::Plan {
            file: Some(file), ..
        } => {
            deployment
                .plan(&document(&file, stdin, cancel).await?, cancel)
                .await?
        }
        Command::Apply { file } => {
            deployment
                .apply(&document(&file, stdin, cancel).await?, cancel)
                .await?
        }
        Command::Plan {
            file: None,
            destroy: false,
        } => return Err("configuration input is required".into()),
        Command::Export { .. } => {
            return Ok(CommandResult::Export(Box::new(
                deployment.export(cancel).await?,
            )));
        }
        Command::Destroy => deployment.destroy(cancel).await?,
    };
    Ok(CommandResult::Operation(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use std::{
        pin::Pin,
        task::{Context, Poll},
    };
    use tokio::io::ReadBuf;

    struct ForbiddenInput;
    impl AsyncRead for ForbiddenInput {
        fn poll_read(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            _: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            panic!("this command must not read stdin");
        }
    }

    #[tokio::test]
    async fn observation_and_teardown_commands_never_read_input() {
        for args in [
            vec!["nemoclaw", "plan", "--destroy"],
            vec!["nemoclaw", "destroy"],
            vec!["nemoclaw", "export"],
        ] {
            let directory = tempfile::tempdir().unwrap();
            let mut cli = Cli::try_parse_from(args).unwrap();
            cli.bundle_dir = Some(directory.path().join("missing-bundle"));
            cli.state_dir = directory.path().join("state");
            // The real SDK rejects the missing bundle; no runtime is invoked.
            assert!(
                run(cli, ForbiddenInput, &CancellationToken::new())
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn configuration_commands_validate_injected_input_before_creating_state() {
        for command in ["plan", "apply"] {
            let directory = tempfile::tempdir().unwrap();
            let state = directory.path().join("state");
            let mut cli = Cli::try_parse_from(["nemoclaw", command, "-"]).unwrap();
            cli.state_dir = state.clone();
            cli.bundle_dir = Some(directory.path().join("missing-bundle"));
            let error = run(
                cli,
                &b"apiKey: secret-sentinel"[..],
                &CancellationToken::new(),
            )
            .await
            .err()
            .unwrap();
            assert!(!error.to_string().contains("secret-sentinel"));
            assert!(!state.exists());
        }
    }
}
