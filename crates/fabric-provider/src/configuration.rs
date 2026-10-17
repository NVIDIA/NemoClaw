// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The Fabric agent configuration resource: the one runtime a Fabric sandbox
//! runs, started and stopped through Fabric's `fabric-agent-ctl`.
use crate::bridge::{AgentBridge, value};
use nemoclaw_backend::{Error, Mutation, ObservationError, Row};
use openshell_provider::{OpenShell, verify_identity};
use serde_json::Value;

/// A failed bridge operation as a public diagnostic: only Fabric's fixed
/// stages and codes cross the boundary, never its message.
pub(crate) fn configuration_failure(stage: &str, code: &str, effects: &str) -> ObservationError {
    let stage = match stage {
        "request" => "request",
        "transport" => "transport",
        "validation" => "validation",
        "start" => "start",
        "invoke" => "invoke",
        "stop" => "stop",
        _ => "unknown",
    };
    let code = match code {
        "validation_failed" => "validation_failed",
        "validation_unavailable" => "validation_unavailable",
        "start_failed" => "start_failed",
        "stop_failed" => "stop_failed",
        "invoke_failed" => "invoke_failed",
        "invalid_input" => "invalid_input",
        "invalid_request" => "invalid_request",
        "interface_unsupported" => "interface_unsupported",
        "wrong_agent" => "wrong_agent",
        "platform_unsupported" => "platform_unsupported",
        "cleanup_unconfirmed" => "cleanup_unconfirmed",
        "host_stopping" => "host_stopping",
        "host_unavailable" => "host_unavailable",
        "runtime_unavailable" => "runtime_unavailable",
        "streaming_unsupported" => "streaming_unsupported",
        "request_too_large" => "request_too_large",
        "response_too_large" => "response_too_large",
        "invalid_response" => "invalid_response",
        _ => "fabric_configuration_failed",
    };
    // Fabric reports whether the failure changed anything; with no effects,
    // no runtime is running.
    let runtime_state = match effects {
        "none" => "unavailable",
        _ => "unknown",
    };
    ObservationError::FabricConfiguration {
        stage,
        code,
        runtime_state,
    }
}

/// Check a Fabric configuration document. The error names the rejected field
/// with a safe path, never the value or Fabric's message about it.
pub(crate) fn check(encoded: &str) -> Result<(), String> {
    let value: Value = serde_json::from_str(encoded).map_err(|_| "is not valid JSON".to_owned())?;
    serde_path_to_error::deserialize::<_, nemo_fabric_core::FabricConfig>(value)
        .map(drop)
        .map_err(|error| {
            let path = error.path().to_string();
            let field = nemoclaw_fabric::capabilities::diagnostic_field(&path);
            format!("is not a valid Fabric configuration at {field}")
        })
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
    if value(want, "sandbox_id").is_empty() {
        return Err(ObservationError::BindingMismatch);
    }
    fabric_binding(parent).map(Some)
}

/// A sandbox row with the Fabric agent name and runtime binding its launch
/// metadata records; a sandbox that Fabric did not launch is refused.
pub fn fabric_binding(mut sandbox: Row) -> Result<Row, ObservationError> {
    use nemoclaw_openshell::runtime::{LAUNCH_AGENT, LAUNCH_AGENT_RUNTIME, LAUNCH_RUNTIME, Launch};
    let launch = Launch::from_json(
        sandbox
            .get("launch_json")
            .ok_or(ObservationError::Incomplete)?,
    )?;
    let metadata = |key: &str| {
        launch
            .metadata
            .get(key)
            .filter(|value| !value.is_empty())
            .cloned()
            .ok_or(ObservationError::BindingMismatch)
    };
    if metadata(LAUNCH_AGENT_RUNTIME)? != "fabric" {
        return Err(ObservationError::BindingMismatch);
    }
    sandbox.insert("agent_name".into(), metadata(LAUNCH_AGENT)?);
    sandbox.insert("agent_runtime".into(), "fabric".into());
    sandbox.insert("runtime_json".into(), metadata(LAUNCH_RUNTIME)?);
    Ok(sandbox)
}
pub(crate) async fn plan(client: &OpenShell, want: &Row) -> Result<(), Error> {
    let config = configuration(value(want, "config_json"))?;
    let sandbox = configuration_parent(client, want, false)
        .await?
        .ok_or(ObservationError::BindingMismatch)?;
    // The sandbox launches one agent with one harness; configure only that.
    if config["metadata"]["name"] != value(&sandbox, "agent_name") {
        return Err(Error::Conflict(
            "the agent name must match the agent its sandbox launches",
        ));
    }
    let binding: Value = serde_json::from_str(value(&sandbox, "runtime_json"))
        .map_err(|_| ObservationError::BindingMismatch)?;
    let image = value(want, "harness_image");
    if binding["adapter_id"] != config["harness"]["adapter_id"]
        || (!image.is_empty() && image != value(&sandbox, "image"))
    {
        return Err(Error::Conflict("the sandbox does not launch this harness"));
    }
    Ok(())
}
pub(crate) async fn read(
    client: &OpenShell,
    prior: &Row,
    removing: bool,
) -> Result<Option<Row>, ObservationError> {
    // The agent lives as long as its sandbox. Fabric reports no runtime
    // status (NVIDIA/NeMo-Fabric#420), so a stopped or changed runtime inside
    // the sandbox is found when it is next invoked, not here.
    let Some(parent) = configuration_parent(client, prior, removing).await? else {
        return Ok(None);
    };
    if value(prior, "id") != value(&parent, "id") {
        return Err(ObservationError::BindingMismatch);
    }
    Ok(Some(prior.clone()))
}

