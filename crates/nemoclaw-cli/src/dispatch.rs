// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{
    args::{Cli, Command},
    authoring::{
        Answers, AuthoredDocument, Capabilities, CompletionBoundary, DirectInputs, Draft,
        IdentityEdits, InferenceEdits, InteractiveInputs, Session,
    },
    io::{document, write_output},
};
use nemoclaw_sdk::{CancellationToken, Deployment, Error, OperationResult, config::Document};
use std::{future::Future, path::Path};
use tokio::io::{AsyncBufReadExt, AsyncRead};

pub(crate) enum CommandResult {
    OnboardExit,
    Export(Box<Document>),
    Operation(OperationResult),
}
impl CommandResult {
    pub(crate) fn render(self) -> Result<String, Box<dyn std::error::Error>> {
        match self {
            Self::OnboardExit => Ok(String::new()),
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
    mut stdin: R,
    cancel: &CancellationToken,
) -> Result<CommandResult, Box<dyn std::error::Error>> {
    let Cli {
        state_dir,
        bundle_dir,
        verbose,
        command,
    } = cli;
    let command = match command {
        Command::Onboard {
            generate_only,
            output,
            non_interactive,
            edit,
            name,
            sandbox,
            agent,
            provider,
            model,
            credential_env,
        } => {
            let mut lines = tokio::io::BufReader::new(stdin).lines();
            let authored = match author(
                non_interactive,
                OnboardValues {
                    edit,
                    name,
                    sandbox,
                    agent,
                    provider,
                    model,
                    credential_env,
                },
                &mut lines,
                cancel,
            )
            .await?
            {
                Some(authored) => authored,
                None => return Ok(CommandResult::OnboardExit),
            };
            let CompletionBoundary::GeneratedDesiredState = authored.completion_boundary();
            let document = Document::parse(authored.yaml().as_bytes())?;
            write_output(Some(&output), authored.yaml().as_bytes(), std::io::sink())?;
            eprintln!(
                "Credential references: {}",
                document.credential_names().join(", ")
            );
            if generate_only {
                return Ok(CommandResult::OnboardExit);
            }

            let deployment = deployment(&state_dir, bundle_dir.as_deref(), verbose)?;
            let deployment = with_document_secrets(
                deployment,
                &document,
                non_interactive,
                true,
                &mut lines,
                cancel,
            )
            .await?;
            let result = complete_onboarding(
                || deployment.plan(&document, cancel),
                || deployment.apply(&document, cancel),
                non_interactive,
                &mut lines,
                cancel,
            )
            .await?;
            let Some(result) = result else {
                eprintln!(
                    "Apply declined; generated YAML remains at {}.",
                    output.display()
                );
                return Ok(CommandResult::OnboardExit);
            };
            return Ok(CommandResult::Operation(result));
        }
        command => command,
    };
    let mut deployment = deployment(&state_dir, bundle_dir.as_deref(), verbose)?;
    let result = match command {
        Command::Plan { destroy: true, .. } => deployment.plan_destroy(cancel).await?,
        Command::Plan {
            file: Some(file),
            non_interactive,
            ..
        } => {
            let document = document(&file, &mut stdin, cancel).await?;
            let mut lines = tokio::io::BufReader::new(stdin).lines();
            deployment = with_document_secrets(
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
        } => {
            let document = document(&file, &mut stdin, cancel).await?;
            let mut lines = tokio::io::BufReader::new(stdin).lines();
            deployment = with_document_secrets(
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
        Command::Destroy => deployment.destroy(cancel).await?,
        Command::Onboard { .. } => unreachable!("onboarding returns before lifecycle setup"),
    };
    Ok(CommandResult::Operation(result))
}

fn deployment(
    state_dir: &Path,
    bundle_dir: Option<&Path>,
    verbose: bool,
) -> Result<Deployment, Box<dyn std::error::Error>> {
    let bundle = match bundle_dir {
        Some(path) => path.to_owned(),
        None => std::env::current_exe()?
            .parent()
            .and_then(|p| p.parent())
            .ok_or(Error::Bundle("cannot locate runtime bundle"))?
            .into(),
    };
    let mut deployment = Deployment::new(state_dir, &bundle);
    use std::io::IsTerminal;
    if verbose || std::io::stderr().is_terminal() {
        deployment = deployment.with_progress(std::sync::Arc::new(move |event| {
            use std::io::Write;
            if let Some(message) = crate::progress::render(event, verbose) {
                let _ = writeln!(std::io::stderr().lock(), "{message}");
            }
        }));
    }
    Ok(deployment)
}

async fn with_document_secrets<R: tokio::io::AsyncBufRead + Unpin>(
    deployment: Deployment,
    document: &Document,
    non_interactive: bool,
    input_available: bool,
    lines: &mut tokio::io::Lines<R>,
    cancel: &CancellationToken,
) -> Result<Deployment, Box<dyn std::error::Error>> {
    Ok(deployment.with_secrets(
        crate::credentials::fulfill(document, non_interactive, input_available, lines, cancel)
            .await?,
    ))
}

async fn confirm_apply<R: tokio::io::AsyncBufRead + Unpin>(
    non_interactive: bool,
    lines: &mut tokio::io::Lines<R>,
    cancel: &CancellationToken,
) -> Result<bool, Box<dyn std::error::Error>> {
    if non_interactive {
        return Ok(true);
    }
    let answer = value_or_prompt(None, "Apply this plan?", "N", lines, cancel).await?;
    Ok(matches!(answer.as_str(), "y" | "yes"))
}

async fn complete_onboarding<R, P, PF, A, AF>(
    plan: P,
    apply: A,
    non_interactive: bool,
    lines: &mut tokio::io::Lines<R>,
    cancel: &CancellationToken,
) -> Result<Option<OperationResult>, Box<dyn std::error::Error>>
where
    R: tokio::io::AsyncBufRead + Unpin,
    P: FnOnce() -> PF,
    PF: Future<Output = Result<OperationResult, Error>>,
    A: FnOnce() -> AF,
    AF: Future<Output = Result<OperationResult, Error>>,
{
    let preview = plan().await?;
    eprintln!("Plan preview:\n{}", serde_json::to_string(&preview)?);
    if !confirm_apply(non_interactive, lines, cancel).await? {
        return Ok(None);
    }
    Ok(Some(apply().await?))
}

struct OnboardValues {
    edit: Option<std::path::PathBuf>,
    name: Option<String>,
    sandbox: Option<String>,
    agent: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    credential_env: Option<String>,
}

async fn author<R: tokio::io::AsyncBufRead + Unpin>(
    non_interactive: bool,
    values: OnboardValues,
    lines: &mut tokio::io::Lines<R>,
    cancel: &CancellationToken,
) -> Result<Option<AuthoredDocument>, Box<dyn std::error::Error>> {
    let OnboardValues {
        edit,
        name,
        sandbox,
        agent,
        provider,
        model,
        credential_env,
    } = values;
    let capabilities = Capabilities::available();
    let defaults = Answers::first_slice();
    if non_interactive {
        let answers = Answers::from_direct(
            defaults,
            DirectInputs {
                deployment_name: name,
                sandbox_name: sandbox,
                agent_name: agent,
                provider_name: provider,
                model,
                credential_env,
                ..DirectInputs::default()
            },
        );
        let authored = Session::new()?.project(&capabilities, &answers)?;
        return Ok(Some(authored));
    }

    let mut draft = if let Some(path) = edit {
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take(nemoclaw_sdk::config::MAX_DOCUMENT_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > nemoclaw_sdk::config::MAX_DOCUMENT_BYTES {
            return Err("configuration exceeds 1 MiB".into());
        }
        Draft::from_yaml(&capabilities, &bytes)?
    } else {
        let deployment_name = value_or_prompt(
            name,
            "Deployment name",
            &defaults.deployment_name,
            lines,
            cancel,
        )
        .await?;
        let sandbox_name = value_or_prompt(
            sandbox,
            "Sandbox name",
            &defaults.sandbox_name,
            lines,
            cancel,
        )
        .await?;
        let agent_name =
            value_or_prompt(agent, "Agent name", &defaults.agent_name, lines, cancel).await?;
        let provider_name = value_or_prompt(
            provider,
            "Provider name",
            &defaults.provider_name,
            lines,
            cancel,
        )
        .await?;
        let model = value_or_prompt(model, "Model", &defaults.model, lines, cancel).await?;
        let credential_env = value_or_prompt(
            credential_env,
            "Credential environment variable",
            &defaults.credential_env,
            lines,
            cancel,
        )
        .await?;
        let answers = Answers::from_interactive(InteractiveInputs {
            deployment_name,
            sandbox_name,
            agent_name,
            harness: defaults.harness,
            runtime: defaults.runtime,
            inference: defaults.inference,
            api: defaults.api,
            provider_name,
            model,
            credential_env,
        });
        Draft::new(Session::new()?, answers)
    };

    loop {
        let review = draft.review(&capabilities)?;
        eprintln!("Review authored configuration:\n{}", review.render());
        let action = value_or_prompt(
            None,
            "Accept [a], edit inference [i], edit identity [d], inspect YAML [y], or exit [x]",
            "a",
            lines,
            cancel,
        )
        .await?;
        match action.as_str() {
            "a" | "accept" => {
                return Ok(Some(review.into_authored()));
            }
            "x" | "exit" => return Ok(None),
            "y" | "yaml" => eprintln!("Authored YAML:\n{}", review.yaml()),
            "d" | "identity" => {
                let deployment_name = review.deployment_name().to_owned();
                let sandbox_name = review.sandbox_name().to_owned();
                let agent_name = review.agent_name().to_owned();
                let edits = IdentityEdits {
                    deployment_name: Some(
                        value_or_prompt(None, "Deployment name", &deployment_name, lines, cancel)
                            .await?,
                    ),
                    sandbox_name: Some(
                        value_or_prompt(None, "Sandbox name", &sandbox_name, lines, cancel).await?,
                    ),
                    agent_name: Some(
                        value_or_prompt(None, "Agent name", &agent_name, lines, cancel).await?,
                    ),
                };
                if let Err(diagnostics) = draft.edit_identity(&capabilities, edits) {
                    eprintln!("Edit rejected: {diagnostics}");
                }
            }
            "i" | "inference" => {
                let provider_name = review.provider_name().to_owned();
                let model = review.model().to_owned();
                let credential_env = review.credential_env().to_owned();
                let edits = InferenceEdits {
                    provider_name: Some(
                        value_or_prompt(None, "Provider name", &provider_name, lines, cancel)
                            .await?,
                    ),
                    model: Some(value_or_prompt(None, "Model", &model, lines, cancel).await?),
                    credential_env: Some(
                        value_or_prompt(
                            None,
                            "Credential environment variable",
                            &credential_env,
                            lines,
                            cancel,
                        )
                        .await?,
                    ),
                };
                if let Err(diagnostics) = draft.edit_inference(&capabilities, edits) {
                    eprintln!("Edit rejected: {diagnostics}");
                }
            }
            _ => eprintln!("Choose a, i, d, y, or x."),
        }
    }
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

    #[tokio::test]
    async fn apply_confirmation_is_distinct_and_defaults_to_decline() {
        for (input, expected) in [
            ("\n", false),
            ("n\n", false),
            ("y\n", true),
            ("yes\n", true),
        ] {
            let mut lines = tokio::io::BufReader::new(input.as_bytes()).lines();
            assert_eq!(
                confirm_apply(false, &mut lines, &CancellationToken::new())
                    .await
                    .unwrap(),
                expected
            );
        }
        let mut forbidden = tokio::io::BufReader::new(ForbiddenInput).lines();
        assert!(
            confirm_apply(true, &mut forbidden, &CancellationToken::new())
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn composed_journey_declines_only_after_plan_and_never_calls_apply() {
        use std::{cell::RefCell, rc::Rc};

        let events = Rc::new(RefCell::new(Vec::new()));
        let planned = events.clone();
        let applied = events.clone();
        let mut lines = tokio::io::BufReader::new(&b"\n"[..]).lines();
        let result = complete_onboarding(
            || async move {
                planned.borrow_mut().push("plan");
                Ok(serde_json::from_value(serde_json::json!({
                    "outcome": "planned", "changes": []
                }))
                .unwrap())
            },
            || async move {
                applied.borrow_mut().push("apply");
                Ok(serde_json::from_value(serde_json::json!({
                    "outcome": "succeeded", "changes": []
                }))
                .unwrap())
            },
            false,
            &mut lines,
            &CancellationToken::new(),
        )
        .await
        .unwrap();

        assert!(result.is_none());
        assert_eq!(*events.borrow(), ["plan"]);
    }

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
