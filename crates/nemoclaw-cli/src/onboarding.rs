// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{credentials, deployment::create as deployment, io::write_output};
use nemoclaw_authoring::{
    AnswerOverrides, Answers, AuthoredDocument, Capabilities, CompletionBoundary, Draft,
    IdentityEdits, InferenceEdits, Review, Session,
};
use nemoclaw_sdk::{CancellationToken, Error, OperationResult, config::Document};
use std::{future::Future, path::PathBuf};
use tokio::io::{AsyncBufReadExt, AsyncRead};

pub(crate) struct Options {
    pub(crate) state_dir: PathBuf,
    pub(crate) bundle_dir: Option<PathBuf>,
    pub(crate) verbose: bool,
    pub(crate) generate_only: bool,
    pub(crate) output: PathBuf,
    pub(crate) non_interactive: bool,
    pub(crate) edit: Option<PathBuf>,
    pub(crate) name: Option<String>,
    pub(crate) sandbox: Option<String>,
    pub(crate) agent: Option<String>,
    pub(crate) provider: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) credential_env: Option<String>,
}

pub(crate) async fn run<R: AsyncRead + Unpin>(
    options: Options,
    stdin: R,
    cancel: &CancellationToken,
) -> Result<Option<OperationResult>, Box<dyn std::error::Error>> {
    let Options {
        state_dir,
        bundle_dir,
        verbose,
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
    } = options;
    let mut lines = tokio::io::BufReader::new(stdin).lines();
    let authored = match author(
        non_interactive,
        Values {
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
        None => return Ok(None),
    };
    let CompletionBoundary::GeneratedDesiredState = authored.completion_boundary();
    let document = Document::parse(authored.yaml().as_bytes())?;
    write_output(Some(&output), authored.yaml().as_bytes(), std::io::sink())?;
    eprintln!(
        "Credential references: {}",
        document.credential_names().join(", ")
    );
    if generate_only {
        return Ok(None);
    }

    let deployment = deployment(&state_dir, bundle_dir.as_deref(), verbose)?;
    let deployment = credentials::attach(
        deployment,
        &document,
        non_interactive,
        true,
        &mut lines,
        cancel,
    )
    .await?;
    let result = complete(
        || deployment.plan(&document, cancel),
        || deployment.apply(&document, cancel),
        non_interactive,
        &mut lines,
        cancel,
    )
    .await?;
    if result.is_none() {
        eprintln!(
            "Apply declined; generated YAML remains at {}.",
            output.display()
        );
    }
    Ok(result)
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

async fn complete<R, P, PF, A, AF>(
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
    eprintln!("Plan preview:\n{}", serde_json::to_string_pretty(&preview)?);
    if !confirm_apply(non_interactive, lines, cancel).await? {
        return Ok(None);
    }
    Ok(Some(apply().await?))
}

struct Values {
    edit: Option<PathBuf>,
    name: Option<String>,
    sandbox: Option<String>,
    agent: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    credential_env: Option<String>,
}

async fn author<R: tokio::io::AsyncBufRead + Unpin>(
    non_interactive: bool,
    values: Values,
    lines: &mut tokio::io::Lines<R>,
    cancel: &CancellationToken,
) -> Result<Option<AuthoredDocument>, Box<dyn std::error::Error>> {
    let Values {
        edit,
        name,
        sandbox,
        agent,
        provider,
        model,
        credential_env,
    } = values;
    let capabilities = Capabilities::available();
    let defaults = Answers::onboarding_defaults();
    if non_interactive {
        let answers = defaults.with_overrides(AnswerOverrides {
            deployment_name: name,
            sandbox_name: sandbox,
            agent_name: agent,
            provider_name: provider,
            model,
            credential_env,
            ..AnswerOverrides::default()
        });
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
        let answers = Answers {
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
        };
        Draft::new(Session::new()?, answers)
    };

    loop {
        let review = draft.review(&capabilities)?;
        eprintln!("Review authored configuration:\n{}", render_review(&review));
        let action = value_or_prompt(
            None,
            "Accept [a], edit inference [i], edit identity [d], inspect YAML [y], or exit [x]",
            "a",
            lines,
            cancel,
        )
        .await?;
        match action.as_str() {
            "a" | "accept" => return Ok(Some(review.into_authored())),
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

fn render_review(review: &Review) -> String {
    use nemoclaw_sdk::config::InferenceApi;
    let api = match review.api() {
        InferenceApi::OpenaiCompletions => "openai-completions",
        InferenceApi::OpenaiResponses => "openai-responses",
        InferenceApi::AnthropicMessages => "anthropic-messages",
    };
    format!(
        "Deployment: {}\nUID: {}\nSandbox: {}\nHarness: {}\nAgent: {}\nProvider: {}\nAPI: {}\nModel: {}\nCredential references: {}\n",
        review.deployment_name(),
        review.uid(),
        review.sandbox_name(),
        review.harness_kind(),
        review.agent_name(),
        review.provider_name(),
        api,
        review.model(),
        review.credential_references().join(", ")
    )
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
    use nemoclaw_sdk::CancellationToken;
    use std::{
        cell::RefCell,
        pin::Pin,
        rc::Rc,
        task::{Context, Poll},
    };
    use tokio::io::{AsyncBufReadExt, AsyncRead, ReadBuf};

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
    async fn onboarding_declines_only_after_plan_and_never_calls_apply() {
        let events = Rc::new(RefCell::new(Vec::new()));
        let planned = events.clone();
        let applied = events.clone();
        let mut lines = tokio::io::BufReader::new(&b"\n"[..]).lines();

        let result = complete(
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
}
