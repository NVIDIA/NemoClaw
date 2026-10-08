// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Health observations from the packaged Fabric bridge.
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
        if health
            .report
            .as_ref()
            .is_some_and(|report| !report.is_object())
            || health.reason_code.as_ref().is_some_and(String::is_empty)
            || (health.supported && health.report.is_none() && health.reason_code.is_none())
            || (!health.supported && health.reason_code.is_none())
        {
            return Err(crate::Error::Conflict(
                "invalid Fabric health response; resources retained",
            ));
        }
        Ok(health)
    }

    /// Health succeeds only when the bridge confirmed a successful Fabric report.
    pub fn allows_apply_completion(&self) -> bool {
        self.supported && self.report.is_some() && self.reason_code.is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_state_requires_an_object_report_and_a_usable_failure_reason() {
        for report in [
            serde_json::json!(42),
            serde_json::json!([]),
            serde_json::json!("text"),
        ] {
            let bytes = serde_json::to_vec(
                &serde_json::json!({"supported":true,"report":report,"reason_code":null}),
            )
            .unwrap();
            assert!(RuntimeHealth::decode(&bytes).is_err());
        }
        assert!(
            RuntimeHealth::decode(br#"{"supported":false,"report":null,"reason_code":""}"#)
                .is_err()
        );
        let unsupported = RuntimeHealth::decode(
            br#"{"supported":false,"report":null,"reason_code":"fabric_health_unsupported"}"#,
        )
        .unwrap();
        assert!(!unsupported.allows_apply_completion());
    }
}
