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
    /// Measure the host. With `gpu`, a GPU UUID or index, only that GPU is read.
    async fn observe(&self, engine: &Engine, gpu: Option<&str>) -> Result<HostObservation, Error>;
}

/// Collector for the existing qualified local-host topology. This does not
/// infer locality from a socket or provide a fallback for remote observers.
#[cfg(unix)]
pub(crate) struct LocalHost {
    /// The `nvidia-smi` program to run.
    pub(crate) nvidia_smi: std::path::PathBuf,
}
#[cfg(unix)]
impl Default for LocalHost {
    fn default() -> Self {
        Self {
            nvidia_smi: "nvidia-smi".into(),
        }
    }
}
#[cfg(unix)]
#[async_trait::async_trait]
impl HostObserver for LocalHost {
    async fn observe(&self, engine: &Engine, gpu: Option<&str>) -> Result<HostObservation, Error> {
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
            super::nvidia::populate_with(&mut capacity, |query| {
                nvidia_smi(&self.nvidia_smi, query, gpu)
            })
            .await?;
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
            let _ = (engine, gpu, &self.nvidia_smi);
            Err(Error::Conflict(
                "capacity requires a local Linux ARM64 or AMD64 host",
            ))
        }
    }
}

/// Run one `nvidia-smi` query, limited to `gpu` when one is named.
#[cfg(target_os = "linux")]
async fn nvidia_smi(
    program: &std::path::Path,
    query: &str,
    gpu: Option<&str>,
) -> Result<String, nemoclaw_runtime::Error> {
    use nemoclaw_runtime::Error;
    let output = tokio::process::Command::new(program)
        .args([query, "--format=csv,noheader,nounits"])
        .args(gpu.map(|gpu| format!("--id={gpu}")))
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|_| Error::State("GPU observation failed"))?;
    if !output.status.success() || output.stdout.len() > 1 << 20 {
        return Err(Error::State("GPU observation failed or exceeded limit"));
    }
    String::from_utf8(output.stdout).map_err(|_| Error::State("GPU inventory is incomplete"))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::docker::fixture::Fixture;

    /// The local collector, against a fake engine and a fake `nvidia-smi` that
    /// reports two GPUs, beside this host's real memory and filesystem.
    #[tokio::test]
    async fn the_local_collector_reads_only_a_named_gpu_and_refuses_two_without_one() {
        let root = tempfile::tempdir().unwrap();
        let docker_root = root.path().to_str().unwrap().to_owned();
        let fixture = Fixture::engine(move |request| {
            assert_eq!(request.path, "/info");
            let info = serde_json::json!({"ID": "engine", "OSType": "linux",
                "Architecture": std::env::consts::ARCH, "DockerRootDir": docker_root});
            Some((200, info.to_string().into_bytes()))
        })
        .await;
        let engine = Engine::connect(&fixture.endpoint).unwrap();
        let nvidia_smi = root.path().join("nvidia-smi");
        crate::executable::write_executable(
            &nvidia_smi,
            format!("#!/bin/sh\n{}", crate::hardware::TWO_GPUS),
        );
        let host = LocalHost { nvidia_smi };
        for (gpu, name) in [
            ("1", "NVIDIA L4"),
            (
                "GPU-00000000-0000-0000-0000-000000000000",
                "NVIDIA H100 80GB HBM3",
            ),
        ] {
            let capacity = host.observe(&engine, Some(gpu)).await.unwrap().capacity;
            assert_eq!(capacity.gpu, name);
            let architecture = match std::env::consts::ARCH {
                "aarch64" => "arm64",
                "x86_64" => "amd64",
                other => other,
            };
            assert_eq!(capacity.architecture, architecture);
        }
        // A GPU the host doesn't have fails at `nvidia-smi` instead of reading every GPU.
        let error = host
            .observe(&engine, Some("5"))
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("GPU observation failed"), "{error}");
        let error = host.observe(&engine, None).await.err().unwrap().to_string();
        assert!(error.contains("exactly one observable GPU"), "{error}");
    }
}
