// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{CancellationToken, Deployment, Error, Progress};
use std::{path::Path, sync::Arc};

pub(crate) fn create(
    state_dir: &Path,
    bundle_dir: Option<&Path>,
    force_stop: &CancellationToken,
    progress: Arc<dyn Fn(Progress) + Send + Sync>,
) -> Result<Deployment, Box<dyn std::error::Error>> {
    let bundle = bundle_directory(bundle_dir)?;
    Ok(Deployment::new(state_dir, &bundle)
        .with_progress(progress)
        .with_force_stop(force_stop.clone()))
}

/// The bundle `--bundle` names, or the one this executable belongs to.
pub(crate) fn bundle_directory(
    bundle_dir: Option<&Path>,
) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    Ok(match bundle_dir {
        Some(path) => path.to_owned(),
        None => std::env::current_exe()?
            .parent()
            .and_then(|p| p.parent())
            .ok_or(Error::Bundle("cannot locate runtime bundle"))?
            .into(),
    })
}
