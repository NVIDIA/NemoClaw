// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The retained part of a Kubernetes gateway: its namespace and credential
//! key, after checking the cluster can host it.
//!
//! Storage outlives the gateway release. Destroy removes the release but
//! keeps these objects, so a later apply finds the same encrypted
//! credentials.

use super::{
    cluster::{Cluster, Owned},
    receipt::{ClusterIdentity, Receipt},
};
use crate::ObservationError;
use k8s_openapi::api::{core::v1::Namespace, storage::v1::StorageClass};
use kube::{Api, api::ListParams};
use serde_json::{Value, json};
use std::path::PathBuf;

/// Everything storage install needs from the deployment.
pub struct Storage {
    /// Private directory holding the receipt.
    pub directory: PathBuf,
    /// API server URL from the kubeconfig context.
    pub server: String,
    pub namespace: String,
    /// Gateway resource name, `nc-<workspace>-gateway`.
    pub name: String,
    pub owner: String,
}

const MISSING_PREREQUISITE: ObservationError = ObservationError::Backend(
    "Kubernetes prerequisites are missing or incompatible: Agent Sandbox must be installed and the cluster needs exactly one default StorageClass; resources retained",
);

/// Bind the cluster, check prerequisites, then create the namespace and
/// credential key if this deployment has not already. Safe to repeat.
pub async fn ensure_storage(
    cluster: &Cluster,
    storage: &Storage,
) -> Result<Receipt, ObservationError> {
    let mut receipt = Receipt::load(&storage.directory, &storage.owner, &storage.name)?
        .unwrap_or_else(|| Receipt::new(&storage.owner, &storage.name));
    receipt.bind(identity(cluster, &storage.server).await?)?;
    receipt.save(&storage.directory)?;
    agent_sandbox(cluster).await?;
    default_storage_class(cluster).await?;
    let namespace =
        json!({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": storage.namespace}});
    ensure(cluster, &mut receipt, storage, namespace).await?;
    let key = json!({
        "apiVersion": "v1", "kind": "Secret", "type": "Opaque",
        "metadata": {"name": format!("{}-kek", storage.name), "namespace": storage.namespace},
        // The gateway reads the key as base64 text; the Secret's data field
        // encodes that text once more, as the chart's own key Secret does.
        "data": {"key-encryption-key": base64(base64(&random_key()?).as_bytes())},
    });
    ensure(cluster, &mut receipt, storage, key).await?;
    receipt.storage_ready = true;
    receipt.save(&storage.directory)?;
    Ok(receipt)
}

/// The cluster's identity: its server URL and the UID of kube-system, which
/// a rebuilt cluster at the same address does not share.
async fn identity(cluster: &Cluster, server: &str) -> Result<ClusterIdentity, ObservationError> {
    let system = Api::<Namespace>::all(cluster.client().clone())
        .get_opt("kube-system")
        .await
        .map_err(read_failure)?
        .and_then(|namespace| namespace.metadata.uid)
        .ok_or(ObservationError::Incomplete)?;
    Ok(ClusterIdentity {
        server: server.into(),
        system_uid: system,
    })
}

/// The class of a failed cluster read. A rejected credential or a missing
/// permission is the user's to fix, so it must not read as a network fault;
/// every other failure is a transport failure.
fn read_failure(error: kube::Error) -> ObservationError {
    match error {
        kube::Error::Api(status) if status.code == 401 => ObservationError::Authentication,
        kube::Error::Api(status) if status.code == 403 => ObservationError::Permission,
        _ => ObservationError::Transport,
    }
}

/// Agent Sandbox must already be installed and its controller available.
/// The platform owns it; a deployment never installs or removes it.
async fn agent_sandbox(cluster: &Cluster) -> Result<(), ObservationError> {
    let probe = |api_version: &str, kind: &str, namespace: &str, name: &str| Owned {
        api_version: api_version.into(),
        kind: kind.into(),
        namespace: namespace.into(),
        name: name.into(),
        uid: String::new(),
    };
    let crd = cluster
        .get(&probe(
            "apiextensions.k8s.io/v1",
            "CustomResourceDefinition",
            "",
            "sandboxes.agents.x-k8s.io",
        ))
        .await?;
    let controller = cluster
        .get(&probe(
            "apps/v1",
            "Deployment",
            "agent-sandbox-system",
            "agent-sandbox-controller",
        ))
        .await?;
    let available = controller
        .as_ref()
        .and_then(|deployment| deployment.data.pointer("/status/availableReplicas"))
        .and_then(Value::as_u64)
        .is_some_and(|replicas| replicas >= 1);
    if crd.is_some() && available {
        Ok(())
    } else {
        Err(MISSING_PREREQUISITE)
    }
}

async fn default_storage_class(cluster: &Cluster) -> Result<(), ObservationError> {
    let classes = Api::<StorageClass>::all(cluster.client().clone())
        .list(&ListParams::default())
        .await
        .map_err(read_failure)?;
    let defaults = classes
        .items
        .iter()
        .filter(|class| {
            class
                .metadata
                .annotations
                .as_ref()
                .is_some_and(|annotations| {
                    [
                        "storageclass.kubernetes.io/is-default-class",
                        "storageclass.beta.kubernetes.io/is-default-class",
                    ]
                    .iter()
                    .any(|key| annotations.get(*key).map(String::as_str) == Some("true"))
                })
        })
        .count();
    if defaults == 1 {
        Ok(())
    } else {
        Err(MISSING_PREREQUISITE)
    }
}

/// Verify `object` if this deployment created it; otherwise create it,
/// refusing one that already exists.
async fn ensure(
    cluster: &Cluster,
    receipt: &mut Receipt,
    storage: &Storage,
    object: Value,
) -> Result<(), ObservationError> {
    if let Some(owned) = receipt.owned(&Owned::new(&object, "")).cloned() {
        cluster.verify(&owned).await?;
        return Ok(());
    }
    let owned = cluster.create(object).await?;
    receipt.objects.push(owned);
    receipt.save(&storage.directory)
}

fn random_key() -> Result<[u8; 32], ObservationError> {
    let mut key = [0; 32];
    getrandom::fill(&mut key).map_err(|_| ObservationError::Incomplete)?;
    Ok(key)
}

fn base64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
