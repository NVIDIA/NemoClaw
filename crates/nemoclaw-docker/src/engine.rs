// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! A read client for one Docker or Podman engine, over a local socket or SSH.
#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
use bollard::{
    models::{ContainerInspectResponse, ImageInspect, NetworkInspect, SystemInfo, Volume},
    query_parameters::{DownloadFromContainerOptions, UploadToContainerOptions},
};
use futures_util::StreamExt;
use nemoclaw_backend::{Error, ObservationError};
use std::{io::Read, time::Duration};

#[derive(Clone)]
pub struct Engine {
    pub api: bollard::Docker,
    endpoint: String,
}

/// Where a read finds the engine behind an endpoint.
pub trait Engines: Send + Sync {
    fn engine(&self, endpoint: &str) -> Result<Engine, Error>;
}

/// Connect to each endpoint as it is read.
pub struct Direct;

impl Engines for Direct {
    fn engine(&self, endpoint: &str) -> Result<Engine, Error> {
        Engine::connect(endpoint)
    }
}

impl Engine {
    pub fn connect(endpoint: &str) -> Result<Self, Error> {
        crate::validate_engine_endpoint(endpoint)?;
        if endpoint.starts_with("ssh://") {
            return crate::ssh::connect(endpoint);
        }
        #[cfg(unix)]
        {
            let api =
                bollard::Docker::connect_with_unix(endpoint, 120, bollard::API_DEFAULT_VERSION)
                    .map_err(|_| Error::State("cannot configure Docker engine client"))?;
            Ok(Self::new(api, endpoint))
        }
        #[cfg(not(unix))]
        {
            Err(Error::Conflict(
                "local container-engine connections are unsupported on this platform",
            ))
        }
    }

    // Only Unix transports, a local socket or SSH, construct an engine client.
    #[cfg(unix)]
    pub fn new(api: bollard::Docker, endpoint: &str) -> Self {
        Self {
            api,
            endpoint: endpoint.into(),
        }
    }

    /// The same engine reported under another endpoint, for fixtures that
    /// serve several logical engines from one server.
    pub fn relabel(mut self, endpoint: &str) -> Self {
        self.endpoint = endpoint.into();
        self
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub async fn info(&self) -> Result<SystemInfo, Error> {
        let info = self.api.info().await.map_err(|error| remote(&error))?;
        if info.id.as_ref().is_none_or(String::is_empty) {
            return Err(ObservationError::Incomplete.into());
        }
        Ok(info)
    }

    pub async fn image(&self, name: &str) -> Result<Option<ImageInspect>, Error> {
        optional(self.api.inspect_image(name).await)
    }

    /// Read Podman's native API, which reports what its Docker-compatible API omits.
    #[cfg(unix)]
    pub async fn podman_json(&self, path: &str) -> Result<serde_json::Value, Error> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .unix_socket(
                self.endpoint()
                    .strip_prefix("unix://")
                    .ok_or(ObservationError::Incomplete)?,
            )
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|_| ObservationError::Incomplete)?;
        let mut response = client
            .get(format!("http://localhost/v4.0.0/libpod/{path}"))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|_| ObservationError::Incomplete)?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| ObservationError::Incomplete)?
        {
            if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                return Err(ObservationError::Incomplete.into());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| ObservationError::Incomplete.into())
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
    pub async fn write_archive(&self, id: &str, path: &str, bytes: Vec<u8>) -> Result<(), Error> {
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

pub fn is_missing(error: &bollard::errors::Error) -> bool {
    matches!(
        error,
        bollard::errors::Error::DockerResponseServerError {
            status_code: 404,
            ..
        }
    )
}

pub fn remote(error: &bollard::errors::Error) -> Error {
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

/// A missing object is `None`, distinct from a failed read.
pub fn optional<T>(result: Result<T, bollard::errors::Error>) -> Result<Option<T>, Error> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if is_missing(&error) => Ok(None),
        Err(error) => Err(remote(&error)),
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
/// A tar archive of files with fixed modification times.
pub fn archive(files: &[(&str, &[u8], u32)]) -> Result<Vec<u8>, Error> {
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
