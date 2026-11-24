// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    CancellationToken, Deployment, Error, ObservationError, Secrets, config::Document,
};
use std::{collections::BTreeMap, fmt, io::Write, sync::Arc};
use tokio::io::{AsyncBufRead, Lines};

#[derive(Debug)]
pub(crate) struct FulfillmentError(String);
impl fmt::Display for FulfillmentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl std::error::Error for FulfillmentError {}

#[derive(Debug, Default)]
struct TransientSecrets(BTreeMap<String, String>);
impl TransientSecrets {
    /// Adds the unresolved references that `environment` sets, without
    /// asking for the others.
    fn add_available<'a>(
        &mut self,
        references: impl IntoIterator<Item = &'a str>,
        mut environment: impl FnMut(&str) -> Option<String>,
    ) {
        for reference in references {
            if !self.0.contains_key(reference)
                && let Some(value) = environment(reference).filter(|value| !value.is_empty())
            {
                self.0.insert(reference.to_owned(), value);
            }
        }
    }
}
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
impl Drop for EchoGuard {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

/// The console mode flag that echoes typed input. Line input stays on, so
/// credentials are still read a line at a time.
#[cfg(windows)]
const ENABLE_ECHO_INPUT: u32 = 0x0004;

#[cfg(windows)]
struct EchoGuard {
    console: crossterm_winapi::ConsoleMode,
    original: Option<u32>,
}
#[cfg(windows)]
impl EchoGuard {
    fn stdin() -> std::io::Result<Self> {
        use crossterm_winapi::{ConsoleMode, Handle, HandleType};
        Self::new(ConsoleMode::from(Handle::new(HandleType::InputHandle)?))
    }

    fn new(console: crossterm_winapi::ConsoleMode) -> std::io::Result<Self> {
        let original = console.mode()?;
        console.set_mode(original & !ENABLE_ECHO_INPUT)?;
        Ok(Self {
            console,
            original: Some(original),
        })
    }

    fn restore(&mut self) -> std::io::Result<()> {
        if let Some(original) = self.original {
            self.console.set_mode(original)?;
            self.original = None;
        }
        Ok(())
    }
}

/// Resolves the `required` references from the environment or by asking, and
/// the document's other references that the environment sets. The SDK
/// reports a missing one that the operation doesn't read as deferred.
pub(crate) async fn fulfill<R: AsyncBufRead + Unpin>(
    document: &Document,
    required: Vec<&str>,
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
    let mut secrets = fulfill_references(
        required,
        non_interactive,
        |name| std::env::var(name).ok(),
        prompt_mode,
        lines,
        &mut stderr,
        cancel,
    )
    .await?;
    secrets.add_available(document.credential_names(), |name| std::env::var(name).ok());
    Ok(Arc::new(secrets))
}

pub(crate) async fn attach<R: AsyncBufRead + Unpin>(
    deployment: Deployment,
    document: &Document,
    required: Vec<&str>,
    non_interactive: bool,
    can_prompt: bool,
    lines: &mut Lines<R>,
    cancel: &CancellationToken,
) -> Result<Deployment, Box<dyn std::error::Error>> {
    Ok(deployment.with_secrets(
        fulfill(
            document,
            required,
            non_interactive,
            can_prompt,
            lines,
            cancel,
        )
        .await?,
    ))
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

    #[tokio::test]
    async fn references_the_command_does_not_read_come_only_from_the_environment() {
        let mut prompts = Vec::new();
        let mut input = tokio::io::BufReader::new(&b"gateway-secret\n"[..]).lines();
        let mut resolver = fulfill_references(
            ["GATEWAY_KEY"],
            false,
            |_| None,
            PromptMode::Visible,
            &mut input,
            &mut prompts,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        resolver.add_available(["GATEWAY_KEY", "INFERENCE_KEY", "SEARCH_KEY"], |name| {
            (name != "SEARCH_KEY").then(|| format!("environment-{name}"))
        });

        assert_eq!(
            String::from_utf8(prompts).unwrap(),
            "Credential for GATEWAY_KEY: "
        );
        assert_eq!(resolver.resolve("GATEWAY_KEY").unwrap(), "gateway-secret");
        assert_eq!(
            resolver.resolve("INFERENCE_KEY").unwrap(),
            "environment-INFERENCE_KEY"
        );
        assert!(resolver.resolve("SEARCH_KEY").is_err());
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

    /// The check runs in a child process with a console of its own, so it
    /// needs no console from the test runner.
    #[cfg(windows)]
    #[tokio::test]
    async fn console_echo_is_hidden_and_restored_when_credential_input_is_cancelled() {
        use crossterm_winapi::{ConsoleMode, Handle};
        const CHILD: &str = "NEMOCLAW_TEST_CONSOLE_CHILD";
        const NAME: &str = "credentials::tests::console_echo_is_hidden_and_restored_when_credential_input_is_cancelled";
        if std::env::var_os(CHILD).is_none() {
            use std::os::windows::process::CommandExt;
            const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", NAME, "--nocapture"])
                .env(CHILD, "1")
                .creation_flags(CREATE_NEW_CONSOLE)
                .output()
                .unwrap();
            let report = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                output.status.success() && report.contains("1 passed"),
                "{report}"
            );
            return;
        }

        let observer = ConsoleMode::from(Handle::current_in_handle().unwrap());
        let original = observer.mode().unwrap();
        assert_ne!(
            original & ENABLE_ECHO_INPUT,
            0,
            "a new console echoes input"
        );
        let echo = EchoGuard::new(ConsoleMode::from(Handle::current_in_handle().unwrap())).unwrap();
        assert_eq!(observer.mode().unwrap(), original & !ENABLE_ECHO_INPUT);

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
        assert_eq!(observer.mode().unwrap(), original);
    }
}
