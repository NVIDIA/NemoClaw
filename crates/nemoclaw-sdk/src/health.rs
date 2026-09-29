// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Unsupported-health response from the packaged Fabric bridge.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeHealth {
    pub supported: bool,
    pub report: Option<Value>,
    pub reason_code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxHealth {
    pub sandbox: String,
    pub agents: Vec<String>,
    #[serde(flatten)]
    pub health: RuntimeHealth,
}

impl RuntimeHealth {
    pub fn decode(bytes: &[u8]) -> Result<Self, crate::Error> {
        let health: Self = serde_json::from_slice(bytes).map_err(|_| {
            crate::Error::Conflict("invalid Fabric health response; resources retained")
        })?;
        if !health.allows_apply_completion() {
            return Err(crate::Error::Conflict(
                "invalid Fabric health response; resources retained",
            ));
        }
        Ok(health)
    }

    /// The pinned Fabric has no health API. Only its explicit unsupported
    /// response permits completion after the other readiness checks pass.
    pub fn allows_apply_completion(&self) -> bool {
        !self.supported
            && self.report.is_none()
            && self.reason_code.as_deref() == Some("fabric_health_unsupported")
    }
}
