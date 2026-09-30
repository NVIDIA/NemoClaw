// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use nemoclaw_sdk::{CancellationToken, Error};
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
                        "ControlSupervisorStartFailed" => Some("ControlSupervisorStartFailed"),
                        "IdentityResolutionFailed" => Some("IdentityResolutionFailed"),
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

fn configuration_phase(status: proto::SandboxStatus) -> Result<i32, Error> {
    if let Some(admission) = &status.configuration_admission
        && admission.state == proto::ConfigurationAdmissionState::Rejected as i32
    {
        // The pinned gateway replaces runtime parser text with public admission
        // diagnostics. Keep only its fixed vocabulary; never echo unknown text,
        // policy load_error, credentials, or supervisor instance identifiers.
        let reason = match admission.error.as_str() {
            "Effective configuration could not be activated; replace the policy or repair attached providers" => {
                "Effective configuration could not be activated; replace the policy or repair attached providers"
            }
            "Effective provider configuration is invalid; repair credential bindings, attached providers, or their policy layers" => {
                "Effective provider configuration is invalid; repair credential bindings, attached providers, or their policy layers"
            }
            "Effective middleware configuration is invalid; repair the policy middleware bindings or registered services" => {
                "Effective middleware configuration is invalid; repair the policy middleware bindings or registered services"
            }
            "Stored policy structure or safety validation failed; submit a complete valid replacement policy" => {
                "Stored policy structure or safety validation failed; submit a complete valid replacement policy"
            }
            _ => "inspect the sandbox configuration; repair its policy or attached providers",
        };
        return Err(ObservationError::SandboxConfigurationRejected { reason }.into());
    }
    startup_phase(status)
}

