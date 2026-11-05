// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! OpenShell gateway configuration authored in the OpenShell Helm chart's
//! `gatewayConfig` format: each top-level key names a TOML table and holds
//! its fields, nested maps are inline tables, and a top-level list of maps is
//! an array of tables. OpenShell validates the settings; NemoClaw checks only
//! the format and that no setting replaces a key NemoClaw manages.

use serde_json::Value;
use std::collections::BTreeMap;

/// Tables of OpenShell gateway settings, keyed by TOML table name.
pub type GatewayConfig = BTreeMap<String, Value>;

/// Keys NemoClaw sets on a managed Docker or Podman gateway, in every driver.
const LOCAL_KEYS: [&str; 10] = [
    "openshell.version",
    "openshell.gateway.compute_driver",
    "openshell.gateway.disable_tls",
    "openshell.gateway.name",
    "openshell.gateway.bind_address",
    "openshell.gateway.auth.allow_unauthenticated_users",
    "openshell.gateway.gateway_jwt.signing_key_path",
    "openshell.gateway.gateway_jwt.public_key_path",
    "openshell.gateway.gateway_jwt.kid_path",
    "openshell.gateway.gateway_jwt.gateway_id",
];
const DOCKER_DRIVER_KEYS: [&str; 3] =
    ["sandbox_label", "sandbox_runtime_image", "supervisor_image"];
const PODMAN_DRIVER_KEYS: [&str; 5] = [
    "socket_path",
    "network_name",
    "grpc_endpoint",
    "sandbox_runtime_image",
    "supervisor_image",
];
/// Keys NemoClaw sets in the chart's `gatewayConfig`; the chart owns the
/// settings it derives from Kubernetes resources.
const KUBERNETES_KEYS: [&str; 3] = [
    "openshell.gateway.auth.allow_unauthenticated_users",
    "openshell.gateway.oidc",
    "openshell.drivers.kubernetes.image_pull_secrets",
];

/// The table holding OpenShell's OIDC settings. NemoClaw owns it under the
/// development profile, whose issuer it runs; the oidc profile authors it.
pub const OIDC_TABLE: &str = "openshell.gateway.oidc";

/// Keys NemoClaw manages for a gateway with this compute driver;
/// `kubernetes-oidc` is a Kubernetes gateway whose OIDC settings are authored.
fn owned(driver: &str) -> Vec<String> {
    let driver_keys: &[&str] = match driver {
        "docker" => &DOCKER_DRIVER_KEYS,
        "podman" => &PODMAN_DRIVER_KEYS,
        "kubernetes-oidc" => {
            return KUBERNETES_KEYS
                .into_iter()
                .filter(|key| *key != OIDC_TABLE)
                .map(String::from)
                .collect();
        }
        _ => return KUBERNETES_KEYS.map(String::from).to_vec(),
    };
    LOCAL_KEYS
        .iter()
        .map(|key| (*key).to_owned())
        .chain(
            driver_keys
                .iter()
                .map(|key| format!("openshell.drivers.{driver}.{key}")),
        )
        .collect()
}

fn leaves(path: String, value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(fields) if !fields.is_empty() => {
            for (key, value) in fields {
                leaves(format!("{path}.{key}"), value, out);
            }
        }
        _ => out.push(path),
    }
}

fn related(left: &str, right: &str) -> bool {
    left == right
        || left
            .strip_prefix(right)
            .is_some_and(|rest| rest.starts_with('.'))
        || right
            .strip_prefix(left)
            .is_some_and(|rest| rest.starts_with('.'))
}

/// Check the format, and that no authored setting replaces a key NemoClaw
/// manages for a gateway with this compute driver.
///
/// # Errors
/// Returns a message naming the offending table or key.
pub fn check(config: &GatewayConfig, driver: &str) -> Result<(), String> {
    render(toml::Table::new(), config)?;
    let mut paths = Vec::new();
    for (table, fields) in config {
        leaves(table.clone(), fields, &mut paths);
    }
    for key in owned(driver) {
        if let Some(path) = paths.iter().find(|path| related(path, &key)) {
            return Err(format!(
                "spec.gateway.config sets {path}, which conflicts with {key}, a key NemoClaw manages for this gateway; remove it"
            ));
        }
    }
    Ok(())
}

