// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::OpenShell;
use nemoclaw_backend::{Error, ObservationError, Row};
use nemoclaw_openshell::runtime::RuntimeBinding;

/// Annotation carrying a sandbox's runtime binding.
pub const RUNTIME: &str = "nemoclaw.nvidia.com/runtime-v1";
/// Annotation carrying a sandbox's policy input.
pub const POLICY: &str = "nemoclaw.nvidia.com/policy-input-v1";

/// The runtime binding of a Fabric sandbox row.
pub fn binding(row: &Row) -> Result<RuntimeBinding, ObservationError> {
    if row.get("agent_runtime").map(String::as_str) != Some("fabric") {
        return Err(ObservationError::BindingMismatch);
    }
    RuntimeBinding::from_json(
        row.get("runtime_json")
            .ok_or(ObservationError::Incomplete)?,
    )
}

impl OpenShell {
    pub(crate) async fn check_sandbox_phase(&self, binding: &Row) -> Result<(), Error> {
        self.gateway.sandbox_phase(binding, false).await?;
        Ok(())
    }
}
