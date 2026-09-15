// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write,
};

type Paths = BTreeMap<String, BTreeSet<String>>;

pub fn render_reference(schema: &Value) -> Result<String, String> {
    let mut paths = Paths::new();
    collect_paths(schema, schema, "", &mut paths, &mut BTreeSet::new())?;
    let mut output = String::from(concat!(
        "<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->\n",
        "<!-- SPDX-License-Identifier: Apache-2.0 -->\n\n",
        "# YAML Configuration Reference\n\n",
        "<!-- Generated from the SDK schema. Edit Rust field descriptions and constraints, then run cargo run --locked -p nemoclaw-build -- schema. -->\n\n",
        "This reference and the [JSON Schema](../../schemas/nemoclaw-v1alpha1.schema.json) describe authored YAML for this source revision.\n",
        "See [schema maintenance](../configuration-schema.md) for generation and validation commands.\n\n",
        "Paths use `[]` for an array element and `{key}` for a map entry.\n",
        "Required fields must appear when their containing object is present; conditional requirements are stated in the table or description.\n",
        "An optional object can contain required fields if you choose to declare it.\n",
        "Omit optional fields instead of assigning `null`; only nested values inside a Pi `piModel` object may be null.\n",
        "Defaults describe SDK normalization or backend behavior; JSON Schema validation does not insert values.\n",
        "Empty or zero selects a default only where stated.\n\n",
        "## Validation Beyond the Schema\n\n"
    ));
    for check in schema["x-nemoclaw-parser-checks"]
        .as_array()
        .ok_or("schema lacks parser-check descriptions")?
    {
        writeln!(
            output,
            "- {}",
            check.as_str().ok_or("invalid parser-check description")?
        )
        .unwrap();
    }
    output.push('\n');
    section(
        &mut output,
        "Document",
        schema,
        &["document root".into()].into_iter().collect(),
    )?;
    for (name, definition) in schema["$defs"]
        .as_object()
        .ok_or("schema lacks definitions")?
    {
        section(
            &mut output,
            name,
            definition,
            paths
                .get(name)
                .ok_or_else(|| format!("unreachable schema definition: {name}"))?,
        )?;
    }
    output.truncate(output.trim_end().len());
    output.push('\n');
    Ok(output)
}

fn description<'a>(schema: &'a Value, path: &str) -> Result<&'a str, String> {
    schema["description"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| format!("{path} lacks a public description; add a Rust doc comment"))
}

fn section(
    output: &mut String,
    name: &str,
    schema: &Value,
    paths: &BTreeSet<String>,
) -> Result<(), String> {
    writeln!(output, "## {name}\n").unwrap();
    writeln!(output, "{}\n", description(schema, name)?).unwrap();
    writeln!(output, "Guide: {}.\n", guide(name)).unwrap();
    output.push_str("Paths:\n\n");
    for path in paths {
        writeln!(output, "- `{path}`").unwrap();
    }
    if schema.get("properties").is_none() {
        writeln!(output, "\nAccepted input: {}.\n", input_type(schema)).unwrap();
        return Ok(());
    }
    output.push_str("\n| Field | Input type | Required | Default | Description and constraints |\n|---|---|---|---|---|\n");
    let required = schema["required"].as_array();
    for (field, property) in schema["properties"]
        .as_object()
        .ok_or_else(|| format!("{name} lacks properties"))?
    {
        let mut detail = description(property, &format!("{name}.{field}"))?.to_owned();
        let constraints = constraints(property);
        if !constraints.is_empty() {
            write!(detail, " Constraints: {constraints}.").unwrap();
        }
        if let Some(rule) = property["x-nemoclaw-default-rule"].as_str() {
            write!(detail, " {rule}").unwrap();
        }
        let presence = property["x-nemoclaw-required"].as_str().unwrap_or_else(|| {
            if required.is_some_and(|fields| fields.iter().any(|v| v == field)) {
                "Yes"
            } else {
                "No"
            }
        });
        let default = property
            .get("default")
            .map(|v| format!("`{v}`"))
            .unwrap_or_else(|| "—".into());
        writeln!(
            output,
            "| `{field}` | {} | {} | {} | {} |",
            cell(&input_type(property)),
            cell(presence),
            cell(&default),
            cell(&detail)
        )
        .unwrap();
    }
    output.push('\n');
    Ok(())
}

fn guide(name: &str) -> &'static str {
    match name {
        "Network" | "Proxy" | "ExplicitPolicy" | "ExplicitPolicySelection" => {
            "[Sandbox policy and proxy](../sandbox-network.md)"
        }
        name if name.starts_with("Policy") => "[Sandbox policy and proxy](../sandbox-network.md)",
        "InlineRecipe" | "Compatibility" | "Tool" | "Resources" | "Settings" | "Compilation"
        | "Reuse" | "Manifest" | "File" => "[Inline model recipes](../recipes.md)",
        "ServicePlacement" | "ServicePublication" => "[SSH model service](../remote-service.md)",
        "Service" | "Model" | "Serving" | "Memory" => "[Managed models](../models.md)",
        "Agent" | "Inference" | "Route" | "Overrides" => "[Agent runtimes](../agents.md)",
        _ => "[Configuration and credentials](../usage.md#configuration-and-credentials)",
    }
}

