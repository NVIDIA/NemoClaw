// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The written project's HCL, rendered from a graph in the JSON syntax. The
//! JSON syntax writes a nested block and an object attribute alike, so the
//! providers' schemas decide which each key is. Strings are templates in both
//! syntaxes; references in `depends_on`, `replace_triggered_by`, `provider`,
//! and variable types are strings in JSON and bare expressions in HCL.

use super::{
    lift::{Lifted, Variable},
    template,
};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Provider schemas, as `tofu providers schema -json` reports them.
#[derive(Clone, Debug)]
pub struct Schemas(Value);

impl Schemas {
    pub fn new(schemas: Value) -> Self {
        Self(schemas)
    }
    fn provider(&self, source: &str) -> Option<&Value> {
        self.0["provider_schemas"]
            .get(source)
            .filter(|schema| schema.is_object())
    }
}

/// A source address as the schemas name it: with the default registry's host.
fn qualified(source: &str) -> String {
    match source.split('/').count() {
        2 => format!("registry.opentofu.org/{source}"),
        _ => source.to_owned(),
    }
}

/// What a block of each kind accepts besides its schema's attributes and blocks.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Resource,
    Data,
    Provider,
    Nested,
}

/// The built-in `terraform_data` resource's arguments.
fn terraform_data() -> Value {
    serde_json::json!({"attributes": {"input": {}, "triggers_replace": {}}})
}

/// Where each concern's blocks go. Blocks no concern claims go to `main.tf`.
const GATEWAY: &str = "gateway.tf";
const INFERENCE: &str = "inference.tf";
const SANDBOXES: &str = "sandboxes.tf";
const MAIN: &str = "main.tf";

/// The concern of a block that anchors one, by its type.
fn anchor(section: &str, kind: &str, name: &str) -> Option<&'static str> {
    // The engines that place model servers.
    if section == "data" && kind == "host_engine" && name.starts_with("target_") {
        return Some(INFERENCE);
    }
    let gateway = [
        "openshell_gateway",
        "openshell_gateway_prerequisites",
        "openshell_docker_gateway_runtime",
        "openshell_docker_gateway_readiness",
        "openshell_gateway_storage",
        "openshell_podman_gateway",
        "openshell_workspace",
    ];
    if gateway.contains(&kind)
        || kind.starts_with("openshell_kubernetes_")
        || kind == "helm_release"
    {
        return Some(GATEWAY);
    }
    if kind == "openshell_inference" || kind.starts_with("vllm_") || kind.starts_with("ollama_") {
        return Some(INFERENCE);
    }
    if matches!(
        kind,
        "openshell_sandbox"
            | "openshell_api"
            | "fabric_agent"
            | "fabric_harness"
            | "fabric_harnesses"
    ) || (section == "resource" && kind == "terraform_data")
    {
        return Some(SANDBOXES);
    }
    None
}

