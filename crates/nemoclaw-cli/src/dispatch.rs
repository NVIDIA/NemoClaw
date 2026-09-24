// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{
    args::{Cli, Command},
    credentials,
    deployment::create as deployment,
    io::document,
};
use nemoclaw_sdk::{CancellationToken, OperationResult, Progress, config::Document};
use std::{path::Path, sync::Arc};
use tokio::io::{AsyncBufReadExt, AsyncRead};

pub(crate) enum CommandResult {
    Export(Box<Document>),
    Authored(Option<std::path::PathBuf>),
    Operation(OperationResult),
}

pub(crate) async fn run<R: AsyncRead + Unpin>(
    cli: Cli,
    mut stdin: R,
    cancel: &CancellationToken,
    progress: Arc<dyn Fn(Progress) + Send + Sync>,
) -> Result<CommandResult, Box<dyn std::error::Error>> {
    let Cli {
        state_dir,
        bundle_dir,
        command,
        ..
    } = cli;
    if let Command::Onboard { file, output } = &command {
        let source = file.as_deref().map_or(
            nemoclaw_onboarding::Source::Defaults,
            nemoclaw_onboarding::Source::Template,
        );
        let saved = nemoclaw_onboarding::author(source, output, cancel).await?;
        return Ok(CommandResult::Authored(saved.then(|| output.clone())));
    }
    let mut deployment = deployment(&state_dir, bundle_dir.as_deref(), progress)?;
    let result = match command {
        Command::Plan { destroy: true, .. } => deployment.plan_destroy(cancel).await?,
        Command::Plan {
            file: Some(file),
            non_interactive,
            ..
        } => {
            let document = document(&file, &mut stdin, cancel).await?;
            let mut lines = tokio::io::BufReader::new(stdin).lines();
            deployment = credentials::attach(
                deployment,
                &document,
                non_interactive,
                file != Path::new("-"),
                &mut lines,
                cancel,
            )
            .await?;
            deployment.plan(&document, cancel).await?
        }
        Command::Apply {
            file,
            non_interactive,
            ..
        } => {
            let document = document(&file, &mut stdin, cancel).await?;
            let mut lines = tokio::io::BufReader::new(stdin).lines();
            deployment = credentials::attach(
                deployment,
                &document,
                non_interactive,
                file != Path::new("-"),
                &mut lines,
                cancel,
            )
            .await?;
            deployment.apply(&document, cancel).await?
        }
        Command::Plan {
            file: None,
            destroy: false,
            ..
        } => return Err("configuration input is required".into()),
        Command::Export { .. } => {
            return Ok(CommandResult::Export(Box::new(
                deployment.export(cancel).await?,
            )));
        }
        Command::Destroy { .. } => deployment.destroy(cancel).await?,
        Command::Onboard { .. } => unreachable!("onboarding returns before deployment setup"),
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
                run(
                    cli,
                    ForbiddenInput,
                    &CancellationToken::new(),
                    Arc::new(|_| {})
                )
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
                Arc::new(|_| {}),
            )
            .await
            .err()
            .unwrap();
            assert!(!error.to_string().contains("secret-sentinel"));
            assert!(!state.exists());
        }
    }
}
