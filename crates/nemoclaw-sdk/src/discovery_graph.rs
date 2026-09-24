// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Discovery reads have no dependency on resource creation or image acquisition.
use crate::config::Document;
use serde_json::{Value, json};

pub(crate) fn populate(graph: &mut Value, document: &Document) {
    let Some(gateway) = document.spec.gateway.as_managed() else {
        return;
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
    let mut observations = serde_json::Map::new();
    observations.insert(
        "engine".into(),
        json!("${data.nemoclaw_engine_capabilities.current.observation_json}"),
    );
    for (index, sandbox) in document.spec.sandboxes.iter().enumerate() {
        let Ok(harness) = document.sandbox_harness(sandbox) else {
            continue;
        };
        let name = format!("sandbox_{index}");
        let selected = serde_json::to_string(harness.kind.as_str()).expect("harness kind");
        graph["data"]["nemoclaw_fabric_capabilities"][&name] = json!({
            "engine": engine,
            "image": literal(&sandbox.image.ref_),
            "lifecycle": { "postcondition": [{
                "condition": format!("${{self.status == \"available\" ? contains([for adapter in jsondecode(self.observation_json).catalog.adapters : adapter.harness], {selected}) : true}}"),
                "error_message": "The selected image's Fabric metadata does not include the configured harness. Choose an image that packages this adapter."
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
}

fn literal(value: &str) -> String {
    value.replace("${", "$${").replace("%{", "%%{")
}

pub(crate) fn is_observation(address: &str) -> bool {
    address == "data.nemoclaw_engine_capabilities.current"
        || address
            .strip_prefix("data.nemoclaw_fabric_capabilities.sandbox_")
            .is_some_and(|name| !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_digit()))
}
