// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The Fabric bridge: one JSON envelope per command run in a Fabric sandbox
//! through OpenShell, for validation, configuration, invocation, and health.

use crate::openshell::{self, OpenShell, SandboxPhase};
use async_trait::async_trait;
use nemoclaw_backend::{Error, ObservationError, Row, RuntimeHealth};
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const REQUEST_LIMIT: usize = 512 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Response {
    pub operation: String,
    pub status: String,
    pub changed: Option<bool>,
    pub result: Option<Value>,
    pub error: Option<Failure>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Failure {
    pub code: String,
    pub stage: String,
    pub message: String,
    pub effects: String,
}

/// A coherent host observation, independent of whether agent health passed.
#[derive(Clone, Debug, Deserialize)]
pub struct AgentSnapshot {
    pub runtime_id: Option<String>,
    pub runtime_state: String,
    pub generation: Option<String>,
    pub applied_config: Option<Value>,
}

fn invalid() -> Error {
    Error::Conflict("invalid Fabric response; outcome unconfirmed; resources retained")
}

impl Response {
    pub(crate) fn decode(operation: &str, exit: i32, bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > openshell::RESPONSE_LIMIT || !bytes.ends_with(b"\n") {
            return Err(invalid());
        }
        // Deserialize the envelope directly so repeated fields cannot replace
        // an earlier failed status or error during a Value round trip.
        let response: Self = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        let value: Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        if ["operation", "status", "changed", "result", "error"]
            .iter()
            .any(|key| value.get(key).is_none())
            || !(value["result"].is_null() || value["result"].is_object())
        {
            return Err(invalid());
        }
        if response.operation != operation {
            return Err(invalid());
        }
        match (exit, response.status.as_str(), &response.error) {
            (0, "succeeded", None) => {}
            (1, "failed" | "unsupported", Some(error))
                if !error.code.is_empty()
                    && !error.stage.is_empty()
                    && !error.message.is_empty()
                    && matches!(error.effects.as_str(), "none" | "applied" | "unknown") => {}
            _ => return Err(invalid()),
        }
        if matches!(operation, "validate" | "check") && response.changed != Some(false) {
            return Err(invalid());
        }
        if operation == "invoke"
            && response.changed.is_some()
            && !(response.changed == Some(false)
                && response
                    .error
                    .as_ref()
                    .is_some_and(|error| error.effects == "none"))
        {
            return Err(invalid());
        }
        Ok(response)
    }

    pub(crate) fn snapshot(&self) -> Result<AgentSnapshot, Error> {
        let result = self.result.as_ref().ok_or_else(invalid)?;
        if [
            "runtime_id",
            "runtime_state",
            "generation",
            "applied_config",
        ]
        .iter()
        .any(|field| result.get(field).is_none())
        {
            return Err(invalid());
        }
        let snapshot: AgentSnapshot =
            serde_json::from_value(result.clone()).map_err(|_| invalid())?;
        if !matches!(
            snapshot.runtime_state.as_str(),
            "running" | "stopped" | "unknown"
        ) || snapshot.generation.as_ref().is_some_and(String::is_empty)
            || snapshot.runtime_id.as_ref().is_some_and(String::is_empty)
            || snapshot
                .applied_config
                .as_ref()
                .is_some_and(|value| !value.is_object())
            || (snapshot.runtime_state != "unknown" && snapshot.generation.is_none())
            || (snapshot.runtime_state == "running"
                && (snapshot.runtime_id.is_none() || snapshot.applied_config.is_none()))
            || (snapshot.runtime_state == "stopped"
                && (snapshot.runtime_id.is_some() || snapshot.applied_config.is_some()))
        {
            return Err(invalid());
        }
        Ok(snapshot)
    }

    pub(crate) fn health(&self) -> Result<nemoclaw_backend::RuntimeHealth, Error> {
        self.snapshot()?;
        let report = self
            .result
            .as_ref()
            .and_then(|result| result.get("health"))
            .ok_or_else(invalid)?;
        if !(report.is_null() || report.is_object())
            || (self.status == "succeeded" && report.is_null())
        {
            return Err(invalid());
        }
        Ok(nemoclaw_backend::RuntimeHealth {
            supported: self.status != "unsupported",
            report: (!report.is_null()).then(|| report.clone()),
            // Backend text is not a diagnostic contract. Only fixed local codes
            // cross the SDK boundary; the public report stays opaque.
            reason_code: match self.status.as_str() {
                "succeeded" => None,
                "unsupported" => Some("fabric_health_unsupported".into()),
                _ => Some("fabric_health_failed".into()),
            },
        })
    }
}

const AGENT_READINESS_TIMEOUT: Duration = Duration::from_secs(300);

async fn readiness_deadline(
    wait: impl std::future::Future<Output = Result<(), Error>>,
    cancel: &CancellationToken,
) -> Result<(), Error> {
    tokio::select! {
        () = cancel.cancelled() => Err(Error::Cancelled),
        result = tokio::time::timeout(AGENT_READINESS_TIMEOUT, wait) =>
            result.map_err(|_| Error::Conflict("agent readiness timed out; resources retained"))?,
    }
}

pub(crate) fn value<'a>(row: &'a Row, key: &str) -> &'a str {
    row.get(key).map(String::as_str).unwrap_or("")
}

