// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Typed OpenTofu inputs of OpenShell objects and the JSON row fields that carry them.

use crate::{object_kind, type_name};
use nemoclaw_tofu::{Export, Reference, Structured, shape::Shape};
use serde_json::Value;

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
        "sandbox" => vec![input("policy", "policy_json", policy_input())],
        _ => Vec::new(),
    }
}

/// The identity an object kind exports as its `ref`.
pub fn export(kind: &str) -> Option<Export> {
    let fields: &[&'static str] = match kind {
        "workspace" => &["name", "owner", "generation", "id"],
        "provider" | "provider_profile" | "sandbox" => {
            &["workspace", "name", "owner", "generation", "id"]
        }
        _ => return None,
    };
    Some(Export {
        kind: type_name(kind),
        fields: fields.to_vec(),
    })
}

/// The inputs of an object kind that take other objects' `ref`s.
pub fn references(kind: &str) -> Vec<Reference> {
    let workspace = Reference {
        attribute: "workspace",
        kind: "openshell_workspace",
        fields: vec![("name", "workspace")],
        list: false,
    };
    match kind {
        "provider_profile" => vec![workspace],
        "provider" => vec![
            workspace,
            Reference {
                attribute: "profile",
                kind: "openshell_provider_profile",
                fields: vec![("name", "profile_name")],
                list: false,
            },
        ],
        "sandbox" => vec![
            workspace,
            Reference {
                attribute: "providers",
                kind: "openshell_provider_registration",
                fields: vec![("name", "provider_names_json")],
                list: true,
            },
        ],
        _ => Vec::new(),
    }
}

/// Rewrite an OpenShell object's OpenTofu values, from state or a plan, into
/// the row fields its `ref` inputs carry, and drop its exported `ref`, so they
/// compare with compiled rows. An omitted reference carries empty fields, as
/// omitted optional inputs do.
pub fn flatten(resource_type: &str, values: &mut Value) {
    let kind = object_kind(resource_type);
    let Some(object) = values.as_object_mut() else {
        return;
    };
    if type_name(kind) != resource_type {
        return;
    }
    object.remove(nemoclaw_tofu::REF);
    for reference in references(kind) {
        let Some(value) = object.remove(reference.attribute) else {
            continue;
        };
        if reference.list {
            let (attribute, field) = reference.fields[0];
            let names: Option<Vec<&str>> = value.as_array().map(|items| {
                items
                    .iter()
                    .filter_map(|item| item[attribute].as_str())
                    .collect()
            });
            let carried = names.map_or_else(String::new, |names| {
                serde_json::to_string(&names).expect("names serialize")
            });
            object.insert(field.into(), Value::String(carried));
            continue;
        }
        for (attribute, field) in reference.fields {
            let carried = value[attribute].as_str().unwrap_or_default();
            object.insert(field.into(), Value::String(carried.into()));
        }
    }
}