/// The written project's files, by name, before formatting.
pub(crate) fn render(
    graph: &Value,
    lifted: &Lifted,
    schemas: &Schemas,
) -> Result<BTreeMap<String, String>, String> {
    let top = graph
        .as_object()
        .ok_or_else(|| "the graph is not an object".to_owned())?;
    for key in top.keys() {
        if !matches!(
            key.as_str(),
            "terraform" | "provider" | "variable" | "locals" | "data" | "resource" | "output"
        ) {
            return Err(format!("the graph's {key} block has no HCL rendering"));
        }
    }
    let sources: BTreeMap<String, String> = graph["terraform"]["required_providers"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(name, requirement)| {
            Some((name.clone(), qualified(requirement["source"].as_str()?)))
        })
        .collect();
    let renderer = Renderer { schemas, sources };
    let mut files: BTreeMap<&'static str, Writer> = BTreeMap::new();

    let versions = files.entry("versions.tf").or_default();
    renderer.terraform(versions, &graph["terraform"])?;
    for (name, configurations) in graph["provider"].as_object().into_iter().flatten() {
        let configurations = match configurations {
            Value::Array(configurations) => configurations.iter().collect(),
            configuration => vec![configuration],
        };
        for configuration in configurations {
            let body = configuration
                .as_object()
                .ok_or_else(|| format!("provider {name} is not an object"))?;
            let schema = renderer.provider_schema(name)?;
            versions.open(&format!("provider {}", template::literal(name)));
            renderer.body(
                versions,
                body,
                &schema,
                Kind::Provider,
                &format!("provider.{name}"),
            )?;
            versions.close();
        }
    }

    let variables = files.entry("variables.tf").or_default();
    for variable in &lifted.variables {
        lifted_variable(variables, variable);
    }
    for (name, variable) in graph["variable"].as_object().into_iter().flatten() {
        renderer.variable(variables, name, variable)?;
    }

    // Blocks, by section, type, and name, with the file each goes to.
    let mut blocks: Vec<(&str, &str, &str, &Map<String, Value>)> = Vec::new();
    for section in ["data", "resource"] {
        for (kind, instances) in graph[section].as_object().into_iter().flatten() {
            for (name, body) in instances.as_object().into_iter().flatten() {
                let body = body
                    .as_object()
                    .ok_or_else(|| format!("{section}.{kind}.{name} is not an object"))?;
                blocks.push((section, kind, name, body));
            }
        }
    }
    let placement = place(&blocks);
    if !lifted.locals.is_empty() {
        let gateway = files.entry(GATEWAY).or_default();
        gateway.open("locals");
        for (name, value) in &lifted.locals {
            renderer.attribute(gateway, name, value)?;
        }
        gateway.close();
    }
    if let Some(locals) = graph["locals"]
        .as_object()
        .filter(|locals| !locals.is_empty())
    {
        let main = files.entry(MAIN).or_default();
        main.open("locals");
        for (name, value) in locals {
            renderer.attribute(main, name, value)?;
        }
        main.close();
    }
    for (index, (section, kind, name, body)) in blocks.iter().enumerate() {
        let writer = files.entry(placement[index]).or_default();
        let header = if *section == "data" {
            "data"
        } else {
            "resource"
        };
        let schema = renderer.block_schema(section, kind, body)?;
        writer.open(&format!(
            "{header} {} {}",
            template::literal(kind),
            template::literal(name)
        ));
        let block_kind = if *section == "data" {
            Kind::Data
        } else {
            Kind::Resource
        };
        renderer.body(
            writer,
            body,
            &schema,
            block_kind,
            &format!("{section}.{kind}.{name}"),
        )?;
        writer.close();
    }
    for (name, output) in graph["output"].as_object().into_iter().flatten() {
        let writer = files.entry("outputs.tf").or_default();
        renderer.output(writer, name, output)?;
    }
    Ok(files
        .into_iter()
        .filter(|(_, writer)| !writer.text.is_empty())
        .map(|(name, writer)| (name.to_owned(), writer.text))
        .collect())
}

