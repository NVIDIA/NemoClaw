// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{
    docker::{Connections, Engine},
    hardware::HostObserver,
};
use nemoclaw_sdk::discovery::ObservationStatus;
use nemoclaw_sdk::{hardware_discovery::GpuObservation, hardware_discovery::HardwareObservation};
use std::time::Duration;
/// Read only the selected engine API. Never run a collector, inspect the client's
/// host, start a probe container, or infer GPU absence from missing advertisements.
pub async fn observe_hardware(connections: &Connections, endpoint: &str) -> HardwareObservation {
    let work = async { connections.resolve(endpoint)?.info().await };
    match tokio::time::timeout(Duration::from_secs(5), work).await {
        Ok(Ok(info)) => HardwareObservation::from_info(info),
        _ => {
            let mut observation = HardwareObservation::unknown();
            observation.reason =
                Some("Hardware information from the selected engine is unobservable.".into());
            observation
        }
    }
}

/// Explicit direct operation using the existing hardware collector contract.
/// Callers select the observer; provider refresh never invokes this operation.
/// A failed or mismatched collector never falls back to measurements on this client.
pub async fn observe_host_hardware(
    engine: &Engine,
    observer: &dyn HostObserver,
) -> HardwareObservation {
    let work = async {
        let info = engine.info().await?;
        let host = observer.observe(engine).await?;
        let capacity = host.for_engine(info.id.as_deref().unwrap_or(""))?;
        if capacity.architecture.is_empty()
            || capacity.total == 0
            || capacity.available > capacity.total
            || capacity.free > capacity.total
            || capacity
                .gpu_memory
                .as_ref()
                .is_some_and(|memory| memory.total == 0 || memory.free > memory.total)
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
            if !capacity.gpu.is_empty() {
                observation.gpu_status = ObservationStatus::Available;
                observation.gpu_inventory_complete =
                    capacity.driver_major > 0 && capacity.compute_capability > 0;
                observation.gpus = vec![GpuObservation {
                    id: None,
                    name: Some(capacity.gpu),
                    memory_total_bytes: capacity.gpu_memory.as_ref().map(|memory| memory.total),
                    memory_free_bytes: capacity.gpu_memory.as_ref().map(|memory| memory.free),
                    memory_supported: Some(capacity.gpu_memory.is_some()),
                    driver_major: (capacity.driver_major > 0).then_some(capacity.driver_major),
                    compute_capability: (capacity.compute_capability > 0)
                        .then_some(capacity.compute_capability),
                }];
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
