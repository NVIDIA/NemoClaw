// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Hand-written HCL for typed inputs, as an author would write them.

use nemoclaw_tofu::shape::{Fields, Shape};
use serde_json::Value;

fn literal(value: &Value) -> String {
    // HCL accepts JSON literals, except that "${" and "%{" start templates.
    value.to_string().replace("${", "$${").replace("%{", "%%{")
}

fn body(fields: &Fields, value: &Value, indent: usize, out: &mut String) {
    let pad = " ".repeat(indent);
    for (name, field) in fields {
        let Some(item) = value.get(name).filter(|item| !item.is_null()) else {
            continue;
        };
        match &field.shape {
            Shape::Object(fields) => {
                out.push_str(&format!("{pad}{name} {{\n"));
                body(fields, item, indent + 2, out);
                out.push_str(&format!("{pad}}}\n"));
            }
            Shape::ObjectList(fields) => {
                for item in item.as_array().into_iter().flatten() {
                    out.push_str(&format!("{pad}{name} {{\n"));
                    body(fields, item, indent + 2, out);
                    out.push_str(&format!("{pad}}}\n"));
                }
            }
            Shape::ObjectMap(fields) => {
                for (label, item) in item.as_object().into_iter().flatten() {
                    out.push_str(&format!("{pad}{name} {} {{\n", Value::from(label.as_str())));
                    body(fields, item, indent + 2, out);
                    out.push_str(&format!("{pad}}}\n"));
                }
            }
            _ => out.push_str(&format!("{pad}{name} = {}\n", literal(item))),
        }
    }
}

/// HCL for block `name` holding `value`, which uses OpenTofu names.
pub fn block(name: &str, fields: &Fields, value: &Value, indent: usize) -> String {
    let pad = " ".repeat(indent);
    let mut out = format!("{pad}{name} {{\n");
    body(fields, value, indent + 2, &mut out);
    out.push_str(&format!("{pad}}}\n"));
    out
}