fn configuration_failure(stage: &str, code: &str, runtime_state: Option<&str>) -> ObservationError {
    // Only fixed public vocabulary crosses the diagnostic boundary.
    let stage = match stage {
        "validate" => "validate",
        "start" => "start",
        "stop" => "stop",
        "invoke" => "invoke",
        "generation" => "generation",
        "request" => "request",
        "transport" => "transport",
        _ => "unknown",
    };
    let code = match code {
        "pi_model_unknown" => "pi_model_unknown",
        "pi_model_invalid" => "pi_model_invalid",
        "lifecycle_adapter_start_failed" => "lifecycle_adapter_start_failed",
        "lifecycle_adapter_stop_failed" => "lifecycle_adapter_stop_failed",
        "lifecycle_adapter_invoke_failed" => "lifecycle_adapter_invoke_failed",
        "fabric_validate_failed" => "fabric_validate_failed",
        "stale_generation" => "stale_generation",
        "fabric_start_failed" => "fabric_start_failed",
        "fabric_stop_failed" => "fabric_stop_failed",
        "fabric_invoke_failed" => "fabric_invoke_failed",
        _ => "fabric_configuration_failed",
    };
    let runtime_state = match runtime_state {
        Some("running") => "running",
        Some("stopped") => "unavailable",
        _ => "unknown",
    };
    ObservationError::FabricConfiguration {
        stage,
        code,
        runtime_state,
    }
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
        let (observed, _) = sandbox_row(
            proto::SandboxResponse {
                sandbox: Some(sandbox.clone()),
                ..Default::default()
            },
            value(binding, "name"),
            false,
        )?;
        for field in ["runtime_json", "agent_name", "agent_runtime"] {
            if binding.get(field) != observed.get(field) {
                return Err(ObservationError::BindingMismatch.into());
            }
        }
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
        self.exec_input(binding, command, environment, seconds, Vec::new())
            .await
    }
    pub(super) async fn exec_input(
        &self,
        binding: &Row,
        command: Vec<String>,
        environment: Row,
        seconds: u32,
        stdin: Vec<u8>,
    ) -> Result<(i32, Vec<u8>), Error> {
        tokio::time::timeout(
            Duration::from_secs(u64::from(seconds)),
            self.exec_stream(binding, command, environment, seconds, stdin),
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
        stdin: Vec<u8>,
    ) -> Result<(i32, Vec<u8>), Error> {
        // Exec is name-addressed upstream; verify the retained identity immediately
        // before sending and never retry an ambiguous invocation.
        let sandbox = self.bound_sandbox(binding).await?;
        let mut request = self.request(proto::ExecSandboxRequest {
            sandbox: sandbox.metadata.ok_or(ObservationError::Incomplete)?.name,
            workspace_scope: Some(proto::workspace_selector(value(binding, "workspace"))),
            command,
            stdin,
            no_login_shell: true,
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
                    if output.len() + chunk.data.len() > protocol::RESPONSE_LIMIT {
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
    pub async fn configure_agent(&self, binding: &Row, prepare: bool) -> Result<(), Error> {
        let generation = tokio::time::timeout(Duration::from_secs(120), async {
            loop {
                let phase = configuration_phase(
                    self.bound_sandbox(binding)
                        .await?
                        .status
                        .ok_or(ObservationError::Incomplete)?,
                )?;
                if phase == proto::SandboxPhase::Ready as i32
                    && let Some(generation) = self.agent_snapshot(binding).await?.generation
                {
                    return Ok::<_, Error>(generation);
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        })
        .await
        .map_err(|_| Error::Conflict("Fabric sandbox startup timed out; resources retained"))??;
        let config: serde_json::Value = serde_json::from_str(value(binding, "config_json"))
            .map_err(|_| ObservationError::Query)?;
        let operation = if prepare { "prepare" } else { "configure" };
        let response = self
            .bridge_file(binding, operation, &config, Some(&generation))
            .await?;
        if response.status != "succeeded" {
            let failure = response
                .error
                .as_ref()
                .ok_or(ObservationError::Incomplete)?;
            return Err(configuration_failure(
                &failure.stage,
                &failure.code,
                response
                    .result
                    .as_ref()
                    .and_then(|result| result["runtime_state"].as_str()),
            )
            .into());
        }
        let result = response
            .result
            .as_ref()
            .ok_or(ObservationError::Incomplete)?;
        if result["generation"].as_str().is_none_or(str::is_empty)
            || (prepare && (result["prepared"] != true || result["runtime_state"] != "stopped"))
            || (!prepare
                && (result["runtime_state"] != "running"
                    || result["runtime_id"].as_str().is_none_or(str::is_empty)))
        {
            return Err(ObservationError::Incomplete.into());
        }
        Ok(())
    }
    pub async fn configuration(&self, binding: &Row) -> Result<(), Error> {
        let snapshot = self.agent_snapshot(binding).await?;
        let desired: serde_json::Value = serde_json::from_str(value(binding, "config_json"))
            .map_err(|_| ObservationError::Query)?;
        if snapshot.runtime_state != "running" || snapshot.applied_config.as_ref() != Some(&desired)
        {
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
                let phase =
                    configuration_phase(sandbox.status.ok_or(ObservationError::Incomplete)?)?;
                if phase == proto::SandboxPhase::Ready as i32
                    && self.configuration(binding).await.is_ok()
                {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        };
        readiness_deadline(wait, cancel).await
    }

    /// Query the existing hosted Fabric runtime; never invoke an agent or model.
    pub async fn health(&self, binding: &Row) -> Result<nemoclaw_sdk::RuntimeHealth, Error> {
        self.bridge(
            binding,
            &["check", "--agent", value(binding, "agent_name"), "--ready"],
            10,
        )
        .await?
        .health()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn configuration_diagnostics_preserve_only_known_fields() {
        let failure = super::configuration_failure(
            "start",
            "lifecycle_adapter_start_failed",
            Some("stopped"),
        );
        let text = failure.to_string();
        assert!(text.contains("lifecycle_adapter_start_failed"));
        assert!(text.contains("agent runtime is unavailable"));
        assert!(!text.contains("private-value"));
        assert_eq!(
            super::configuration_failure("private-value", "private-value", Some("private-value")),
            nemoclaw_sdk::ObservationError::FabricConfiguration {
                stage: "unknown",
                code: "fabric_configuration_failed",
                runtime_state: "unknown",
            }
        );
    }

    #[test]
    fn pi_model_failure_keeps_the_code_and_named_sandbox_without_native_details() {
        let error = super::configuration_failure("start", "pi_model_unknown", Some("stopped"));
        let message = crate::resource::observation_message(error, Some("coder"));
        for expected in [
            "sandbox/coder",
            "pi_model_unknown",
            "start",
            "resources retained",
        ] {
            assert!(message.contains(expected), "{message}");
        }
        assert!(!message.contains("PRIVATE_SENTINEL"));
    }

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
    fn startup_failures_name_the_sandbox_and_explain_known_reasons_without_backend_text() {
        for (reason, guidance) in [
            (
                "IdentityResolutionFailed",
                "check policy.process.run_as_user and run_as_group",
            ),
            (
                "ControlSupervisorStartFailed",
                "check the sandbox policy and attached providers",
            ),
        ] {
            let failure = startup_phase(proto::SandboxStatus {
                phase: proto::SandboxPhase::Error as i32,
                conditions: vec![proto::SandboxCondition {
                    r#type: "Ready".into(),
                    status: "False".into(),
                    reason: reason.into(),
                    message: "PRIVATE_SENTINEL".into(),
                    ..Default::default()
                }],
                ..Default::default()
            })
            .unwrap_err();
            let direct = failure.to_string();
            let observation = failure.into_observation();
            assert_eq!(direct, observation.to_string());
            let message = crate::resource::observation_message(observation, Some("coder"));
            for expected in ["sandbox/coder", reason, guidance, "resources retained"] {
                assert!(message.contains(expected), "{message}");
            }
            assert!(!message.contains("PRIVATE_SENTINEL"));
        }
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
            (
                "Ready",
                "False",
                "ControlSupervisorStartFailed",
                "ControlSupervisorStartFailed",
            ),
            (
                "Ready",
                "False",
                "IdentityResolutionFailed",
                "IdentityResolutionFailed",
            ),
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
