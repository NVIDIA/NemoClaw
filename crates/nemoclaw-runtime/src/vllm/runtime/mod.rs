// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod authentication;
mod download;
mod hardware;
mod inline_recipe;
mod process;
mod recipe;
mod routes;

use crate::execution::supervisor::{self, Monitors};
use crate::{
    CancellationToken, Error,
    vllm::{Service, arguments},
};
use process_wrap::tokio::{KillOnDrop, ProcessGroup};
use std::{
    fs,
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
    use std::os::unix::fs::OpenOptionsExt;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(Path::new(ROOT).join("runtime.lock"))
        .map_err(|_| Error::State("cannot open persistent runtime lock"))?;
    lock.try_lock().map_err(|_| {
        Error::Conflict("persistent storage already has a writer or locking failed")
    })?;
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
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open("/credentials/runtime.lock")
            .map_err(|_| Error::State("cannot open credential writer lock"))?;
        file.try_lock().map_err(|_| {
            Error::Conflict("credential storage already has a writer or locking failed")
        })?;
        Some(file)
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
    let (mut command, readiness) = process::launch(
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
    if let Err(error) = report(
        "loading",
        "waiting for inference readiness",
        child.id().unwrap_or(0),
    ) {
        supervisor::terminate(child.as_mut()).await;
        return Err(error);
    }
    let (samples_tx, samples) = tokio::sync::mpsc::channel(1);
    let sampler = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            interval.tick().await;
            if samples_tx.send(hardware::memory()).await.is_err() {
                break;
            }
        }
    });
    let (ready_tx, ready) = tokio::sync::mpsc::channel(1);
    let health = tokio::spawn(async move { process::wait_ready(readiness, ready_tx).await });
    let policy = supervisor::Policy {
        startup_timeout: Duration::from_secs(spec.serving.startup_timeout_seconds as u64),
        protection: crate::hardware::ProtectionPolicy::for_service(spec)?,
    };
    let monitors = Monitors {
        samples,
        ready,
        trip: trip.clone(),
        report: &report,
    };
    let result = match filter {
        Some((listener, vllm)) => {
            let filter = tokio::spawn(routes::serve(
                listener,
                vllm,
                routes::HEADER_TIMEOUT,
                routes::connections(),
            ));
            routes::supervise(policy, child.as_mut(), monitors, cancel, filter).await
        }
        None => supervisor::supervise(policy, child.as_mut(), monitors, cancel).await,
    };
    sampler.abort();
    health.abort();
    result
}
