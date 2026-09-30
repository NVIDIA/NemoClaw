// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_provider::openshell::OpenShell;
use nemoclaw_sdk::backend::Row;
use serde_json::Value;
use std::{fs, path::Path};

pub fn bindings(directory: &Path) -> (Value, Row) {
    let state: Value =
        serde_json::from_slice(&fs::read(directory.join("terraform.tfstate")).unwrap()).unwrap();
    let mut ids = serde_json::Map::new();
    let mut sandbox = None;
    let resources = state["resources"].as_array().unwrap();
    for resource in resources {
        if resource["mode"] == "data" {
            continue;
        }
        let instances = resource["instances"].as_array().unwrap();
        assert_eq!(instances.len(), 1);
        let attributes = &instances[0]["attributes"];
        ids.insert(
            format!(
                "{}.{}",
                resource["type"].as_str().unwrap(),
                resource["name"].as_str().unwrap()
            ),
            attributes["id"].clone(),
        );
        if resource["type"] == "nemoclaw_sandbox" {
            assert!(
                sandbox
                    .replace(serde_json::from_value(attributes.clone()).unwrap())
                    .is_none(),
                "expected one sandbox binding"
            );
        }
    }
    (Value::Object(ids), sandbox.unwrap())
}

pub async fn runtime_id(client: &OpenShell, binding: &Row) -> String {
    let snapshot = client.agent_snapshot(binding).await.unwrap();
    assert_eq!(snapshot.runtime_state, "running");
    let identity = snapshot
        .runtime_id
        .expect("running runtime must have an identity");
    assert!(
        !identity.trim().is_empty(),
        "runtime identity must not be empty"
    );
    identity
}
