// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{FileRef, SecretRef};
use serde::{Deserialize, Serialize};

/// Existing-cluster target for a managed development gateway: an explicit kubeconfig and context, or, with both omitted, the service account of the pod that runs NemoClaw. The SDK does not create a cluster or select an ambient context. Agent Sandbox and a default StorageClass are platform prerequisites that the SDK does not check. `runtime.provider: openshift` selects the OpenShift profile.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedKubernetes {
    /// Environment reference whose value is the local kubeconfig file path. Requires context; omit both to use the pod's service account. The file and its credentials remain outside configuration and exported state. Process, loader, trust, proxy, cluster, Python, Helm, OpenTofu, and SDK control variable names are reserved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "FileRef")]
    pub kubeconfig: Option<FileRef>,
    /// Exact kubeconfig context used for every cluster operation. Requires kubeconfig.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(
        default,
        with = "String",
        length(min = 1, max = 253),
        regex(pattern = r"^[^\x00-\x20\x7f]+$")
    )]
    pub context: Option<String>,
    /// Namespace for this deployment's gateway and generated development authentication resources. An existing namespace is bound by UID and never changed; a missing one is created. A namespace another NemoClaw deployment created is refused.
    #[schemars(
        length(min = 1, max = 63),
        regex(pattern = r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")
    )]
    pub namespace: String,
    /// How the managed gateway authenticates users: a generated development issuer, or an existing OIDC issuer.
    pub authentication: KubernetesAuthentication,
    /// Caller environment variables that the kubeconfig's exec credential plugin needs, such as `AWS_PROFILE` for an EKS cluster. Requires kubeconfig. Cluster operations receive only platform variables and these; they are resolved like credential references and never written to configuration or state.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 32))]
    pub environment: Vec<String>,
    /// Names of caller-managed registry Secrets in this deployment's namespace, used by gateway/helper and sandbox pods. Values stay in Kubernetes; NemoClaw does not create, read, rotate, or remove these Secrets. Provision them in the namespace before the first apply, or after the SDK creates it, before its pods need to pull images.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 32))]
    pub image_pull_secrets: Vec<String>,
    /// How clients outside the cluster reach the gateway. With it, `endpoint` is the address they dial and the gateway certificate names its host; without it, NemoClaw forwards a free local port to the gateway pod for each command. Fixed after the first successful plan, like the endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "KubernetesExpose")]
    pub expose: Option<KubernetesExpose>,
}

/// Publication of a managed Kubernetes gateway's endpoint.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KubernetesExpose {
    /// A Service that publishes the endpoint's port and forwards it to the gateway pod. TLS and client certificates pass through to the gateway unchanged.
    pub service: ExposureService,
}

/// The Service that publishes a managed Kubernetes gateway.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExposureService {
    /// `NodePort` listens on the endpoint's port, from 30000 through 32767, on every node. `LoadBalancer` asks the cluster's load-balancer implementation for an address, requires the `oidc` authentication profile, and also listens on a node port Kubernetes allocates.
    #[serde(rename = "type")]
    pub service_type: ExposureServiceType,
    /// LoadBalancer only: client CIDRs the load balancer admits. Load-balancer implementations differ in whether they enforce it, and it never covers node ports.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 32))]
    pub load_balancer_source_ranges: Vec<String>,
    /// LoadBalancer only: annotations set on the Service unchanged, such as the address annotation of MetalLB, GKE, AKS or the AWS Load Balancer Controller. They must not terminate TLS. Fixed after the first successful plan.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    #[schemars(length(max = 32))]
    pub annotations: std::collections::BTreeMap<String, String>,
}

/// The Kubernetes Service type that publishes a managed gateway.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(inline)]
pub enum ExposureServiceType {
    /// A port on every node.
    NodePort,
    /// An address from the cluster's load-balancer implementation.
    LoadBalancer,
}

impl ExposureServiceType {
    /// The Service `spec.type` value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NodePort => "NodePort",
            Self::LoadBalancer => "LoadBalancer",
        }
    }
}

/// Authentication provisioned for a managed Kubernetes gateway.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KubernetesAuthentication {
    /// `development` generates a scoped local issuer for isolated qualification; `oidc` uses an existing OIDC issuer, configured in spec.gateway.config's openshell.gateway.oidc table.
    pub profile: KubernetesAuthenticationProfile,
    /// Existing ConfigMap in this deployment's namespace whose `ca.crt` verifies the issuer's TLS certificate; omit for a publicly trusted issuer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String", length(min = 1, max = 253))]
    pub ca_config_map: Option<String>,
    /// Environment reference holding the bearer token NemoClaw sends to the gateway. Required for `oidc`; your identity provider's tooling obtains and refreshes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "SecretRef")]
    pub token: Option<SecretRef>,
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
