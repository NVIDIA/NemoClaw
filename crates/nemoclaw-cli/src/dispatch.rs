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
