// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The private record of what one Kubernetes deployment created.
//!
//! The receipt lives in the deployment's state directory. It binds the
//! deployment to one cluster and records every object it created by UID, so
//! later operations act only on those objects and refuse a different cluster.

use super::cluster::Owned;
use crate::{ObservationError, state::save_json};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Create `directory` readable only by its owner. The receipt and the
/// gateway's client credentials live here.
pub(crate) fn private_directory(directory: &Path) -> Result<(), ObservationError> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(directory)
        .map_err(|_| ObservationError::Incomplete)
}

/// The cluster a deployment was first applied to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ClusterIdentity {
    /// API server URL from the kubeconfig context.
    pub server: String,
    /// UID of the cluster's kube-system namespace, stable for its lifetime.
    pub system_uid: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Receipt {
    pub owner: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cluster: Option<ClusterIdentity>,
    /// Objects this deployment created, in creation order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub objects: Vec<Owned>,
    /// Set once the namespace and key exist.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub storage_ready: bool,
    /// The development issuer's objects, created before the gateway release.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issuer: Vec<Owned>,
    /// Set after every issuer object exists and its identity is recorded.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub issuer_ready: bool,
    /// The OpenShift identity assigned to the retained namespace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace_identity: Option<super::gateway::Identity>,
    /// Set while a Helm release exists for the gateway.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway: Option<String>,
}

impl Receipt {
    pub fn new(owner: &str, name: &str) -> Self {
        Self {
            owner: owner.into(),
            name: name.into(),
            ..Self::default()
        }
    }

    fn path(directory: &Path) -> PathBuf {
        directory.join("receipt.json")
    }

    /// The receipt for this owner and name, or `None` before first apply.
    /// A receipt written for another deployment is a binding mismatch.
    pub fn load(
        directory: &Path,
        owner: &str,
        name: &str,
    ) -> Result<Option<Self>, ObservationError> {
        let bytes = match std::fs::read(Self::path(directory)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(ObservationError::Incomplete),
        };
        let receipt: Self =
            serde_json::from_slice(&bytes).map_err(|_| ObservationError::Incomplete)?;
        if receipt.owner != owner || receipt.name != name {
            return Err(ObservationError::BindingMismatch);
        }
        Ok(Some(receipt))
    }

    pub fn save(&self, directory: &Path) -> Result<(), ObservationError> {
        private_directory(directory)?;
        save_json(&Self::path(directory), self).map_err(|_| ObservationError::Incomplete)
    }

    /// Bind to `cluster` on first use; afterwards, refuse any other cluster.
    pub fn bind(&mut self, cluster: ClusterIdentity) -> Result<(), ObservationError> {
        match &self.cluster {
            None => {
                self.cluster = Some(cluster);
                Ok(())
            }
            Some(bound) if *bound == cluster => Ok(()),
            Some(_) => Err(ObservationError::BindingMismatch),
        }
    }

    /// The recorded object at `object`'s address, if this deployment made it.
    pub fn owned(&self, object: &Owned) -> Option<&Owned> {
        self.objects.iter().find(|owned| {
            owned.kind == object.kind
                && owned.namespace == object.namespace
                && owned.name == object.name
        })
    }
}
