// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(test)]
use super::Callback;
use super::{DownloadProgress, with_download_progress};
use crate::Progress;
use interprocess::local_socket::{
    GenericFilePath, Name, ToFsName,
    tokio::{Stream, prelude::*},
};
use std::{
    ffi::{OsStr, OsString},
    future::Future,
    io,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::mpsc,
};
use tokio_util::task::AbortOnDropHandle;
pub(crate) const ENV: &str = "NEMOCLAW_INTERNAL_PROGRESS_ENDPOINT";
const LIMIT: usize = 8192;
const IO_TIMEOUT: Duration = Duration::from_secs(1);
fn name(endpoint: &OsStr) -> io::Result<Name<'_>> {
    endpoint.to_fs_name::<GenericFilePath>()
}
pub(super) async fn forward<T>(
    endpoint: OsString,
    resource: String,
    operation: impl Future<Output = T>,
) -> T {
    let (sender, receiver) = mpsc::channel(32);
    let mut writer = AbortOnDropHandle::new(tokio::spawn(write(endpoint, receiver)));
    let callback = Arc::new(move |event| {
        if let Progress::Download(event) = event {
            let _ = sender.try_send(event);
        }
    });
    let result = with_download_progress(resource, callback, operation).await;
    // Wait until the listener confirms delivery, bounded even if it is stuck.
    // Dropping this future during cancellation aborts the writer immediately.
    let _ = tokio::time::timeout(IO_TIMEOUT, &mut writer).await;
    result
}
// Windows normally flushes dropped named pipes in background threads. Progress
// must release its handle even when the peer stops reading.
struct WriterStream(Stream);
impl Drop for WriterStream {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            let Stream::NamedPipe(stream) = &self.0;
            stream.inner().assume_flushed();
        }
    }
}
async fn write(endpoint: OsString, mut receiver: mpsc::Receiver<DownloadProgress>) {
    // Do not connect for resource operations that emit no download events.
    let Some(first) = receiver.recv().await else {
        return;
    };
    let Ok(name) = name(&endpoint) else {
        return;
    };
    let Ok(Ok(stream)) = tokio::time::timeout(IO_TIMEOUT, Stream::connect(name)).await else {
        return;
    };
    let mut stream = WriterStream(stream);
    let mut next = Some(first);
    while let Some(event) = next {
        let Ok(mut line) = serde_json::to_vec(&event) else {
            return;
        };
        if line.len() >= LIMIT {
            return;
        }
        line.push(b'\n');
        if !matches!(
            tokio::time::timeout(IO_TIMEOUT, stream.0.write_all(&line)).await,
            Ok(Ok(()))
        ) {
            return;
        }
        next = receiver.recv().await;
    }
    // Closing at once could discard unread bytes, notably on Windows pipes. End
    // with a blank line and wait for the listener to close after delivering
    // every event. forward() bounds this wait, and cancellation drops the handle.
    if matches!(
        tokio::time::timeout(IO_TIMEOUT, stream.0.write_all(b"\n")).await,
        Ok(Ok(()))
    ) {
        let _ = stream.0.read_u8().await;
    }
}

#[cfg(test)]
mod tests;
