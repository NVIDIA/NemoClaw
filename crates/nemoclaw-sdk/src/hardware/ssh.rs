// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{HostObservation, HostObserver};
#[cfg(unix)]
use crate::ObservationError;
use crate::{Error, docker::Engine};

/// Fixed, read-only collector for a Linux host with a local Docker daemon.
pub struct SshHost;
#[async_trait::async_trait]
impl HostObserver for SshHost {
    async fn observe(&self, engine: &Engine) -> Result<HostObservation, Error> {
        if !engine.endpoint().starts_with("ssh://") {
            return Err(Error::Conflict(
                "SSH host observation requires an SSH engine",
            ));
        }
        #[cfg(unix)]
        {
            use std::{process::Stdio, time::Duration};
            let script = format!(
                "'{}'",
                include_str!("ssh_capacity.py").replace('\'', "'\\''")
            );
            let result = tokio::time::timeout(
                Duration::from_secs(60),
                crate::docker::ssh_command(engine.endpoint())
                    .args(["python3", "-c", &script])
                    .stdin(Stdio::null())
                    .stderr(Stdio::null())
                    .output(),
            )
            .await
            .map_err(|_| ObservationError::Transport)?
            .map_err(|_| ObservationError::Transport)?;
            if !result.status.success() || result.stdout.len() > 128 * 1024 {
                return Err(ObservationError::Transport.into());
            }
            decode(&result.stdout)
        }
        #[cfg(not(unix))]
        Err(Error::Conflict(
            "SSH host observation requires a Unix client",
        ))
    }
}

