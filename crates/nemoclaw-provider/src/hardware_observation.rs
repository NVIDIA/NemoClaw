// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{docker::Engine, hardware::HostObserver};
use nemoclaw_sdk::discovery::ObservationStatus;
use nemoclaw_sdk::{hardware_discovery::GpuObservation, hardware_discovery::HardwareObservation};
use std::time::Duration;

/// Explicit direct operation using the existing hardware collector contract.
/// Callers select the observer; provider refresh never invokes this operation.
/// A failed or mismatched collector never falls back to measurements on this client.
pub async fn observe_host_hardware(
    engine: &Engine,
    observer: &dyn HostObserver,
) -> HardwareObservation {
    let work = async {
        let info = engine.info().await?;
        let host = observer.observe(engine, None).await?;
        let capacity = host.for_engine(info.id.as_deref().unwrap_or(""))?;
        if capacity.architecture.is_empty()
            || capacity.total == 0
            || capacity.available > capacity.total
            || capacity.free > capacity.total
            || capacity.gpus.iter().any(|gpu| {
                gpu.memory
                    .as_ref()
                    .is_some_and(|memory| memory.total == 0 || memory.free > memory.total)
            })
        {
            return Err(crate::Error::State(
                "host hardware measurements are incomplete or inconsistent",
            ));
        }
        Ok::<_, crate::Error>((info, capacity))
    };
    match tokio::time::timeout(Duration::from_secs(30), work).await {
        Ok(Ok((info, capacity))) => {
            let mut observation = HardwareObservation::from_info(info);
            observation.source = "explicit_host_observer".into();
            observation.reason = None;
            observation.architecture = Some(capacity.architecture);
            observation.memory_bytes = Some(capacity.total);
            observation.available_memory_bytes = Some(capacity.available);
            observation.disk_free_bytes = Some(capacity.disk_free);
            if !capacity.gpus.is_empty() {
                observation.gpu_status = ObservationStatus::Available;
                observation.gpu_inventory_complete = capacity
                    .gpus
                    .iter()
                    .all(|gpu| gpu.driver_major > 0 && gpu.compute_capability > 0);
                observation.gpus = capacity
                    .gpus
                    .into_iter()
                    .map(|gpu| GpuObservation {
                        id: Some(gpu.uuid),
                        name: Some(gpu.name),
                        memory_total_bytes: gpu.memory.as_ref().map(|memory| memory.total),
                        memory_free_bytes: gpu.memory.as_ref().map(|memory| memory.free),
                        memory_supported: Some(gpu.memory.is_some()),
                        driver_major: (gpu.driver_major > 0).then_some(gpu.driver_major),
                        compute_capability: (gpu.compute_capability > 0)
                            .then_some(gpu.compute_capability),
                    })
                    .collect();
            }
            observation
        }
        _ => {
            let mut observation = HardwareObservation::unknown();
            observation.source = "explicit_host_observer".into();
            observation.reason =
                Some("Host hardware could not be verified against the selected engine.".into());
            observation
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::{docker::fixture::Fixture, hardware::LocalHost};

    /// The local collector, against a fake engine and a fake `nvidia-smi` that
    /// reports an H100 and an L4.
    #[tokio::test]
    async fn explicit_observation_reports_each_gpu_with_its_uuid() {
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
            format!(
                "#!/bin/sh\n{}",
                crate::hardware::fake_nvidia_smi(&crate::hardware::TWO_GPUS)
            ),
        );
        let observed = observe_host_hardware(&engine, &LocalHost { nvidia_smi }).await;
        assert_eq!(observed.gpu_status, ObservationStatus::Available);
        assert!(observed.gpu_inventory_complete);
        let gpus: Vec<_> = observed
            .gpus
            .iter()
            .map(|gpu| {
                (
                    gpu.id.as_deref(),
                    gpu.name.as_deref(),
                    gpu.memory_total_bytes,
                    gpu.memory_free_bytes,
                    gpu.driver_major,
                    gpu.compute_capability,
                )
            })
            .collect();
        assert_eq!(
            gpus,
            [
                (
                    Some("GPU-00000000-0000-0000-0000-000000000000"),
                    Some("NVIDIA H100 80GB HBM3"),
                    Some(81559 << 20),
                    Some(81000 << 20),
                    Some(580),
                    Some(90),
                ),
                (
                    Some("GPU-11111111-1111-1111-1111-111111111111"),
                    Some("NVIDIA L4"),
                    Some(23034 << 20),
                    Some(22000 << 20),
                    Some(580),
                    Some(89),
                ),
            ]
        );
    }
}
