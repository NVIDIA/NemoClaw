// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Consumer bridge for Fabric PR #305, revision d3aebd464458dcddeaf2965249154dbc4353c93e.
//! 2026-09-16: retain upstream reports without implementing adapter health semantics.
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
    pub(crate) fn decode(bytes: &[u8]) -> Result<Self, crate::Error> {
        let health: Self = serde_json::from_slice(bytes).map_err(|_| {
            crate::Error::Conflict("invalid Fabric health response; resources retained")
        })?;
        if !health.valid() {
            return Err(crate::Error::Conflict(
                "invalid Fabric health response; resources retained",
            ));
        }
        Ok(health)
    }

    fn valid(&self) -> bool {
        let Some(report) = &self.report else {
            return match (self.supported, self.reason_code.as_deref()) {
                (false, Some("fabric_health_unsupported")) => true,
                (true, Some(reason)) => [
                    "runtime_unavailable",
                    "runtime_changed",
                    "fabric_health_timeout",
                    "fabric_health_error",
                    "health_transport_timeout",
                    "health_transport_error",
                ]
                .contains(&reason),
                _ => false,
            };
        };
        self.supported
            && self.reason_code.is_none()
            && report["runtime_id"].as_str().is_some_and(|s| !s.is_empty())
            && report["reason_code"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
            && report["checked_at_millis"].as_u64().is_some()
            && report["duration_millis"].as_u64().is_some()
            && ["responsive", "unresponsive", "exited", "unknown"]
                .contains(&report["liveness"].as_str().unwrap_or(""))
            && ["idle", "busy", "stopping", "unknown"]
                .contains(&report["activity"].as_str().unwrap_or(""))
            && ["ready", "not_ready", "unknown"]
                .contains(&report["readiness"].as_str().unwrap_or(""))
            && report["checks"].as_array().is_some_and(|checks| {
                checks.iter().all(|check| {
                    check["name"].as_str().is_some_and(|s| !s.is_empty())
                        && check["reason_code"].as_str().is_some_and(|s| !s.is_empty())
                        && check["observed_at_millis"].as_u64().is_some()
                        && check["age_millis"].as_u64().is_some()
                        && ["ok", "failed", "unknown", "unsupported"]
                            .contains(&check["status"].as_str().unwrap_or(""))
                })
            })
    }

    /// Older Fabric retains legacy readiness checks, with health explicitly unsupported.
    pub fn allows_apply_completion(&self) -> bool {
        if !self.valid() {
            return false;
        }
        if !self.supported {
            return true;
        }
        self.report.as_ref().is_some_and(|report| {
            report["liveness"] == "responsive" && report["readiness"] == "ready"
        })
    }
}
