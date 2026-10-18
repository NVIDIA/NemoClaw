// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Fabric's sandbox bridge, `fabric-agent-ctl`: one JSON envelope per command
//! run in a Fabric sandbox through OpenShell, to start, invoke, and stop the
//! sandbox's one agent runtime.
use async_trait::async_trait;
use nemoclaw_backend::{Error, ObservationError, Row};
use openshell_provider::{self as openshell, OpenShell, SandboxPhase};
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

/// Fabric's limit on one request to `fabric-agent-ctl`.
const REQUEST_LIMIT: usize = 512 * 1024;
/// Longer than `fabric-agent-ctl`'s own 320-second transport deadline.
const OPERATION_SECONDS: u32 = 330;
/// How long a new sandbox has to become ready and serve its bridge.
const START_DEADLINE: Duration = Duration::from_secs(120);

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Response {
    pub operation: String,
    pub status: String,
    // Required in every envelope; NemoClaw does not act on it.
    #[serde(rename = "changed")]
    pub _changed: Option<bool>,
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
            || response.operation != operation
        {
            return Err(invalid());
        }
        match (exit, response.status.as_str(), &response.error) {
            (0, "succeeded", None) => Ok(response),
            (1, "failed" | "unsupported", Some(error))
                if !error.code.is_empty()
                    && !error.stage.is_empty()
                    && !error.message.is_empty()
                    && matches!(error.effects.as_str(), "none" | "applied" | "unknown") =>
            {
                Ok(response)
            }
            _ => Err(invalid()),
        }
    }

    fn error(&self) -> Option<&Failure> {
        self.error.as_ref()
    }
}

pub(crate) fn value<'a>(row: &'a Row, key: &str) -> &'a str {
    row.get(key).map(String::as_str).unwrap_or("")
}

/// Run one `fabric-agent-ctl` command in the sandbox `binding` names.
async fn run(
    client: &OpenShell,
    binding: &Row,
    arguments: &[&str],
    stdin: Vec<u8>,
) -> Result<Response, Error> {
    // The agent and runtime binding must be the ones the sandbox launch
    // records; the gateway checks that launch against the live sandbox.
    let recorded = crate::configuration::fabric_binding(binding.clone())?;
    if ["agent_name", "runtime_json"]
        .iter()
        .any(|field| recorded.get(*field) != binding.get(*field))
    {
        return Err(ObservationError::BindingMismatch.into());
    }
    let runtime =
        nemoclaw_openshell::runtime::RuntimeBinding::from_json(value(binding, "runtime_json"))?;
    let (exit, output) = client
        .exec_input(
            binding,
            runtime.command(arguments[0], &arguments[1..]),
            runtime.environment(),
            OPERATION_SECONDS,
            stdin,
        )
        .await?;
    Response::decode(arguments[0], exit, &output)
}

/// Send one JSON value on stdin in the same exec as the command, so no file is
/// staged in the sandbox and no cleanup can leave the outcome unknown.
async fn run_input(
    client: &OpenShell,
    binding: &Row,
    arguments: &[&str],
    data: &Value,
) -> Result<Response, Error> {
    let payload = serde_json::to_vec(data).map_err(|_| invalid())?;
    if payload.len() > REQUEST_LIMIT {
        return Err(Error::Conflict("Fabric input exceeds the request limit"));
    }
    run(client, binding, arguments, payload).await
}

/// A failed operation as a public diagnostic built from Fabric's fixed codes.
fn failure(response: &Response) -> Error {
    let Some(error) = response.error() else {
        return invalid();
    };
    if error.code == "runtime_exists" {
        return ObservationError::Backend(
            "this sandbox already started its agent runtime, perhaps when an earlier \
             reply was lost; replace the sandbox and apply again",
        )
        .into();
    }
    crate::configuration::configuration_failure(&error.stage, &error.code, &error.effects).into()
}

