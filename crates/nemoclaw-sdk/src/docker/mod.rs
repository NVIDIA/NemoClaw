// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(test)]
mod tests;

use crate::{Error, ObservationError};
use bollard::{
    models::{ContainerInspectResponse, ImageInspect, NetworkInspect, SystemInfo, Volume},
    query_parameters::{DownloadFromContainerOptions, UploadToContainerOptions},
};
use futures_util::StreamExt;
use std::{io::Read, time::Duration};

#[derive(Clone)]
pub struct Engine {
    pub(crate) api: bollard::Docker,
}
impl Engine {
    pub fn connect(endpoint: &str) -> Result<Self, Error> {
        if !endpoint.starts_with("unix:///") || endpoint.contains(['\0', '?', '#']) {
            return Err(Error::Conflict(
                "managed runtimes require an explicit local Unix engine socket",
            ));
        }
        #[cfg(unix)]
        {
            let api =
                bollard::Docker::connect_with_unix(endpoint, 120, bollard::API_DEFAULT_VERSION)
                    .map_err(|_| Error::State("cannot configure Docker engine client"))?;
            Ok(Self { api })
        }
        #[cfg(not(unix))]
        {
            Err(Error::Conflict(
                "local managed runtime topology is not qualified on this platform",
            ))
        }
    }
    pub async fn info(&self) -> Result<SystemInfo, Error> {
        let info = self.api.info().await.map_err(remote)?;
        if info.id.as_ref().is_none_or(String::is_empty) {
            return Err(ObservationError::Incomplete.into());
        }
        Ok(info)
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
    pub async fn image(&self, name: &str) -> Result<Option<ImageInspect>, Error> {
        optional(self.api.inspect_image(name).await)
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
                    Err(error) => return Err(remote(error)),
                }
            }
            read_archive(&bytes, limit).map(Some)
        };
        tokio::time::timeout(Duration::from_secs(20), work)
            .await
            .map_err(|_| ObservationError::Transport)?
    }
    pub async fn write_files(
        &self,
        id: &str,
        path: &str,
        files: &[(&str, &[u8], u32)],
    ) -> Result<(), Error> {
        let bytes = archive(files)?;
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
            .map_err(remote)
    }
}
pub(crate) fn is_missing(error: &bollard::errors::Error) -> bool {
    matches!(
        error,
        bollard::errors::Error::DockerResponseServerError {
            status_code: 404,
            ..
        }
    )
}
pub(crate) fn remote(error: bollard::errors::Error) -> Error {
    match error {
        bollard::errors::Error::DockerResponseServerError {
            status_code: 401, ..
        } => ObservationError::Authentication.into(),
        bollard::errors::Error::DockerResponseServerError {
            status_code: 403, ..
        } => ObservationError::Permission.into(),
        _ => ObservationError::Transport.into(),
    }
}
fn optional<T>(result: Result<T, bollard::errors::Error>) -> Result<Option<T>, Error> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if is_missing(&error) => Ok(None),
        Err(error) => Err(remote(error)),
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
fn archive(files: &[(&str, &[u8], u32)]) -> Result<Vec<u8>, Error> {
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
