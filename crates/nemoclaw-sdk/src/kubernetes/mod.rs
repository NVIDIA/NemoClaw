// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Kubernetes gateways on an explicitly selected cluster.
//!
//! Every operation connects with the kubeconfig file and context named in the
//! deployment YAML. Ambient selection such as `KUBECONFIG` or in-cluster
//! service variables is never consulted, so one deployment cannot reach
//! another cluster by accident.

pub mod cluster;
pub mod gateway;
pub mod operations;
pub mod receipt;
pub mod storage;

use crate::{Error, ObservationError, config::ManagedGateway};
use kube::config::{KubeConfigOptions, Kubeconfig};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Resource kinds a Kubernetes gateway compiles into: the retained storage
/// and the gateway release that uses it.
pub const STORAGE_KIND: &str = "kubernetes_storage";
pub const GATEWAY_KIND: &str = "kubernetes_gateway";
/// Environment names that carry the gateway's generated client credentials
/// from the runtime stage to the OpenShell provider. Authored references may
/// not use them.
pub const TOKEN_ENV: &str = "NEMOCLAW_MANAGED_K8S_TOKEN";
pub const CA_ENV: &str = "NEMOCLAW_MANAGED_K8S_CA";
pub const CERT_ENV: &str = "NEMOCLAW_MANAGED_K8S_CERT";
pub const KEY_ENV: &str = "NEMOCLAW_MANAGED_K8S_KEY";
/// Directory holding the gateway's private receipt and generated material.
pub const STATE_ENV: &str = "NEMOCLAW_KUBERNETES_STATE";

/// The managed specification one Kubernetes resource is compiled from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Spec {
    pub layout: u32,
    pub kind: String,
    pub name: String,
    pub owner: String,
    pub generation: String,
    pub settings: ManagedGateway,
}

impl Spec {
    pub fn validate(&self) -> Result<(), Error> {
        let identifier = |pattern: &str, value: &str| {
            regex::Regex::new(pattern)
                .expect("constant pattern")
                .is_match(value)
        };
        if self.layout != 1
            || !matches!(self.kind.as_str(), STORAGE_KIND | GATEWAY_KIND)
            || !identifier(r"^nc-[a-f0-9]{16}-gateway$", &self.name)
            || !identifier(r"^[a-f0-9-]{36}$", &self.owner)
            || !identifier(r"^[a-f0-9]{32}$", &self.generation)
            || self.settings.kubernetes.is_none()
        {
            return Err(Error::Conflict(
                "invalid managed Kubernetes identity or layout",
            ));
        }
        self.settings.validate_managed()?;
        Ok(())
    }
    pub fn decode(value: &str) -> Result<Self, Error> {
        let spec: Self = serde_json::from_str(value)
            .map_err(|_| Error::Conflict("invalid managed Kubernetes specification"))?;
        spec.validate()?;
        Ok(spec)
    }
    pub fn encode(&self) -> Result<String, Error> {
        self.validate()?;
        serde_json::to_string(self)
            .map_err(|_| Error::State("cannot encode Kubernetes specification"))
    }
}

/// The kubeconfig file and context a deployment names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClusterTarget {
    pub kubeconfig: PathBuf,
    pub context: String,
}

/// Connect to the target's context. The kubeconfig's exec credential plugins
/// run as written, with the caller's environment.
pub async fn connect(target: &ClusterTarget) -> Result<kube::Client, ObservationError> {
    let kubeconfig =
        Kubeconfig::read_from(&target.kubeconfig).map_err(|_| ObservationError::Authentication)?;
    let options = KubeConfigOptions {
        context: Some(target.context.clone()),
        ..KubeConfigOptions::default()
    };
    let config = kube::Config::from_custom_kubeconfig(kubeconfig, &options)
        .await
        .map_err(|_| ObservationError::Authentication)?;
    client(config)
}

/// The API server URL the target's context selects.
pub fn server(target: &ClusterTarget) -> Result<String, ObservationError> {
    let kubeconfig =
        Kubeconfig::read_from(&target.kubeconfig).map_err(|_| ObservationError::Authentication)?;
    let context = kubeconfig
        .contexts
        .iter()
        .find(|context| context.name == target.context)
        .and_then(|context| context.context.as_ref())
        .ok_or(ObservationError::Authentication)?;
    kubeconfig
        .clusters
        .iter()
        .find(|cluster| cluster.name == context.cluster)
        .and_then(|cluster| cluster.cluster.as_ref())
        .and_then(|cluster| cluster.server.clone())
        .ok_or(ObservationError::Authentication)
}

/// A client for `config`. The workspace links both rustls providers, so one
/// must be chosen; the provider binary installs ring at startup, and this
/// covers every other caller.
pub fn client(config: kube::Config) -> Result<kube::Client, ObservationError> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    kube::Client::try_from(config).map_err(|_| ObservationError::Transport)
}
