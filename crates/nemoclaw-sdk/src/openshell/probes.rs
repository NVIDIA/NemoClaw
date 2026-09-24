// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::{CancellationToken, Error};
use std::time::Duration;

const AGENT_READINESS_TIMEOUT: Duration = Duration::from_secs(300);

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
        result = tokio::time::timeout(AGENT_READINESS_TIMEOUT, wait) =>
            result.map_err(|_| Error::Conflict("agent readiness timed out; resources retained"))?,
    }
}

fn value<'a>(row: &'a Row, key: &str) -> &'a str {
    row.get(key).map(String::as_str).unwrap_or("")
}
impl OpenShell {
    async fn bound_sandbox(&self, binding: &Row) -> Result<proto::Sandbox, Error> {
        let sandbox = self
            .client
            .raw_grpc()
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
            .client
            .raw_grpc()
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
        if value(binding, "agent_runtime") != "fabric" {
            return Err(Error::Conflict("unsupported sandbox runtime"));
        }
        let config = value(binding, "config_json");
        serde_json::from_str::<nemo_fabric_core::FabricConfig>(config)
            .map_err(|_| ObservationError::Query)?;
        Ok((
            vec![
                "/opt/fabric/bin/python".into(),
                "/opt/nemoclaw/fabric.py".into(),
                "check".into(),
                value(binding, "agent_name").into(),
                config.into(),
            ],
            Row::new(),
        ))
    }
    pub async fn configure_agent(&self, binding: &Row, prepare: bool) -> Result<(), Error> {
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
        .map_err(|_| Error::Conflict("Fabric sandbox startup timed out; resources retained"))??;
        let (mut command, environment) = self.configuration_command(binding)?;
        command[2] = if prepare { "prepare" } else { "configure" }.into();
        let (exit, _) = self.exec_bound(binding, command, environment, 120).await?;
        if exit != 0 {
            return Err(Error::Conflict(
                "Fabric configuration failed; resources retained",
            ));
        }
        Ok(())
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

    pub async fn inference_ready(&self, _binding: &Row) -> Result<(), Error> {
        Err(Error::Conflict(
            "Fabric does not expose a model-only inference probe contract; resources retained",
        ))
    }
    pub async fn agent_response(&self, _binding: &Row) -> Result<String, Error> {
        Err(Error::Conflict(
            "Fabric does not expose a normalized text probe contract; resources retained",
        ))
    }
}

#[cfg(test)]
mod tests {
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
            .into_observation()
            .to_string();
            assert!(error.contains(&format!("reason {expected}")), "{error}");
            assert!(error.contains("exit code unknown"));
            assert!(error.contains("resources retained"));
            assert!(!error.contains("secret-sentinel"));
        }
    }
}