/// The file of each block: an anchor's own concern; else the concern of the
/// first anchored or placed block whose expressions reference it; else that
/// of a placed block that depends on it, other than an anchor, or that it
/// references.
fn place(blocks: &[(&str, &str, &str, &Map<String, Value>)]) -> Vec<&'static str> {
    let concerns = [GATEWAY, INFERENCE, SANDBOXES];
    let mut placement: Vec<Option<&'static str>> = blocks
        .iter()
        .map(|(section, kind, name, _)| anchor(section, kind, name))
        .collect();
    let anchored: Vec<bool> = placement.iter().map(Option::is_some).collect();
    let addresses: Vec<String> = blocks
        .iter()
        .map(|(section, kind, name, _)| {
            if *section == "data" {
                format!("data.{kind}.{name}")
            } else {
                format!("{kind}.{name}")
            }
        })
        .collect();
    let expressions: Vec<String> = blocks
        .iter()
        .map(|(_, _, _, body)| {
            body.iter()
                .filter(|(key, _)| !matches!(key.as_str(), "depends_on" | "lifecycle" | "provider"))
                .map(|(_, value)| value.to_string())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect();
    let dependencies: Vec<Vec<&str>> = blocks
        .iter()
        .map(|(_, _, _, body)| {
            body.get("depends_on")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect()
        })
        .collect();
    for weak in [false, true] {
        loop {
            let mut changed = false;
            for index in 0..blocks.len() {
                if placement[index].is_some() {
                    continue;
                }
                let found = concerns.into_iter().find(|concern| {
                    (0..blocks.len()).any(|other| {
                        placement[other] == Some(concern)
                            && (references(&expressions[other], &addresses[index])
                                || (weak
                                    && ((!anchored[other]
                                        && dependencies[other]
                                            .contains(&addresses[index].as_str()))
                                        || references(&expressions[index], &addresses[other]))))
                    })
                });
                if let Some(concern) = found {
                    placement[index] = Some(concern);
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
    }
    placement
        .into_iter()
        .map(|concern| concern.unwrap_or(MAIN))
        .collect()
}

/// Whether `text` names `address` as a whole reference.
fn references(text: &str, address: &str) -> bool {
    text.match_indices(address).any(|(start, _)| {
        let before = text[..start].chars().next_back();
        let after = text[start + address.len()..].chars().next();
        !before.is_some_and(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        }) && !after.is_some_and(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
        })
    })
}

/// HCL text with two-space indentation.
#[derive(Default)]
struct Writer {
    text: String,
    depth: usize,
    /// Where each open block's body starts, to write an empty one as `{}`.
    bodies: Vec<usize>,
}

impl Writer {
    fn line(&mut self, line: &str) {
        for _ in 0..self.depth {
            self.text.push_str("  ");
        }
        self.text.push_str(line);
        self.text.push('\n');
    }
    fn open(&mut self, header: &str) {
        if self.depth == 0 && !self.text.is_empty() {
            self.text.push('\n');
        }
        self.line(&format!("{header} {{"));
        self.depth += 1;
        self.bodies.push(self.text.len());
    }
    fn close(&mut self) {
        self.depth -= 1;
        let body = self.bodies.pop().expect("an open block");
        if body == self.text.len() {
            self.text.truncate(body - 1);
            self.text.push_str("}\n");
        } else {
            self.line("}");
        }
    }
}

fn lifted_variable(writer: &mut Writer, variable: &Variable) {
    writer.open(&format!("variable {}", template::literal(&variable.name)));
    writer.line(&format!(
        "description = {}",
        template::literal(&variable.description)
    ));
    writer.line(&format!("type = {}", variable.kind));
    writer.line(&format!("default = {}", literal_value(&variable.default)));
    writer.close();
}

/// A literal value, such as a variable's default: strings escape template syntax.
fn literal_value(value: &Value) -> String {
    match value {
        Value::String(text) => template::literal(text),
        value => value.to_string(),
    }
}

struct Renderer<'a> {
    schemas: &'a Schemas,
    /// Provider local names and their qualified source addresses.
    sources: BTreeMap<String, String>,
}

impl Renderer<'_> {
    fn provider_schema(&self, name: &str) -> Result<Value, String> {
        let source = self
            .sources
            .get(name)
            .ok_or_else(|| format!("provider {name} has no requirement"))?;
        self.schemas
            .provider(source)
            .map(|schema| schema["provider"]["block"].clone())
            .ok_or_else(|| format!("no schema for provider {source}"))
    }

    fn block_schema(
        &self,
        section: &str,
        kind: &str,
        body: &Map<String, Value>,
    ) -> Result<Value, String> {
        if section == "resource" && kind == "terraform_data" {
            return Ok(terraform_data());
        }
        let local = match body.get("provider").and_then(Value::as_str) {
            Some(reference) => reference.split('.').next().unwrap_or(reference),
            None => kind.split('_').next().unwrap_or(kind),
        };
        let source = self
            .sources
            .get(local)
            .ok_or_else(|| format!("{section}.{kind} has no provider requirement"))?;
        let schemas = if section == "data" {
            "data_source_schemas"
        } else {
            "resource_schemas"
        };
        self.schemas
            .provider(source)
            .and_then(|provider| provider[schemas].get(kind))
            .map(|schema| schema["block"].clone())
            .ok_or_else(|| format!("no schema for {section}.{kind} in provider {source}"))
    }

    fn terraform(&self, writer: &mut Writer, terraform: &Value) -> Result<(), String> {
        let Some(settings) = terraform.as_object() else {
            return Ok(());
        };
        writer.open("terraform");
        for (key, value) in settings {
            match key.as_str() {
                "required_version" => self.attribute(writer, key, value)?,
                "required_providers" => {
                    writer.open("required_providers");
                    for (name, requirement) in value.as_object().into_iter().flatten() {
                        self.attribute(writer, name, requirement)?;
                    }
                    writer.close();
                }
                key => return Err(format!("the terraform block's {key} has no HCL rendering")),
            }
        }
        writer.close();
        Ok(())
    }

    fn variable(&self, writer: &mut Writer, name: &str, variable: &Value) -> Result<(), String> {
        writer.open(&format!("variable {}", template::literal(name)));
        for (key, value) in variable.as_object().into_iter().flatten() {
            match (key.as_str(), value) {
                ("type", Value::String(kind)) => writer.line(&format!("type = {kind}")),
                ("description", Value::String(text)) => {
                    writer.line(&format!("description = {}", template::literal(text)));
                }
                ("default", value) => writer.line(&format!("default = {}", literal_value(value))),
                ("sensitive" | "nullable" | "ephemeral", Value::Bool(flag)) => {
                    writer.line(&format!("{key} = {flag}"));
                }
                (key, _) => {
                    return Err(format!("variable {name}'s {key} has no HCL rendering"));
                }
            }
        }
        writer.close();
        Ok(())
    }

    fn output(&self, writer: &mut Writer, name: &str, output: &Value) -> Result<(), String> {
        writer.open(&format!("output {}", template::literal(name)));
        for (key, value) in output.as_object().into_iter().flatten() {
            match (key.as_str(), value) {
                ("value", value) => self.attribute(writer, key, value)?,
                ("description", Value::String(text)) => {
                    writer.line(&format!("description = {}", template::literal(text)));
                }
                ("sensitive" | "ephemeral", Value::Bool(flag)) => {
                    writer.line(&format!("{key} = {flag}"));
                }
                ("depends_on", references) => {
                    writer.line(&format!(
                        "depends_on = {}",
                        traversals(references, "output", writer.depth)?
                    ));
                }
                (key, _) => return Err(format!("output {name}'s {key} has no HCL rendering")),
            }
        }
        writer.close();
        Ok(())
    }

    /// A block's body: meta-arguments, attributes, nested blocks, `lifecycle`,
    /// and `depends_on`, in that order.
    fn body(
        &self,
        writer: &mut Writer,
        body: &Map<String, Value>,
        schema: &Value,
        kind: Kind,
        path: &str,
    ) -> Result<(), String> {
        let attributes = schema["attributes"].as_object();
        let blocks = schema["block_types"].as_object();
        let is_attribute =
            |key: &str| attributes.is_some_and(|attributes| attributes.contains_key(key));
        let block_type = |key: &str| blocks.and_then(|blocks| blocks.get(key));
        let meta = matches!(kind, Kind::Resource | Kind::Data);
        for key in body.keys() {
            let known = is_attribute(key)
                || block_type(key).is_some()
                || (meta
                    && matches!(
                        key.as_str(),
                        "count" | "for_each" | "provider" | "depends_on" | "lifecycle"
                    ))
                || (kind == Kind::Provider && key == "alias");
            if !known {
                return Err(format!(
                    "{path}.{key} is neither an argument nor a block in the provider's schema"
                ));
            }
        }
        if meta {
            for key in ["count", "for_each"] {
                if let Some(value) = body.get(key) {
                    self.attribute(writer, key, value)?;
                }
            }
            if let Some(provider) = body.get("provider") {
                let reference = provider
                    .as_str()
                    .filter(|reference| traversal(reference))
                    .ok_or_else(|| format!("{path}.provider is not a provider reference"))?;
                writer.line(&format!("provider = {reference}"));
            }
        }
        if kind == Kind::Provider
            && let Some(alias) = body.get("alias")
        {
            let alias = alias
                .as_str()
                .ok_or_else(|| format!("{path}.alias is not a string"))?;
            writer.line(&format!("alias = {}", template::literal(alias)));
        }
        for (key, value) in body {
            if is_attribute(key) && !value.is_null() {
                self.attribute(writer, key, value)?;
            }
        }
        for (key, value) in body {
            if let Some(block) = block_type(key)
                && !is_attribute(key)
            {
                self.nested(writer, key, value, block, &format!("{path}.{key}"))?;
            }
        }
        if meta {
            if let Some(lifecycle) = body.get("lifecycle") {
                self.lifecycle(writer, lifecycle, &format!("{path}.lifecycle"))?;
            }
            if let Some(references) = body.get("depends_on") {
                writer.line(&format!(
                    "depends_on = {}",
                    traversals(references, path, writer.depth)?
                ));
            }
        }
        Ok(())
    }

    /// The blocks of one nested block type, by its nesting mode.
    fn nested(
        &self,
        writer: &mut Writer,
        name: &str,
        value: &Value,
        block: &Value,
        path: &str,
    ) -> Result<(), String> {
        let schema = &block["block"];
        let mode = block["nesting_mode"].as_str().unwrap_or("single");
        let mut write = |label: Option<&str>, body: &Value| -> Result<(), String> {
            let body = body
                .as_object()
                .ok_or_else(|| format!("{path} is not a block body"))?;
            match label {
                Some(label) => writer.open(&format!("{name} {}", template::literal(label))),
                None => writer.open(name),
            }
            self.body(writer, body, schema, Kind::Nested, path)?;
            writer.close();
            Ok(())
        };
        match (mode, value) {
            (_, Value::Null) => Ok(()),
            ("map", Value::Object(labelled)) => {
                for (label, bodies) in labelled {
                    match bodies {
                        Value::Array(bodies) => {
                            for body in bodies {
                                write(Some(label), body)?;
                            }
                        }
                        body => write(Some(label), body)?,
                    }
                }
                Ok(())
            }
            ("map", _) => Err(format!("{path} is not a map of blocks")),
            (_, Value::Array(bodies)) => {
                for body in bodies {
                    write(None, body)?;
                }
                Ok(())
            }
            (_, body @ Value::Object(_)) => write(None, body),
            _ => Err(format!("{path} is not a block")),
        }
    }

    fn lifecycle(&self, writer: &mut Writer, lifecycle: &Value, path: &str) -> Result<(), String> {
        let settings = lifecycle
            .as_object()
            .ok_or_else(|| format!("{path} is not an object"))?;
        writer.open("lifecycle");
        let order = [
            "create_before_destroy",
            "prevent_destroy",
            "ignore_changes",
            "replace_triggered_by",
            "precondition",
            "postcondition",
        ];
        let mut keys: Vec<&String> = settings.keys().collect();
        keys.sort_by_key(|key| {
            order
                .iter()
                .position(|known| known == key)
                .unwrap_or(order.len())
        });
        for key in keys {
            let value = &settings[key];
            match key.as_str() {
                "create_before_destroy" | "prevent_destroy" => {
                    let flag = value
                        .as_bool()
                        .ok_or_else(|| format!("{path}.{key} is not a literal bool"))?;
                    writer.line(&format!("{key} = {flag}"));
                }
                "ignore_changes" if value.as_str() == Some("all") => {
                    writer.line("ignore_changes = all");
                }
                "ignore_changes" | "replace_triggered_by" => {
                    writer.line(&format!(
                        "{key} = {}",
                        traversals(value, path, writer.depth)?
                    ));
                }
                "precondition" | "postcondition" => {
                    let checks = match value {
                        Value::Array(checks) => checks.iter().collect(),
                        check => vec![check],
                    };
                    for check in checks {
                        writer.open(key);
                        for (argument, expression) in check.as_object().into_iter().flatten() {
                            if !matches!(argument.as_str(), "condition" | "error_message") {
                                return Err(format!(
                                    "{path}.{key}.{argument} has no HCL rendering"
                                ));
                            }
                            self.attribute(writer, argument, expression)?;
                        }
                        writer.close();
                    }
                }
                key => return Err(format!("{path}.{key} has no HCL rendering")),
            }
        }
        writer.close();
        Ok(())
    }

    fn attribute(&self, writer: &mut Writer, name: &str, value: &Value) -> Result<(), String> {
        let expression =
            expression(value, writer.depth).map_err(|reason| format!("{name}: {reason}"))?;
        writer.line(&format!("{} = {expression}", key(name)?));
        Ok(())
    }
}

