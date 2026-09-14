// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    CancellationToken, Error,
    config::Service,
    hardware::{Capacity, GIB, Profile},
};
use std::time::Duration;
pub(crate) fn memory(profile: Profile) -> Result<Capacity, Error> {
    match profile {
        Profile::SparkV1 => nemoclaw_sdk::hardware::linux::memory(),
    }
}
pub(crate) async fn before_start(
    profile: Profile,
    spec: &Service,
    cancel: &CancellationToken,
) -> Result<Capacity, Error> {
    match profile {
        Profile::SparkV1 => before_spark_start(profile, spec, cancel).await,
    }
}
async fn before_spark_start(
    profile: Profile,
    spec: &Service,
    cancel: &CancellationToken,
) -> Result<Capacity, Error> {
    let capacity = memory(profile)?;
    if capacity.available < spec.gpu_bytes()? + 20 * GIB
        || spec.gpu_bytes()? + spec.memory.host_reserve_gib as u64 * GIB > capacity.total
    {
        return Err(Error::Conflict(
            "memory headroom changed during preparation; service was not started",
        ));
    }
    let gpu = tokio::process::Command::new("nvidia-smi")
        .args(["--query-compute-apps=pid", "--format=csv,noheader,nounits"])
        .kill_on_drop(true)
        .output();
    let gpu = tokio::select! {()=cancel.cancelled()=>return Err(Error::Cancelled),result=tokio::time::timeout(Duration::from_secs(15),gpu)=>result.map_err(|_|Error::State("GPU availability observation timed out"))?.map_err(|_|Error::State("GPU availability is unobservable"))?};
    if !gpu.status.success() || !String::from_utf8_lossy(&gpu.stdout).trim().is_empty() {
        return Err(Error::Conflict(
            "GPU availability changed after preparation; service was not started",
        ));
    }
    Ok(capacity)
}
