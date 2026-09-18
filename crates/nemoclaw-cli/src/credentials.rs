// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    CancellationToken, Deployment, Error, ObservationError, config::Document, openshell::Secrets,
};
use std::{collections::BTreeMap, fmt, io::Write, sync::Arc};
use tokio::io::{AsyncBufRead, Lines};

#[derive(Debug)]
struct FulfillmentError(String);
impl fmt::Display for FulfillmentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl std::error::Error for FulfillmentError {}

#[derive(Debug, Default)]
struct TransientSecrets(BTreeMap<String, String>);
impl Secrets for TransientSecrets {
    fn resolve(&self, reference: &str) -> Result<String, ObservationError> {
        self.0
            .get(reference)
            .filter(|value| !value.is_empty())
            .cloned()
            .ok_or(ObservationError::Authentication)
    }
}

#[derive(Clone, Copy)]
enum PromptMode {
    Unavailable,
    Visible,
    Hidden,
}

#[cfg(unix)]
enum Terminal {
    Stdin(std::io::Stdin),
    #[cfg(test)]
    File(std::fs::File),
}
#[cfg(unix)]
impl std::os::fd::AsFd for Terminal {
    fn as_fd(&self) -> std::os::fd::BorrowedFd<'_> {
        match self {
            Self::Stdin(terminal) => terminal.as_fd(),
            #[cfg(test)]
            Self::File(terminal) => terminal.as_fd(),
        }
    }
}

#[cfg(unix)]
struct EchoGuard {
    terminal: Terminal,
    original: Option<nix::sys::termios::Termios>,
}
#[cfg(unix)]
impl EchoGuard {
    fn stdin() -> std::io::Result<Self> {
        Self::new(Terminal::Stdin(std::io::stdin()))
    }

    fn new(terminal: Terminal) -> std::io::Result<Self> {
        use nix::sys::termios::{LocalFlags, SetArg, tcgetattr, tcsetattr};
        let original = tcgetattr(&terminal).map_err(std::io::Error::other)?;
        let mut hidden = original.clone();
        hidden.local_flags.remove(LocalFlags::ECHO);
        tcsetattr(&terminal, SetArg::TCSANOW, &hidden).map_err(std::io::Error::other)?;
        Ok(Self {
            terminal,
            original: Some(original),
        })
    }

    fn restore(&mut self) -> std::io::Result<()> {
        use nix::sys::termios::{SetArg, tcsetattr};
        if let Some(original) = self.original.as_ref() {
            tcsetattr(&self.terminal, SetArg::TCSANOW, original).map_err(std::io::Error::other)?;
            self.original = None;
        }
        Ok(())
    }
}
#[cfg(unix)]
impl Drop for EchoGuard {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

#[cfg(not(unix))]
struct EchoGuard;
#[cfg(not(unix))]
impl EchoGuard {
    fn stdin() -> std::io::Result<Self> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "hidden credential input is unsupported on this platform",
        ))
    }

    fn restore(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub(crate) async fn fulfill<R: AsyncBufRead + Unpin>(
    document: &Document,
    non_interactive: bool,
    can_prompt: bool,
    lines: &mut Lines<R>,
    cancel: &CancellationToken,
) -> Result<Arc<dyn Secrets>, Box<dyn std::error::Error>> {
    use std::io::IsTerminal;
    let mut stderr = std::io::stderr().lock();
    let prompt_mode = if !can_prompt {
        PromptMode::Unavailable
    } else if std::io::stdin().is_terminal() {
        PromptMode::Hidden
    } else {
        PromptMode::Visible
    };
    Ok(Arc::new(
        fulfill_references(
            document.credential_names(),
            non_interactive,
            |name| std::env::var(name).ok(),
            prompt_mode,
            lines,
            &mut stderr,
            cancel,
        )
        .await?,
    ))
}

pub(crate) async fn attach<R: AsyncBufRead + Unpin>(
    deployment: Deployment,
    document: &Document,
    non_interactive: bool,
    can_prompt: bool,
    lines: &mut Lines<R>,
    cancel: &CancellationToken,
) -> Result<Deployment, Box<dyn std::error::Error>> {
    Ok(deployment
        .with_secrets(fulfill(document, non_interactive, can_prompt, lines, cancel).await?))
}

async fn fulfill_references<'a, R, I, E>(
    references: I,
    non_interactive: bool,
    mut environment: E,
    prompt_mode: PromptMode,
    lines: &mut Lines<R>,
    prompts: &mut impl Write,
    cancel: &CancellationToken,
) -> Result<TransientSecrets, Box<dyn std::error::Error>>
where
    R: AsyncBufRead + Unpin,
    I: IntoIterator<Item = &'a str>,
    E: FnMut(&str) -> Option<String>,
{
    let references: std::collections::BTreeSet<_> = references.into_iter().collect();
    let mut values = BTreeMap::new();
    let mut missing = Vec::new();
    for reference in references {
        if let Some(value) = environment(reference).filter(|value| !value.is_empty()) {
            values.insert(reference.to_owned(), value);
        } else {
            missing.push(reference);
        }
    }
    if non_interactive && !missing.is_empty() {
        return Err(FulfillmentError(format!(
            "missing credential environment variables: {}",
            missing.join(", ")
        ))
        .into());
    }
    if matches!(prompt_mode, PromptMode::Unavailable) && !missing.is_empty() {
        return Err(FulfillmentError(format!(
            "cannot prompt for credentials while reading configuration from stdin; set environment variables or use --non-interactive (missing: {})",
            missing.join(", ")
        ))
        .into());
    }
    for reference in missing {
        let echo = matches!(prompt_mode, PromptMode::Hidden)
            .then(EchoGuard::stdin)
            .transpose()?;
        let value = read_credential(reference, lines, prompts, cancel, echo).await?;
        if value.is_empty() {
            return Err(
                FulfillmentError(format!("credential {reference} must not be empty")).into(),
            );
        }
        values.insert(reference.to_owned(), value);
    }
    Ok(TransientSecrets(values))
}

