// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::execution::authentication;
mod download;
mod hardware;
mod inline_recipe;
mod process;
mod recipe;
mod routes;

use crate::execution::supervisor;
use crate::{
    CancellationToken, Error,
    vllm::{Service, arguments},
};
use process_wrap::tokio::{KillOnDrop, ProcessGroup};
use std::{
    net::{Ipv4Addr, SocketAddr},
    path::Path,
    time::Duration,
};
const ROOT: &str = "/data";
pub(super) use crate::execution::report;

pub(crate) async fn run(
    spec: &Service,
    cancel: &CancellationToken,
    trip: &CancellationToken,
) -> Result<(), Error> {
    let _writer = crate::execution::lock(
        &Path::new(ROOT).join("runtime.lock"),
        "cannot open persistent runtime lock",
        "persistent storage already has a writer or locking failed",
    )?;
    crate::execution::begin()?;
    // A platform may supply the key; otherwise the runtime generates one in its
    // credential storage, which keeps its own writer lock even if the model
    // cache is replaced.
    let supplied = authentication::supplied(std::env::var_os(crate::INFERENCE_KEY_ENV))?;
    if supplied.is_some() && spec.authentication.is_none() {
        return Err(Error::Conflict(
            "an inference key was supplied, but the runtime contract has no authentication",
        ));
    }
    let _credentials_lock = if spec.authentication.is_some() && supplied.is_none() {
        Some(crate::execution::lock(
            Path::new("/credentials/runtime.lock"),
            "cannot open credential writer lock",
            "credential storage already has a writer or locking failed",
        )?)
    } else {
        None
    };
    let result = run_owned(spec, supplied, cancel, trip).await;
    if let Err(error) = &result {
        // Only the holder of the persistent writer lock may publish status.
        let _ = report("stopped", &error.to_string(), 0);
    }
    result
}
async fn run_owned(
    spec: &Service,
    supplied: Option<String>,
    cancel: &CancellationToken,
    trip: &CancellationToken,
) -> Result<(), Error> {
    let credential = match (spec.authentication, supplied) {
        (None, _) => None,
        (Some(_), Some(key)) => Some(key),
        (Some(_), None) => Some(authentication::load(Path::new("/credentials"))?),
    };
    let prepared = recipe::prepare(spec, Path::new(ROOT), cancel).await?;
    if trip.is_cancelled() {
        return Err(Error::Conflict(
            "memory protection tripped by operator; reapply required",
        ));
    }
    let capacity = hardware::before_start(spec, cancel).await?;
    let (mut command, readiness, output) = process::launch(
        spec,
        &prepared,
        crate::vllm::hardware_capacity::serving_memory(spec, &capacity)?,
        credential,
    )?;
    command.wrap(KillOnDrop).wrap(ProcessGroup::leader());
    // Bearer vLLM listens on loopback behind the route filter, which owns the
    // published port; bind it first so a port conflict fails startup.
    let filter = match spec.authentication {
        Some(_) => {
            let port = |port| u16::try_from(port).map_err(|_| Error::State("invalid serving port"));
            let listener = routes::bind(port(spec.serving.port)?).await?;
            let vllm = SocketAddr::from((Ipv4Addr::LOCALHOST, port(arguments::listen_port(spec))?));
            Some((listener, vllm))
        }
        None => None,
    };
    let mut child = command
        .spawn()
        .map_err(|_| Error::State("inference process could not start"))?;
    // The command holds the runtime's copy of the output pipe's write end,
    // which would keep the pipe open after vLLM exits.
    drop(command);
    if let Err(error) = report(
        "loading",
        "waiting for inference readiness",
        child.id().unwrap_or(0),
    ) {
        supervisor::terminate(child.as_mut()).await;
        return Err(error);
    }
    let policy = supervisor::Policy {
        startup_timeout: Duration::from_secs(spec.serving.startup_timeout_seconds as u64),
        protection: crate::hardware::ProtectionPolicy::for_service(spec)?,
    };
    let filter = filter.map(|(listener, vllm)| {
        tokio::spawn(routes::serve(
            listener,
            vllm,
            routes::HEADER_TIMEOUT,
            routes::connections(),
        ))
    });
    crate::execution::serve(
        child.as_mut(),
        policy,
        output,
        move |ready| process::wait_ready(readiness, ready),
        filter,
        cancel,
        trip,
    )
    .await
}
