// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::ConfigError;
use crate::config::HarnessKind;
use serde::{Deserialize, Serialize};

pub(crate) const OTLP_ENDPOINT: &str = "http://host.openshell.internal:4318";
/// Harness-native telemetry shared by the sandbox.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentObservability {
    /// Export OpenClaw traces to an externally operated local OTLP/HTTP collector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "OtlpTracing")]
    pub otlp: Option<OtlpTracing>,
    /// Emit Hermes ATOF and ATIF traces through its in-process NeMo Relay integration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "RelayTracing")]
    pub relay: Option<RelayTracing>,
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
/// Explicitly enabled in-process NeMo Relay tracing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayTracing {
    /// Must be true. Omit observability to leave Relay tracing disabled.
    pub enabled: bool,
}
impl AgentObservability {
    pub(crate) fn validate(&self, harness: HarnessKind) -> Result<(), ConfigError> {
        match (&self.otlp, &self.relay) {
            (Some(otlp), None)
                if harness == HarnessKind::OpenClaw
                    && otlp.enabled
                    && otlp.endpoint == OTLP_ENDPOINT
                    && !otlp.service_name.is_empty()
                    && otlp.service_name.len() <= 256
                    && otlp.service_name.trim() == otlp.service_name
                    && otlp.service_name.bytes().all(|b| (32..=126).contains(&b))
                    && otlp
                        .sample_rate
                        .as_f64()
                        .is_some_and(|n| (0.0..=1.0).contains(&n)) => {}
            (None, Some(relay)) if harness == HarnessKind::Hermes && relay.enabled => {}
            _ => {
                return Err(ConfigError::new(
                    "observability requires exactly one supported harness-native integration",
                ));
            }
        }
        Ok(())
    }

    pub(crate) fn uses_otlp(&self) -> bool {
        self.otlp.is_some()
    }
}
