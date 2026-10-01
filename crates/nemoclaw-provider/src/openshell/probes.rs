// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use nemoclaw_sdk::{CancellationToken, Error};
use std::time::Duration;

const AGENT_READINESS_TIMEOUT: Duration = Duration::from_secs(300);

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
    pub(crate) async fn check_sandbox_phase(&self, binding: &Row) -> Result<(), Error> {
        self.gateway.sandbox_phase(binding, false).await?;
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
            self.gateway
                .exec(binding, command, environment, seconds, stdin),
        )
        .await
        .map_err(|_| Error::Conflict("sandbox exec timed out; invocation may have had effects"))?
    }
    pub async fn configure_agent(&self, binding: &Row) -> Result<(), Error> {
        let generation = tokio::time::timeout(Duration::from_secs(120), async {
            loop {
                let phase = self.gateway.sandbox_phase(binding, true).await?;
                if phase == SandboxPhase::Ready
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
        let response = self
            .bridge_file(binding, "configure", &config, Some(&generation))
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
            || result["runtime_state"] != "running"
            || result["runtime_id"].as_str().is_none_or(str::is_empty)
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
                let phase = self.gateway.sandbox_phase(binding, true).await?;
                if phase == SandboxPhase::Ready && self.configuration(binding).await.is_ok() {
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
}
