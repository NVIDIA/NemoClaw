// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Checked-in snapshots of a provider's schema: its configuration, every
//! resource, data source, and function, with their attributes, types,
//! constraints, and descriptions.
//!
//! A provider's snapshot test renders the compiled schema and compares it with
//! the file. A difference fails with a unified diff; after an intended change,
//! the author regenerates the file with `NEMOCLAW_REGENERATE_FIXTURES=1` and
//! reviews the diff with the change.

use std::{collections::BTreeMap, fmt::Write as _, fs, path::Path};
use tf_provider::{
    Diagnostics, DynamicProvider,
    schema::{
        Attribute, AttributeConstraint, AttributeType, Block, Description, FunctionSchema,
        NestedBlock, Parameter, Schema, StringKind, Type,
    },
};

/// The variable that rewrites snapshots instead of comparing them; the
/// `openshell_contract_fixtures` test uses it too.
pub const REGENERATE: &str = "NEMOCLAW_REGENERATE_FIXTURES";

/// Compares `provider`'s schema with the snapshot at `path`, or rewrites the
/// snapshot when `NEMOCLAW_REGENERATE_FIXTURES` is set.
///
/// `name` is the provider's local name, which prefixes its type names.
/// `command` is the test command a failure tells the author to rerun with
/// `NEMOCLAW_REGENERATE_FIXTURES=1`.
///
/// # Panics
///
/// When the schema differs from the snapshot, the snapshot is missing, or the
/// provider reports a diagnostic while returning its schema.
pub fn assert_snapshot(name: &str, provider: &impl DynamicProvider, path: &Path, command: &str) {
    let rendered = render(name, provider, command);
    check(
        path,
        &rendered,
        command,
        std::env::var_os(REGENERATE).is_some(),
    );
}

/// Writes `rendered` to `path` when `regenerate` is set; otherwise panics
/// with a unified diff from the file at `path` to `rendered`.
///
/// # Panics
///
/// When the file differs from `rendered` and `regenerate` is not set, or the
/// file cannot be written.
pub fn check(path: &Path, rendered: &str, command: &str, regenerate: bool) {
    if regenerate {
        fs::write(path, rendered).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        return;
    }
    // Git may check the file out with CRLF line endings on Windows.
    let expected = fs::read_to_string(path)
        .map(|text| text.replace("\r\n", "\n"))
        .unwrap_or_default();
    if expected == rendered {
        return;
    }
    // Name the snapshot relative to the repository when it is inside it.
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .unwrap();
    let shown = path
        .strip_prefix(workspace)
        .unwrap_or(path)
        .display()
        .to_string();
    let diff = diff(&expected, rendered, &shown);
    panic!(
        "{shown} does not match the provider's schema.\n\
         If the change is intended, regenerate the snapshot and commit it with the change:\n\
         \n    {REGENERATE}=1 {command}\n\n{diff}"
    );
}

/// A unified diff from `expected` to `rendered`. Like Git naming a function,
/// each hunk header names the provider type the hunk starts in.
fn diff(expected: &str, rendered: &str, shown: &str) -> String {
    let lines: Vec<&str> = rendered.lines().collect();
    let mut text = format!("--- {shown}\n+++ compiled provider\n");
    let diff = similar::TextDiff::from_lines(expected, rendered);
    for hunk in diff.unified_diff().context_radius(3).iter_hunks() {
        let start = hunk
            .ops()
            .first()
            .map_or(0, |op| op.new_range().start)
            .min(lines.len());
        let heading = lines[..start]
            .iter()
            .rev()
            .find(|line| !line.is_empty() && !line.starts_with([' ', '#']))
            .unwrap_or(&"");
        let body = hunk.to_string();
        let changes = body.split_once('\n').map_or("", |(_, changes)| changes);
        let _ = write!(text, "{} {heading}\n{changes}", hunk.header());
    }
    text
}

/// The snapshot text for `provider`, served under the local name `name`.
///
/// # Panics
///
/// When the provider reports a diagnostic or returns no schema.
#[must_use]
pub fn render(name: &str, provider: &impl DynamicProvider, command: &str) -> String {
    let mut diagnostics = Diagnostics::default();
    let mut out = format!(
        "# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.\n\
         # SPDX-License-Identifier: Apache-2.0\n\
         # The {name} provider's schema, rendered by nemoclaw-test-fixtures.\n\
         # Regenerate it after an intended change:\n\
         #   {REGENERATE}=1 {command}\n\
         # Lines starting with > quote descriptions; tf-provider's placeholder\n\
         # description `empty` is omitted. Blocks are version 1 unless shown.\n"
    );
    let schema = provider.schema(&mut diagnostics).expect("provider schema");
    write_schema(&mut out, &format!("provider {name}"), &schema);
    let meta = provider
        .meta_schema(&mut diagnostics)
        .expect("provider meta schema");
    if !meta.block.attributes.is_empty() || !meta.block.blocks.is_empty() {
        write_schema(&mut out, &format!("provider_meta {name}"), &meta);
    }
    let resources = provider
        .get_resources(&mut diagnostics)
        .expect("provider resources");
    for (kind, resource) in sorted(&resources) {
        let schema = resource.schema(&mut diagnostics).expect(kind);
        write_schema(&mut out, &format!("resource {name}_{kind}"), &schema);
    }
    let sources = provider
        .get_data_sources(&mut diagnostics)
        .expect("provider data sources");
    for (kind, source) in sorted(&sources) {
        let schema = source.schema(&mut diagnostics).expect(kind);
        write_schema(&mut out, &format!("data {name}_{kind}"), &schema);
    }
    let functions = provider
        .get_functions(&mut diagnostics)
        .expect("provider functions");
    for (function, implementation) in sorted(&functions) {
        let schema = implementation.schema(&mut diagnostics).expect(function);
        write_function(&mut out, function, &schema);
    }
    assert!(
        diagnostics.errors.is_empty() && diagnostics.warnings.is_empty(),
        "{diagnostics:?}"
    );
    out
}

