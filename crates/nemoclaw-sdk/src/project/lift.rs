// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The variables and locals of a written project. The values a team changes,
//! the deployment UID, images, an external gateway's endpoint, and whether the
//! providers may delete, become variables; the gateway connection that every
//! object repeats becomes a local. Each replaces only literal text, so the
//! graph plans the same values with the variables' defaults.

use super::template::{self, Unsupported};
use crate::config::Document;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

/// The providers whose `destroy` setting permits deleting what they own, as
/// the SDK's teardown graph sets it.
pub(crate) const DESTROYING_PROVIDERS: [&str; 4] = ["openshell", "fabric", "vllm", "ollama"];

/// Arguments that OpenTofu reads as references or settings, not values.
const META_ARGUMENTS: [&str; 5] = ["depends_on", "provider", "count", "for_each", "lifecycle"];

/// A variable the written project declares, with the graph's value as its default.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Variable {
    pub name: String,
    pub description: String,
    /// `string` or `bool`.
    pub kind: &'static str,
    pub default: Value,
}

/// What lifting adds beside the graph.
#[derive(Debug, Default)]
pub(crate) struct Lifted {
    pub variables: Vec<Variable>,
    /// Locals by name, as JSON-syntax values.
    pub locals: Map<String, Value>,
}

/// Replace literal values in `graph` with the variables and locals that
/// produce them.
pub(crate) fn lift(document: &Document, graph: &mut Value) -> Result<Lifted, Unsupported> {
    let mut lifted = Lifted::default();
    let uid = document.metadata.uid.clone();
    let workspace = document.workspace();
    let mut whole: BTreeMap<String, String> = BTreeMap::new();
    lifted.variables.push(Variable {
        name: "deployment_uid".into(),
        description: "The deployment's UID. Its workspace, container, and volume names and its objects' owner derive from it, so a new value makes a new deployment.".into(),
        kind: "string",
        default: json!(uid),
    });
    if let crate::config::Gateway::External(gateway) = &document.spec.gateway
        && !gateway.endpoint.is_empty()
    {
        whole.insert(gateway.endpoint.clone(), "gateway_endpoint".into());
        lifted.variables.push(Variable {
            name: "gateway_endpoint".into(),
            description: "The OpenShell gateway's endpoint.".into(),
            kind: "string",
            default: json!(gateway.endpoint),
        });
    }
    for (image, (name, description)) in images(document, graph) {
        whole.insert(image.clone(), name.clone());
        lifted.variables.push(Variable {
            name,
            description,
            kind: "string",
            default: json!(image),
        });
    }
    let mut uses_workspace = false;
    each_value(graph, &mut |value| {
        strings(value, &mut |text| {
            if let Some(variable) = whole.get(text) {
                return Ok(Some(format!("${{var.{variable}}}")));
            }
            let rewritten = template::rewrite_text(text, |literal| {
                let named = template::replace_literal(literal, &workspace, "${local.workspace}");
                template::replace_literal(&named, &uid, "${var.deployment_uid}")
            })?;
            if rewritten.contains("${local.workspace}") {
                uses_workspace = true;
            }
            Ok((rewritten != text).then_some(rewritten))
        })
    })?;
    if uses_workspace {
        lifted.locals.insert(
            "workspace".into(),
            json!("nc-${substr(sha256(var.deployment_uid), 0, 16)}"),
        );
    }
    if let Some(connection) = gateway_connection(graph) {
        lifted.locals.insert("gateway".into(), connection);
    }
    let mut destroys = false;
    for provider in DESTROYING_PROVIDERS {
        for configuration in configurations(&mut graph["provider"][provider]) {
            if configuration.get("destroy").is_none() {
                configuration.insert("destroy".into(), json!("${var.destroy}"));
                destroys = true;
            }
        }
    }
    if destroys {
        lifted.variables.push(Variable {
            name: "destroy".into(),
            description: "Whether the openshell, fabric, vllm, and ollama providers may delete what they own. Set it to true for tofu destroy.".into(),
            kind: "bool",
            default: json!(false),
        });
    }
    Ok(lifted)
}

/// Each pinned image the graph names, with its variable's name and description.
fn images(document: &Document, graph: &Value) -> BTreeMap<String, (String, String)> {
    let mut images: BTreeMap<String, (String, String)> = BTreeMap::new();
    let mut taken: Vec<String> = Vec::new();
    let mut name = |base: &str| {
        let base = identifier(base);
        let mut candidate = base.clone();
        let mut suffix = 2;
        while taken.contains(&candidate) {
            candidate = format!("{base}_{suffix}");
            suffix += 1;
        }
        taken.push(candidate.clone());
        candidate
    };
    let mut sandboxes: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (sandbox, definition) in &document.spec.sandboxes {
        sandboxes
            .entry(definition.image.ref_.as_str())
            .or_default()
            .push(sandbox.as_str());
    }
    let named = |image: &str| graph_names(graph, image);
    for (image, users) in sandboxes {
        if image.is_empty() || !named(image) {
            continue;
        }
        let variable = name(&format!("{}_image", users[0]));
        let description = if users.len() == 1 {
            format!("The agent image of sandbox {}, pinned by digest.", users[0])
        } else {
            format!(
                "The agent image of sandboxes {}, pinned by digest.",
                users.join(", ")
            )
        };
        images.insert(image.into(), (variable, description));
    }
    let services = serde_json::to_value(&document.spec.services).unwrap_or_default();
    for (service, definition) in services.as_object().into_iter().flatten() {
        let Some(image) = definition["image"].as_str() else {
            continue;
        };
        if images.contains_key(image) || !named(image) {
            continue;
        }
        let variable = name(&format!("{service}_image"));
        images.insert(
            image.into(),
            (
                variable,
                format!("The runtime image of service {service}, pinned by digest."),
            ),
        );
    }
    for kind in ["openshell_gateway_storage", "openshell_podman_gateway"] {
        for body in graph["resource"][kind].as_object().into_iter().flatten() {
            if let Some(image) = body.1["image"].as_str()
                && !images.contains_key(image)
                && !image.contains("${")
            {
                let variable = name("gateway_image");
                images.insert(
                    image.into(),
                    (
                        variable,
                        "The OpenShell gateway image, pinned by digest.".into(),
                    ),
                );
            }
        }
    }
    images
}

