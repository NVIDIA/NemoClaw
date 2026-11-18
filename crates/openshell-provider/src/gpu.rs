// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Map the explicit GPU count to OpenShell's portable resource request.
use crate::{ObservationError, Row, proto};

fn count(value: &str) -> Result<u32, ObservationError> {
    value
        .parse::<u32>()
        .ok()
        .filter(|count| *count > 0)
        .ok_or(ObservationError::Query)
}

pub(super) fn request(
    value: &str,
) -> Result<Option<proto::ResourceRequirements>, ObservationError> {
    if value.is_empty() {
        return Ok(None);
    }
    Ok(Some(proto::ResourceRequirements {
        gpu: Some(proto::GpuResourceRequirements {
            count: Some(count(value)?),
        }),
    }))
}

pub(super) fn observed(
    resources: Option<&proto::ResourceRequirements>,
) -> Result<String, ObservationError> {
    match resources.and_then(|resources| resources.gpu) {
        None => Ok(String::new()),
        Some(gpu) => {
            let count = gpu.count.unwrap_or(1);
            if count == 0 {
                return Err(ObservationError::Incomplete);
            }
            Ok(count.to_string())
        }
    }
}

pub(super) fn validate_inputs(
    known: &Row,
    unknown: &[&str],
) -> Result<(), std::borrow::Cow<'static, str>> {
    crate::network::validate_grant_names(known, unknown)?;
    if !unknown.contains(&"gpu_count")
        && let Some(value) = known.get("gpu_count").filter(|value| !value.is_empty())
    {
        count(value).map_err(|_| "gpu_count must be a positive 32-bit integer")?;
    }
    Ok(())
}
