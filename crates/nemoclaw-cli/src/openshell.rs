// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::args::Cli;
use std::{ffi::OsString, process::ExitCode, sync::Arc};

/// Replace this process with the bundled OpenShell CLI, so its terminal,
/// signals, output, and exit status are OpenShell's own.
#[cfg_attr(
    not(unix),
    expect(
        unused_variables,
        reason = "OpenShell publishes no Windows CLI to pass args to"
    )
)]
pub(crate) fn run(cli: &Cli, args: &[OsString]) -> ExitCode {
    let error = match crate::deployment::create(
        &cli.state_dir,
        cli.bundle_dir.as_deref(),
        &nemoclaw_sdk::CancellationToken::new(),
        Arc::new(|_| {}),
    ) {
        #[cfg(unix)]
        Ok(deployment) => match deployment.openshell(args) {
            Ok((mut command, sign_in)) => {
                use std::os::unix::process::CommandExt;
                if let Some(add) = sign_in {
                    eprintln!(
                        "Sign in to this OIDC gateway once by registering it:\n  nemoclaw osh -- {add}"
                    );
                }
                command.exec().to_string()
            }
            Err(error) => error.to_string(),
        },
        #[cfg(not(unix))]
        Ok(_) => "OpenShell publishes no Windows CLI; use NemoClaw inside WSL 2".into(),
        Err(error) => error.to_string(),
    };
    eprintln!("OpenShell failed: {error}");
    ExitCode::FAILURE
}
