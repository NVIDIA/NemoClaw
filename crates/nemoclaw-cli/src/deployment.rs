// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{Deployment, Error, Progress};
use std::{path::Path, sync::Arc};

pub(crate) fn create(
    state_dir: &Path,
    bundle_dir: Option<&Path>,
    progress: Arc<dyn Fn(Progress) + Send + Sync>,
) -> Result<Deployment, Box<dyn std::error::Error>> {
    let bundle = match bundle_dir {
        Some(path) => path.to_owned(),
        None => std::env::current_exe()?
            .parent()
            .and_then(|p| p.parent())
            .ok_or(Error::Bundle("cannot locate runtime bundle"))?
            .into(),
    };
    Ok(Deployment::new(state_dir, &bundle).with_progress(progress))
}