fn sorted<V>(map: &std::collections::HashMap<String, V>) -> BTreeMap<&str, &V> {
    map.iter()
        .map(|(key, value)| (key.as_str(), value))
        .collect()
}

fn write_schema(out: &mut String, title: &str, schema: &Schema) {
    let _ = writeln!(out, "\n{title} (version {})", schema.version);
    write_block(out, 1, &schema.block);
}

fn write_block(out: &mut String, depth: usize, block: &Block) {
    if block.version != 1 {
        let _ = writeln!(out, "{}block version {}", indent(depth), block.version);
    }
    if block.deprecated {
        let _ = writeln!(out, "{}deprecated", indent(depth));
    }
    write_description(out, depth, &block.description);
    write_attributes(out, depth, &block.attributes);
    for (name, nested) in sorted(&block.blocks) {
        let (mode, inner) = match nested {
            NestedBlock::Single(inner) => ("single", inner),
            NestedBlock::List(inner) => ("list", inner),
            NestedBlock::Set(inner) => ("set", inner),
            NestedBlock::Map(inner) => ("map", inner),
            NestedBlock::Group(inner) => ("group", inner),
            NestedBlock::Optional(inner) => ("optional", inner),
        };
        let _ = writeln!(out, "{}block {name}: {mode}", indent(depth));
        write_block(out, depth + 1, inner);
    }
}

fn write_attributes(
    out: &mut String,
    depth: usize,
    attributes: &std::collections::HashMap<String, Attribute>,
) {
    for (name, attribute) in sorted(attributes) {
        let constraint = match attribute.constraint {
            AttributeConstraint::Computed => "computed",
            AttributeConstraint::Optional => "optional",
            AttributeConstraint::OptionalComputed => "optional, computed",
            AttributeConstraint::Required => "required",
        };
        let mut line = format!(
            "{}{name}: {}, {constraint}",
            indent(depth),
            attribute_type(&attribute.attr_type)
        );
        if attribute.sensitive {
            line.push_str(", sensitive");
        }
        if attribute.deprecated {
            line.push_str(", deprecated");
        }
        let _ = writeln!(out, "{line}");
        write_description(out, depth + 1, &attribute.description);
        if let Some(nested) = nested_attributes(&attribute.attr_type) {
            write_attributes(out, depth + 1, nested);
        }
    }
}

fn write_function(out: &mut String, name: &str, schema: &FunctionSchema) {
    let _ = writeln!(
        out,
        "\nfunction {name}: {}",
        value_type(&schema.return_type)
    );
    let depth = 1;
    if let Some(reason) = &schema.deprecated {
        let _ = writeln!(out, "{}deprecated: {reason}", indent(depth));
    }
    if !schema.summary.is_empty() {
        let _ = writeln!(out, "{}summary: {}", indent(depth), schema.summary);
    }
    write_description(out, depth, &schema.description);
    let parameters = schema
        .parameters
        .iter()
        .map(|parameter| ("parameter", parameter));
    for (role, parameter) in parameters.chain(schema.variadic.iter().map(|p| ("variadic", p))) {
        write_parameter(out, depth, role, parameter);
    }
}

fn write_parameter(out: &mut String, depth: usize, role: &str, parameter: &Parameter) {
    let mut line = format!(
        "{}{role} {}: {}",
        indent(depth),
        parameter.name,
        value_type(&parameter.param_type)
    );
    if parameter.allow_null {
        line.push_str(", allows null");
    }
    if parameter.allow_unknown {
        line.push_str(", allows unknown");
    }
    let _ = writeln!(out, "{line}");
    write_description(out, depth + 1, &parameter.description);
}

/// Each description line is quoted with `> `, or `md> ` for Markdown, so a
/// changed word shows as a changed line. tf-provider's default description,
/// `empty`, is omitted like an empty one.
fn write_description(out: &mut String, depth: usize, description: &Description) {
    if description.content == "empty" {
        return;
    }
    let marker = match description.kind {
        StringKind::Plain => ">",
        StringKind::Markdown => "md>",
    };
    for line in description.content.lines() {
        let line = format!("{marker} {line}");
        let _ = writeln!(out, "{}{}", indent(depth), line.trim_end());
    }
}

