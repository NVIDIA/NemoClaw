// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Deployment-owned projection into the public Fabric configuration contract.
use crate::config::{ConfigError, Document, Sandbox};
use serde_json::{Value, json};

/// Resolve deployment references without interpreting native adapter settings.
/// This exact configuration is planned against the image descriptors and sent to Fabric.
pub fn for_sandbox(document: &Document, sandbox: &Sandbox) -> Result<Value, ConfigError> {
    let harness = document.sandbox_harness(sandbox)?;
    let selection = document.scoped_inference(sandbox)?;
    let mut result = json!({
        "schema_version":"fabric.agent/v1alpha1",
        "metadata":{"name":sandbox.agent.name},
        "harness":{"adapter_id":harness.kind.as_str(),"settings":harness.settings.clone().unwrap_or_default()},
        "runtime":{"artifacts":"/sandbox/artifacts"},
        "environment":{"provider":"local","workspace":"/sandbox/workspace"},
        "models":{}
    });
    if let Some(timeout) = harness
        .execution
        .as_ref()
        .and_then(|execution| execution.timeout_seconds)
    {
        result["runtime"]["timeout_seconds"] = timeout.into();
    }
    if let Some(tools) = &sandbox.agent.tools {
        result["tools"] = json!({"enabled":tools.allow});
    }
    let selected = selection.inference.default_route()?;
    if selection
        .inference
        .routes
        .iter()
        .any(|route| route.name == "default")
        && selected.name != "default"
    {
        return Err(ConfigError::new(
            "model role default conflicts with the selected Fabric default role",
        ));
    }
    for route in &selection.inference.routes {
        let provider = document.route_provider(route, &selection)?;
        let definition = provider.definition;
        let connection = document.provider_connection(definition)?;
        let profile = crate::openshell::inference_profile(
            &provider.key,
            &connection.endpoint,
            definition.provider,
            crate::services::provider_authenticated(document, definition)?,
        )
        .map_err(|_| ConfigError::new("invalid inference transport"))?;
        let mut projected = json!({"provider":definition.provider,"model":route.overrides.model,
            "base_url":connection.endpoint,"api_key_env":profile.credentials.first().map(|credential|credential.name.as_str()).unwrap_or("NEMOCLAW_ANONYMOUS_API_KEY"),
            "api":definition.api.unwrap_or(crate::config::InferenceApi::for_provider(definition.provider)),
            "settings":route.overrides.settings.clone().unwrap_or_default()});
        if let Some(limit) = route.overrides.tuning.max_tokens {
            projected["max_tokens"] = limit.into();
        }
        result["models"][&route.name] = projected.clone();
        if route.name == selected.name {
            result["models"]["default"] = projected;
        }
    }
    if let Some(authored) = &harness.config {
        for reserved in ["models", "harness", "metadata", "schema_version"] {
            if authored.contains_key(reserved) {
                return Err(ConfigError::new(
                    "public Fabric configuration cannot override deployment-owned identities or models",
                ));
            }
        }
        let mut merged = Value::Object(authored.clone());
        merge_owned(&mut merged, result)?;
        result = merged;
    }
    serde_json::from_value::<nemo_fabric_core::FabricConfig>(result.clone())
        .map_err(|_| ConfigError::new("invalid public Fabric configuration"))?;
    Ok(result)
}

fn merge_owned(authored: &mut Value, owned: Value) -> Result<(), ConfigError> {
    match (authored, owned) {
        (Value::Object(authored), Value::Object(owned)) => {
            for (key, value) in owned {
                if let Some(existing) = authored.get_mut(&key) {
                    merge_owned(existing, value)?;
                } else {
                    authored.insert(key, value);
                }
            }
            Ok(())
        }
        (authored, owned) if *authored == owned => Ok(()),
        _ => Err(ConfigError::new(
            "public Fabric configuration conflicts with a deployment-owned field",
        )),
    }
}
