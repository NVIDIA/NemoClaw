// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{OpenShell, SandboxPhase};
use nemoclaw_sdk::{
    CancellationToken, Error, ObservationError, backend::Row, image_runtime::RuntimeBinding,
};
use std::time::Duration;

pub(super) const RUNTIME: &str = "nemoclaw.nvidia.com/runtime-v1";
pub(super) const POLICY: &str = "nemoclaw.nvidia.com/policy-input-v1";

pub(super) fn binding(row: &Row) -> Result<RuntimeBinding, ObservationError> {
    if row.get("agent_runtime").map(String::as_str) != Some("fabric") {
        return Err(ObservationError::BindingMismatch);
    }
    RuntimeBinding::from_json(
        row.get("runtime_json")
            .ok_or(ObservationError::Incomplete)?,
    )
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

fn value<'a>(row: &'a Row, key: &str) -> &'a str {
    row.get(key).map(String::as_str).unwrap_or("")
}

impl OpenShell {
    pub(crate) async fn check_sandbox_phase(&self, binding: &Row) -> Result<(), Error> {
        self.gateway.sandbox_phase(binding, false).await?;
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
