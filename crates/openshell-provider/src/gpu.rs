// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A sandbox's GPU request: OpenShell's portable `resource_requirements.gpu`.
use crate::{ObservationError, proto};

/// The GPUs a sandbox requests, or none when the input is empty. OpenShell
/// validates the count.
pub(super) fn request(
    count: &str,
) -> Result<Option<proto::ResourceRequirements>, ObservationError> {
    if count.is_empty() {
        return Ok(None);
    }
    let count = count.parse().map_err(|_| ObservationError::Query)?;
    Ok(Some(proto::ResourceRequirements {
        gpu: Some(proto::GpuResourceRequirements { count: Some(count) }),
    }))
}

/// The input an observed request corresponds to. OpenShell reads an omitted
/// count as one GPU.
pub(super) fn observed(resources: Option<&proto::ResourceRequirements>) -> String {
    resources
        .and_then(|resources| resources.gpu)
        .map_or_else(String::new, |gpu| gpu.count.unwrap_or(1).to_string())
}
