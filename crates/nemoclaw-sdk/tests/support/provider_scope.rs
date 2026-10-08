// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::compile::Target;

#[allow(dead_code)]
pub fn normalized(rows: Vec<Target>) -> Vec<Target> {
    normalized_as(rows, "local")
}

#[allow(dead_code)]
pub fn normalized_as(rows: Vec<Target>, original: &str) -> Vec<Target> {
    let names: Vec<_> = rows
        .iter()
        .filter(|row| row.kind == "provider")
        .map(|row| row.values["name"].clone())
        .collect();
    let mut text = serde_json::to_string(&rows).unwrap();
    for name in names {
        text = text
            .replace(
                &name.replace('-', "_").to_ascii_uppercase(),
                &original.replace('-', "_").to_ascii_uppercase(),
            )
            .replace(&name, original);
    }
    serde_json::from_str(&text).unwrap()
}

#[allow(dead_code)]
pub fn resource<'a>(instances: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
    let prefix = format!("inference_{name}-");
    let matches: Vec<_> = instances
        .as_object()
        .unwrap()
        .iter()
        .filter(|(key, _)| key.starts_with(&prefix))
        .collect();
    assert_eq!(matches.len(), 1, "expected one registration for {name}");
    matches[0].1
}
#[allow(dead_code)]
pub fn address(instances: &serde_json::Value, kind: &str, name: &str) -> String {
    format!(
        "{}.inference_{}",
        nemoclaw_sdk::compile::resource_type(kind),
        resource(instances, name)["name"]
            .as_str()
            .unwrap()
            .trim_start_matches("nemoclaw-inference-")
    )
}
