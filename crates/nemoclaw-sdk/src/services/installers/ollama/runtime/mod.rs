// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod hardware;
mod observation;
mod process;
mod recipe;

use crate::services::runtime::supervisor::{self, Monitors};
use crate::{
    CancellationToken, Error,
    services::installers::ollama::{ManagedOllama, policy},
};
use process_wrap::tokio::{KillOnDrop, ProcessGroup};
use std::{fs, io::Write, path::Path, time::Duration};

const ROOT: &str = "/data";

pub(crate) fn report(phase: &str, detail: &str, pid: u32) -> Result<(), Error> {
    let updated = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| Error::State("cannot timestamp runtime status"))?;
    let value = serde_json::json!({"phase":phase,"detail":detail,"updated":updated,"pid":pid});
    let mut file = tempfile::NamedTempFile::new_in(ROOT)
        .map_err(|_| Error::State("cannot write runtime status"))?;
    file.write_all(&serde_json::to_vec(&value).expect("status JSON"))
        .and_then(|()| file.as_file().sync_all())
        .map_err(|_| Error::State("cannot sync runtime status"))?;
    file.persist(Path::new(ROOT).join("status.json"))
        .map_err(|_| Error::State("cannot commit runtime status"))?;
    fs::File::open(ROOT)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| Error::State("cannot sync runtime status directory"))?;
    eprintln!("{phase}: {detail}");
    Ok(())
}

pub(in crate::services) async fn run(
    service: &ManagedOllama,
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
    let result = run_owned(service, cancel, trip).await;
    if let Err(error) = &result {
        let _ = report("stopped", &error.to_string(), 0);
    }
    result
}

async fn run_owned(
    service: &ManagedOllama,
    cancel: &CancellationToken,
    trip: &CancellationToken,
) -> Result<(), Error> {
    let model = recipe::prepare(service, Path::new(ROOT), cancel).await?;
    if trip.is_cancelled() {
        return Err(Error::Conflict(
            "memory protection tripped by operator; explicit apply required",
        ));
    }
    let capacity = hardware::before_start(service, cancel).await?;
    let (mut command, readiness) = process::launch(service, &model, &capacity)?;
    command.wrap(KillOnDrop).wrap(ProcessGroup::leader());
    let mut child = command
        .spawn()
        .map_err(|_| Error::State("Ollama process could not start"))?;
    if let Err(error) = report(
        "loading",
        "waiting for Ollama readiness",
        child.id().unwrap_or(0),
    ) {
        supervisor::terminate(child.as_mut()).await;
        return Err(error);
    }
    let (samples_tx, samples) = tokio::sync::mpsc::channel(1);
    let failures = samples_tx.clone();
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
    let health = tokio::spawn(async move {
        if let Err(error) = process::wait_ready(readiness, ready_tx).await {
            let _ = failures.send(Err(error)).await;
        }
    });
    let result = supervisor::supervise(
        supervisor::Policy {
            startup_timeout: Duration::from_secs(service.serving.startup_timeout_seconds as u64),
            protection: policy::protection(service)?,
        },
        child.as_mut(),
        Monitors {
            samples,
            ready,
            trip: trip.clone(),
            report: &report,
        },
        cancel,
    )
    .await;
    sampler.abort();
    health.abort();
    result
}