/// A JSON-syntax value as a native expression, at `depth` levels of indentation.
fn expression(value: &Value, depth: usize) -> Result<String, String> {
    Ok(match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => match template::interpolation_only(text) {
            Some(expression) => expression.to_owned(),
            None => template::quoted(text).map_err(|reason| reason.0.to_owned())?,
        },
        Value::Array(items) if items.is_empty() => "[]".into(),
        Value::Array(items) => {
            let rendered = items
                .iter()
                .map(|item| expression(item, depth + 1))
                .collect::<Result<Vec<_>, _>>()?;
            let inline = format!("[{}]", rendered.join(", "));
            if items
                .iter()
                .all(|item| !item.is_array() && !item.is_object())
                && inline.len() <= 80
            {
                inline
            } else {
                let indent = "  ".repeat(depth + 1);
                let mut text = String::from("[\n");
                for item in rendered {
                    text.push_str(&format!("{indent}{item},\n"));
                }
                text.push_str(&"  ".repeat(depth));
                text.push(']');
                text
            }
        }
        Value::Object(fields) if fields.is_empty() => "{}".into(),
        Value::Object(fields) => {
            let indent = "  ".repeat(depth + 1);
            let mut text = String::from("{\n");
            for (name, field) in fields {
                text.push_str(&format!(
                    "{indent}{} = {}\n",
                    key(name)?,
                    expression(field, depth + 1)?
                ));
            }
            text.push_str(&"  ".repeat(depth));
            text.push('}');
            text
        }
    })
}

