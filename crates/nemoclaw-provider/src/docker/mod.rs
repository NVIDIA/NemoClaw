// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(test)]
mod tests;

use crate::{Error, ObservationError};
use bollard::{
    models::{ContainerInspectResponse, NetworkInspect, Volume},
    query_parameters::{DownloadFromContainerOptions, UploadToContainerOptions},
};
use futures_util::StreamExt;
use nemoclaw_discovery::optional;
pub(crate) use nemoclaw_discovery::{is_missing, remote};
use std::{io::Read, time::Duration};

/// The shared read client, with the host observer and container operations
/// that resources need.
#[derive(Clone)]
pub struct Engine {
    read: nemoclaw_discovery::Engine,
    pub(crate) host_observer_explicit: bool,
    pub(crate) host_observer: std::sync::Arc<dyn crate::hardware::HostObserver>,
}
impl std::ops::Deref for Engine {
    type Target = nemoclaw_discovery::Engine;
    fn deref(&self) -> &Self::Target {
        &self.read
    }
}
impl Engine {
    pub fn connect(endpoint: &str) -> Result<Self, Error> {
        let read = nemoclaw_discovery::Engine::connect(endpoint)?;
        #[cfg(unix)]
        {
            let host_observer: std::sync::Arc<dyn crate::hardware::HostObserver> =
                if endpoint.starts_with("ssh://") {
                    std::sync::Arc::new(ssh::RemoteHost)
                } else {
                    std::sync::Arc::new(crate::hardware::LocalHost)
                };
            Ok(Self {
                read,
                host_observer_explicit: false,
                host_observer,
            })
        }
        #[cfg(not(unix))]
        {
            let _ = read;
            Err(Error::Conflict(
                "container-engine connections are unsupported on this platform",
            ))
        }
    }
    /// The same engine reported under another endpoint.
    pub fn relabel(self, endpoint: &str) -> Self {
        Self {
            read: self.read.relabel(endpoint),
            ..self
        }
    }
    /// Replace host collection explicitly; failures never fall back to local data.
    pub fn with_host_observer(
        mut self,
        observer: std::sync::Arc<dyn crate::hardware::HostObserver>,
    ) -> Self {
        self.host_observer_explicit = true;
        self.host_observer = observer;
        self
    }
    pub async fn container(&self, name: &str) -> Result<Option<ContainerInspectResponse>, Error> {
        optional(self.api.inspect_container(name, None).await)
    }
    pub async fn volume(&self, name: &str) -> Result<Option<Volume>, Error> {
        optional(self.api.inspect_volume(name).await)
    }
    pub async fn network(&self, name: &str) -> Result<Option<NetworkInspect>, Error> {
        optional(self.api.inspect_network(name, None).await)
    }
    /// Offline archive reads also work for stopped containers. A missing path
    /// is distinct from a failed transport or incomplete archive.
    pub async fn read_file(
        &self,
        id: &str,
        path: &str,
        limit: usize,
    ) -> Result<Option<Vec<u8>>, Error> {
        let work = async {
            let options = DownloadFromContainerOptions { path: path.into() };
            let mut stream = self.api.download_from_container(id, Some(options));
            let mut bytes = Vec::new();
            let bound = limit
                .checked_add(8192)
                .ok_or(Error::State("invalid artifact read limit"))?;
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(chunk) => {
                        if chunk.len() > bound.saturating_sub(bytes.len()) {
                            return Err(ObservationError::Incomplete.into());
                        }
                        bytes.extend(chunk);
                    }
                    Err(error) if is_missing(&error) && bytes.is_empty() => return Ok(None),
                    Err(error) => return Err(remote(&error)),
                }
            }
            read_archive(&bytes, limit).map(Some)
        };
        tokio::time::timeout(Duration::from_secs(20), work)
            .await
            .map_err(|_| ObservationError::Transport)?
    }
    pub async fn stat_file(
        &self,
        id: &str,
        path: &str,
    ) -> Result<Option<bollard::container::PathStatResponse>, Error> {
        optional(
            self.api
                .get_container_archive_info(
                    id,
                    Some(bollard::query_parameters::ContainerArchiveInfoOptions {
                        path: path.into(),
                    }),
                )
                .await,
        )
    }
    pub async fn write_files(
        &self,
        id: &str,
        path: &str,
        files: &[(&str, &[u8], u32)],
    ) -> Result<(), Error> {
        self.write_archive(id, path, archive(files)?).await
    }
    pub(crate) async fn write_archive(
        &self,
        id: &str,
        path: &str,
        bytes: Vec<u8>,
    ) -> Result<(), Error> {
        self.api
            .upload_to_container(
                id,
                Some(UploadToContainerOptions {
                    path: path.into(),
                    ..Default::default()
                }),
                bollard::body_full(bytes.into()),
            )
            .await
            .map_err(|error| remote(&error))
    }
}
fn read_archive(bytes: &[u8], limit: usize) -> Result<Vec<u8>, Error> {
    let mut archive = tar::Archive::new(bytes);
    let mut entries = archive
        .entries()
        .map_err(|_| ObservationError::Incomplete)?;
    let mut entry = entries
        .next()
        .ok_or(ObservationError::Incomplete)?
        .map_err(|_| ObservationError::Incomplete)?;
    let size = entry.size();
    if !entry.header().entry_type().is_file() || size == 0 || size > limit as u64 {
        return Err(ObservationError::Incomplete.into());
    }
    let mut output = Vec::new();
    entry
        .read_to_end(&mut output)
        .map_err(|_| ObservationError::Incomplete)?;
    if output.len() as u64 != size || entries.next().is_some() {
        return Err(ObservationError::Incomplete.into());
    }
    Ok(output)
}
pub(crate) fn archive(files: &[(&str, &[u8], u32)]) -> Result<Vec<u8>, Error> {
    let mut builder = tar::Builder::new(Vec::new());
    for (name, bytes, mode) in files {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(*mode);
        header.set_mtime(0);
        header.set_cksum();
        builder
            .append_data(&mut header, name, *bytes)
            .map_err(|_| Error::State("cannot prepare container file write"))?;
    }
    builder
        .into_inner()
        .map_err(|_| Error::State("cannot finish container file write"))
}

#[cfg(all(test, unix))]
pub(crate) mod fixture;

#[cfg(all(test, unix))]
mod two_engines;

mod connections;
pub use connections::Connections;

#[cfg(unix)]
mod ssh;

#[cfg(unix)]
pub(crate) use nemoclaw_discovery::ssh_command;
