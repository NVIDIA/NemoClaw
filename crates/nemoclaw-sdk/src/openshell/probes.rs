// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::{CancellationToken, Error};
use std::time::Duration;

fn startup_phase(status: proto::SandboxStatus) -> Result<i32, Error> {
    if let Ok(
        phase @ (proto::SandboxPhase::Error
        | proto::SandboxPhase::Deleting
        | proto::SandboxPhase::Stopped
        | proto::SandboxPhase::Completed),
    ) = proto::SandboxPhase::try_from(status.phase)
    {
        return Err(Error::SandboxStartup {
            phase: phase.as_str_name(),
            // Conditions are backend-controlled. Only fixed known reasons may
            // cross the diagnostic boundary; messages can contain credentials.
            reason: status
                .conditions
                .iter()
                .find_map(|condition| {
                    if condition.r#type != "Ready" || condition.status != "False" {
                        return None;
                    }
                    match condition.reason.as_str() {
                        "ControlSupervisorExited" => Some("ControlSupervisorExited"),
                        "ContainerExited" => Some("ContainerExited"),
                        _ => None,
                    }
                })
                .unwrap_or("unknown"),
            exit_code: status
                .exit_code
                .map_or_else(|| "unknown".into(), |code| code.to_string()),
        });
    }
    Ok(status.phase)
}

async fn readiness_deadline(
    wait: impl std::future::Future<Output = Result<(), Error>>,
    cancel: &CancellationToken,
) -> Result<(), Error> {
    tokio::select! {
        () = cancel.cancelled() => Err(Error::Cancelled),
        result = tokio::time::timeout(Duration::from_secs(120), wait) =>
            result.map_err(|_| Error::Conflict("agent readiness timed out; resources retained"))?,
    }
}

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
fn voice_command(
    binding: &Row,
    session: &str,
    message: &str,
    command_timeout: &str,
) -> Result<Vec<String>, OpenClawResponseError> {
    if value(binding, "agent_runtime") != "fabric-openclaw" {
        return Err(OpenClawResponseError::Unavailable);
    }
    let settings = inference_settings(value(binding, "inference_json"), "fabric-openclaw")
        .map_err(|_| OpenClawResponseError::Unavailable)?
        .ok_or(OpenClawResponseError::Unavailable)?;
    let [agent] = settings.agents.as_slice() else {
        return Err(OpenClawResponseError::Unavailable);
    };
    // The binding names the Fabric sandbox runtime; OpenClaw has a separate
    // native agent identity carried by its validated runtime configuration.
    Ok([
        "openclaw",
        "agent",
        "--agent",
        &agent.name,
        "--session-id",
        session,
        "--message",
        message,
        "--thinking",
        "off",
        "--json",
        "--timeout",
        command_timeout,
    ]
    .map(String::from)
    .to_vec())
}

impl OpenShell {
    pub(crate) async fn voice_ready(&self, binding: &Row) -> crate::voice::ProbeResult {
        match self.agent_configuration(binding).await {
            Ok(()) => crate::voice::ProbeResult::Ready,
            Err(Error::Observation(ObservationError::BindingMismatch)) => {
                crate::voice::ProbeResult::Replaced
            }
            Err(_) => crate::voice::ProbeResult::Unavailable,
        }
    }

