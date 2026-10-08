// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Typed OpenTofu inputs of OpenShell objects and the JSON row fields that carry them.

use nemoclaw_tofu::{Structured, shape::Shape};

fn strings() -> Shape {
    Shape::List(Box::new(Shape::String))
}

/// Typed sandbox policy: authored rules and deployment-managed grants.
fn policy_input() -> Shape {
    let schema = serde_json::to_value(schemars::schema_for!(crate::runtime::PolicyInput))
        .expect("the sandbox policy schema serializes");
    Shape::Object(
        nemoclaw_tofu::shape::fields(&schema, &[]).expect("the sandbox policy maps to OpenTofu"),
    )
}

/// The typed inputs of an object kind.
pub fn structured_inputs(kind: &str) -> Vec<Structured> {
    let input = |attribute, field, shape| Structured {
        attribute,
        field,
        shape,
    };
    match kind {
        "provider_profile" => vec![input("binaries", "binaries_json", strings())],
        "sandbox" => vec![
            input("policy", "policy_json", policy_input()),
            input("provider_names", "provider_names_json", strings()),
        ],
        _ => Vec::new(),
    }
}
