// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/// Persistence contract shared by graph compilation, operation policy, and
/// provider reconciliation. Ownership must still be verified before mutation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenShellLifecycle {
    /// Workspace identity survives deployment teardown.
    Retained,
    /// Sandboxes, registrations and configuration can be rebuilt from
    /// declared intent. Replacing a sandbox deletes its files and history;
    /// data that must survive belongs on a mounted volume.
    Reconstructible,
}

/// Classify either a backend kind or its full OpenTofu resource type.
pub fn openshell_lifecycle(kind: &str) -> Option<OpenShellLifecycle> {
    match object_kind(kind) {
        "workspace" => Some(OpenShellLifecycle::Retained),
        "sandbox" | "provider" | "provider_profile" | "web_search" | "inference" | "agent" => {
            Some(OpenShellLifecycle::Reconstructible)
        }
        _ => None,
    }
}

/// The `openshell` provider's resource type name, after its prefix, for each object kind.
pub const RESOURCE_TYPES: [(&str, &str); 4] = [
    ("workspace", "workspace"),
    ("web_search", "web_search"),
    ("inference", "inference"),
    ("sandbox", "sandbox"),
];

/// Gateway installation kinds the openshell provider serves, with their type
/// names. They install a gateway rather than reach one, so they take no
/// gateway `ref` and have no `type_name`.
pub const INSTALLATION_TYPES: [(&str, &str); 8] = [
    ("managed_gateway", "podman_gateway"),
    ("gateway_storage", "gateway_storage"),
    ("kubernetes_storage", "kubernetes_storage"),
    ("kubernetes_auth", "kubernetes_auth"),
    ("kubernetes_gateway", "kubernetes_gateway"),
    // Data sources.
    ("gateway_readiness", "docker_gateway_readiness"),
    ("gateway_runtime", "docker_gateway_runtime"),
    ("gateway_prerequisites", "gateway_prerequisites"),
];

/// The OpenTofu resource or data source type of a gateway installation kind.
pub fn installation_type(kind: &str) -> Option<String> {
    INSTALLATION_TYPES
        .iter()
        .find(|(installation, _)| *installation == kind)
        .map(|(_, name)| format!("openshell_{name}"))
}

/// The object kind that a kind or an OpenTofu resource type names.
pub fn object_kind(name: &str) -> &str {
    if let Some(name) = name.strip_prefix("openshell_") {
        return RESOURCE_TYPES
            .iter()
            .chain(&INSTALLATION_TYPES)
            .find(|(_, resource)| *resource == name)
            .map_or(name, |(kind, _)| kind);
    }
    name.strip_prefix("nemoclaw_")
        .or_else(|| name.strip_prefix("fabric_"))
        .unwrap_or(name)
}

/// The OpenTofu resource type for an OpenShell object kind.
pub fn resource_type(kind: &str) -> Option<String> {
    let name = type_name(kind);
    (!name.is_empty()).then(|| name.to_owned())
}

/// The OpenTofu resource type for an OpenShell object kind, or empty for
/// another kind. Refs name their exporting type with it.
pub fn type_name(kind: &str) -> &'static str {
    match kind {
        "workspace" => "openshell_workspace",
        "web_search" => "openshell_web_search",
        "inference" => "openshell_inference",
        "sandbox" => "openshell_sandbox",
        _ => "",
    }
}

/// The type of the `ref` every OpenShell provider registration exports,
/// whatever resource registers it; sandboxes' `providers` take these refs.
pub const PROVIDER_TYPE: &str = "openshell_provider";

/// The type of the `ref` an object kind exports.
pub fn ref_type(kind: &str) -> &'static str {
    match kind {
        "web_search" | "inference" => PROVIDER_TYPE,
        kind => type_name(kind),
    }
}

/// The OpenShell registration name a provider target or row registers.
pub fn registration_name(
    kind: &str,
    values: &std::collections::BTreeMap<String, String>,
) -> Option<String> {
    let value = |field: &str| values.get(field).map(String::as_str).unwrap_or_default();
    match kind {
        "inference" => Some(value("name").to_owned()),
        "web_search" => {
            let provider = crate::search::SearchProvider::from_name(value("provider_type"))?;
            Some(
                crate::search::web_search_names(provider, value("credential_env"), value("name")).1,
            )
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Installation kinds are served by the openshell provider but install a
    /// gateway rather than reach one, so they take no gateway `ref`.
    #[test]
    fn installation_kinds_map_to_openshell_types_without_a_gateway_ref() {
        for (kind, name) in [
            ("managed_gateway", "openshell_podman_gateway"),
            ("gateway_storage", "openshell_gateway_storage"),
            ("kubernetes_storage", "openshell_kubernetes_storage"),
            ("kubernetes_auth", "openshell_kubernetes_auth"),
            ("kubernetes_gateway", "openshell_kubernetes_gateway"),
            ("gateway_readiness", "openshell_docker_gateway_readiness"),
            ("gateway_runtime", "openshell_docker_gateway_runtime"),
            ("gateway_prerequisites", "openshell_gateway_prerequisites"),
        ] {
            assert_eq!(installation_type(kind).as_deref(), Some(name));
            assert_eq!(object_kind(name), kind);
            assert_eq!(type_name(kind), "", "{kind}");
            assert_eq!(openshell_lifecycle(name), None, "{kind}");
        }
        assert_eq!(installation_type("sandbox"), None);
        assert_eq!(object_kind("openshell_sandbox"), "sandbox");
    }
}
