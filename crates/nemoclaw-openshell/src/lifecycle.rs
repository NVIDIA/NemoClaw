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
    match kind.strip_prefix("nemoclaw_").unwrap_or(kind) {
        "workspace" => Some(OpenShellLifecycle::Retained),
        "sandbox" => Some(OpenShellLifecycle::Stateful),
        "provider" | "provider_profile" | "agent_configuration" => {
            Some(OpenShellLifecycle::Reconstructible)
        }
        _ => None,
    }
}
