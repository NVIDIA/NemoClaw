// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Hugging Face's own client downloads the pinned snapshot's selected files.

use crate::{CancellationToken, Error, snapshot::Manifest};
use std::{path::Path, process::Stdio};

/// Download exactly the manifest's files at its revision into `directory` with
/// the image's `hf` client, which resumes partial files and checks large files'
/// SHA-256 as it downloads them.
pub(crate) async fn fetch(
    directory: &Path,
    manifest: &Manifest,
    cancel: &CancellationToken,
) -> Result<(), Error> {
    let mut command = tokio::process::Command::new("hf");
    command.arg("download").arg(&manifest.repository);
    for file in &manifest.files {
        command.arg(&file.name);
    }
    command
        .arg("--revision")
        .arg(&manifest.revision)
        .arg("--local-dir")
        .arg(directory)
        .env("HF_HOME", "/data/huggingface")
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("HF_HUB_DISABLE_PROGRESS_BARS", "1")
        .env_remove("HF_HUB_OFFLINE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| Error::State("cannot start the Hugging Face client"))?;
    tokio::select! {
        () = cancel.cancelled() => {
            let _ = child.kill().await;
            Err(Error::Cancelled)
        }
        status = child.wait() => match status {
            Ok(status) if status.success() => Ok(()),
            _ => Err(Error::State(
                "Hugging Face client could not download the pinned snapshot; partial data retained",
            )),
        },
    }
}