pub(crate) async fn ensure(client: &OpenShell, desired: &Row) -> Mutation {
    let result = async {
        let config = configuration(value(desired, "config_json"))?;
        let parent = configuration_parent(client, desired, false)
            .await?
            .ok_or(ObservationError::BindingMismatch)?;
        if !value(desired, "id").is_empty() && value(desired, "id") != parent["id"] {
            return Err(ObservationError::BindingMismatch);
        }
        let runtime_id = client
            .start_agent(&parent, &config)
            .await
            .map_err(Error::into_observation)?;
        let mut row = desired.clone();
        row.insert("id".into(), parent["id"].clone());
        row.insert("runtime_id".into(), runtime_id);
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
    // A sandbox that is already gone took its agent with it.
    let Some(parent) = configuration_parent(client, prior, true).await? else {
        return Ok(());
    };
    if value(prior, "id") != value(&parent, "id") {
        return Err(ObservationError::BindingMismatch);
    }
    // Removing the agent stops its runtime, as removing an attachment does.
    // The sandbox stays, and can never start another runtime.
    let runtime_id = value(prior, "runtime_id");
    if runtime_id.is_empty() {
        return Ok(());
    }
    client
        .stop_agent(&parent, runtime_id)
        .await
        .map_err(Error::into_observation)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    fn valid() -> serde_json::Value {
        json!({
            "schema_version": "fabric.agent/v1alpha1",
            "runtime": {},
            "metadata": {"name": "assistant"},
            "harness": {"adapter_id": "nvidia.fabric.pi"},
        })
    }

    #[test]
    fn rejected_configuration_names_the_field_without_its_value() {
        assert!(super::check(&valid().to_string()).is_ok());
        let mut invalid = valid();
        invalid["harness"]["adapter_id"] = json!(["PRIVATE_SENTINEL"]);
        let message = super::check(&invalid.to_string()).unwrap_err();
        assert!(message.contains("harness.adapter_id"), "{message}");
        assert!(!message.contains("PRIVATE_SENTINEL"), "{message}");
        // Malformed JSON is reported as such, without echoing the input.
        let message = super::check("{\"PRIVATE_SENTINEL\"").unwrap_err();
        assert!(message.contains("JSON"), "{message}");
        assert!(!message.contains("PRIVATE_SENTINEL"), "{message}");
    }

    #[test]
    fn configuration_diagnostics_preserve_only_known_fields() {
        let failure = super::configuration_failure("start", "start_failed", "none");
        let text = failure.to_string();
        assert!(text.contains("start_failed"));
        assert!(text.contains("agent runtime is unavailable"));
        assert!(!text.contains("private-value"));
        assert_eq!(
            super::configuration_failure("private-value", "private-value", "private-value"),
            nemoclaw_backend::ObservationError::FabricConfiguration {
                stage: "unknown",
                code: "fabric_configuration_failed",
                runtime_state: "unknown",
            }
        );
    }

    #[test]
    fn start_failure_keeps_the_code_and_named_sandbox_without_native_details() {
        let error = super::configuration_failure("start", "start_failed", "none");
        let message = nemoclaw_tofu::observation_message(error, Some("coder"));
        for expected in [
            "sandbox/coder",
            "start_failed",
            "start",
            "resources retained",
        ] {
            assert!(message.contains(expected), "{message}");
        }
        assert!(!message.contains("PRIVATE_SENTINEL"));
    }
}
