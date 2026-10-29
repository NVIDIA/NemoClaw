// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The retained part of a Kubernetes gateway: its namespace, bound by UID,
//! and its credential key.
//!
//! Storage outlives the gateway release. Destroy removes the release but
//! keeps these objects, so a later apply finds the same encrypted
//! credentials. Agent Sandbox and a default StorageClass are the platform's;
//! storage reads nothing outside the namespace.

use super::{
    cluster::{Cluster, OWNER_LABEL, Owned},
    receipt::Receipt,
};
use crate::ObservationError;
use kube::api::DynamicObject;
use serde_json::{Value, json};
use std::path::PathBuf;

/// Everything storage install needs from the deployment.
pub struct Storage {
    /// Private directory holding the receipt.
    pub directory: PathBuf,
    pub namespace: String,
    /// Gateway resource name, `nc-<workspace>-gateway`.
    pub name: String,
    pub owner: String,
}

/// Bind the target namespace, creating it if it does not exist, then create
/// the credential key if this deployment has not already. Safe to repeat.
pub async fn ensure_storage(
    cluster: &Cluster,
    storage: &Storage,
) -> Result<Receipt, ObservationError> {
    let mut receipt = Receipt::load(&storage.directory, &storage.owner, &storage.name)?
        .unwrap_or_else(|| Receipt::new(&storage.owner, &storage.name));
    if let Some(namespace) = &receipt.namespace {
        same_namespace(namespace, &storage.namespace)?;
        cluster.verify_uid(namespace).await?;
    } else {
        receipt.namespace =
            Some(bind_namespace(cluster, &storage.namespace, &storage.owner).await?);
        receipt.save(&storage.directory)?;
    }
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

/// The address of the namespace named `name`.
pub(crate) fn namespace_address(name: &str) -> Owned {
    Owned {
        api_version: "v1".into(),
        kind: "Namespace".into(),
        namespace: String::new(),
        name: name.into(),
        uid: String::new(),
    }
}

/// Refuse a target other than the namespace the receipt bound, which would
/// put objects outside the namespace this deployment verifies.
pub(crate) fn same_namespace(bound: &Owned, target: &str) -> Result<(), ObservationError> {
    if bound.name == target {
        Ok(())
    } else {
        Err(bound.changed(&format!(
            "is bound; gateway.kubernetes.namespace names {target}"
        )))
    }
}

/// The namespace named `name`, if it exists, unless it is being deleted or
/// another deployment's owner label shows that deployment created it.
pub(crate) async fn bindable_namespace(
    cluster: &Cluster,
    name: &str,
    owner: &str,
) -> Result<Option<DynamicObject>, ObservationError> {
    let address = namespace_address(name);
    let existing = cluster.get(&address).await?;
    let Some(namespace) = &existing else {
        return Ok(None);
    };
    // A namespace being deleted keeps its UID until it is gone, and then the
    // binding could never be satisfied again.
    if namespace.metadata.deletion_timestamp.is_some() {
        return Err(address.changed("is being deleted"));
    }
    let other = namespace
        .metadata
        .labels
        .as_ref()
        .and_then(|labels| labels.get(OWNER_LABEL))
        .is_some_and(|label| label != owner);
    if other {
        return Err(address.changed("belongs to another NemoClaw deployment"));
    }
    Ok(existing)
}

/// Record an existing namespace's UID without changing the namespace, or
/// create it.
async fn bind_namespace(
    cluster: &Cluster,
    name: &str,
    owner: &str,
) -> Result<Owned, ObservationError> {
    match bindable_namespace(cluster, name, owner).await? {
        Some(namespace) => Ok(Owned {
            uid: namespace.metadata.uid.ok_or(ObservationError::Incomplete)?,
            ..namespace_address(name)
        }),
        None => {
            cluster
                .create(
                    json!({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": name}}),
                )
                .await
        }
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
