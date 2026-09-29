// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{Callback, DownloadProgress};
use crate::Progress;
use interprocess::local_socket::{
    GenericFilePath, ListenerOptions, Name, ToFsName,
    tokio::{Stream, prelude::*},
};
use std::{
    ffi::{OsStr, OsString},
    io,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    task::JoinSet,
};
use tokio_util::task::AbortOnDropHandle;

pub(crate) const ENV: &str = "NEMOCLAW_INTERNAL_PROGRESS_ENDPOINT";
const LIMIT: usize = 8192;

fn name(endpoint: &OsStr) -> io::Result<Name<'_>> {
    endpoint.to_fs_name::<GenericFilePath>()
}

pub(crate) struct Listener {
    pub(crate) endpoint: OsString,
    // Aborting this task also drops its JoinSet of connection readers.
    task: AbortOnDropHandle<()>,
    _directory: tempfile::TempDir,
}
impl Listener {
    pub(crate) fn start(callback: Callback) -> io::Result<Self> {
        let directory = tempfile::Builder::new().prefix("nc-progress-").tempdir()?;
        #[cfg(unix)]
        let endpoint = {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))?;
            directory.path().join("progress.sock").into_os_string()
        };
        #[cfg(windows)]
        let endpoint = OsString::from(format!(
            r"\\.\pipe\{}",
            directory.path().file_name().unwrap().to_string_lossy()
        ));
        let options = ListenerOptions::new().name(name(&endpoint)?);
        #[cfg(windows)]
        let options = {
            use interprocess::os::windows::{
                local_socket::ListenerOptionsExt, security_descriptor::SecurityDescriptor,
            };
            // Restrict the pipe to its owner. Local sockets reject remote clients.
            options.security_descriptor(SecurityDescriptor::deserialize(widestring::u16cstr!(
                "D:P(A;;GA;;;OW)"
            ))?)
        };
        let listener = options.create_tokio()?;
        let task = AbortOnDropHandle::new(tokio::spawn(async move {
            let mut readers = JoinSet::new();
            loop {
                tokio::select! {
                    result = listener.accept() => match result {
                        Ok(stream) if readers.len() < 64 => { readers.spawn(read(stream, callback.clone())); }
                        Ok(_) => {},
                        Err(_) => break,
                    },
                    _ = readers.join_next(), if !readers.is_empty() => {},
                }
            }
        }));
        Ok(Self {
            endpoint,
            task,
            _directory: directory,
        })
    }
}
impl Drop for Listener {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn read(stream: Stream, callback: Callback) {
    let mut reader = BufReader::new(stream);
    loop {
        let mut line = Vec::new();
        let result = (&mut reader)
            .take((LIMIT + 1) as u64)
            .read_until(b'\n', &mut line)
            .await;
        if result.is_err() || line.is_empty() || line.len() > LIMIT || !line.ends_with(b"\n") {
            break;
        }
        if let Ok(event) = serde_json::from_slice::<DownloadProgress>(&line)
            && event.valid()
        {
            callback(Progress::Download(event));
        }
    }
}

#[cfg(test)]
#[path = "transport/tests.rs"]
mod tests;
