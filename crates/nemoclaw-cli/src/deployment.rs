// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{Deployment, Error};
use std::path::Path;

pub(crate) fn create(
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
