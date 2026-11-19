// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::LlamaCppService;
use crate::{
    CancellationToken, Error,
    execution::{
        self, authentication,
        output::Output,
        supervisor::{self, Monitors},
    },
    hardware::GIB,
};
use process_wrap::tokio::{CommandWrap, KillOnDrop, ProcessGroup};
use std::{fs, io::Write, path::Path, process::Stdio, time::Duration};

fn lock(path: &Path) -> Result<fs::File, Error> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| Error::State("cannot open llama.cpp writer lock"))?;
    file.try_lock()
        .map_err(|_| Error::Conflict("llama.cpp storage already has a writer or locking failed"))?;
    Ok(file)
}
fn disk_bytes(root: &Path) -> Result<u64, Error> {
    let filesystem = rustix::fs::statvfs(root)
        .map_err(|_| Error::State("model filesystem capacity is unobservable"))?;
    filesystem
        .f_bavail
        .checked_mul(filesystem.f_frsize)
        .ok_or(Error::State("model filesystem capacity overflow"))
}
async fn observe() -> Result<crate::hardware::Capacity, Error> {
    let mut c = crate::hardware::linux::memory()?;
    c.disk_free = disk_bytes(Path::new("/data"))?;
    tokio::time::timeout(
        Duration::from_secs(30),
        crate::hardware::nvidia::populate(&mut c),
    )
    .await
    .map_err(|_| Error::State("GPU observation timed out"))??;
    Ok(c)
}
pub(crate) async fn run(
    spec: &LlamaCppService,
    cancel: &CancellationToken,
    trip: &CancellationToken,
) -> Result<(), Error> {
    let root = Path::new("/data");
    let _writer = lock(&root.join("runtime.lock"))?;
    execution::begin()?;
    let result = run_owned(spec, root, cancel, trip).await;
    if let Err(error) = &result {
        let _ = execution::report("stopped", &error.to_string(), 0);
    }
    result
}
async fn run_owned(
    spec: &LlamaCppService,
    root: &Path,
    cancel: &CancellationToken,
    trip: &CancellationToken,
) -> Result<(), Error> {
    spec.validate()?;
    let supplied = authentication::supplied(std::env::var_os(crate::INFERENCE_KEY_ENV))?;
    if supplied.is_some() && spec.authentication.is_none() {
        return Err(Error::Conflict(
            "inference key supplied without authentication",
        ));
    }
    let _credentials = if spec.authentication.is_some() && supplied.is_none() {
        Some(lock(Path::new("/credentials/runtime.lock"))?)
    } else {
        None
    };
    let key = match (spec.authentication, supplied) {
        (None, _) => None,
        (Some(_), Some(key)) => Some(key),
        (Some(_), None) => Some(authentication::load(Path::new("/credentials"))?),
    };
    // Even a supplied key is a private, transient file, never a llama-server argv value.
    let key_file = key
        .as_ref()
        .map(|key| {
            let mut file = tempfile::NamedTempFile::new()
                .map_err(|_| Error::State("cannot create inference key file"))?;
            file.write_all(key.as_bytes())
                .and_then(|()| file.as_file().sync_all())
                .map_err(|_| Error::State("cannot write inference key file"))?;
            Ok::<_, Error>(file)
        })
        .transpose()?;
    let cache_file = root
        .join("gguf")
        .join(spec.model.manifest().key())
        .join("model.gguf");
    let remaining = if cache_file.exists() {
        0
    } else {
        spec.model.size_bytes
    };
    tokio::select! {
        () = cancel.cancelled() => return Err(Error::Cancelled),
        capacity = observe() => spec.check_capacity(&capacity?, true, remaining)?,
    }
    execution::report("downloading", "acquiring or verifying the pinned GGUF", 0)?;
    let file = super::artifact::prepare(root, &spec.model, cancel).await?;
    if trip.is_cancelled() {
        return Err(Error::Conflict(
            "memory protection tripped; reapply required",
        ));
    }
    tokio::select! {
        () = cancel.cancelled() => return Err(Error::Cancelled),
        capacity = observe() => spec.check_capacity(&capacity?, true, 0)?,
    }
    let file = file
        .to_str()
        .ok_or(Error::State("GGUF path is not UTF-8"))?;
    let credential_path = key_file
        .as_ref()
        .map(|f| {
            f.path()
                .to_str()
                .ok_or(Error::State("credential path is not UTF-8"))
        })
        .transpose()?;
    let args = spec.arguments(file, credential_path)?;
    let (reader, writer) =
        std::io::pipe().map_err(|_| Error::State("cannot create inference output pipe"))?;
    let errors = writer
        .try_clone()
        .map_err(|_| Error::State("cannot clone inference output pipe"))?;
    let output = Output::start(reader, key.clone());
    let mut command = CommandWrap::with_new("/app/llama-server", |cmd| {
        cmd.args(args)
            .env_remove(crate::INFERENCE_KEY_ENV)
            .env_remove("HF_TOKEN")
            .stdin(Stdio::null())
            .stdout(writer)
            .stderr(errors);
    });
    command.wrap(KillOnDrop).wrap(ProcessGroup::leader());
    let mut child = command
        .spawn()
        .map_err(|_| Error::State("llama-server could not start"))?;
    drop(command);
    if let Err(error) = execution::report(
        "loading",
        "waiting for llama.cpp health and model inventory",
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
            if samples_tx
                .send(crate::hardware::linux::memory())
                .await
                .is_err()
            {
                break;
            }
        }
    });
    let endpoint = format!("http://127.0.0.1:{}", spec.serving.port);
    let model = spec.served_model().to_owned();
    let (ready_tx, ready) = tokio::sync::mpsc::channel(1);
    let health = tokio::spawn(async move {
        let client = super::readiness::client()?;
        loop {
            if super::readiness::matches(&client, &endpoint, &model, key.as_deref()).await {
                let _ = ready_tx.send(true).await;
                return Ok::<_, Error>(());
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    let policy = supervisor::Policy {
        startup_timeout: Duration::from_secs(spec.serving.startup_timeout_seconds),
        protection: crate::hardware::ProtectionPolicy::new(
            spec.memory.min_available_gib * GIB,
            spec.memory.min_free_gib * GIB,
            spec.memory.free_gate_gib * GIB,
            spec.memory.consecutive_samples,
        )?,
    };
    let result = supervisor::supervise(
        policy,
        child.as_mut(),
        Monitors {
            samples,
            ready,
            trip: trip.clone(),
            report: &execution::report,
        },
        cancel,
    )
    .await;
    sampler.abort();
    health.abort();
    output.explain(result).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn model_storage_reports_available_bytes_and_refuses_a_missing_path() {
        let root = tempfile::tempdir().unwrap();
        assert!(
            super::disk_bytes(root.path()).unwrap() > 0,
            "model admission needs a filesystem observation, not the memory sampler default"
        );
        assert!(super::disk_bytes(&root.path().join("missing")).is_err());
    }
}
