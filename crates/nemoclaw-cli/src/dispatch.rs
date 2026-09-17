// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{
    args::{Cli, Command},
    authoring::{Answers, AuthoredDocument, Capabilities, Session},
    io::document,
};
use nemoclaw_sdk::{CancellationToken, Deployment, Error, OperationResult, config::Document};
use tokio::io::AsyncRead;

pub(crate) enum CommandResult {
    Onboard(Box<AuthoredDocument>),
    Export(Box<Document>),
    Operation(OperationResult),
}
impl CommandResult {
    pub(crate) fn render(self) -> Result<String, Box<dyn std::error::Error>> {
        match self {
            Self::Onboard(authored) => Ok(authored.yaml().to_owned()),
            Self::Export(document) => Ok(document.yaml()?),
            Self::Operation(result) => Ok(format!("{}\n", serde_json::to_string(&result)?)),
        }
    }

    pub(crate) fn notice(&self) -> Option<String> {
        match self {
            Self::Onboard(authored) => Some(format!(
                "Credential references: {}",
                authored.document().credential_names().join(", ")
            )),
            _ => None,
        }
    }
}

pub(crate) fn render_error(error: &(dyn std::error::Error + 'static)) -> String {
    if let Some(Error::Health { health }) = error.downcast_ref::<Error>() {
        return serde_json::json!({
            "error": "fabric_readiness", "health": health, "resourcesRetained": true
        })
        .to_string();
    }
    if let Some(Error::SandboxStartup { .. }) = error.downcast_ref::<Error>() {
        return format!(
            "{error}\nInspect with openshell sandbox get NAME -o json using the deployment's gateway and workspace. Collect OpenShell gateway and supervisor logs before cleanup."
        );
    }
    error.to_string()
}

pub(crate) async fn run<R: AsyncRead + Unpin>(
    cli: Cli,
    stdin: R,
    cancel: &CancellationToken,
) -> Result<CommandResult, Box<dyn std::error::Error>> {
    let command = match cli.command {
        Command::Onboard {
            generate_only: _,
            output: _,
            non_interactive,
            name,
            sandbox,
            agent,
            provider,
            model,
            credential_env,
        } => {
            return onboard(
                non_interactive,
                OnboardValues {
                    name,
                    sandbox,
                    agent,
                    provider,
                    model,
                    credential_env,
                },
                stdin,
                cancel,
            )
            .await;
        }
        command => command,
    };
    let bundle = match cli.bundle_dir {
        Some(path) => path,
        None => std::env::current_exe()?
            .parent()
            .and_then(|p| p.parent())
            .ok_or(Error::Bundle("cannot locate runtime bundle"))?
            .into(),
    };
    let mut deployment = Deployment::new(&cli.state_dir, &bundle);
    use std::io::IsTerminal;
    if cli.verbose || std::io::stderr().is_terminal() {
        deployment = deployment.with_progress(std::sync::Arc::new(move |event| {
            use std::io::Write;
            if let Some(message) = crate::progress::render(event, cli.verbose) {
                let _ = writeln!(std::io::stderr().lock(), "{message}");
            }
        }));
    }
    let result = match command {
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
        Command::Onboard { .. } => unreachable!("onboarding returns before lifecycle setup"),
    };
    Ok(CommandResult::Operation(result))
}

struct OnboardValues {
    name: Option<String>,
    sandbox: Option<String>,
    agent: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    credential_env: Option<String>,
}

async fn onboard<R: AsyncRead + Unpin>(
    non_interactive: bool,
    values: OnboardValues,
    stdin: R,
    cancel: &CancellationToken,
) -> Result<CommandResult, Box<dyn std::error::Error>> {
    let mut answers = Answers::first_slice();
    if non_interactive {
        answers.deployment_name = values.name.unwrap_or(answers.deployment_name);
        answers.sandbox_name = values.sandbox.unwrap_or(answers.sandbox_name);
        answers.agent_name = values.agent.unwrap_or(answers.agent_name);
        answers.provider_name = values.provider.unwrap_or(answers.provider_name);
        answers.model = values.model.unwrap_or(answers.model);
        answers.credential_env = values.credential_env.unwrap_or(answers.credential_env);
    } else {
        use tokio::io::AsyncBufReadExt;
        let mut lines = tokio::io::BufReader::new(stdin).lines();
        answers.deployment_name = value_or_prompt(
            values.name,
            "Deployment name",
            &answers.deployment_name,
            &mut lines,
            cancel,
        )
        .await?;
        answers.sandbox_name = value_or_prompt(
            values.sandbox,
            "Sandbox name",
            &answers.sandbox_name,
            &mut lines,
            cancel,
        )
        .await?;
        answers.agent_name = value_or_prompt(
            values.agent,
            "Agent name",
            &answers.agent_name,
            &mut lines,
            cancel,
        )
        .await?;
        answers.provider_name = value_or_prompt(
            values.provider,
            "Provider name",
            &answers.provider_name,
            &mut lines,
            cancel,
        )
        .await?;
        answers.model =
            value_or_prompt(values.model, "Model", &answers.model, &mut lines, cancel).await?;
        answers.credential_env = value_or_prompt(
            values.credential_env,
            "Credential environment variable",
            &answers.credential_env,
            &mut lines,
            cancel,
        )
        .await?;
    }
    let authored = Session::new()?.project(&Capabilities::first_slice(), &answers)?;
    Ok(CommandResult::Onboard(Box::new(authored)))
}

async fn value_or_prompt<R: tokio::io::AsyncBufRead + Unpin>(
    supplied: Option<String>,
    label: &str,
    default: &str,
    lines: &mut tokio::io::Lines<R>,
    cancel: &CancellationToken,
) -> Result<String, Box<dyn std::error::Error>> {
    if let Some(value) = supplied {
        return Ok(value);
    }
    use std::io::Write;
    eprint!("{label} [{default}]: ");
    std::io::stderr().flush()?;
    let line = tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(Error::Cancelled.into()),
        line = lines.next_line() => line?,
    }
    .ok_or("interactive input ended before authoring completed")?;
    Ok(if line.is_empty() {
        default.into()
    } else {
        line
    })
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
    fn apply_reports_health_without_changing_the_command_surface() {
        let value = serde_json::json!({
            "outcome": "succeeded", "changes": [], "health": [{
                "sandbox": "research", "agents": ["researcher", "writer"],
                "supported": false, "report": null, "reason_code": "fabric_health_unsupported"
            }]
        });
        let result = CommandResult::Operation(serde_json::from_value(value.clone()).unwrap());
        let output: serde_json::Value = serde_json::from_str(&result.render().unwrap()).unwrap();
        assert_eq!(output, value);
    }

    #[test]
    fn sandbox_failure_points_to_openshell_diagnostics() {
        let error = Error::SandboxStartup {
            phase: "SANDBOX_PHASE_ERROR",
            reason: "ControlSupervisorExited",
            exit_code: "unknown".into(),
        };
        let output = render_error(&error);
        assert!(output.contains("ControlSupervisorExited"));
        assert!(output.contains("openshell sandbox get NAME -o json"));
        assert!(output.contains("gateway and workspace"));
        assert!(output.contains("resources retained"));
    }

    #[test]
    fn health_failure_keeps_structured_evidence_in_stderr() {
        let health = serde_json::from_value(serde_json::json!({
            "sandbox": "research", "agents": ["researcher"],
            "supported": true, "report": null, "reason_code": "fabric_health_timeout"
        }))
        .unwrap();
        let error = Error::Health {
            health: Box::new(health),
        };
        let output: serde_json::Value = serde_json::from_str(&render_error(&error)).unwrap();
        assert_eq!(output["health"]["reason_code"], "fabric_health_timeout");
        assert_eq!(output["resourcesRetained"], true);
        assert_eq!(
            render_error(&Error::Conflict("fixed message")),
            "fixed message"
        );
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
