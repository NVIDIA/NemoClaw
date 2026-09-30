// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{ObservationError, backend::Row, image_runtime::RuntimeBinding};

pub(super) const RUNTIME: &str = "nemoclaw.nvidia.com/runtime-v1";
pub(super) const POLICY: &str = "nemoclaw.nvidia.com/policy-input-v1";

pub(super) fn binding(row: &Row) -> Result<RuntimeBinding, ObservationError> {
    if row.get("agent_runtime").map(String::as_str) != Some("fabric") {
        return Err(ObservationError::BindingMismatch);
    }
    RuntimeBinding::from_json(
        row.get("runtime_json")
            .ok_or(ObservationError::Incomplete)?,
    )
}
