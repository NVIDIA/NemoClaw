// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(test)]
mod tests;

use crate::Error;
pub(crate) use nemoclaw_discovery::remote;

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
}

// Only the Unix fixture tests build container archives.
#[cfg(all(test, unix))]
pub(crate) use nemoclaw_docker::archive;

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
