// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Discovery reads have no dependency on resource creation or image acquisition.
use crate::config::Document;
use serde_json::{Value, json};

pub(crate) fn populate(
    graph: &mut Value,
    document: &Document,
) -> Result<(), crate::config::ConfigError> {
    let mut observations = serde_json::Map::new();
    // Reuse the existing strict gateway read rather than probing it twice.
    observations.insert(
        "gateway".into(),
        json!("${data.nemoclaw_gateway_capabilities.current.observation_json}"),
    );
    {
        let requests = crate::inference_discovery::endpoint_requests(document).map_err(|_| {
            crate::config::ConfigError::new("inference discovery inputs are invalid")
        })?;
        for (index, request) in requests.iter().enumerate() {
            let name = format!("endpoint_{index}");
            graph["data"]["nemoclaw_inference_capabilities"][&name] = json!({"endpoint":literal(&request.endpoint),"api":request.api,"credential_env":request.credential_env});
            observations.insert(
                name.clone(),
                json!(format!(
                    "${{data.nemoclaw_inference_capabilities.{name}.observation_json}}"
                )),
            );
        }
    }
    let mut engines = crate::services::discovery_engines(document)?;
    if let Some(gateway) = document.spec.gateway.as_managed() {
        engines.insert(gateway.engine.clone());
    }
    for (index, engine) in engines.iter().enumerate() {
        let name = format!("target_{index}");
        graph["data"]["nemoclaw_target_hardware"][&name] = json!({"engine":literal(engine)});
        observations.insert(
            name.clone(),
            json!(format!(
                "${{data.nemoclaw_target_hardware.{name}.observation_json}}"
            )),
        );
    }
    let Some(gateway) = document.spec.gateway.as_managed() else {
        graph["output"]["discovery"] = json!({"value":observations});
        return Ok(());
    };
    let engine = literal(&gateway.engine);
    graph["data"]["nemoclaw_engine_capabilities"]["current"] = json!({
        "engine": engine,
        "compute_driver": document.spec.sandboxes[0].runtime.provider,
        "lifecycle": { "postcondition": [{
            "condition": "${self.status != \"unavailable\"}",
            "error_message": "The selected engine does not meet gateway prerequisites. Correct the runtime or target configuration."
        }] }
    });
    observations.insert(
        "engine".into(),
        json!("${data.nemoclaw_engine_capabilities.current.observation_json}"),
    );
    let mut sandboxes: Vec<_> = document.spec.sandboxes.iter().collect();
    sandboxes.sort_by(|left, right| left.name.cmp(&right.name));
    for (index, sandbox) in sandboxes.into_iter().enumerate() {
        let requirements =
            crate::fabric_capabilities::FabricRequirements::for_sandbox(document, sandbox)?;
        let name = format!("sandbox_{index}");

        graph["data"]["nemoclaw_fabric_capabilities"][&name] = json!({
            "engine": engine,
            "image": literal(&sandbox.image.ref_),
            "requirements_json": literal(&serde_json::to_string(&requirements).expect("Fabric requirements")),
            "architecture": "${jsondecode(data.nemoclaw_engine_capabilities.current.observation_json).architecture}",
            "operating_system": "${jsondecode(data.nemoclaw_engine_capabilities.current.observation_json).operating_system}",
            "lifecycle": { "postcondition": [{
                "condition": "${self.compatibility_status != \"unsupported\"}",
                "error_message": "The selected image or Fabric adapter contradicts the configured platform, adapter settings, native features, or filesystem grants. Revise the image or configuration."
            }] }
        });
        observations.insert(
            name.clone(),
            json!(format!(
                "${{data.nemoclaw_fabric_capabilities.{name}.observation_json}}"
            )),
        );
    }
    graph["output"]["discovery"] = json!({ "value": observations });
    Ok(())
}

fn literal(value: &str) -> String {
    value.replace("${", "$${").replace("%{", "%%{")
}

pub(crate) fn is_observation(address: &str) -> bool {
    address == "data.nemoclaw_engine_capabilities.current"
        || [
            "data.nemoclaw_fabric_capabilities.sandbox_",
            "data.nemoclaw_target_hardware.target_",
            "data.nemoclaw_inference_capabilities.endpoint_",
        ]
        .iter()
        .any(|prefix| {
            address.strip_prefix(prefix).is_some_and(|name| {
                !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_digit())
            })
        })
}
