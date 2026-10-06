// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Kubernetes gateways on an explicitly selected cluster.
//!
//! Every operation connects with the kubeconfig file and context named in the
//! deployment YAML. Ambient selection such as `KUBECONFIG` or in-cluster
//! service variables is never consulted, so one deployment cannot reach
//! another cluster by accident.

use crate::ObservationError;
use kube::config::{KubeConfigOptions, Kubeconfig};
use std::path::PathBuf;

/// The kubeconfig file and context a deployment names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClusterTarget {
    pub kubeconfig: PathBuf,
    pub context: String,
}

/// Connect to the target's context. The kubeconfig's exec credential plugins
/// run as written, with the caller's environment.
pub async fn connect(target: &ClusterTarget) -> Result<kube::Client, ObservationError> {
    // The workspace links both rustls providers, so one must be chosen. The
    // provider binary installs ring at startup; this covers other callers.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let kubeconfig =
        Kubeconfig::read_from(&target.kubeconfig).map_err(|_| ObservationError::Authentication)?;
    let options = KubeConfigOptions {
        context: Some(target.context.clone()),
        ..KubeConfigOptions::default()
    };
    let config = kube::Config::from_custom_kubeconfig(kubeconfig, &options)
        .await
        .map_err(|_| ObservationError::Authentication)?;
    kube::Client::try_from(config).map_err(|_| ObservationError::Transport)
}
