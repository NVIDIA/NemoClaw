// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{CancellationToken, Deployment, EngineProbe, Error, Progress};
use std::{path::Path, sync::Arc};

/// Reads a managed gateway's engine through the Docker API.
struct Engines;
impl EngineProbe for Engines {
    fn docker_desktop<'a>(
        &'a self,
        engine: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Option<bool>> {
        Box::pin(nemoclaw_discovery::docker_desktop(
            &nemoclaw_discovery::Direct,
            engine,
        ))
    }
}

pub(crate) fn create(
    state_dir: &Path,
    bundle_dir: Option<&Path>,
    force_stop: &CancellationToken,
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
    Ok(Deployment::new(state_dir, &bundle)
        .with_progress(progress)
        .with_force_stop(force_stop.clone())
        .with_engine_probe(Arc::new(Engines)))
}
