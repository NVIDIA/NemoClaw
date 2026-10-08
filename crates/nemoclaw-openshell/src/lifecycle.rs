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

/// The object kind that a kind or an OpenTofu resource type names.
pub fn object_kind(name: &str) -> &str {
    if let Some(name) = name.strip_prefix("openshell_") {
        return RESOURCE_TYPES
            .iter()
            .find(|(_, resource)| *resource == name)
            .map_or(name, |(kind, _)| kind);
    }
    name.strip_prefix("nemoclaw_").unwrap_or(name)
}

/// The OpenTofu resource type for an OpenShell object kind.
pub fn resource_type(kind: &str) -> Option<String> {
    RESOURCE_TYPES
        .iter()
        .find(|(object, _)| *object == kind)
        .map(|(_, name)| format!("openshell_{name}"))
}