fn indent(depth: usize) -> String {
    "  ".repeat(depth)
}

fn nested_attributes(
    attribute: &AttributeType,
) -> Option<&std::collections::HashMap<String, Attribute>> {
    match attribute {
        AttributeType::AttributeSingle(nested)
        | AttributeType::AttributeList(nested)
        | AttributeType::AttributeSet(nested)
        | AttributeType::AttributeMap(nested) => Some(nested),
        _ => None,
    }
}

/// An attribute type in OpenTofu's type constraint syntax; nested attributes
/// are listed beneath the attribute instead.
fn attribute_type(attribute: &AttributeType) -> String {
    match attribute {
        AttributeType::String => "string".into(),
        AttributeType::Number => "number".into(),
        AttributeType::Bool => "bool".into(),
        AttributeType::Any => "any".into(),
        AttributeType::List(item) => format!("list({})", attribute_type(item)),
        AttributeType::Set(item) => format!("set({})", attribute_type(item)),
        AttributeType::Map(item) => format!("map({})", attribute_type(item)),
        AttributeType::Object(fields) => {
            let fields: Vec<_> = sorted(fields)
                .into_iter()
                .map(|(name, field)| format!("{name} = {}", attribute_type(field)))
                .collect();
            format!("object({{ {} }})", fields.join(", "))
        }
        AttributeType::Tuple(items) => {
            let items: Vec<_> = items.iter().map(attribute_type).collect();
            format!("tuple([{}])", items.join(", "))
        }
        AttributeType::AttributeSingle(_) => "nested single".into(),
        AttributeType::AttributeList(_) => "nested list".into(),
        AttributeType::AttributeSet(_) => "nested set".into(),
        AttributeType::AttributeMap(_) => "nested map".into(),
    }
}

fn value_type(value: &Type) -> String {
    match value {
        Type::String => "string".into(),
        Type::Number => "number".into(),
        Type::Bool => "bool".into(),
        Type::Any => "any".into(),
        Type::List(item) => format!("list({})", value_type(item)),
        Type::Set(item) => format!("set({})", value_type(item)),
        Type::Map(item) => format!("map({})", value_type(item)),
        Type::Object(fields) => {
            let fields: Vec<_> = sorted(fields)
                .into_iter()
                .map(|(name, field)| format!("{name} = {}", value_type(field)))
                .collect();
            format!("object({{ {} }})", fields.join(", "))
        }
        Type::Tuple(items) => {
            let items: Vec<_> = items.iter().map(value_type).collect();
            format!("tuple([{}])", items.join(", "))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::check;
    use std::fs;

    const OLD: &str = "resource x\n  e: bool, computed\n  f: bool, computed\n  g: bool, computed\n  h: bool, computed\n  a: string, required\n  b: bool, computed\n";
    const NEW: &str = "resource x\n  e: bool, computed\n  f: bool, computed\n  g: bool, computed\n  h: bool, computed\n  a: string, optional\n  b: bool, computed\n";

    fn failure(snapshot: Option<&str>) -> String {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("schema.txt");
        if let Some(snapshot) = snapshot {
            fs::write(&path, snapshot).unwrap();
        }
        let panic = std::panic::catch_unwind(|| check(&path, NEW, "cargo test -p demo", false))
            .expect_err("a changed schema must fail");
        panic.downcast_ref::<String>().unwrap().clone()
    }

    #[test]
    fn a_changed_schema_fails_with_a_diff_and_the_regenerate_command() {
        let message = failure(Some(OLD));
        assert!(
            message.contains("NEMOCLAW_REGENERATE_FIXTURES=1 cargo test -p demo"),
            "{message}"
        );
        assert!(message.contains("\n-  a: string, required\n"), "{message}");
        assert!(message.contains("\n+  a: string, optional\n"), "{message}");
        assert!(message.contains("\n   b: bool, computed\n"), "{message}");
        assert!(message.contains("@@ resource x\n"), "{message}");
    }

    #[test]
    fn a_missing_snapshot_fails_with_the_regenerate_command() {
        let message = failure(None);
        assert!(
            message.contains("NEMOCLAW_REGENERATE_FIXTURES=1"),
            "{message}"
        );
        assert!(message.contains("\n+  a: string, optional\n"), "{message}");
    }

    #[test]
    fn regenerating_writes_the_schema_and_then_matches_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("schema.txt");
        fs::write(&path, OLD).unwrap();
        check(&path, NEW, "cargo test -p demo", true);
        assert_eq!(fs::read_to_string(&path).unwrap(), NEW);
        check(&path, NEW, "cargo test -p demo", false);
        fs::write(&path, NEW.replace('\n', "\r\n")).unwrap();
        check(&path, NEW, "cargo test -p demo", false);
    }
}
