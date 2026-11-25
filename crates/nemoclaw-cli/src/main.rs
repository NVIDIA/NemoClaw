// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod args;
mod credentials;
mod deployment;
mod dispatch;
mod formatting;
mod host_client;
mod io;
mod progress;
mod style;
mod telemetry;
use args::Cli;
use clap::Parser;
use nemoclaw_sdk::CancellationToken;
use std::{io::Write, process::ExitCode};

/// Cancels `cancel` at the first interrupt and `force_stop` at the second: the
/// first lets OpenTofu finish the resource operations in progress, the second
/// ends it at once.
fn interrupts(
    cancel: CancellationToken,
    force_stop: CancellationToken,
) -> std::io::Result<impl std::future::Future<Output = ()>> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        // Install both handlers before dispatch can print a prompt. Registration
        // inside the spawned task leaves a window for default signal handling.
        let mut interruption = signal(SignalKind::interrupt())?;
        let mut termination = signal(SignalKind::terminate())?;
        Ok(async move {
            for token in [cancel, force_stop] {
                tokio::select! {_=interruption.recv()=>{},_=termination.recv()=>{}}
                token.cancel();
            }
        })
    }
    #[cfg(not(unix))]
    {
        Ok(async move {
            for token in [cancel, force_stop] {
                let _ = tokio::signal::ctrl_c().await;
                token.cancel();
            }
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
    let started = std::time::Instant::now();
    let label = telemetry::gate::check();
    let operation = match &cli.command {
        args::Command::Apply { .. } => Some(telemetry::record::Operation::Apply),
        args::Command::Destroy { .. } => Some(telemetry::record::Operation::Destroy),
        args::Command::Onboard { .. } => Some(telemetry::record::Operation::Onboard),
        _ => None,
    };
    let output_format = cli.command.output_format();
    let mut context = formatting::RenderContext::new(&cli);
    let (cancel, force_stop) = (CancellationToken::new(), CancellationToken::new());
    let interruption = match interrupts(cancel.clone(), force_stop.clone()) {
        Ok(interruption) => interruption,
        Err(error) => {
            return report_error(&error, output_format, &context);
        }
    };
    let signals = tokio::spawn(interruption);
    let output_path = match &cli.command {
        args::Command::Export { output } => output.clone(),
        _ => None,
    };
    let mut reporter = progress::Reporter::new(cli.progress, cli.verbose, context.header());
    let stage = telemetry::Stage::default();
    let mut document = None;
    let result = dispatch::run(
        cli,
        tokio::io::stdin(),
        &cancel,
        &force_stop,
        stage.watch(context.progress(reporter.callback())),
        &mut document,
    )
    .await;
    reporter.finish();
    signals.abort();
    let ended = operation.and_then(|operation| match &result {
        Ok(dispatch::CommandResult::Operation(result)) => {
            Some(telemetry::succeeded(operation, &result.changes))
        }
        Ok(dispatch::CommandResult::Authored { path: Some(_), .. }) => {
            Some(telemetry::succeeded(operation, &[]))
        }
        Ok(_) => None,
        // `onboard` sends a record only when it writes the configuration.
        Err(_) if operation == telemetry::record::Operation::Onboard => None,
        Err(error) => Some(stage.failed(formatting::error_exit_code(error.as_ref()) == 130)),
    });
    let duration = started.elapsed();
    let code = match result {
        Ok(result) => {
            if matches!(output_format, args::OutputFormat::Text)
                && matches!(&result, dispatch::CommandResult::Operation(operation) if !operation.agents.is_empty() || !operation.interfaces.is_empty())
            {
                let path = host_client::find(std::env::var_os("PATH").as_deref());
                context.host_client =
                    Some(host_client::inspect(nemoclaw_sdk::OPENSHELL_CLIENT_VERSION, path).await);
            }
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
    };
    // After the output is written; the send gives up within its time limit.
    if let Some((operation, ended)) = operation.zip(ended) {
        telemetry::report(label, operation, ended, duration, document.as_ref()).await;
    }
    code
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
