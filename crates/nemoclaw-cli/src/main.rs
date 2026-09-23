// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod args;
mod credentials;
mod deployment;
mod dispatch;
mod formatting;
mod io;
mod progress;
mod style;
use args::Cli;
use clap::Parser;
use nemoclaw_sdk::CancellationToken;
use std::{io::Write, process::ExitCode};

fn interrupt() -> std::io::Result<impl std::future::Future<Output = ()>> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        // Install both handlers before dispatch can print a prompt. Registration
        // inside the spawned task leaves a window for default signal handling.
        let mut interruption = signal(SignalKind::interrupt())?;
        let mut termination = signal(SignalKind::terminate())?;
        Ok(async move {
            tokio::select! {_=interruption.recv()=>{},_=termination.recv()=>{}}
        })
    }
    #[cfg(not(unix))]
    {
        Ok(async {
            let _ = tokio::signal::ctrl_c().await;
        })
    }
}
fn main() -> ExitCode {
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("Cannot start command: {error}");
            return ExitCode::FAILURE;
        }
    };
    let outcome = runtime.block_on(run());
    // Tokio stdin uses an uncancellable blocking read. All operation/state cleanup
    // and terminal restoration have finished; do not wait for more input to exit.
    runtime.shutdown_background();
    outcome
}

async fn run() -> ExitCode {
    let cli = Cli::parse();
    let output_format = cli.command.output_format();
    let context = formatting::RenderContext::new(&cli);
    let cancel = CancellationToken::new();
    let signal = cancel.clone();
    let interruption = match interrupt() {
        Ok(interruption) => interruption,
        Err(error) => {
            return report_error(&error, output_format, &context);
        }
    };
    let signals = tokio::spawn(async move {
        interruption.await;
        signal.cancel();
    });
    let output_path = match &cli.command {
        args::Command::Export { output } => output.clone(),
        _ => None,
    };
    let mut reporter = progress::Reporter::new(cli.progress, cli.verbose, context.header());
    let result = dispatch::run(cli, tokio::io::stdin(), &cancel, reporter.callback()).await;
    reporter.finish();
    signals.abort();
    match result {
        Ok(result) => {
            match formatting::render(result, output_format, &context).and_then(|output| {
                io::write_output(
                    output_path.as_deref(),
                    output.as_bytes(),
                    std::io::stdout().lock(),
                )?;
                Ok(())
            }) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    // Output may already contain a partial result. Do not append another JSON value.
                    let _ = writeln!(
                        std::io::stderr().lock(),
                        "{}",
                        formatting::render_output_error(error.as_ref(), &context).trim_end()
                    );
                    ExitCode::FAILURE
                }
            }
        }
        Err(error) => report_error(error.as_ref(), output_format, &context),
    }
}

fn report_error(
    error: &(dyn std::error::Error + 'static),
    format: args::OutputFormat,
    context: &formatting::RenderContext,
) -> ExitCode {
    let rendered = formatting::render_error(error, format, context);
    let written = match format {
        args::OutputFormat::Json => writeln!(std::io::stdout().lock(), "{}", rendered.trim_end()),
        args::OutputFormat::Text => writeln!(std::io::stderr().lock(), "{}", rendered.trim_end()),
    };
    if written.is_err() {
        return ExitCode::FAILURE;
    }
    ExitCode::from(formatting::error_exit_code(error))
}