/// An object key or argument name: bare when it's an identifier, else quoted.
/// Keys are templates in both syntaxes.
fn key(name: &str) -> Result<String, String> {
    let identifier = name
        .chars()
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
        && !matches!(name, "true" | "false" | "null");
    if identifier {
        Ok(name.to_owned())
    } else {
        template::quoted(name).map_err(|reason| reason.0.to_owned())
    }
}

/// Whether `reference` is a static reference such as `data.kind.name.attr`.
fn traversal(reference: &str) -> bool {
    !reference.is_empty()
        && reference.split('.').all(|step| {
            let name = step.split('[').next().unwrap_or(step);
            name.chars()
                .next()
                .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
                && name.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
                })
                && step[name.len()..]
                    .chars()
                    .all(|character| character.is_ascii_digit() || matches!(character, '[' | ']'))
        })
}

/// A list of static references, one per line, for a line at `depth`.
fn traversals(references: &Value, path: &str, depth: usize) -> Result<String, String> {
    let references = references
        .as_array()
        .ok_or_else(|| format!("{path}: references are not a list"))?;
    let indent = "  ".repeat(depth + 1);
    let mut text = String::from("[\n");
    for reference in references {
        let reference = reference
            .as_str()
            .filter(|reference| traversal(reference))
            .ok_or_else(|| format!("{path}: {reference} is not a static reference"))?;
        text.push_str(&format!("{indent}{reference},\n"));
    }
    text.push_str(&"  ".repeat(depth));
    text.push(']');
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schemas() -> Schemas {
        Schemas::new(json!({"provider_schemas": {
            "nvidia.github.io/nemoclaw/openshell": {
                "provider": {"block": {"attributes": {"destroy": {}}}},
                "resource_schemas": {"openshell_sandbox": {"block": {
                    "attributes": {"name": {}, "gateway": {}, "providers": {}},
                    "block_types": {
                        "policy": {"nesting_mode": "list", "block": {"block_types": {
                            "managed": {"nesting_mode": "list", "block": {"attributes": {"name": {}}}},
                            "explicit": {"nesting_mode": "list", "block": {"attributes": {"name": {}}}}
                        }}},
                        "params": {"nesting_mode": "map", "block": {"attributes": {"value": {}}}}
                    }
                }}},
                "data_source_schemas": {"openshell_gateway": {"block": {"attributes": {"endpoint": {}, "compatible": {}}}}}
            }
        }}))
    }

    fn graph() -> Value {
        json!({
            "terraform": {"required_providers": {
                "openshell": {"source": "nvidia.github.io/nemoclaw/openshell", "version": "= 0.1.0"}
            }},
            "provider": {"openshell": {"destroy": "${var.destroy}"}},
            "data": {"openshell_gateway": {"current": {
                "endpoint": "http://127.0.0.1:1",
                "lifecycle": {"postcondition": [{"condition": "${self.compatible}", "error_message": "gateway \"x\" is incompatible"}]}
            }}},
            "resource": {
                "openshell_sandbox": {"agent": {
                    "name": "agent",
                    "gateway": {"endpoint": "http://127.0.0.1:1", "max-file": "3"},
                    "providers": ["${openshell_inference.a.ref}"],
                    "policy": {"explicit": null, "managed": [{"name": "one"}, {"name": "two"}]},
                    "params": {},
                    "depends_on": ["data.openshell_gateway.current"],
                    "lifecycle": {"prevent_destroy": true, "replace_triggered_by": ["terraform_data.agent"]}
                }},
                "terraform_data": {"agent": {"input": "{\"a\":1}"}}
            }
        })
    }

    #[test]
    fn schemas_decide_blocks_and_references_stay_bare() {
        let files = render(&graph(), &Lifted::default(), &schemas()).unwrap();
        assert_eq!(
            files[SANDBOXES],
            r#"resource "openshell_sandbox" "agent" {
  gateway = {
    endpoint = "http://127.0.0.1:1"
    "max-file" = "3"
  }
  name = "agent"
  providers = [openshell_inference.a.ref]
  policy {
    managed {
      name = "one"
    }
    managed {
      name = "two"
    }
  }
  lifecycle {
    prevent_destroy = true
    replace_triggered_by = [
      terraform_data.agent,
    ]
  }
  depends_on = [
    data.openshell_gateway.current,
  ]
}

resource "terraform_data" "agent" {
  input = "{\"a\":1}"
}
"#
        );
        assert!(files[GATEWAY].contains("condition = self.compatible"));
        assert!(files[GATEWAY].contains(r#"error_message = "gateway \"x\" is incompatible""#));
        assert!(
            files["versions.tf"].contains("provider \"openshell\" {\n  destroy = var.destroy\n}")
        );
    }

    #[test]
    fn an_unknown_key_is_refused() {
        let mut graph = graph();
        graph["resource"]["openshell_sandbox"]["agent"]["surprise"] = json!(1);
        let error = render(&graph, &Lifted::default(), &schemas()).unwrap_err();
        assert!(
            error.contains("resource.openshell_sandbox.agent.surprise"),
            "{error}"
        );
    }

    #[test]
    fn unreferenced_support_blocks_go_to_main() {
        let empty = Map::new();
        let blocks = [("data", "host_engine", "current", &empty)];
        assert_eq!(place(&blocks), [MAIN]);
    }

    #[test]
    fn whole_references_only() {
        assert!(references("${docker_image.a.image_id}", "docker_image.a"));
        assert!(!references("${docker_image.ab.image_id}", "docker_image.a"));
        assert!(!references("${data.docker_image.a.id}", "docker_image.a"));
    }
}
