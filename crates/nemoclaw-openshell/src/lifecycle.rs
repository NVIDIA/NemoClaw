// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/// Persistence contract shared by graph compilation, operation policy, and
/// provider reconciliation. Ownership must still be verified before mutation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenShellLifecycle {
    /// Workspace identity survives deployment teardown.
    Retained,
    /// Sandbox files and history have no separately managed persistent storage.
    /// Deletion requires explicit teardown; absence and replacement need recovery.
    Stateful,
    /// Registrations and configuration can be rebuilt from declared intent.
    Reconstructible,
}

/// Classify either a backend kind or its full OpenTofu resource type.
pub fn openshell_lifecycle(kind: &str) -> Option<OpenShellLifecycle> {
    match object_kind(kind) {
        "workspace" => Some(OpenShellLifecycle::Retained),
        "sandbox" => Some(OpenShellLifecycle::Stateful),
        "provider" | "provider_profile" | "agent_configuration" => {
            Some(OpenShellLifecycle::Reconstructible)
        }
        _ => None,
    }
}

/// The `openshell` provider's resource type name, after its prefix, for each object kind.
pub const RESOURCE_TYPES: [(&str, &str); 4] = [
    ("workspace", "workspace"),
    ("provider", "provider_registration"),
    ("provider_profile", "provider_profile"),
    ("sandbox", "sandbox"),
];

/// Gateway installation kinds the openshell provider serves, with their type
/// names. They install a gateway rather than reach one, so they take no
/// gateway `ref` and have no `type_name`.
pub const INSTALLATION_TYPES: [(&str, &str); 7] = [
    ("managed_gateway", "podman_gateway"),
    ("gateway_storage", "gateway_storage"),
    ("kubernetes_storage", "kubernetes_storage"),
    ("kubernetes_auth", "kubernetes_auth"),
    ("kubernetes_gateway", "kubernetes_gateway"),
    // Data sources.
    ("gateway_readiness", "docker_gateway_readiness"),
    ("gateway_runtime", "docker_gateway_runtime"),
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
        "provider" => "openshell_provider_registration",
        "provider_profile" => "openshell_provider_profile",
        "sandbox" => "openshell_sandbox",
        _ => "",
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
