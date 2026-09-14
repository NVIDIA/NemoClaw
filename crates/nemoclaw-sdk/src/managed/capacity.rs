// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{RuntimeObservation, Spec};
use crate::{Error, docker::Engine};
impl Engine {
    pub async fn check_capacity(
        &self,
        spec: &Spec,
        observed: Option<&RuntimeObservation>,
    ) -> Result<(), Error> {
        spec.validate()?;
        if self.endpoint() != spec.gateway.engine {
            return Err(Error::Conflict(
                "capacity engine differs from runtime specification",
            ));
        }
        let service = spec
            .service
            .as_ref()
            .ok_or(Error::Conflict("capacity requires an inference service"))?;
        #[cfg(target_os = "linux")]
        {
            let work = async {
                let file = std::fs::File::open("/proc/meminfo")
                    .map_err(|_| Error::State("host memory is unobservable"))?;
                let mut capacity = crate::spark::read_memory(file)?;
                capacity.architecture = if std::env::consts::ARCH == "aarch64" {
                    "arm64"
                } else {
                    std::env::consts::ARCH
                }
                .into();
                let gpu = gpu_query("--query-gpu=name,driver_version").await?;
                let processes = gpu_query("--query-compute-apps=pid").await?;
                (
                    capacity.gpu,
                    capacity.driver_major,
                    capacity.foreign_gpu_processes,
                ) = gpu_inventory(&gpu, &processes)?;
                let info = self.info().await?;
                if info.os_type.as_deref() != Some("linux")
                    || !matches!(info.architecture.as_deref(), Some("arm64" | "aarch64"))
                {
                    return Err(Error::Conflict(
                        "Spark requires the local Linux ARM64 engine",
                    ));
                }
                let root = info
                    .docker_root_dir
                    .ok_or(Error::State("Docker storage root is unobservable"))?;
                let stat = rustix::fs::statvfs(root.as_str())
                    .map_err(|_| Error::State("Docker storage capacity is unobservable"))?;
                capacity.disk_free = stat
                    .f_bavail
                    .checked_mul(stat.f_frsize)
                    .ok_or(Error::State("Docker storage capacity overflow"))?;
                let mut download = crate::spark::model_manifest().bytes()?;
                let mut preparation = crate::spark::PREPARED_BYTES;
                if let Some(observed) = observed {
                    for file in crate::spark::model_manifest().files {
                        let base = format!("/data/models/{}/{}", service.model.revision, file.name);
                        for suffix in ["", ".nemoclaw-partial"] {
                            if let Some(stat) = self
                                .stat_file(&observed.container_id, &format!("{base}{suffix}"))
                                .await?
                            {
                                if !regular_stat(&stat)
                                    || stat.size < 0
                                    || stat.size as u64 > file.size
                                {
                                    return Err(Error::Conflict(
                                        "retained download progress is unobservable or corrupt",
                                    ));
                                }
                                download -= stat.size as u64;
                                break;
                            }
                        }
                    }
                    let path = format!(
                        "/data/prepared/{}/{}",
                        crate::spark::preparation_key(),
                        crate::spark::PREPARED_FILE
                    );
                    if let Some(stat) = self.stat_file(&observed.container_id, &path).await? {
                        if !regular_stat(&stat) || stat.size <= 0 || stat.size as u64 > preparation
                        {
                            return Err(Error::Conflict(
                                "retained preparation progress is unobservable or corrupt",
                            ));
                        }
                        preparation -= stat.size as u64;
                    }
                }
                service.check_capacity(
                    &capacity,
                    observed.is_none_or(|observed| !observed.running),
                    download,
                    preparation,
                )
            };
            tokio::time::timeout(std::time::Duration::from_secs(20), work)
                .await
                .map_err(|_| Error::State("host capacity observation timed out"))?
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (service, observed);
            Err(Error::Conflict(
                "Spark capacity requires a local Linux ARM64 host",
            ))
        }
    }
}
#[cfg(target_os = "linux")]
async fn gpu_query(query: &str) -> Result<String, Error> {
    let output = tokio::process::Command::new("nvidia-smi")
        .args([query, "--format=csv,noheader,nounits"])
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|_| Error::State("GPU observation failed"))?;
    if !output.status.success() || output.stdout.len() > 1 << 20 {
        return Err(Error::State("GPU observation failed or exceeded limit"));
    }
    String::from_utf8(output.stdout).map_err(|_| Error::State("GPU inventory is incomplete"))
}
#[cfg(any(target_os = "linux", test))]
fn gpu_inventory(gpu: &str, processes: &str) -> Result<(String, u32, usize), Error> {
    let lines: Vec<_> = gpu.trim().lines().collect();
    if lines.len() != 1 {
        return Err(Error::State("Spark requires exactly one observable GPU"));
    }
    let fields: Vec<_> = lines[0].split(',').map(str::trim).collect();
    if fields.len() != 2 || fields[0].is_empty() {
        return Err(Error::State("GPU inventory is incomplete"));
    }
    let major = fields[1]
        .split('.')
        .next()
        .unwrap_or("")
        .parse::<u32>()
        .map_err(|_| Error::State("driver version is unobservable"))?;
    let mut seen = std::collections::BTreeSet::new();
    for line in processes.trim().lines() {
        let pid = line
            .trim()
            .parse::<u32>()
            .map_err(|_| Error::State("GPU process inventory is incomplete"))?;
        if pid == 0 || !seen.insert(pid) {
            return Err(Error::State("GPU process inventory is ambiguous"));
        }
    }
    Ok((fields[0].into(), major, seen.len()))
}
pub(crate) fn regular_stat(stat: &bollard::container::PathStatResponse) -> bool {
    const GO_MODE_TYPE: u32 =
        (1 << 31) | (1 << 27) | (1 << 26) | (1 << 25) | (1 << 24) | (1 << 21) | (1 << 19);
    stat.file_mode & GO_MODE_TYPE == 0 && stat.link_target.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gpu_inventory_requires_one_gpu_and_complete_process_metadata() {
        assert_eq!(
            gpu_inventory("NVIDIA GB10, 580.142\n", "12\n34\n").unwrap(),
            ("NVIDIA GB10".into(), 580, 2)
        );
        assert_eq!(gpu_inventory("NVIDIA GB10, 580.142\n", "").unwrap().2, 0);
        for (gpu, processes) in [
            ("", ""),
            ("NVIDIA GB10, unknown", ""),
            ("NVIDIA GB10, 580\nNVIDIA GB10, 580", ""),
            ("NVIDIA GB10, 580", "unknown"),
            ("NVIDIA GB10, 580", "12\n12"),
            ("NVIDIA GB10, 580", "0"),
        ] {
            assert!(gpu_inventory(gpu, processes).is_err());
        }
    }
}
