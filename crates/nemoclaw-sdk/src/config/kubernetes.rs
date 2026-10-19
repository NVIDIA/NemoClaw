// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::FileRef;
use serde::{Deserialize, Serialize};

/// Explicit existing-cluster target for a managed development gateway. The SDK does not create a cluster or select an ambient context, and installs nothing cluster-wide: Agent Sandbox and a default StorageClass must already exist. `runtime.provider: openshift` selects the OpenShift profile.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedKubernetes {
    /// Environment reference whose value is the local kubeconfig file path. The file and its credentials remain outside configuration and exported state. Process, loader, trust, proxy, cluster, Python, Helm, OpenTofu, and SDK control variable names are reserved.
    pub kubeconfig: FileRef,
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
    /// How the managed gateway authenticates users: a generated development issuer, or an existing OIDC issuer.
    pub authentication: KubernetesAuthentication,
    /// Caller environment variables that the kubeconfig's exec credential plugin needs, such as `AWS_PROFILE` for an EKS cluster. Cluster operations receive only platform variables and these; they are resolved like credential references and never written to configuration or state.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 32))]
    pub environment: Vec<String>,
    /// Names of caller-managed registry Secrets in this deployment's namespace, used by gateway/helper and sandbox pods. Values stay in Kubernetes; NemoClaw does not create, read, rotate, or remove these Secrets. Provision them after the SDK creates the namespace, before its pods need to pull images.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 32))]
    pub image_pull_secrets: Vec<String>,
}

/// Authentication provisioned for a managed Kubernetes gateway.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KubernetesAuthentication {
    /// `development` generates a scoped local issuer for isolated qualification; `oidc` uses an existing OIDC issuer.
    pub profile: KubernetesAuthenticationProfile,
    /// HTTPS URL of the existing OIDC issuer. Required for `oidc`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String", length(min = 9, max = 2048))]
    pub issuer: Option<String>,
    /// Audience the gateway requires in tokens. Required for `oidc`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String", length(min = 1, max = 253))]
    pub audience: Option<String>,
    /// Dot-separated path to the roles array in token claims, such as `groups` or `realm_access.roles`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String", length(min = 1, max = 253))]
    pub roles_claim: Option<String>,
    /// Role that grants administrator access; set together with `userRole`, or neither for authentication only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String", length(min = 1, max = 253))]
    pub admin_role: Option<String>,
    /// Role that grants user access; set together with `adminRole`, or neither for authentication only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String", length(min = 1, max = 253))]
    pub user_role: Option<String>,
    /// Dot-separated path to the scopes array in token claims.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String", length(min = 1, max = 253))]
    pub scopes_claim: Option<String>,
    /// Existing ConfigMap in this deployment's namespace whose `ca.crt` verifies the issuer's TLS certificate; omit for a publicly trusted issuer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String", length(min = 1, max = 253))]
    pub ca_config_map: Option<String>,
    /// Environment variable holding the bearer token NemoClaw sends to the gateway. Required for `oidc`; your identity provider's tooling obtains and refreshes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String", length(min = 1, max = 253))]
    pub token_env: Option<String>,
}

/// Supported managed gateway authentication profile.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(inline)]
pub enum KubernetesAuthenticationProfile {
    /// Generated authentication for isolated development qualification only.
    Development,
    /// An existing OIDC issuer.
    Oidc,
}
