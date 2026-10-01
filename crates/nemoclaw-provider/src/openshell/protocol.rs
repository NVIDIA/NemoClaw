// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use nemoclaw_sdk::{Error, image_runtime::path_is_granted};
use serde::Deserialize;
use serde_json::Value;

pub(super) const RESPONSE_LIMIT: usize = 4 * 1024 * 1024;
const REQUEST_LIMIT: usize = 512 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Response {
    pub operation: String,
    pub status: String,
    pub changed: Option<bool>,
    pub result: Option<Value>,
    pub error: Option<Failure>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Failure {
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
    pub(super) fn decode(operation: &str, exit: i32, bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > RESPONSE_LIMIT || !bytes.ends_with(b"\n") {
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

    pub(super) fn snapshot(&self) -> Result<AgentSnapshot, Error> {
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

    pub(super) fn health(&self) -> Result<nemoclaw_sdk::RuntimeHealth, Error> {
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
        Ok(nemoclaw_sdk::RuntimeHealth {
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

impl OpenShell {
    /// Validate through the adapter packaged in the bound sandbox image.
    pub async fn validate_agent(&self, binding: &Row, config: &Value) -> Result<Value, Error> {
        let response = self.bridge_file(binding, "validate", config, None).await?;
        let result = response.result.ok_or_else(invalid)?;
        if response.status != "succeeded" || result["valid"] != true {
            return Err(Error::Conflict(
                "Fabric configuration validation failed; resources retained",
            ));
        }
        Ok(result)
    }

    pub(super) async fn bridge(
        &self,
        binding: &Row,
        arguments: &[&str],
        seconds: u32,
    ) -> Result<Response, Error> {
        let runtime = agent::binding(binding)?;
        let name = binding.get("agent_name").map(String::as_str).unwrap_or("");
        let (exit, output) = self
            .exec_bound(
                binding,
                runtime.command(arguments[0], &arguments[1..]),
                runtime.environment(name),
                seconds,
            )
            .await?;
        Response::decode(arguments[0], exit, &output)
    }

    pub async fn agent_snapshot(&self, binding: &Row) -> Result<AgentSnapshot, Error> {
        self.bridge(
            binding,
            &[
                "check",
                "--agent",
                binding.get("agent_name").map(String::as_str).unwrap_or(""),
                "--live",
            ],
            20,
        )
        .await?
        .snapshot()
    }

    pub(super) async fn bridge_file(
        &self,
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
        let runtime = agent::binding(binding)?;
        let name = binding.get("agent_name").map(String::as_str).unwrap_or("");
        let environment = runtime.environment(name);
        let python = &environment["ADAPTER_PYTHON"];
        let filesystem = super::row_policy(binding)?
            .filesystem
            .ok_or(ObservationError::Incomplete)?;
        let directory = ["HOME", "TMPDIR"]
            .into_iter()
            .filter_map(|key| environment.get(key))
            .find(|directory| path_is_granted(directory, &filesystem.read_write))
            .ok_or(Error::Conflict(
                "image does not advertise a writable Fabric input directory",
            ))?;
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce)
            .map_err(|_| Error::Conflict("cannot allocate Fabric input file"))?;
        let token: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
        let path = format!("{}/.nemoclaw-{token}.json", directory.trim_end_matches('/'));
        let stage = self
            .exec_input(
                binding,
                vec![
                    python.clone(),
                    "-c".into(),
                    include_str!("stage_json.py").into(),
                    path.clone(),
                ],
                environment.clone(),
                20,
                payload,
            )
            .await;
        let mut arguments = vec![
            operation,
            "--agent",
            name,
            if operation == "invoke" {
                "--input"
            } else {
                "--config"
            },
            &path,
        ];
        if let Some(generation) = expected_generation {
            arguments.extend(["--expected-generation", generation]);
        }
        let response = match stage {
            Ok((0, _)) => self.bridge(binding, &arguments, 120).await,
            Ok(_) => Err(Error::Conflict("cannot stage Fabric input file")),
            Err(error) => Err(error),
        };
        let cleanup = self
            .exec_bound(
                binding,
                vec![python.clone(), "-c".into(), "from pathlib import Path; import sys; Path(sys.argv[1]).unlink(missing_ok=True)".into(), path],
                environment,
                20,
            )
            .await;
        match (response, cleanup) {
            (Err(error), _) => Err(error),
            (Ok(response), Ok((0, _))) => Ok(response),
            (Ok(_), _) => Err(Error::Conflict(
                "Fabric input cleanup failed; command outcome requires observation",
            )),
        }
    }

    /// Send one explicit request. An ambiguous outcome is never retried.
    pub async fn invoke_agent(&self, binding: &Row, input: &Value) -> Result<Value, Error> {
        let response = self.bridge_file(binding, "invoke", input, None).await?;
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
