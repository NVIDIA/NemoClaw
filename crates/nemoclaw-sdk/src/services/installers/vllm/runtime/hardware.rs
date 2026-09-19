// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{CancellationToken, Error, hardware::Capacity, services::installers::vllm::Service};
use std::time::Duration;
pub(crate) fn memory() -> Result<Capacity, Error> {
    crate::hardware::linux::memory()
}
pub(crate) async fn before_start(
    spec: &Service,
    cancel: &CancellationToken,
) -> Result<Capacity, Error> {
    let mut capacity = memory()?;
    let gpu = crate::hardware::nvidia::populate(&mut capacity);
    tokio::select! { ()=cancel.cancelled()=>return Err(Error::Cancelled), result=tokio::time::timeout(Duration::from_secs(30),gpu)=>result.map_err(|_|Error::State("GPU availability observation timed out"))?? };
    crate::services::installers::vllm::hardware_capacity::check_memory(spec, &capacity, true)?;
    Ok(capacity)
}