/// Whether some attribute in `graph` has exactly the value `text`.
fn graph_names(graph: &Value, text: &str) -> bool {
    fn contains(value: &Value, text: &str) -> bool {
        match value {
            Value::String(value) => value == text,
            Value::Array(items) => items.iter().any(|item| contains(item, text)),
            Value::Object(fields) => fields.values().any(|field| contains(field, text)),
            _ => false,
        }
    }
    ["resource", "data"].iter().any(|section| {
        graph[section]
            .as_object()
            .into_iter()
            .flat_map(Map::values)
            .filter_map(Value::as_object)
            .flat_map(Map::values)
            .filter_map(Value::as_object)
            .flat_map(|body| {
                body.iter()
                    .filter(|(key, _)| !META_ARGUMENTS.contains(&key.as_str()))
            })
            .any(|(_, value)| contains(value, text))
    })
}

/// An OpenTofu name from a document name: letters, digits, and underscores.
fn identifier(name: &str) -> String {
    let mut identifier: String = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect();
    if identifier.starts_with(|character: char| character.is_ascii_digit()) {
        identifier.insert(0, '_');
    }
    identifier
}

/// The gateway connection every object repeats, replaced by `local.gateway`.
fn gateway_connection(graph: &mut Value) -> Option<Value> {
    let mut connection: Option<Value> = None;
    for section in ["resource", "data"] {
        for body in bodies(&graph[section]) {
            if let Some(value) = body.get("gateway").filter(|value| value.is_object()) {
                match &connection {
                    None => connection = Some(value.clone()),
                    Some(existing) if existing == value => {}
                    // Objects on different gateways keep their own connection.
                    Some(_) => return None,
                }
            }
        }
    }
    let connection = connection?;
    for section in ["resource", "data"] {
        for body in bodies_mut(&mut graph[section]) {
            if body.get("gateway") == Some(&connection) {
                body.insert("gateway".into(), json!("${local.gateway}"));
            }
        }
    }
    Some(connection)
}

fn bodies(section: &Value) -> impl Iterator<Item = &Map<String, Value>> {
    section
        .as_object()
        .into_iter()
        .flat_map(Map::values)
        .filter_map(Value::as_object)
        .flat_map(Map::values)
        .filter_map(Value::as_object)
}

fn bodies_mut(section: &mut Value) -> impl Iterator<Item = &mut Map<String, Value>> {
    section
        .as_object_mut()
        .into_iter()
        .flat_map(Map::values_mut)
        .filter_map(Value::as_object_mut)
        .flat_map(Map::values_mut)
        .filter_map(Value::as_object_mut)
}

/// A provider's configurations: one object, or a list of aliased ones.
pub(crate) fn configurations(provider: &mut Value) -> Vec<&mut Map<String, Value>> {
    match provider {
        Value::Object(configuration) => vec![configuration],
        Value::Array(configurations) => configurations
            .iter_mut()
            .filter_map(Value::as_object_mut)
            .collect(),
        _ => Vec::new(),
    }
}

/// Visit every value OpenTofu evaluates as an expression: resource, data,
/// and provider arguments, outputs, and locals.
fn each_value(
    graph: &mut Value,
    visit: &mut impl FnMut(&mut Value) -> Result<(), Unsupported>,
) -> Result<(), Unsupported> {
    for section in ["resource", "data"] {
        for body in bodies_mut(&mut graph[section]) {
            for (key, value) in body.iter_mut() {
                if !META_ARGUMENTS.contains(&key.as_str()) {
                    visit(value)?;
                }
            }
        }
    }
    if let Some(providers) = graph["provider"].as_object_mut() {
        for provider in providers.values_mut() {
            for configuration in configurations(provider) {
                for (key, value) in configuration.iter_mut() {
                    if key != "alias" {
                        visit(value)?;
                    }
                }
            }
        }
    }
    if let Some(outputs) = graph["output"].as_object_mut() {
        for output in outputs.values_mut() {
            if let Some(value) = output.get_mut("value") {
                visit(value)?;
            }
        }
    }
    if let Some(locals) = graph["locals"].as_object_mut() {
        for value in locals.values_mut() {
            visit(value)?;
        }
    }
    Ok(())
}

/// Rewrite each string in `value`; `rewrite` returns `None` to keep one.
fn strings(
    value: &mut Value,
    rewrite: &mut impl FnMut(&str) -> Result<Option<String>, Unsupported>,
) -> Result<(), Unsupported> {
    match value {
        Value::String(text) => {
            if let Some(rewritten) = rewrite(text)? {
                *text = rewritten;
            }
        }
        Value::Array(items) => {
            for item in items {
                strings(item, rewrite)?;
            }
        }
        Value::Object(fields) => {
            for field in fields.values_mut() {
                strings(field, rewrite)?;
            }
        }
        _ => {}
    }
    Ok(())
}