/// The operations NemoClaw runs through a Fabric sandbox's bridge.
#[async_trait]
pub trait AgentBridge {
    /// Start the sandbox's one runtime once the sandbox serves its bridge, and
    /// return the runtime's ID.
    async fn start_agent(&self, binding: &Row, config: &Value) -> Result<String, Error>;
    /// Send one explicit request. An ambiguous outcome is never retried.
    async fn invoke_agent(
        &self,
        binding: &Row,
        runtime_id: &str,
        input: &Value,
    ) -> Result<Value, Error>;
    /// Stop the runtime. One that is already gone, or a bridge that no longer
    /// answers, counts as stopped.
    async fn stop_agent(&self, binding: &Row, runtime_id: &str) -> Result<(), Error>;
}

#[async_trait]
impl AgentBridge for OpenShell {
    async fn start_agent(&self, binding: &Row, config: &Value) -> Result<String, Error> {
        let name = value(binding, "agent_name");
        let arguments = ["start", "--agent", name, "--config", "-"];
        tokio::time::timeout(START_DEADLINE, async {
            loop {
                if self.sandbox_phase(binding, true).await? == SandboxPhase::Ready {
                    let response = run_input(self, binding, &arguments, config).await?;
                    if response.status == "succeeded" {
                        return response
                            .result
                            .as_ref()
                            .and_then(|result| result["runtime_id"].as_str())
                            .filter(|id| !id.is_empty())
                            .map(str::to_owned)
                            .ok_or_else(invalid);
                    }
                    // Until `serve` listens, nothing has started; ask again.
                    if !response.error().is_some_and(|error| {
                        error.code == "host_unavailable" && error.effects == "none"
                    }) {
                        return Err(failure(&response));
                    }
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        })
        .await
        .map_err(|_| Error::Conflict("Fabric sandbox startup timed out; resources retained"))?
    }

    async fn invoke_agent(
        &self,
        binding: &Row,
        runtime_id: &str,
        input: &Value,
    ) -> Result<Value, Error> {
        let name = value(binding, "agent_name");
        let arguments = [
            "invoke",
            "--agent",
            name,
            "--runtime-id",
            runtime_id,
            "--input",
            "-",
        ];
        let response = run_input(self, binding, &arguments, input).await?;
        if response.status != "succeeded" {
            return Err(failure(&response));
        }
        response.result.ok_or_else(invalid)
    }

    async fn stop_agent(&self, binding: &Row, runtime_id: &str) -> Result<(), Error> {
        let name = value(binding, "agent_name");
        let arguments = ["stop", "--agent", name, "--runtime-id", runtime_id];
        let response = run(self, binding, &arguments, Vec::new()).await?;
        match response.error() {
            None => Ok(()),
            Some(error)
                if matches!(
                    error.code.as_str(),
                    "runtime_unavailable" | "host_unavailable"
                ) =>
            {
                Ok(())
            }
            Some(_) => Err(failure(&response)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Response;

    fn decode(operation: &str, exit: i32, text: &str) -> bool {
        Response::decode(operation, exit, format!("{text}\n").as_bytes()).is_ok()
    }

    #[test]
    fn envelopes_must_match_the_operation_and_exit_status() {
        let started = r#"{"operation":"start","status":"succeeded","changed":true,"result":{"runtime_id":"r"},"error":null}"#;
        assert!(decode("start", 0, started));
        assert!(!decode("stop", 0, started), "another operation's reply");
        assert!(!decode("start", 1, started), "success with a failing exit");
        let stopped = r#"{"operation":"stop","status":"succeeded","changed":true,"result":null,"error":null}"#;
        assert!(decode("stop", 0, stopped));
        let failed = r#"{"operation":"start","status":"failed","changed":null,"result":null,"error":{"code":"start_failed","stage":"start","message":"m","effects":"unknown"}}"#;
        assert!(decode("start", 1, failed));
        assert!(
            !decode("start", 0, failed),
            "failure with a succeeding exit"
        );
        let effects = failed.replace("unknown", "maybe");
        assert!(!decode("start", 1, &effects), "unknown effects value");
        assert!(
            !decode("start", 0, r#"{"operation":"start"}"#),
            "missing fields"
        );
        assert!(
            Response::decode("start", 0, started.as_bytes()).is_err(),
            "no trailing newline"
        );
    }
}
