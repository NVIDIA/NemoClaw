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
    if let Some(gateway) = document.spec.gateway.as_local_managed() {
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
    let engine = literal(match &document.spec.gateway {
        crate::config::Gateway::Managed(gateway) => &gateway.engine,
        crate::config::Gateway::External(gateway) => &gateway.engine,
    });
    let managed = document.spec.gateway.as_local_managed().is_some();
    let kubernetes = document.spec.gateway.runtime().provider.is_kubernetes();
    if managed {
        graph["data"]["nemoclaw_engine_capabilities"]["current"] = json!({
            "engine": engine,
            "compute_driver": document.spec.gateway.runtime().provider,
            "lifecycle": { "postcondition": [{
                "condition": "${self.status != \"unavailable\"}",
                "error_message": "The selected engine does not meet gateway prerequisites. Correct the runtime or target configuration."
            }] }
        });
        observations.insert(
            "engine".into(),
            json!("${data.nemoclaw_engine_capabilities.current.observation_json}"),
        );
    }
    let mut sandboxes: Vec<_> = document.spec.sandboxes.iter().collect();
    sandboxes.sort_by(|left, right| left.name.cmp(&right.name));
    for (index, sandbox) in sandboxes.into_iter().enumerate() {
        let requirements =
            crate::fabric_capabilities::FabricRequirements::for_sandbox(document, sandbox)?;
        let name = format!("sandbox_{index}");
        let adapter = requirements.configuration["harness"]["adapter_id"]
            .as_str()
            .expect("resolved adapter");
        let context = literal(&format!(
            "sandbox/{}: adapter/{} compatibility rejected",
            sandbox.name,
            crate::fabric_capabilities::diagnostic_field(adapter)
        ));
        let rejection = format!(
            r#"${{join("; ", concat([{}], [for check in jsondecode(self.observation_json).compatibility.checks : format("%s: %s", check.requirement, check.reason) if check.status == "unsupported"]))}}"#,
            serde_json::to_string(&context).expect("diagnostic context"),
        );

        graph["data"]["nemoclaw_fabric_capabilities"][&name] = json!({
            "engine": if kubernetes { "" } else { &engine },
            "image": literal(&sandbox.image.ref_),
            "requirements_json": literal(&serde_json::to_string(&requirements).expect("Fabric requirements")),
            "lifecycle": { "postcondition": [{
                "condition": "${self.compatibility_status != \"unsupported\"}",
                "error_message": rejection
            }, {
                "condition": "${self.runtime_json != \"\"}",
                "error_message": if kubernetes {
                    format!("sandbox/{}: image runtime metadata is unavailable. Set image.metadata.env to an absolute metadata bundle path and verify that it matches the immutable image digest. Resources retained.", sandbox.name)
                } else {
                    format!("sandbox/{}: image runtime metadata is unavailable. Set spec.gateway.engine to the sandbox image engine, load an image built with its runtime manifest, and use its immutable digest. Resources retained.", sandbox.name)
                }
            }] }
        });
        if kubernetes {
            // Destroy does not need image metadata, so a document without it
            // still compiles. Deployment discovery rejects the empty reference;
            // teardown removes these data sources without reading the image.
            graph["data"]["nemoclaw_fabric_capabilities"][&name]["metadata_env"] = json!(
                sandbox
                    .image
                    .metadata
                    .as_ref()
                    .map_or("", |metadata| metadata.env.as_str())
            );
        }
        if managed {
            graph["data"]["nemoclaw_fabric_capabilities"][&name]["architecture"] = json!(
                "${jsondecode(data.nemoclaw_engine_capabilities.current.observation_json).architecture}"
            );
            graph["data"]["nemoclaw_fabric_capabilities"][&name]["operating_system"] = json!(
                "${jsondecode(data.nemoclaw_engine_capabilities.current.observation_json).operating_system}"
            );
        }
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