fn toml_value(path: &str, value: &Value) -> Result<Option<toml::Value>, String> {
    Ok(Some(match value {
        Value::Null => return Ok(None),
        Value::Bool(value) => toml::Value::Boolean(*value),
        Value::String(value) => toml::Value::String(value.clone()),
        Value::Number(number) => match (number.as_i64(), number.as_f64()) {
            (Some(value), _) => toml::Value::Integer(value),
            (None, Some(value)) if number.is_f64() => toml::Value::Float(value),
            _ => return Err(format!("spec.gateway.config value {path} is out of range")),
        },
        Value::Array(items) => toml::Value::Array(
            items
                .iter()
                .map(|item| {
                    toml_value(path, item)?.ok_or_else(|| {
                        format!("spec.gateway.config list {path} must not contain null")
                    })
                })
                .collect::<Result<_, _>>()?,
        ),
        Value::Object(fields) => {
            let mut table = toml::Table::new();
            for (key, value) in fields {
                if let Some(value) = toml_value(&format!("{path}.{key}"), value)? {
                    table.insert(key.clone(), value);
                }
            }
            toml::Value::Table(table)
        }
    }))
}

/// Insert `value` at `path`, merging tables and refusing to replace a value.
fn insert(
    table: &mut toml::Table,
    path: &[&str],
    value: toml::Value,
    name: &str,
) -> Result<(), String> {
    let twice = || format!("spec.gateway.config defines {name} more than once");
    let (key, rest) = path.split_first().ok_or_else(twice)?;
    if rest.is_empty() {
        return match (table.get_mut(*key), value) {
            (None, value) => {
                table.insert((*key).to_owned(), value);
                Ok(())
            }
            (Some(toml::Value::Table(existing)), toml::Value::Table(fields)) => {
                for (field, value) in fields {
                    insert(existing, &[&field], value, &format!("{name}.{field}"))?;
                }
                Ok(())
            }
            _ => Err(twice()),
        };
    }
    match table
        .entry((*key).to_owned())
        .or_insert_with(|| toml::Value::Table(toml::Table::new()))
    {
        toml::Value::Table(child) => insert(child, rest, value, name),
        _ => Err(twice()),
    }
}

/// Whether the authored tables define `table`, in either the dotted or the
/// nested form.
pub fn defines(config: &GatewayConfig, table: &str) -> bool {
    let Ok(root) = render(toml::Table::new(), config) else {
        return false;
    };
    let mut value = &toml::Value::Table(root);
    for segment in table.split('.') {
        match value.get(segment) {
            Some(child) => value = child,
            None => return false,
        }
    }
    value.is_table()
}

/// Merge authored tables into a gateway file's owned keys.
///
/// # Errors
/// Returns a message naming a malformed table or a key defined twice.
pub fn render(mut root: toml::Table, config: &GatewayConfig) -> Result<toml::Table, String> {
    for (table, fields) in config {
        let path: Vec<&str> = table.split('.').collect();
        if path.iter().any(|segment| segment.is_empty()) {
            return Err(format!(
                "spec.gateway.config table {table:?} contains an empty key segment"
            ));
        }
        let valid = match fields {
            Value::Object(_) => true,
            Value::Array(items) => items.iter().all(Value::is_object),
            _ => false,
        };
        if !valid {
            return Err(format!(
                "spec.gateway.config table {table} must be a map or a list of maps"
            ));
        }
        // As in the chart, a table is either a field of its parent or a
        // dotted top-level key, not both.
        if let Some(field) = fields
            .as_object()
            .into_iter()
            .flat_map(|fields| fields.keys())
            .find(|field| config.contains_key(&format!("{table}.{field}")))
        {
            return Err(format!(
                "spec.gateway.config defines {table}.{field} both as a nested map and as a top-level table; use only the top-level table"
            ));
        }
        if let Some(value) = toml_value(table, fields)? {
            insert(&mut root, &path, value, table)?;
        }
    }
    Ok(root)
}
