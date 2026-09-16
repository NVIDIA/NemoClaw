// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::Capacity;
use crate::{Error, ObservationError, docker::Engine};

/// Measurements supplied by the execution host, associated with its daemon.
pub struct HostObservation {
    pub engine_id: String,
    pub capacity: Capacity,
}
impl HostObservation {
    pub fn for_engine(self, engine_id: &str) -> Result<Capacity, Error> {
        if engine_id.is_empty() || self.engine_id != engine_id {
            return Err(ObservationError::BindingMismatch.into());
        }
        Ok(self.capacity)
    }
}
#[async_trait::async_trait]
pub trait HostObserver: Send + Sync {
    async fn observe(&self, engine: &Engine) -> Result<HostObservation, Error>;
}

/// Collector for the existing qualified local-host topology. This does not
/// infer locality from a socket or provide a fallback for remote observers.
#[cfg(unix)]
pub(crate) struct LocalHost;
#[cfg(unix)]
#[async_trait::async_trait]
impl HostObserver for LocalHost {
    async fn observe(&self, engine: &Engine) -> Result<HostObservation, Error> {
        #[cfg(target_os = "linux")]
        {
            let info = engine.info().await?;
            if info.os_type.as_deref() != Some("linux")
                || !matches!(
                    info.architecture.as_deref(),
                    Some("arm64" | "aarch64" | "amd64" | "x86_64")
                )
            {
                return Err(Error::Conflict("capacity requires a local Linux engine"));
            }
            let mut capacity = super::linux::memory()?;
            super::nvidia::populate(&mut capacity).await?;
            let root = info
                .docker_root_dir
                .ok_or(Error::State("Docker storage root is unobservable"))?;
            let stat = rustix::fs::statvfs(root.as_str())
                .map_err(|_| Error::State("Docker storage capacity is unobservable"))?;
            capacity.disk_free = stat
                .f_bavail
                .checked_mul(stat.f_frsize)
                .ok_or(Error::State("Docker storage capacity overflow"))?;
            Ok(HostObservation {
                engine_id: info.id.ok_or(ObservationError::Incomplete)?,
                capacity,
            })
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = engine;
            Err(Error::Conflict(
                "Spark capacity requires a local Linux ARM64 host",
            ))
        }
    }
}
