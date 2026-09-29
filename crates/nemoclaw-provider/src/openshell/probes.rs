// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use nemoclaw_sdk::{CancellationToken, Error};
use std::time::Duration;

const AGENT_READINESS_TIMEOUT: Duration = Duration::from_secs(300);

fn configuration_failure(output: &[u8]) -> ObservationError {
    let report: serde_json::Value = serde_json::from_slice(output).unwrap_or_default();
    let error = &report["error"];
    // Keep the bridge's vocabulary bounded again at the provider boundary.
    // Older images and malformed reports retain an explicit unknown state.
    let stage = match error["stage"].as_str() {
        Some("validate") => "validate",
        Some("start") => "start",
        Some("stop") => "stop",
        Some("invoke") => "invoke",
        _ => "unknown",
    };
    let code = match error["code"].as_str() {
        Some("lifecycle_adapter_start_failed") => "lifecycle_adapter_start_failed",
        Some("lifecycle_adapter_stop_failed") => "lifecycle_adapter_stop_failed",
        Some("lifecycle_adapter_invoke_failed") => "lifecycle_adapter_invoke_failed",
        Some("fabric_validate_failed") => "fabric_validate_failed",
        Some("fabric_start_failed") => "fabric_start_failed",
        Some("fabric_stop_failed") => "fabric_stop_failed",
        Some("fabric_invoke_failed") => "fabric_invoke_failed",
        _ => "fabric_configuration_failed",
    };
    let runtime_state = match error["runtime_state"].as_str() {
        Some("running") => "running",
        Some("unavailable") => "unavailable",
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
    pub(crate) async fn check_sandbox_phase(&self, binding: &Row) -> Result<(), Error> {
        self.gateway.sandbox_phase(binding).await?;
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
            self.gateway.exec(binding, command, environment, seconds),
        )
        .await
        .map_err(|_| Error::Conflict("sandbox exec timed out; invocation may have had effects"))?
    }
    fn configuration_command(&self, binding: &Row) -> Result<(Vec<String>, Row), Error> {
        if value(binding, "agent_runtime") != "fabric" {
            return Err(Error::Conflict("unsupported sandbox runtime"));
        }
        let config = value(binding, "config_json");
        serde_json::from_str::<nemo_fabric_core::FabricConfig>(config)
            .map_err(|_| ObservationError::Query)?;
        Ok((
            agent::fabric_command(&["check", value(binding, "agent_name"), config]),
            Row::new(),
        ))
    }
    pub async fn configure_agent(&self, binding: &Row, prepare: bool) -> Result<(), Error> {
        tokio::time::timeout(Duration::from_secs(120), async {
            loop {
                let phase = self.gateway.sandbox_phase(binding).await?;
                if phase == SandboxPhase::Ready {
                    return Ok::<(), Error>(());
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        })
        .await
        .map_err(|_| Error::Conflict("Fabric sandbox startup timed out; resources retained"))??;
        let (mut command, environment) = self.configuration_command(binding)?;
        command[2] = if prepare { "prepare" } else { "configure" }.into();
        let (exit, output) = self.exec_bound(binding, command, environment, 120).await?;
        if exit != 0 {
            return Err(configuration_failure(&output).into());
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
                let phase = self.gateway.sandbox_phase(binding).await?;
                if phase == SandboxPhase::Ready {
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
    pub async fn health(&self, binding: &Row) -> Result<nemoclaw_sdk::RuntimeHealth, Error> {
        self.health_for(binding, None).await
    }

    pub(crate) async fn health_for(
        &self,
        binding: &Row,
        agent: Option<&str>,
    ) -> Result<nemoclaw_sdk::RuntimeHealth, Error> {
        let mut command = agent::fabric_command(&["health"]);
        command.extend(agent.map(String::from));
        let (exit, output) = self.exec_bound(binding, command, Row::new(), 10).await?;
        if exit != 0 {
            return Err(Error::Conflict(
                "Fabric health bridge unavailable; rebuild the agent image; resources retained",
            ));
        }
        nemoclaw_sdk::RuntimeHealth::decode(&output)
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
    #[test]
    fn configuration_diagnostics_preserve_only_known_fields() {
        let failure = super::configuration_failure(br#"{"error":{"stage":"start","code":"lifecycle_adapter_start_failed","runtime_state":"unavailable","message":"private-value"}}"#);
        let text = failure.to_string();
        assert!(text.contains("lifecycle_adapter_start_failed"));
        assert!(text.contains("agent runtime is unavailable"));
        assert!(!text.contains("private-value"));
        for output in [b"".as_slice(), b"private-value", br#"{"error":{"stage":"private-value","code":"private-value","runtime_state":"private-value"}}"#] {
            assert_eq!(super::configuration_failure(output), nemoclaw_sdk::ObservationError::FabricConfiguration {
                stage: "unknown", code: "fabric_configuration_failed", runtime_state: "unknown",
            });
        }
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
}