#[cfg(unix)]
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Measurements {
    daemon: String,
    architecture: String,
    memory: String,
    gpu: String,
    processes: String,
    compute_capability: String,
    gpu_memory: String,
    disk_free: u64,
}
#[cfg(unix)]
fn decode(bytes: &[u8]) -> Result<HostObservation, Error> {
    let data: Measurements =
        serde_json::from_slice(bytes).map_err(|_| ObservationError::Incomplete)?;
    if data.daemon.is_empty()
        || !matches!(
            data.architecture.as_str(),
            "arm64" | "aarch64" | "amd64" | "x86_64"
        )
    {
        return Err(Error::Conflict(
            "remote inference requires a Linux ARM64 or AMD64 Docker host",
        ));
    }
    let mut capacity = super::read_memory(data.memory.as_bytes())?;
    capacity.architecture = if matches!(data.architecture.as_str(), "arm64" | "aarch64") {
        "arm64"
    } else {
        "amd64"
    }
    .into();
    super::nvidia::apply_observations(
        &mut capacity,
        &data.gpu,
        &data.processes,
        &data.compute_capability,
        &data.gpu_memory,
    )?;
    capacity.disk_free = data.disk_free;
    Ok(HostObservation {
        engine_id: data.daemon,
        capacity,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn unified_memory_requires_observed_compute_capability_independently_of_vram() {
        let mut value = serde_json::json!({
            "daemon":"remote", "architecture":"aarch64",
            "memory":"MemTotal: 128000000 kB\nMemAvailable: 96000000 kB\nMemFree: 64000000 kB\n",
            "gpu":"NVIDIA GB10, 580.0\n", "processes":"", "disk_free":1000000000000_u64,
            "compute_capability":"12.1\n", "gpu_memory":"[N/A], [N/A]\n"
        });
        let doc = crate::config::Document::parse(
            include_bytes!("../../../../examples/spark/vllm.yaml").as_slice(),
        )
        .unwrap();
        let service = doc.spec.inference_providers[0].service.as_ref().unwrap();
        let observation = decode(&serde_json::to_vec(&value).unwrap()).unwrap();
        super::super::check_capacity(service, &observation.capacity, true, 0, 0).unwrap();
        assert!(observation.capacity.gpu_memory.is_none());
        assert_eq!(
            super::super::serving_memory(service, &observation.capacity).unwrap(),
            observation.capacity.total
        );
        // Reported counters do not change the declared unified-memory accounting.
        value["gpu_memory"] = "1024, 512\n".into();
        let observation = decode(&serde_json::to_vec(&value).unwrap()).unwrap();
        super::super::check_capacity(service, &observation.capacity, true, 0, 0).unwrap();
        assert_eq!(
            super::super::serving_memory(service, &observation.capacity).unwrap(),
            observation.capacity.total
        );
        value["compute_capability"] = "12.0\n".into();
        let observation = decode(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(super::super::check_capacity(service, &observation.capacity, true, 0, 0).is_err());
        for invalid in ["", "[N/A]", "12.10", "12", "12.1\n12.1", "unknown"] {
            value["compute_capability"] = invalid.into();
            assert!(
                decode(&serde_json::to_vec(&value).unwrap()).is_err(),
                "{invalid}"
            );
        }
        value.as_object_mut().unwrap().remove("compute_capability");
        assert!(decode(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    #[test]
    fn collector_queries_compute_and_memory_independently_on_every_gpu() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let result = std::process::Command::new("python3")
            .arg("-B")
            .arg(root.join("tests/fixtures/ssh_capacity.py"))
            .arg(root.join("src/hardware/ssh_capacity.py"))
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    #[test]
    fn arm64_blackwell_requires_observed_hbm_instead_of_host_ram() {
        let mut value = serde_json::json!({"daemon":"remote", "architecture":"aarch64", "memory":"MemTotal: 496000000 kB\nMemAvailable: 396000000 kB\nMemFree: 320000000 kB\n", "gpu":"NVIDIA GB300, 610.0\n", "processes":"", "disk_free":1000000000000_u64, "gpu_memory":"245760, 204800\n", "compute_capability":"10.3\n"});
        let capacity = decode(&serde_json::to_vec(&value).unwrap())
            .unwrap()
            .capacity;
        assert_eq!(capacity.gpu_memory.unwrap().total, 240 * super::super::GIB);
        value["gpu_memory"] = "[N/A], [N/A]\n".into();
        let capacity = decode(&serde_json::to_vec(&value).unwrap())
            .unwrap()
            .capacity;
        let mut doc = crate::config::Document::parse(
            include_bytes!("../../../../examples/spark/vllm.yaml").as_slice(),
        )
        .unwrap();
        let service = doc.spec.inference_providers[0].service.as_mut().unwrap();
        service.hardware = Some(crate::config::ServiceHardware::Profile {
            profile: crate::config::HardwareProfile::Gb300,
            architecture: None,
            min_gpu_memory_bytes: None,
        });
        assert!(super::super::check_capacity(service, &capacity, true, 0, 0).is_err());
        assert!(super::super::serving_memory(service, &capacity).is_err());
        for missing in [
            serde_json::Value::Null,
            serde_json::json!("[N/A], [N/A], 10.3"),
        ] {
            value["gpu_memory"] = missing;
            assert!(decode(&serde_json::to_vec(&value).unwrap()).is_err());
        }
    }
    #[test]
    fn amd64_measurements_require_dedicated_gpu_memory_and_compute_capability() {
        let mut value = serde_json::json!({"daemon":"remote", "architecture":"x86_64", "memory":"MemTotal: 256000000 kB\nMemAvailable: 196000000 kB\nMemFree: 64000000 kB\n", "gpu":"NVIDIA H100, 580.0\n", "processes":"", "disk_free":1000000000000_u64, "compute_capability":"9.0\n"});
        assert!(decode(&serde_json::to_vec(&value).unwrap()).is_err());
        value["gpu_memory"] = "98304, 90112\n".into();
        let capacity = decode(&serde_json::to_vec(&value).unwrap())
            .unwrap()
            .for_engine("remote")
            .unwrap();
        assert_eq!(capacity.architecture, "amd64");
        assert_eq!(capacity.gpu_memory.unwrap().total, 96 * super::super::GIB);
        value["gpu_memory"] = "[N/A], [N/A], 9.0".into();
        assert!(decode(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    #[test]
    fn remote_measurements_require_complete_host_data_and_matching_daemon() {
        let value = serde_json::json!({
            "daemon":"remote", "architecture":"aarch64",
            "memory":"MemTotal: 128000000 kB\nMemAvailable: 96000000 kB\nMemFree: 64000000 kB\n",
            "gpu":"NVIDIA GB10, 580.0\n", "processes":"", "disk_free":1000000000000_u64,
            "compute_capability":"12.1\n", "gpu_memory":"[N/A], [N/A]\n"
        });
        let observation = decode(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(observation.for_engine("different").is_err());
        let observation = decode(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(observation.for_engine("remote").unwrap().disk_free > 0);
        for field in [
            "daemon",
            "memory",
            "gpu",
            "disk_free",
            "processes",
            "compute_capability",
            "gpu_memory",
        ] {
            let mut incomplete = value.clone();
            incomplete.as_object_mut().unwrap().remove(field);
            assert!(decode(&serde_json::to_vec(&incomplete).unwrap()).is_err());
        }
        assert!(decode(b"{").is_err());
    }
}