async fn bridge(
    client: &OpenShell,
    binding: &Row,
    arguments: &[&str],
    seconds: u32,
    stdin: Vec<u8>,
) -> Result<Response, Error> {
    let runtime = openshell::agent::binding(binding)?;
    let (exit, output) = client
        .exec_input(
            binding,
            runtime.command(arguments[0], &arguments[1..]),
            runtime.environment(value(binding, "agent_name")),
            seconds,
            stdin,
        )
        .await?;
    Response::decode(arguments[0], exit, &output)
}

/// Send one JSON object on stdin in the same exec as the command, so no
/// file is staged in the sandbox and no cleanup can leave the outcome unknown.
pub(crate) async fn bridge_input(
    client: &OpenShell,
    binding: &Row,
    operation: &str,
    data: &Value,
    expected_generation: Option<&str>,
) -> Result<Response, Error> {
    if !data.is_object() {
        return Err(Error::Conflict("Fabric input must be a JSON object"));
    }
    let payload = serde_json::to_vec(data).map_err(|_| invalid())?;
    if payload.len() > REQUEST_LIMIT {
        return Err(Error::Conflict("Fabric input exceeds the request limit"));
    }
    let name = value(binding, "agent_name");
    let flag = if operation == "invoke" {
        "--input"
    } else {
        "--config"
    };
    let mut arguments = vec![operation, "--agent", name, flag, "-"];
    if let Some(generation) = expected_generation {
        arguments.extend(["--expected-generation", generation]);
    }
    bridge(client, binding, &arguments, 120, payload).await
}

/// Fabric operations on an OpenShell sandbox that runs the Fabric bridge.
#[async_trait]
pub trait AgentBridge {
    /// Validate through the adapter packaged in the bound sandbox image.
    async fn validate_agent(&self, binding: &Row, config: &Value) -> Result<Value, Error>;
    async fn agent_snapshot(&self, binding: &Row) -> Result<AgentSnapshot, Error>;
    /// Send one explicit request. An ambiguous outcome is never retried.
    async fn invoke_agent(&self, binding: &Row, input: &Value) -> Result<Value, Error>;
    /// Query the existing hosted Fabric runtime; never invoke an agent or model.
    async fn health(&self, binding: &Row) -> Result<RuntimeHealth, Error>;
    /// Wait until the sandbox is ready and runs its declared configuration.
    async fn ready(&self, binding: &Row, cancel: &CancellationToken) -> Result<(), Error>;
    /// Apply the bound configuration once the runtime reports a generation.
    async fn configure_agent(&self, binding: &Row) -> Result<(), Error>;
    /// Confirm that the running runtime applied the bound configuration.
    async fn configuration(&self, binding: &Row) -> Result<(), Error>;
}

#[async_trait]
impl AgentBridge for OpenShell {
    async fn validate_agent(&self, binding: &Row, config: &Value) -> Result<Value, Error> {
        let response = bridge_input(self, binding, "validate", config, None).await?;
        let result = response.result.ok_or_else(invalid)?;
        if response.status != "succeeded" || result["valid"] != true {
            return Err(Error::Conflict(
                "Fabric configuration validation failed; resources retained",
            ));
        }
        Ok(result)
    }

    async fn agent_snapshot(&self, binding: &Row) -> Result<AgentSnapshot, Error> {
        bridge(
            self,
            binding,
            &["check", "--agent", value(binding, "agent_name"), "--live"],
            20,
            Vec::new(),
        )
        .await?
        .snapshot()
    }

