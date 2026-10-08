// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{compile, config::Document};
use serde_json::Value;

pub fn specification(kind: &str) -> Value {
    let document =
        Document::parse(include_bytes!("../../../../examples/spark/vllm.yaml").as_slice()).unwrap();
    let generations = [
        ("managed_gateway".into(), "a".repeat(32)),
        ("inference_service".into(), "b".repeat(32)),
    ]
    .into();
    let target = compile::runtime_targets(&document, &generations)
        .unwrap()
        .into_iter()
        .find(|target| target.kind == kind)
        .unwrap();
    // Gateways and their storage take typed attributes instead of a spec.
    target.values.get("spec").map_or_else(
        || serde_json::json!(target.values),
        |spec| serde_json::from_str(spec).unwrap(),
    )
}

/// A served resource definition with its planning rules, narrowed to the
/// fields a test exercises.
pub fn definition(
    kind: &str,
    fields: &[&'static str],
    mutable: &[&'static str],
) -> nemoclaw_provider::Definition {
    let mut definition = nemoclaw_provider::resource_definition(kind)
        .or_else(|| {
            openshell_provider::definitions()
                .into_iter()
                .find(|definition| definition.kind == kind)
        })
        .unwrap();
    definition.fields = fields.to_vec();
    definition.mutable = mutable.to_vec();
    definition.optional.retain(|field| fields.contains(field));
    definition
        .reset_when_omitted
        .retain(|field| fields.contains(field));
    definition
}