fn input_type(schema: &Value) -> String {
    if let Some(name) = schema["$ref"]
        .as_str()
        .and_then(|reference| reference.strip_prefix("#/$defs/"))
    {
        return format!("[{name}](#{})", name.to_lowercase());
    }
    if schema["type"] == "array" {
        return format!("array of {}", input_type(&schema["items"]));
    }
    if schema["type"] == "object" && schema["additionalProperties"].is_object() {
        return format!("map of {}", input_type(&schema["additionalProperties"]));
    }
    if let Some(kind) = schema["type"].as_str() {
        return kind.into();
    }
    for key in ["anyOf", "oneOf"] {
        if let Some(variants) = schema[key].as_array() {
            return variants
                .iter()
                .map(input_type)
                .collect::<Vec<_>>()
                .join(" or ");
        }
    }
    schema["type"]
        .as_str()
        .unwrap_or("any JSON value")
        .to_owned()
}

fn constraints(schema: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(value) = schema.get("const") {
        parts.push(format!("`{value}`"));
    }
    if let Some(values) = schema["enum"].as_array() {
        parts.push(
            values
                .iter()
                .map(|v| format!("`{v}`"))
                .collect::<Vec<_>>()
                .join(" or "),
        );
    }
    if let Some(pattern) = schema["pattern"].as_str() {
        parts.push(format!("pattern `{pattern}`"));
    }
    for (key, label) in [
        ("minimum", "minimum"),
        ("maximum", "maximum"),
        ("minLength", "minimum characters"),
        ("maxLength", "maximum characters"),
        ("minItems", "minimum items"),
        ("maxItems", "maximum items"),
    ] {
        if let Some(value) = schema.get(key) {
            parts.push(format!("{label} {value}"));
        }
    }
    if let Some(variants) = schema["anyOf"].as_array() {
        parts.push(
            variants
                .iter()
                .map(constraints)
                .collect::<Vec<_>>()
                .join(" or "),
        );
    }
    if let Some(names) = schema.get("propertyNames") {
        parts.push(format!("keys: {}", constraints(names)));
    }
    for (key, label) in [("items", "items"), ("additionalProperties", "values")] {
        if let Some(child) = schema.get(key) {
            let detail = constraints(child);
            if !detail.is_empty() {
                parts.push(format!("{label}: {detail}"));
            }
        }
    }
    parts.join("; ")
}

fn cell(text: &str) -> String {
    text.replace('\n', " ").replace('|', "\\|")
}

fn collect_paths(
    root: &Value,
    schema: &Value,
    path: &str,
    paths: &mut Paths,
    active: &mut BTreeSet<String>,
) -> Result<(), String> {
    if let Some(reference) = schema["$ref"].as_str() {
        let name = reference
            .strip_prefix("#/$defs/")
            .ok_or("reference requires a local definition")?;
        paths.entry(name.into()).or_default().insert(path.into());
        if !active.insert(name.into()) {
            return Err(format!("recursive reference: {name}"));
        }
        collect_paths(
            root,
            root.pointer(&reference[1..])
                .ok_or("missing schema definition")?,
            path,
            paths,
            active,
        )?;
        active.remove(name);
    }
    if let Some(properties) = schema["properties"].as_object() {
        for (field, property) in properties {
            let child = if path.is_empty() {
                field.clone()
            } else {
                format!("{path}.{field}")
            };
            collect_paths(root, property, &child, paths, active)?;
        }
    }
    if let Some(values) = schema.get("additionalProperties").filter(|v| v.is_object()) {
        collect_paths(root, values, &format!("{path}.{{key}}"), paths, active)?;
    }
    for key in ["anyOf", "oneOf"] {
        if let Some(variants) = schema[key].as_array() {
            for variant in variants {
                collect_paths(root, variant, path, paths, active)?;
            }
        }
    }
    if let Some(items) = schema.get("items") {
        collect_paths(root, items, &format!("{path}[]"), paths, active)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reference_documents_map_values_and_matcher_alternatives() {
        let markdown = render_reference(&nemoclaw_sdk::config::schema::input_schema()).unwrap();
        assert!(markdown.contains("network_policies.{key}.endpoints[].rules[].allow"));
        assert!(markdown.contains("## PolicyValueMatcher"));
        assert!(!markdown.contains("any JSON value or any JSON value"));
        assert!(markdown.contains("| `consecutiveSamples` | integer |"));
        assert!(markdown.contains("[PolicyAnyMatcher](#policyanymatcher)"));
    }
    #[test]
    fn reference_requires_field_descriptions_and_reflects_schema_metadata() {
        let mut schema = nemoclaw_sdk::config::schema::input_schema();
        let property = &mut schema["$defs"]["Serving"]["properties"]["port"];
        property["default"] = serde_json::json!(19001);
        property["description"] = serde_json::json!("A changed field description.");
        let markdown = render_reference(&schema).unwrap();
        assert!(markdown.contains("19001"));
        assert!(markdown.contains("A changed field description."));
        schema["$defs"]["Serving"]["properties"]["port"]
            .as_object_mut()
            .unwrap()
            .remove("description");
        assert!(
            render_reference(&schema)
                .unwrap_err()
                .contains("Serving.port lacks a public description")
        );
    }
}
