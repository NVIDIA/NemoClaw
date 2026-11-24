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
    Authored {
        path: Option<std::path::PathBuf>,
        missing_credentials: Vec<(String, &'static str)>,
    },
    Operation(Box<OperationResult>),
}

fn saved_document(
    path: std::path::PathBuf,
    document: &Document,
    mut available: impl FnMut(&str) -> bool,
) -> CommandResult {
    let plan = document.plan_credential_names();
    let missing_credentials = document
        .credential_names()
        .into_iter()
        .filter(|name| !available(name))
        .map(|name| {
            (
                name.to_owned(),
                if plan.contains(&name) {
                    "plan"
                } else {
                    "apply"
                },
            )
        })
        .collect();
    CommandResult::Authored {
        path: Some(path),
        missing_credentials,
    }
}

pub(crate) async fn run<R: AsyncRead + Unpin>(
    cli: Cli,
    mut stdin: R,
    cancel: &CancellationToken,
    force_stop: &CancellationToken,
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
        let saved = nemoclaw_onboarding::author(source, output, true, cancel).await?;
        return if saved {
            let document = document(output, tokio::io::empty(), cancel).await?;
            Ok(saved_document(output.clone(), &document, |name| {
                std::env::var(name).is_ok_and(|value| !value.is_empty())
            }))
        } else {
            Ok(CommandResult::Authored {
                path: None,
                missing_credentials: Vec::new(),
            })
        };
    }
    let mut deployment = deployment(&state_dir, bundle_dir.as_deref(), force_stop, progress)?;
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
                document.plan_credential_names(),
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
                document.credential_names(),
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
    Ok(CommandResult::Operation(Box::new(result)))
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

    #[test]
    fn saving_reminds_about_missing_credentials_at_the_stage_that_needs_them() {
        let document = Document::parse(
            include_bytes!("../../../examples/onboarding/openclaw.yaml").as_slice(),
        )
        .unwrap();
        let cli = Cli::try_parse_from(["nemoclaw", "onboard"]).unwrap();
        let result = saved_document("deployment.yaml".into(), &document, |_| false);
        let text = crate::formatting::render(
            result,
            crate::args::OutputFormat::Text,
            &crate::formatting::RenderContext::new(&cli),
        )
        .unwrap();
        assert!(
            text.contains("NVIDIA_API_KEY: not set; apply will ask"),
            "{text}"
        );
        assert!(text.contains("not saved in the deployment file"), "{text}");
    }

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
