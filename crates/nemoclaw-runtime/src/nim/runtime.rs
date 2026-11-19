// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::NimService;
use crate::{
    CancellationToken, Error,
    execution::{self, authentication, supervisor},
};
use process_wrap::tokio::{KillOnDrop, ProcessGroup};
use std::{fs, path::Path, time::Duration};

/// Supplied by the operator/platform as a read-only regular file. The runtime
/// reads it but never creates, retains, rotates or deletes it.
pub const NGC_CREDENTIAL_FILE: &str = "/run/nemoclaw/ngc-api-key";

async fn observe(root: &Path) -> Result<crate::hardware::Capacity, Error> {
    let mut capacity = crate::hardware::linux::memory()?;
    let disk = rustix::fs::statvfs(root)
        .map_err(|_| Error::State("NIM cache capacity is unobservable"))?;
    capacity.disk_free = disk
        .f_bavail
        .checked_mul(disk.f_frsize)
        .ok_or(Error::State("NIM cache capacity overflow"))?;
    tokio::time::timeout(
        Duration::from_secs(30),
        crate::hardware::nvidia::populate(&mut capacity),
    )
    .await
    .map_err(|_| Error::State("NIM GPU observation timed out"))??;
    Ok(capacity)
}

pub(crate) async fn run(
    spec: &NimService,
    cancel: &CancellationToken,
    trip: &CancellationToken,
) -> Result<(), Error> {
    let root = Path::new("/data");
    let _writer = execution::lock(
        &root.join("runtime.lock"),
        "cannot open NIM storage lock",
        "NIM storage already has a writer or locking failed",
    )?;
    execution::begin()?;
    let result = run_owned(spec, root, cancel, trip).await;
    if let Err(error) = &result {
        let _ = execution::report("stopped", &error.to_string(), 0);
    }
    result
}
async fn run_owned(
    spec: &NimService,
    root: &Path,
    cancel: &CancellationToken,
    trip: &CancellationToken,
) -> Result<(), Error> {
    spec.validate()?;
    let supplied = authentication::supplied(std::env::var_os(crate::INFERENCE_KEY_ENV))?;
    if supplied.is_some() && spec.authentication.is_none() {
        return Err(Error::Conflict(
            "NIM inference key supplied without authentication",
        ));
    }
    let _credentials = if spec.authentication.is_some() && supplied.is_none() {
        Some(execution::lock(
            Path::new("/credentials/runtime.lock"),
            "cannot open NIM storage lock",
            "NIM storage already has a writer or locking failed",
        )?)
    } else {
        None
    };
    let key = match (spec.authentication, supplied) {
        (None, _) => None,
        (Some(_), Some(key)) => Some(key),
        (Some(_), None) => Some(authentication::load(Path::new("/credentials"))?),
    };
    let capacity = tokio::select! {()=cancel.cancelled()=>return Err(Error::Cancelled),capacity=observe(root)=>capacity?};
    spec.check_capacity(&capacity, true)?;
    if trip.is_cancelled() {
        return Err(Error::Conflict(
            "memory protection tripped; reapply required",
        ));
    }
    let total = match spec.memory_architecture() {
        crate::vllm::MemoryArchitecture::Unified => capacity.total,
        crate::vllm::MemoryArchitecture::Dedicated => {
            capacity.selected_gpus()?[0]
                .memory
                .as_ref()
                .ok_or(Error::State("NIM GPU capacity is unobservable"))?
                .total
        }
    };
    fs::create_dir_all(root.join("cache"))
        .and_then(|()| fs::create_dir_all(root.join("native")))
        .map_err(|_| Error::State("cannot prepare NIM writable directories"))?;
    let (mut command, output) = super::process::launch(
        spec,
        root,
        Path::new(NGC_CREDENTIAL_FILE),
        total,
        key.clone(),
    )?;
    command.wrap(KillOnDrop).wrap(ProcessGroup::leader());
    let mut child = command
        .spawn()
        .map_err(|_| Error::State("native NIM process could not start"))?;
    drop(command);
    if let Err(error) = execution::report(
        "loading",
        "waiting for native NIM preparation and readiness",
        child.id().unwrap_or(0),
    ) {
        supervisor::terminate(child.as_mut()).await;
        return Err(error);
    }
    let (endpoint, model) = (
        format!("http://127.0.0.1:{}", spec.serving.port),
        spec.model.name.clone(),
    );
    let readiness = move |ready_tx: tokio::sync::mpsc::Sender<bool>| async move {
        let client = super::readiness::client()?;
        loop {
            if super::readiness::matches(&client, &endpoint, &model, key.as_deref()).await {
                let _ = ready_tx.send(true).await;
                return Ok::<_, Error>(());
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    };
    let policy = supervisor::Policy {
        startup_timeout: Duration::from_secs(spec.serving.startup_timeout_seconds),
        protection: spec.memory.protection()?,
    };
    execution::serve(
        child.as_mut(),
        policy,
        output,
        readiness,
        None,
        cancel,
        trip,
    )
    .await
}
