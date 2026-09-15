// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::ConfigError;
use serde::{Deserialize, Serialize};

pub(crate) const OTLP_ENDPOINT: &str = "http://host.openshell.internal:4318";
/// OpenClaw gateway telemetry, declared on the first agent and shared by its sandbox.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AgentObservability {
    /// Export traces to an externally operated local OTLP/HTTP collector. Credentials, logs, and metrics are excluded.
    pub otlp: OtlpTracing,
}
/// Explicitly enabled HTTP/protobuf tracing. The collector is not managed by NemoClaw.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OtlpTracing {
    /// Must be true. Omit observability to leave native telemetry unconfigured.
    pub enabled: bool,
    /// Local collector base URL; currently http://host.openshell.internal:4318.
    pub endpoint: String,
    /// Nonempty printable ASCII service name, without leading or trailing spaces, at most 256 characters.
    pub service_name: String,
    /// Fraction of traces sampled, from 0 through 1 inclusive.
    #[schemars(with = "f64", range(min = 0, max = 1))]
    pub sample_rate: serde_json::Number,
}
impl AgentObservability {
    pub(crate) fn validate(&self, harness: &str) -> Result<(), ConfigError> {
        let otlp = &self.otlp;
        if harness != "openclaw"
            || !otlp.enabled
            || otlp.endpoint != OTLP_ENDPOINT
            || otlp.service_name.is_empty()
            || otlp.service_name.len() > 256
            || otlp.service_name.trim() != otlp.service_name
            || !otlp.service_name.bytes().all(|b| (32..=126).contains(&b))
            || otlp
                .sample_rate
                .as_f64()
                .is_none_or(|n| !(0.0..=1.0).contains(&n))
        {
            return Err(ConfigError(
                "OTLP requires OpenClaw, the local collector, a printable service name and a sample rate from 0 through 1",
            ));
        }
        Ok(())
    }
}
