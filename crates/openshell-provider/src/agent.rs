// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::OpenShell;
use nemoclaw_backend::{Error, ObservationError, Row};
use nemoclaw_openshell::runtime::Launch;

/// Annotation carrying a sandbox's launch.
pub const LAUNCH: &str = "nemoclaw.nvidia.com/launch-v1";
/// Annotation carrying a sandbox's policy input.
pub const POLICY: &str = "nemoclaw.nvidia.com/policy-input-v1";

/// How a sandbox row starts and what its runtime needs from the policy.
pub fn launch(row: &Row) -> Result<Launch, ObservationError> {
    Launch::from_json(row.get("launch_json").ok_or(ObservationError::Incomplete)?)
}

impl OpenShell {
    pub(crate) async fn check_sandbox_phase(&self, binding: &Row) -> Result<(), Error> {
        self.gateway.sandbox_phase(binding, false).await?;
        Ok(())
    }
}
