// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::{CancellationToken, Error};
use std::time::Duration;

fn value<'a>(row: &'a Row, key: &str) -> &'a str {
    row.get(key).map(String::as_str).unwrap_or("")
}
fn hermes_response_text(bytes: &[u8]) -> Result<String, Error> {
    if bytes.len() > 1 << 20 {
        return Err(Error::Conflict("agent response exceeds the probe limit"));
    }
    let response: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|_| Error::Conflict("agent returned no confirmed response"))?;
    let text = response["output"]["response"].as_str().unwrap_or("").trim();
    if response["status"] != "succeeded" || text.is_empty() || text.len() > 16 << 10 {
        return Err(Error::Conflict(
            "agent returned no confirmed successful response",
        ));
    }
    Ok(text.into())
}
fn response_text(bytes: &[u8]) -> Result<String, Error> {
    if bytes.len() > 1 << 20 {
        return Err(Error::Conflict("agent response exceeds the probe limit"));
    }
    let response: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|_| Error::Conflict("agent returned no confirmed response"))?;
    let payloads = response["result"]["payloads"]
        .as_array()
        .ok_or(Error::Conflict("agent returned no confirmed response"))?;
    if response["status"] != "ok"
        || payloads.is_empty()
        || payloads.iter().any(|p| p["isError"] == true)
    {
        return Err(Error::Conflict(
            "agent returned no confirmed successful response",
        ));
    }
    let text = payloads[0]["text"].as_str().unwrap_or("").trim();
    if text.is_empty() || text.len() > 16 << 10 {
        return Err(Error::Conflict(
            "agent response is empty or exceeds the probe limit",
        ));
    }
    Ok(text.into())
}
impl OpenShell {
    pub async fn verify_gateway(&self, driver: &str) -> Result<(), Error> {
        let info = self
            .grpc()
            .get_gateway_info(self.request(proto::GetGatewayInfoRequest {}))
            .await
            .map_err(|error| remote_error(&error))?
            .into_inner();
        if info.gateway_version != "0.0.117-dev.155+gb3e4ad457"
            || info.compute_drivers.len() != 1
            || (info.compute_drivers[0].name != driver
                && info.compute_drivers[0]
                    .capabilities
                    .as_ref()
                    .is_none_or(|capability| capability.driver_name != driver))
        {
            return Err(Error::Conflict(
                "gateway version or compute driver does not satisfy the configuration",
            ));
        }
        Ok(())
    }
    async fn bound_sandbox(&self, binding: &Row) -> Result<proto::Sandbox, Error> {
        let sandbox = self
            .grpc()
            .get_sandbox(self.request(proto::GetSandboxRequest {
                name: value(binding, "name").into(),
                workspace_scope: Some(proto::workspace_selector(value(binding, "workspace"))),
            }))
            .await
            .map_err(|error| remote_error(&error))?
            .into_inner()
            .sandbox
            .ok_or(ObservationError::Incomplete)?;
        verify_identity(
            binding,
            &base(sandbox.metadata.clone(), value(binding, "name"), false)?,
        )?;
        Ok(sandbox)
    }
    pub async fn exec_bound(
        &self,
        binding: &Row,
        command: Vec<String>,
        environment: Row,
        seconds: u32,
    ) -> Result<(i32, Vec<u8>), Error> {
        tokio::time::timeout(
            Duration::from_secs(u64::from(seconds)),
            self.exec_stream(binding, command, environment, seconds),
        )
        .await
        .map_err(|_| Error::Conflict("sandbox exec timed out; invocation may have had effects"))?
    }
    async fn exec_stream(
        &self,
        binding: &Row,
        command: Vec<String>,
        environment: Row,
        seconds: u32,
    ) -> Result<(i32, Vec<u8>), Error> {
        let sandbox = self.bound_sandbox(binding).await?;
        let mut request = self.request(proto::ExecSandboxRequest {
            sandbox_id: sandbox.metadata.ok_or(ObservationError::Incomplete)?.id,
            command,
            environment: environment.into_iter().collect(),
            timeout_seconds: seconds,
            ..Default::default()
        });
        request.set_timeout(Duration::from_secs(u64::from(seconds)));
        let mut stream = self
            .grpc()
            .exec_sandbox(request)
            .await
            .map_err(|error| remote_error(&error))?
            .into_inner();
        let mut output = Vec::new();
        let mut exit = None;
        while let Some(event) = stream
            .message()
            .await
            .map_err(|error| remote_error(&error))?
        {
            if exit.is_some() {
                return Err(ObservationError::Incomplete.into());
            }
            match event.payload.ok_or(ObservationError::Incomplete)? {
                proto::exec_sandbox_event::Payload::Stdout(chunk) => {
                    if output.len() + chunk.data.len() > 1 << 20 {
                        return Err(Error::Conflict("sandbox exec output exceeds limit"));
                    }
                    output.extend(chunk.data);
                }
                proto::exec_sandbox_event::Payload::Stderr(_) => {}
                proto::exec_sandbox_event::Payload::Exit(result) => exit = Some(result.exit_code),
            }
        }
        Ok((exit.ok_or(ObservationError::Incomplete)?, output))
    }
    fn configuration_command(&self, binding: &Row) -> Result<(Vec<String>, Row), Error> {
        let harness = value(binding, "agent_runtime")
            .strip_prefix("fabric-")
            .filter(|harness| crate::config::is_fabric_harness(harness))
            .ok_or(Error::Conflict(
                "sandbox does not declare a supported Fabric runtime",
            ))?;
        let mut command = [
            "/opt/fabric/bin/python",
            "/opt/nemoclaw/fabric.py",
            "check",
            value(binding, "agent_name"),
        ]
        .map(String::from)
        .to_vec();
        if harness != "deepagents" {
            command.push(harness.into());
        }
        if harness == "pi" {
            command.push(
                binding
                    .get("pi_model_config")
                    .filter(|value| !value.is_empty())
                    .ok_or(Error::Conflict(
                        "Pi configuration requires the declared route model",
                    ))?
                    .clone(),
            );
        }
        if let Some(settings) = binding.get("inference_json").filter(|s| !s.is_empty()) {
            inference_settings(settings, value(binding, "agent_runtime"))?;
            command.extend(["--inference".into(), settings.clone()]);
        }
        Ok((command, Row::new()))
    }
    pub async fn configure_pi(&self, binding: &Row, prepare: bool) -> Result<(), Error> {
        tokio::time::timeout(Duration::from_secs(120), async {
            loop {
                let phase = self
                    .bound_sandbox(binding)
                    .await?
                    .status
                    .ok_or(ObservationError::Incomplete)?
                    .phase;
                if phase == proto::SandboxPhase::Ready as i32 {
                    return Ok::<(), Error>(());
                }
                if matches!(
                    proto::SandboxPhase::try_from(phase),
                    Ok(proto::SandboxPhase::Error
                        | proto::SandboxPhase::Deleting
                        | proto::SandboxPhase::Stopped)
                ) {
                    return Err(Error::Conflict(
                        "Pi sandbox is unavailable; resources retained",
                    ));
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        })
        .await
        .map_err(|_| Error::Conflict("Pi sandbox startup timed out; resources retained"))??;
        let (mut command, environment) = self.configuration_command(binding)?;
        command[2] = if prepare { "prepare" } else { "configure" }.into();
        let (exit, _) = self.exec_bound(binding, command, environment, 120).await?;
        if exit != 0 {
            return Err(Error::Conflict(
                "Pi model configuration failed; check model ID and piModel metadata; resources retained",
            ));
        }
        Ok(())
    }
    pub(super) async fn agent_configuration(&self, binding: &Row) -> Result<(), Error> {
        if self
            .bound_sandbox(binding)
            .await?
            .status
            .ok_or(ObservationError::Incomplete)?
            .phase
            != proto::SandboxPhase::Ready as i32
        {
            return Err(ObservationError::Incomplete.into());
        }
        self.configuration(binding).await
    }
    pub async fn configuration(&self, binding: &Row) -> Result<(), Error> {
        let (command, environment) = self.configuration_command(binding)?;
        let (exit, _) = self.exec_bound(binding, command, environment, 20).await?;
        if exit != 0 {
            return Err(Error::Conflict(
                "agent configuration cannot be independently established",
            ));
        }
        Ok(())
    }
    pub async fn ready(&self, binding: &Row, cancel: &CancellationToken) -> Result<(), Error> {
        let wait = async {
            loop {
                let sandbox = self.bound_sandbox(binding).await?;
                let phase = sandbox.status.ok_or(ObservationError::Incomplete)?.phase;
                if matches!(
                    proto::SandboxPhase::try_from(phase),
                    Ok(proto::SandboxPhase::Error
                        | proto::SandboxPhase::Deleting
                        | proto::SandboxPhase::Stopped)
                ) {
                    return Err(Error::Conflict(
                        "sandbox readiness failed; established identity retained",
                    ));
                }
                if phase == proto::SandboxPhase::Ready as i32 {
                    let (command, environment) = self.configuration_command(binding)?;
                    if let Ok((0, _)) = self.exec_bound(binding, command, environment, 20).await {
                        return Ok(());
                    }
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        };
        tokio::select! {
            ()=cancel.cancelled()=>Err(Error::Cancelled),
            result=tokio::time::timeout(Duration::from_secs(120),wait)=>result.map_err(|_|Error::Conflict("agent readiness timed out; resources retained"))?,
        }
    }
    pub async fn inference_ready(&self, binding: &Row) -> Result<(), Error> {
        if value(binding, "agent_runtime") == "fabric-pi" {
            let model = binding
                .get("pi_model_config")
                .ok_or(Error::Conflict("Pi requires the declared route model"))?;
            let (exit, _) = self
                .exec_bound(
                    binding,
                    vec![
                        "node".into(),
                        "/opt/fabric-source/adapters/typescript/pi/dist/pi-probe.js".into(),
                        model.clone(),
                    ],
                    Row::new(),
                    90,
                )
                .await?;
            return if exit == 0 {
                Ok(())
            } else {
                Err(Error::Conflict(
                    "Pi inference through the configured model failed; resources retained",
                ))
            };
        }
        inference_settings(
            value(binding, "inference_json"),
            value(binding, "agent_runtime"),
        )?
        .ok_or(ObservationError::Incomplete)?;
        let (exit, _) = self
            .exec_bound(
                binding,
                vec!["node".into(), "/opt/nemoclaw/inference-probe.mts".into()],
                Row::new(),
                90,
            )
            .await?;
        if exit != 0 {
            return Err(Error::Conflict(
                "inference through the sandbox failed; resources retained",
            ));
        }
        Ok(())
    }
    pub async fn agent_response(&self, binding: &Row) -> Result<String, Error> {
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| Error::State("cannot generate probe session"))?;
        random[6] = (random[6] & 15) | 64;
        random[8] = (random[8] & 63) | 128;
        let hex: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let session = format!(
            "{}-{}-{}-{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..]
        );
        let hermes = value(binding, "agent_runtime") == "fabric-hermes";
        let command = if hermes {
            vec![
                "/opt/fabric/bin/python".into(),
                "/opt/nemoclaw/fabric.py".into(),
                "probe".into(),
                value(binding, "agent_name").into(),
                "hermes".into(),
            ]
        } else {
            [
                "openclaw",
                "agent",
                "--agent",
                value(binding, "agent_name"),
                "--session-id",
                &session,
                "--message",
                "Reply with the word FOUR.",
                "--thinking",
                "off",
                "--json",
                "--timeout",
                "300",
            ]
            .map(String::from)
            .to_vec()
        };
        let (exit, output) = self.exec_bound(binding, command, Row::new(), 360).await?;
        if exit != 0 {
            return Err(Error::Conflict(
                "actual agent response failed; resources retained",
            ));
        }
        let text = if hermes {
            hermes_response_text(&output)?
        } else {
            response_text(&output)?
        };
        if !text
            .trim_matches([' ', '\n', '\r', '\t', '.', '!', '\"', '\''])
            .eq_ignore_ascii_case("FOUR")
        {
            return Err(Error::Conflict(
                "agent did not answer the inference probe; resources retained",
            ));
        }
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hermes_reply_requires_success_before_accepting_text() {
        assert_eq!(
            hermes_response_text(br#"{"status":"succeeded","output":{"response":"FOUR"}}"#)
                .unwrap(),
            "FOUR"
        );
        assert!(
            hermes_response_text(br#"{"status":"failed","output":{"response":"FOUR"}}"#).is_err()
        );
        assert!(hermes_response_text(br#"{"status":"succeeded","output":{}}"#).is_err());
    }
    #[test]
    fn agent_reply_requires_confirmed_success_and_non_error_payloads() {
        assert_eq!(
            response_text(br#"{"status":"ok","result":{"payloads":[{"text":" FOUR. "}]}}"#)
                .unwrap(),
            "FOUR."
        );
        for bytes in [
            br#"{"status":"error","result":{"payloads":[{"text":"FOUR"}]}}"#.as_slice(),
            br#"{"status":"ok","result":{"payloads":[{"text":"FOUR"},{"isError":true}]}}"#,
            br#"{"status":"ok","result":{"payloads":[]}}"#,
        ] {
            assert!(response_text(bytes).is_err());
        }
    }
}
