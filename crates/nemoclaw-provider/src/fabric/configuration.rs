// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The Fabric agent configuration resource: a running runtime's applied
//! configuration in a Fabric sandbox, written through the Fabric bridge.

use crate::fabric::bridge::{AgentBridge, value};
use crate::openshell::{OpenShell, SandboxPhase, verify_identity};
use nemoclaw_backend::{Error, Mutation, ObservationError, Row};
use serde_json::Value;
use std::time::Duration;

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

fn configuration(encoded: &str) -> Result<Value, ObservationError> {
    let value: Value = serde_json::from_str(encoded).map_err(|_| ObservationError::Query)?;
    serde_json::from_value::<nemo_fabric_core::FabricConfig>(value.clone())
        .map_err(|_| ObservationError::Query)?;
    Ok(value)
}

async fn configuration_parent(
    client: &OpenShell,
    want: &Row,
    removing: bool,
) -> Result<Option<Row>, ObservationError> {
    let Some(parent) = client
        .observe(
            "sandbox",
            value(want, "workspace"),
            value(want, "name"),
            removing,
        )
        .await?
    else {
        return if removing {
            Ok(None)
        } else {
            Err(ObservationError::BindingMismatch)
        };
    };
    let mut expected = want.clone();
    expected.insert("id".into(), value(want, "sandbox_id").into());
    verify_identity(&expected, &parent)?;
    if value(&parent, "agent_runtime") != "fabric" || value(want, "sandbox_id").is_empty() {
        return Err(ObservationError::BindingMismatch);
    }
    Ok(Some(parent))
}
pub(crate) async fn plan(client: &OpenShell, want: &Row) -> Result<(), Error> {
    configuration(value(want, "config_json"))?;
    configuration_parent(client, want, false).await?;
    Ok(())
}
pub(crate) async fn read(
    client: &OpenShell,
    prior: &Row,
    removing: bool,
) -> Result<Option<Row>, ObservationError> {
    let Some(parent) = configuration_parent(client, prior, removing).await? else {
        return Ok(None);
    };
    if value(prior, "id") != value(&parent, "id") {
        return Err(ObservationError::BindingMismatch);
    }
    if removing {
        return Ok(Some(prior.clone()));
    }
    let status = client
        .agent_snapshot(&parent)
        .await
        .map_err(Error::into_observation)?;
    let ready = match status.runtime_state.as_str() {
        "running" => true,
        "stopped" => false,
        _ => return Err(ObservationError::Incomplete),
    };
    let config = status.applied_config.unwrap_or(Value::Null);
    let mut row = prior.clone();
    row.insert("running".into(), ready.to_string());
    if config.is_null() && !ready {
        return Ok(Some(row));
    }
    if config["metadata"]["name"] != value(&parent, "agent_name") {
        return Err(ObservationError::BindingMismatch);
    }
    if ready && status.runtime_id.as_deref().is_none_or(str::is_empty) {
        return Err(ObservationError::Incomplete);
    }
    let observed = config.to_string();
    if configuration(value(prior, "config_json"))? != configuration(&observed)? {
        row.insert("config_json".into(), observed.clone());
    }
    Ok(Some(row))
}
pub(crate) async fn ensure(client: &OpenShell, desired: &Row) -> Mutation {
    let result = async {
        configuration(value(desired, "config_json"))?;
        let encoded = value(desired, "config_json").to_owned();
        let mut parent = configuration_parent(client, desired, false)
            .await?
            .ok_or(ObservationError::BindingMismatch)?;
        if !value(desired, "id").is_empty() && value(desired, "id") != parent["id"] {
            return Err(ObservationError::BindingMismatch);
        }
        parent.insert("config_json".into(), encoded);
        configure_agent(client, &parent)
            .await
            .map_err(Error::into_observation)?;
        let mut row = desired.clone();
        row.insert("id".into(), parent["id"].clone());
        row.insert("running".into(), "true".into());
        let observed = read(client, &row, false)
            .await?
            .ok_or(ObservationError::Incomplete)?;
        if configuration(&observed["config_json"])? != configuration(value(desired, "config_json"))?
            || observed["running"] != "true"
        {
            return Err(ObservationError::Incomplete);
        }
        // Preserve the configured JSON spelling after semantic readback.
        Ok(row)
    }
    .await;
    match result {
        Ok(row) => Mutation::complete(row),
        Err(error) => Mutation::failed(error),
    }
}
pub(crate) async fn remove(
    client: &OpenShell,
    prior: &Row,
    _destroying: bool,
) -> Result<(), ObservationError> {
    read(client, prior, true).await?;
    // The sandbox owns this runtime. Forgetting its configuration binding
    // must not mutate or delete a runtime independently of that sandbox.
    Ok(())
}
pub(crate) async fn configure_agent(client: &OpenShell, binding: &Row) -> Result<(), Error> {
    let generation = tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            let phase = client.sandbox_phase(binding, true).await?;
            if phase == SandboxPhase::Ready
                && let Some(generation) = client.agent_snapshot(binding).await?.generation
            {
                return Ok::<_, Error>(generation);
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    })
    .await
    .map_err(|_| Error::Conflict("Fabric sandbox startup timed out; resources retained"))??;
    let config: serde_json::Value =
        serde_json::from_str(value(binding, "config_json")).map_err(|_| ObservationError::Query)?;
    let response = crate::fabric::bridge::bridge_input(
        client,
        binding,
        "configure",
        &config,
        Some(&generation),
    )
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
            nemoclaw_backend::ObservationError::FabricConfiguration {
                stage: "unknown",
                code: "fabric_configuration_failed",
                runtime_state: "unknown",
            }
        );
    }

    #[test]
    fn pi_model_failure_keeps_the_code_and_named_sandbox_without_native_details() {
        let error = super::configuration_failure("start", "pi_model_unknown", Some("stopped"));
        let message = nemoclaw_tofu::observation_message(error, Some("coder"));
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
}