    async fn invoke_agent(&self, binding: &Row, input: &Value) -> Result<Value, Error> {
        let response = bridge_input(self, binding, "invoke", input, None).await?;
        if response.status != "succeeded" {
            return Err(Error::Conflict(
                if response
                    .error
                    .as_ref()
                    .is_some_and(|error| error.effects == "none")
                {
                    "Fabric invocation rejected before execution"
                } else {
                    "Fabric invocation failed; effects may have occurred"
                },
            ));
        }
        let result = response.result.ok_or_else(invalid)?;
        if result["runtime_id"].as_str().is_none_or(str::is_empty)
            || !result["fabric_result"].is_object()
            || result["fabric_result"]["status"] != "succeeded"
        {
            return Err(invalid());
        }
        Ok(result)
    }

    async fn health(&self, binding: &Row) -> Result<RuntimeHealth, Error> {
        bridge(
            self,
            binding,
            &["check", "--agent", value(binding, "agent_name"), "--ready"],
            10,
            Vec::new(),
        )
        .await?
        .health()
    }

    async fn ready(&self, binding: &Row, cancel: &CancellationToken) -> Result<(), Error> {
        let wait = async {
            loop {
                let phase = self.sandbox_phase(binding, true).await?;
                if phase == SandboxPhase::Ready && self.configuration(binding).await.is_ok() {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        };
        readiness_deadline(wait, cancel).await
    }

    async fn configure_agent(&self, binding: &Row) -> Result<(), Error> {
        crate::fabric::configuration::configure_agent(self, binding).await
    }

    async fn configuration(&self, binding: &Row) -> Result<(), Error> {
        let snapshot = self.agent_snapshot(binding).await?;
        let desired: Value = serde_json::from_str(value(binding, "config_json"))
            .map_err(|_| ObservationError::Query)?;
        if snapshot.runtime_state != "running" || snapshot.applied_config.as_ref() != Some(&desired)
        {
            return Err(Error::Conflict(
                "agent configuration cannot be independently established",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contradictory_or_incomplete_envelopes_never_confirm_an_outcome() {
        for bytes in [
            "{\"operation\":\"check\",\"status\":\"failed\",\"status\":\"succeeded\",\"changed\":false,\"result\":{},\"error\":null}\n",
            "{\"operation\":\"check\",\"status\":\"succeeded\",\"result\":{},\"error\":null}\n",
            "{\"operation\":\"invoke\",\"status\":\"succeeded\",\"changed\":false,\"result\":{},\"error\":null}\n",
            "{\"operation\":\"check\",\"status\":\"succeeded\",\"changed\":false,\"result\":{},\"error\":null}",
        ] {
            let operation = if bytes.contains("invoke") {
                "invoke"
            } else {
                "check"
            };
            assert!(Response::decode(operation, 0, bytes.as_bytes()).is_err());
        }
        let rejected = b"{\"operation\":\"invoke\",\"status\":\"unsupported\",\"changed\":false,\"result\":null,\"error\":{\"stage\":\"request\",\"code\":\"streaming_unsupported\",\"message\":\"streaming is unsupported\",\"effects\":\"none\"}}\n";
        assert!(Response::decode("invoke", 1, rejected).is_ok());
        let success = b"{\"operation\":\"check\",\"status\":\"succeeded\",\"changed\":false,\"result\":{},\"error\":null}\n";
        assert!(Response::decode("check", 1, success).is_err());
        assert!(
            Response::decode("check", 0, success)
                .unwrap()
                .health()
                .is_err()
        );
    }
}

#[cfg(test)]
mod readiness_tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn readiness_uses_the_full_deadline_without_wall_clock_waiting() {
        let cancel = CancellationToken::new();
        let started = tokio::time::Instant::now();
        let error = readiness_deadline(std::future::pending(), &cancel)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("readiness timed out"));
        assert_eq!(started.elapsed(), AGENT_READINESS_TIMEOUT);
        readiness_deadline(
            async {
                tokio::time::sleep(AGENT_READINESS_TIMEOUT - Duration::from_secs(1)).await;
                Ok(())
            },
            &cancel,
        )
        .await
        .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn readiness_cancellation_and_terminal_errors_do_not_wait_for_the_deadline() {
        let cancel = CancellationToken::new();
        let started = tokio::time::Instant::now();
        let (_, result) = tokio::join!(
            async {
                tokio::time::sleep(Duration::from_secs(2)).await;
                cancel.cancel();
            },
            readiness_deadline(std::future::pending(), &cancel)
        );
        assert!(matches!(result, Err(Error::Cancelled)));
        assert_eq!(started.elapsed(), Duration::from_secs(2));
        let error = readiness_deadline(
            async { Err(Error::Conflict("terminal")) },
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "terminal");
        assert_eq!(started.elapsed(), Duration::from_secs(2));
    }
}
