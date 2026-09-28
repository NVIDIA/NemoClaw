// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::Credential;
use serde::{Deserialize, Serialize};

/// Explicit existing-cluster target for a managed development gateway. The SDK does not create a cluster or select an ambient context.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedKubernetes {
    /// Environment reference whose value is the local kubeconfig file path. The file and its credentials remain outside configuration and exported state. Process, loader, trust, proxy, cluster, Python, Helm, OpenTofu, and SDK control variable names are reserved.
    pub kubeconfig: Credential,
    /// Exact kubeconfig context used for every cluster operation.
    #[schemars(
        length(min = 1, max = 253),
        regex(pattern = r"^[^\x00-\x20\x7f]+$(?![\s\S])")
    )]
    pub context: String,
    /// Namespace for this deployment's gateway and generated development authentication resources.
    #[schemars(
        length(min = 1, max = 63),
        regex(pattern = r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$(?![\s\S])")
    )]
    pub namespace: String,
    /// Explicit prerequisite ownership. Managed installation may create cluster-wide resources when the pinned prerequisite is absent.
    pub prerequisites: KubernetesPrerequisites,
    /// Explicit generated development authentication profile; this is not a production identity service.
    pub authentication: KubernetesAuthentication,
}

/// Installation policy for the pinned Kubernetes prerequisites.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KubernetesPrerequisites {
    /// Whether to require an existing Agent Sandbox installation or install the pinned prerequisite when absent.
    pub agent_sandbox: AgentSandboxPrerequisite,
}

/// Ownership policy for the pinned Agent Sandbox controller and custom resource definitions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSandboxPrerequisite {
    /// Existing verifies a compatible installation; managed installs owned prerequisites when absent and does not adopt a foreign installation.
    pub management: KubernetesPrerequisiteManagement,
}

/// Whether the platform or this deployment installs an absent prerequisite.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(inline)]
pub enum KubernetesPrerequisiteManagement {
    /// Require the pinned prerequisite to exist without taking ownership.
    Existing,
    /// Install the pinned prerequisite when absent; preserve foreign ownership and retained resources.
    Managed,
}

/// Authentication provisioned for a managed Kubernetes gateway.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KubernetesAuthentication {
    /// Development generates the scoped local authentication fixture. Existing production issuers use gateway.management: external.
    pub profile: KubernetesAuthenticationProfile,
}

/// Supported managed gateway authentication profile.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(inline)]
pub enum KubernetesAuthenticationProfile {
    /// Generated authentication for isolated development qualification only.
    Development,
}
