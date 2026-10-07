// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! A read client for one Docker or Podman engine, over a local socket or SSH.
use bollard::models::{ImageInspect, SystemInfo};
use nemoclaw_sdk::{Error, ObservationError, config::ComputeDriver};

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
        nemoclaw_sdk::config::validate_engine_endpoint(endpoint)?;
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
    pub(crate) fn new(api: bollard::Docker, endpoint: &str) -> Self {
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

    /// Read the engine and check existing gateway prerequisites without changing resources.
    /// Passing this check does not establish image, GPU, or deployment readiness.
    pub async fn gateway_engine_info(&self, driver: ComputeDriver) -> Result<SystemInfo, Error> {
        if driver == ComputeDriver::Podman {
            #[cfg(unix)]
            {
                let native = self.podman_json("info").await?;
                let rootless = native["host"]["security"]["rootless"]
                    .as_bool()
                    .ok_or(ObservationError::Incomplete)?;
                if rootless && native["host"]["rootlessNetworkCmd"] != serde_json::json!("pasta") {
                    return Err(Error::Conflict(
                        "managed rootless Podman requires an API that reports pasta networking for OpenShell callbacks",
                    ));
                }
            }
            let version = self.api.version().await.map_err(|error| remote(&error))?;
            if !version
                .components
                .unwrap_or_default()
                .iter()
                .any(|part| part.name == "Podman Engine")
            {
                return Err(Error::Conflict(
                    "Podman sandbox driver requires a Podman engine socket",
                ));
            }
        }
        self.info().await
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
