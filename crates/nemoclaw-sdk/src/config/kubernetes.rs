// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{FileRef, SecretRef};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// An existing cluster for a managed gateway, reached with an explicit kubeconfig and context or, with both omitted, the service account of the pod that runs NemoClaw. The SDK does not create a cluster or select an ambient context. Agent Sandbox and a default StorageClass are platform prerequisites that the SDK does not check. Without expose, NemoClaw reaches the gateway through a port forward on a free local port for each command, so the document names no port.
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
    /// How clients outside the cluster reach the gateway: the endpoint they dial, and the Service or Route that publishes it. The gateway certificate names the endpoint's host. NemoClaw's own commands still forward a free local port to the gateway pod. The endpoint, whether a Service or a Route publishes the gateway, and the Service's type are fixed after the first plan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "KubernetesExpose")]
    pub expose: Option<KubernetesExpose>,
}

/// Publication of a managed cluster gateway's endpoint, through exactly one of `service` and `route`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KubernetesExpose {
    /// The address clients outside the cluster dial: `https://HOST:PORT`, with a lowercase DNS name or IPv4 address and an explicit nonzero port, and no path. The gateway certificate names its host.
    pub endpoint: String,
    /// The gateway chart's own Service, which publishes the endpoint's port and forwards it to the gateway pod. TLS and client certificates pass through to the gateway unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ExposureService")]
    pub service: Option<ExposureService>,
    /// The gateway chart's own OpenShift Route, which publishes the endpoint's host through the cluster's router and passes TLS through to the gateway by SNI, so TLS and client certificates reach the gateway unchanged. The endpoint's host is a DNS name, since clients send no SNI host name for an IP address, and its port is the one the router serves. Only the openshift target takes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ExposureRoute")]
    pub route: Option<ExposureRoute>,
}

impl KubernetesExpose {
    /// What publishes the gateway: the Service's type, or `Route`.
    pub fn publisher(&self) -> &'static str {
        match &self.service {
            Some(service) => service.service_type.as_str(),
            None => "Route",
        }
    }
}

/// The OpenShift Route that publishes a managed gateway.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExposureRoute {
    /// Annotations on the Route, such as `haproxy.router.openshift.io/timeout`. OpenShift checks them; changing them updates the Route in place.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub annotations: BTreeMap<String, String>,
}

/// The Service that publishes a managed cluster gateway.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExposureService {
    /// `NodePort` listens on the endpoint's port on every node; the port must be in the cluster's node-port range, 30000 through 32767 by default.
    #[serde(rename = "type")]
    pub service_type: ExposureServiceType,
}

/// The Kubernetes Service type that publishes a managed gateway.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(inline)]
pub enum ExposureServiceType {
    /// A port on every node.
    NodePort,
}

impl ExposureServiceType {
    /// The Service `spec.type` value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NodePort => "NodePort",
        }
    }
}

/// Authentication provisioned for a managed cluster gateway.
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
