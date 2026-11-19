// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Package-neutral runtime entry point. Package dispatch remains inside the
//! service component alongside each installer's implementation.

pub(crate) mod authentication;
pub(crate) mod output;
pub(super) mod supervisor;

use crate::{CancellationToken, Error};
use std::path::Path;

/// Open the lock file at `path` and take its exclusive writer lock, which the
/// returned file holds until it is dropped.
pub(crate) fn lock(
    path: &Path,
    open_error: &'static str,
    busy_error: &'static str,
) -> Result<std::fs::File, Error> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| Error::State(open_error))?;
    file.try_lock().map_err(|_| Error::Conflict(busy_error))?;
    Ok(file)
}

/// Monitor the owned backend, then close its tasks and explain its final output.
pub(crate) async fn serve<F, R>(
    child: &mut dyn process_wrap::tokio::ChildWrapper,
    policy: supervisor::Policy,
    output: output::Output,
    readiness: F,
    filter: Option<tokio::task::JoinHandle<std::convert::Infallible>>,
    cancel: &CancellationToken,
    trip: &CancellationToken,
) -> Result<(), Error>
where
    F: FnOnce(tokio::sync::mpsc::Sender<bool>) -> R,
    R: std::future::Future<Output = Result<(), Error>> + Send + 'static,
{
    let (samples_tx, samples) = tokio::sync::mpsc::channel(1);
    let sampler = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
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
    let (ready_tx, ready) = tokio::sync::mpsc::channel(1);
    let health = tokio::spawn(readiness(ready_tx));
    let monitors = supervisor::Monitors {
        samples,
        ready,
        trip: trip.clone(),
        report: &report,
    };
    let result = match filter {
        Some(filter) => supervisor::with_filter(policy, child, monitors, cancel, filter).await,
        None => supervisor::supervise(policy, child, monitors, cancel).await,
    };
    sampler.abort();
    health.abort();
    output.explain(result).await
}

pub async fn run(cancel: &CancellationToken, trip: &CancellationToken) -> Result<(), Error> {
    let text = match std::env::var("NEMOCLAW_RUNTIME_SPEC") {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => {
            return Err(Error::State("missing runtime specification"));
        }
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err(Error::State("runtime specification is not UTF-8"));
        }
    };
    match crate::RuntimeSpec::decode(&text)? {
        crate::RuntimeSpec::Ollama(service) => {
            crate::ollama::runtime::run(&service, cancel, trip).await
        }
        crate::RuntimeSpec::Vllm(service) => {
            crate::vllm::runtime::run(&service, cancel, trip).await
        }
    }
}

pub(super) fn report(phase: &str, detail: &str, pid: u32) -> Result<(), Error> {
    report_at(Path::new("/data"), phase, detail, pid)
}

/// Record that this runtime holds the storage lock and hasn't started its
/// service yet, replacing any status an earlier container left on retained
/// storage, so nothing reads that status as this runtime's.
pub(super) fn begin() -> Result<(), Error> {
    begin_at(Path::new("/data"))
}

fn begin_at(root: &Path) -> Result<(), Error> {
    report_at(root, "initializing", "runtime started", 0)
}

fn report_at(root: &Path, phase: &str, detail: &str, pid: u32) -> Result<(), Error> {
    let updated = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| Error::State("cannot timestamp runtime status"))?;
    let value = serde_json::json!({"phase":phase,"detail":detail,"updated":updated,"pid":pid});
    crate::files::save_json(&root.join("status.json"), &value)?;
    // Later lines of a detail repeat process output the container log already has.
    eprintln!("{phase}: {}", detail.lines().next().unwrap_or_default());
    Ok(())
}

#[cfg(test)]
mod status_tests {
    #[test]
    fn writer_ownership_is_exclusive_until_the_holder_releases_it() {
        // Other test threads fork backend children; isolate descriptor ownership.
        const CHILD: &str = "NEMOCLAW_WRITER_LOCK_TEST_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "execution::status_tests::writer_ownership_is_exclusive_until_the_holder_releases_it", "--nocapture"])
                .env(CHILD, "1").output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stdout)
            );
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("runtime.lock");
        let acquire = || super::lock(&path, "cannot open test lock", "test lock held");
        let owner = acquire().unwrap();
        assert!(acquire().is_err());
        drop(owner);
        assert!(acquire().is_ok());
    }
    #[test]
    fn status_replaces_the_previous_phase_and_preserves_it_when_directory_is_missing() {
        let root = tempfile::tempdir().unwrap();
        super::report_at(root.path(), "preparing", "verified model", 0).unwrap();
        super::report_at(root.path(), "ready", "serving", 123).unwrap();
        let status: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.path().join("status.json")).unwrap())
                .unwrap();
        assert_eq!(status["phase"], "ready");
        assert_eq!(status["detail"], "serving");
        assert_eq!(status["pid"], 123);
        assert!(
            time::OffsetDateTime::parse(
                status["updated"].as_str().unwrap(),
                &time::format_description::well_known::Rfc3339
            )
            .is_ok()
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
        assert!(super::report_at(&root.path().join("missing"), "stopped", "failed", 0).is_err());
        let preserved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.path().join("status.json")).unwrap())
                .unwrap();
        assert_eq!(preserved, status);
    }

    #[test]
    fn a_started_runtime_replaces_a_ready_status_left_by_an_earlier_container() {
        let root = tempfile::tempdir().unwrap();
        super::report_at(root.path(), "ready", "serving", 123).unwrap();
        super::begin_at(root.path()).unwrap();
        let status: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.path().join("status.json")).unwrap())
                .unwrap();
        assert_eq!(status["phase"], "initializing");
        assert_eq!(status["pid"], 0);
    }
}