    async fn openclaw_response(
        &self,
        binding: &Row,
        message: &'static str,
        command_timeout: &'static str,
        execution_timeout: u32,
    ) -> Result<String, OpenClawResponseError> {
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| OpenClawResponseError::Unavailable)?;
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
        let command = voice_command(binding, &session, message, command_timeout)?;
        let (exit, output) = match self
            .exec_bound(binding, command, Row::new(), execution_timeout)
            .await
        {
            Ok(result) => result,
            Err(Error::Observation(ObservationError::BindingMismatch)) => {
                return Err(OpenClawResponseError::Replaced);
            }
            Err(_) => return Err(OpenClawResponseError::Unavailable),
        };
        if exit != 0 {
            return Err(OpenClawResponseError::Unavailable);
        }
        response_text(&output).map_err(|_| OpenClawResponseError::InvalidResponse)
    }

    pub(crate) async fn voice_response(&self, binding: &Row) -> crate::voice::DispatchResult {
        match self
            .openclaw_response(binding, crate::voice::QUESTION, "60", 60)
            .await
        {
            Ok(answer) => crate::voice::DispatchResult::Answer(answer),
            Err(OpenClawResponseError::Replaced) => crate::voice::DispatchResult::TargetReplaced,
            Err(OpenClawResponseError::Unavailable) => {
                crate::voice::DispatchResult::AgentUnavailable
            }
            Err(OpenClawResponseError::InvalidResponse) => {
                crate::voice::DispatchResult::InvalidResponse
            }
        }
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
    pub(crate) async fn check_sandbox_phase(&self, binding: &Row) -> Result<(), Error> {
        startup_phase(
            self.bound_sandbox(binding)
                .await?
                .status
                .ok_or(ObservationError::Incomplete)?,
        )?;
        Ok(())
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
            execution_timeout: Some(
                openshell_core::time::duration_from_std(Duration::from_secs(u64::from(seconds)))
                    .expect("u32 seconds fit protobuf duration"),
            ),
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
            let model = match binding
                .get("pi_model_config")
                .filter(|value| !value.is_empty())
            {
                Some(model) => model.clone(),
                None => {
                    // Refresh observes the immutable catalog, not the separate single-model binding.
                    let settings =
                        inference_settings(value(binding, "inference_json"), "fabric-pi")?
                            .ok_or(ObservationError::Incomplete)?;
                    let selection = settings
                        .agents
                        .iter()
                        .find(|agent| agent.name == value(binding, "agent_name"))
                        .and_then(|agent| agent.inference.as_ref())
                        .ok_or(ObservationError::Incomplete)?;
                    let model = selection
                        .models
                        .get(&selection.default)
                        .and_then(|model| model.pi.as_ref())
                        .ok_or(ObservationError::Incomplete)?;
                    serde_json::to_string(model).map_err(|_| ObservationError::Query)?
                }
            };
            command.push(model);
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
                let phase = startup_phase(
                    self.bound_sandbox(binding)
                        .await?
                        .status
                        .ok_or(ObservationError::Incomplete)?,
                )?;
                if phase == proto::SandboxPhase::Ready as i32 {
                    return Ok::<(), Error>(());
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
                let phase = startup_phase(sandbox.status.ok_or(ObservationError::Incomplete)?)?;
                if phase == proto::SandboxPhase::Ready as i32 {
                    let (command, environment) = self.configuration_command(binding)?;
                    if let Ok((0, _)) = self.exec_bound(binding, command, environment, 20).await {
                        return Ok(());
                    }
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        };
        readiness_deadline(wait, cancel).await
    }

    /// Query the existing hosted Fabric runtime; never invoke an agent or model.
    pub async fn health(&self, binding: &Row) -> Result<crate::RuntimeHealth, Error> {
        self.health_for(binding, None).await
    }

    pub(crate) async fn health_for(
        &self,
        binding: &Row,
        agent: Option<&str>,
    ) -> Result<crate::RuntimeHealth, Error> {
        let mut command = [
            "/opt/fabric/bin/python",
            "/opt/nemoclaw/fabric.py",
            "health",
        ]
        .map(String::from)
        .to_vec();
        command.extend(agent.map(String::from));
        let (exit, output) = self.exec_bound(binding, command, Row::new(), 10).await?;
        if exit != 0 {
            return Err(Error::Conflict(
                "Fabric health bridge unavailable; rebuild the agent image; resources retained",
            ));
        }
        crate::RuntimeHealth::decode(&output)
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
    fn voice_dispatch_selects_the_native_agent_not_the_sandbox_runtime() {
        let document = crate::config::Document::parse(
            include_bytes!("../../../../examples/fabric-openclaw.yaml").as_slice(),
        )
        .unwrap();
        let generations = ["workspace", "provider", "sandbox"]
            .map(|kind| (kind.into(), "a".repeat(32)))
            .into();
        let targets = crate::compile::targets(&document, &generations).unwrap();
        let binding = &targets
            .iter()
            .find(|target| target.kind == "sandbox")
            .unwrap()
            .values;
        assert_eq!(binding["agent_name"], "assistant");
        let command = voice_command(binding, "session", crate::voice::QUESTION, "60").unwrap();
        assert_eq!(command[3], "main");
        assert_eq!(command[7], crate::voice::QUESTION);
    }

    #[tokio::test]
    async fn observed_pi_catalog_supplies_its_declared_default_without_private_model_state() {
        let mut value: serde_json::Value =
            serde_saphyr::from_str(include_str!("../../../../examples/fabric-pi.yaml")).unwrap();
        let inference = &mut value["spec"]["sandboxes"][0]["agent"]["inference"];
        let mut fast = inference["routes"][0].clone();
        fast["name"] = serde_json::json!("fast");
        fast["overrides"]["model"] = serde_json::json!("fast-model");
        inference["routes"]
            .as_array_mut()
            .unwrap()
            .push(fast.clone());
        inference["default"] = serde_json::json!("fast");
        let doc = crate::config::Document::parse(value.to_string().as_bytes()).unwrap();
        let generations = ["workspace", "provider", "sandbox"]
            .map(|key| (key.into(), "a".repeat(32)))
            .into();
        let targets = crate::compile::targets(&doc, &generations).unwrap();
        let mut row = targets
            .iter()
            .find(|row| row.kind == "sandbox")
            .unwrap()
            .values
            .clone();
        row.remove("pi_model_config");
        let client =
            OpenShell::connect(&doc.spec.gateway, std::sync::Arc::new(EnvironmentSecrets)).unwrap();
        let (command, _) = client.configuration_command(&row).unwrap();
        let model: serde_json::Value = serde_json::from_str(&command[5]).unwrap();
        assert_eq!(model, fast["overrides"]);
    }

    #[tokio::test(start_paused = true)]
    async fn readiness_uses_the_full_deadline_without_wall_clock_waiting() {
        let cancel = CancellationToken::new();
        let started = tokio::time::Instant::now();
        let error = readiness_deadline(std::future::pending(), &cancel)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("readiness timed out"));
        assert_eq!(started.elapsed(), Duration::from_secs(120));
        readiness_deadline(
            async {
                tokio::time::sleep(Duration::from_secs(119)).await;
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

    #[test]
    fn terminal_sandbox_reports_known_failure_without_backend_text() {
        for (kind, status, reason, expected) in [
            (
                "Ready",
                "False",
                "ControlSupervisorExited",
                "ControlSupervisorExited",
            ),
            ("Ready", "False", "ContainerExited", "ContainerExited"),
            ("Ready", "False", "secret-sentinel", "unknown"),
            ("Ready", "True", "ControlSupervisorExited", "unknown"),
            ("Other", "False", "ControlSupervisorExited", "unknown"),
        ] {
            let error = startup_phase(proto::SandboxStatus {
                phase: proto::SandboxPhase::Error as i32,
                conditions: vec![proto::SandboxCondition {
                    r#type: kind.into(),
                    status: status.into(),
                    reason: reason.into(),
                    message: "secret-sentinel".into(),
                    ..Default::default()
                }],
                ..Default::default()
            })
            .unwrap_err()
            .to_string();
            assert!(error.contains(&format!("reason {expected}")), "{error}");
            assert!(error.contains("exit code unknown"));
            assert!(error.contains("resources retained"));
            assert!(!error.contains("secret-sentinel"));
        }
    }

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OpenClawResponseError {
    Replaced,
    Unavailable,
    InvalidResponse,
}