async fn read_credential<R: AsyncBufRead + Unpin>(
    reference: &str,
    lines: &mut Lines<R>,
    prompts: &mut impl Write,
    cancel: &CancellationToken,
    mut echo: Option<EchoGuard>,
) -> Result<String, Box<dyn std::error::Error>> {
    let input: Result<Option<String>, Box<dyn std::error::Error>> = if let Err(error) =
        write!(prompts, "Credential for {reference}: ").and_then(|()| prompts.flush())
    {
        Err(error.into())
    } else {
        tokio::select! {
        biased;
            () = cancel.cancelled() => Err(Error::Cancelled.into()),
            value = lines.next_line() => Ok(value?),
        }
    };
    if let Some(echo) = echo.as_mut() {
        echo.restore()?;
        writeln!(prompts)?;
    }
    input?.ok_or_else(|| {
        FulfillmentError(format!("credential input ended before {reference}")).into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncBufReadExt;

    const SENTINEL: &str = "credential-value-sentinel";

    #[tokio::test]
    async fn environment_precedes_prompts_and_duplicate_references_resolve_once() {
        let mut prompts = Vec::new();
        let mut input = tokio::io::BufReader::new(&b"unused\n"[..]).lines();
        let resolver = fulfill_references(
            ["API_KEY", "API_KEY"],
            false,
            |name| (name == "API_KEY").then(|| SENTINEL.into()),
            PromptMode::Visible,
            &mut input,
            &mut prompts,
            &CancellationToken::new(),
        )
        .await
        .unwrap();

        assert!(prompts.is_empty());
        assert_eq!(resolver.resolve("API_KEY").unwrap(), SENTINEL);
        assert!(resolver.resolve("OTHER_KEY").is_err());
    }

    #[tokio::test]
    async fn interactive_fulfillment_prompts_only_for_sorted_unresolved_references() {
        let mut prompts = Vec::new();
        let mut input = tokio::io::BufReader::new(&b"first-secret\nsecond-secret\n"[..]).lines();
        let resolver = fulfill_references(
            ["Z_KEY", "ENV_KEY", "A_KEY"],
            false,
            |name| (name == "ENV_KEY").then(|| "environment-secret".into()),
            PromptMode::Visible,
            &mut input,
            &mut prompts,
            &CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(
            String::from_utf8(prompts).unwrap(),
            "Credential for A_KEY: Credential for Z_KEY: "
        );
        assert_eq!(resolver.resolve("A_KEY").unwrap(), "first-secret");
        assert_eq!(resolver.resolve("ENV_KEY").unwrap(), "environment-secret");
        assert_eq!(resolver.resolve("Z_KEY").unwrap(), "second-secret");
    }

    #[tokio::test]
    async fn non_interactive_missing_and_cancellation_are_reference_only() {
        let mut prompts = Vec::new();
        let mut input = tokio::io::BufReader::new(&b""[..]).lines();
        let error = fulfill_references(
            ["Z_KEY", "A_KEY"],
            true,
            |_| None,
            PromptMode::Visible,
            &mut input,
            &mut prompts,
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "missing credential environment variables: A_KEY, Z_KEY"
        );
        assert!(!error.to_string().contains(SENTINEL));
        assert!(prompts.is_empty());

        let cancel = CancellationToken::new();
        cancel.cancel();
        let error = fulfill_references(
            ["A_KEY"],
            false,
            |_| None,
            PromptMode::Visible,
            &mut input,
            &mut prompts,
            &cancel,
        )
        .await
        .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<Error>(),
            Some(Error::Cancelled)
        ));
        assert!(!String::from_utf8(prompts).unwrap().contains(SENTINEL));
    }

    #[tokio::test]
    async fn stdin_documents_do_not_attempt_impossible_interactive_prompts() {
        let mut prompts = Vec::new();
        let mut input = tokio::io::BufReader::new(&b"unused\n"[..]).lines();
        let error = fulfill_references(
            ["API_KEY"],
            false,
            |_| None,
            PromptMode::Unavailable,
            &mut input,
            &mut prompts,
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("reading configuration from stdin")
        );
        assert!(error.to_string().contains("API_KEY"));
        assert!(prompts.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_echo_is_restored_when_credential_input_is_cancelled() {
        use nix::{pty::openpty, sys::termios};
        use std::fs::File;

        let pair = openpty(None, None).unwrap();
        // Keep the master open so the slave remains a usable terminal during cancellation.
        let _master = pair.master;
        let terminal = File::from(pair.slave);
        let observer = terminal.try_clone().unwrap();
        let original = termios::tcgetattr(&observer).unwrap();
        let echo = EchoGuard::new(Terminal::File(terminal)).unwrap();
        assert!(
            !termios::tcgetattr(&observer)
                .unwrap()
                .local_flags
                .contains(termios::LocalFlags::ECHO)
        );

        let cancel = CancellationToken::new();
        cancel.cancel();
        let mut prompts = Vec::new();
        let mut input = tokio::io::BufReader::new(&b""[..]).lines();
        let error = read_credential("API_KEY", &mut input, &mut prompts, &cancel, Some(echo))
            .await
            .unwrap_err();

        assert!(matches!(
            error.downcast_ref::<Error>(),
            Some(Error::Cancelled)
        ));
        assert_eq!(termios::tcgetattr(&observer).unwrap(), original);
    }
}
