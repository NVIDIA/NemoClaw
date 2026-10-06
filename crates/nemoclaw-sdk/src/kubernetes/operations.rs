// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The operations the provider performs for the two Kubernetes resources.
//!
//! `kubernetes_storage` is the retained namespace and credential key;
//! `kubernetes_gateway` is the Helm release that uses them. Each operation
//! reports the resource's identity and whether it is running.

use super::{
    GATEWAY_KIND, STORAGE_KIND, Spec,
    cluster::{Cluster, Owned},
    gateway::{self, Release},
    receipt::Receipt,
    storage::{Storage, ensure_storage},
};
use crate::ObservationError;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// What an operation observed.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Response {
    /// The resource's identity, or `None` when it does not exist.
    pub id: Option<String>,
    pub running: Option<bool>,
}

/// Cluster access and local paths for one deployment's operations.
pub struct Operations {
    pub client: kube::Client,
    /// API server URL from the kubeconfig context.
    pub server: String,
    pub helm: PathBuf,
    pub kubeconfig: PathBuf,
    /// Private state directory holding the receipt.
    pub state: PathBuf,
}

impl Operations {
    fn target<'a>(
        &self,
        spec: &'a Spec,
    ) -> Result<&'a crate::config::ManagedKubernetes, ObservationError> {
        spec.settings
            .kubernetes
            .as_ref()
            .ok_or(ObservationError::Query)
    }

    fn cluster(&self, spec: &Spec) -> Cluster {
        Cluster::new(self.client.clone(), &spec.owner, &spec.generation)
    }

    fn storage(&self, spec: &Spec) -> Result<Storage, ObservationError> {
        let target = self.target(spec)?;
        Ok(Storage {
            directory: self.state.clone(),
            server: self.server.clone(),
            namespace: target.namespace.clone(),
            name: spec.name.clone(),
            owner: spec.owner.clone(),
            manage_prerequisites: target.prerequisites.agent_sandbox.management
                == crate::config::KubernetesPrerequisiteManagement::Managed,
        })
    }

    fn release(&self, spec: &Spec) -> Result<Release, ObservationError> {
        let target = self.target(spec)?;
        Ok(Release {
            helm: self.helm.clone(),
            state: self.state.clone(),
            kubeconfig: self.kubeconfig.clone(),
            context: target.context.clone(),
            namespace: target.namespace.clone(),
            name: spec.name.clone(),
        })
    }

    fn receipt(&self, spec: &Spec) -> Result<Option<Receipt>, ObservationError> {
        Receipt::load(&self.state, &spec.owner, &spec.name)
    }

    /// The gateway StatefulSet the chart creates, named after the release.
    fn statefulset(&self, spec: &Spec) -> Result<Owned, ObservationError> {
        Ok(Owned {
            api_version: "apps/v1".into(),
            kind: "StatefulSet".into(),
            namespace: self.target(spec)?.namespace.clone(),
            name: spec.name.clone(),
            uid: String::new(),
        })
    }

    /// Observe the resource. `prior` is the identity from state, if any.
    pub async fn read(
        &self,
        spec: &Spec,
        prior: Option<&str>,
    ) -> Result<Response, ObservationError> {
        let response = match spec.kind.as_str() {
            STORAGE_KIND => self.read_storage(spec).await?,
            GATEWAY_KIND => self.read_gateway(spec).await?,
            _ => return Err(ObservationError::Query),
        };
        if let (Some(prior), Some(id)) = (prior, &response.id)
            && prior != id
        {
            return Err(ObservationError::BindingMismatch);
        }
        Ok(response)
    }

    async fn read_storage(&self, spec: &Spec) -> Result<Response, ObservationError> {
        let Some(receipt) = self.receipt(spec)? else {
            return Ok(Response::default());
        };
        let cluster = self.cluster(spec);
        for owned in &receipt.objects {
            cluster.verify(owned).await?;
        }
        let namespace = receipt
            .objects
            .iter()
            .find(|owned| owned.kind == "Namespace");
        Ok(Response {
            id: namespace.map(|owned| owned.uid.clone()),
            running: namespace.map(|_| receipt.storage_ready),
        })
    }

    async fn read_gateway(&self, spec: &Spec) -> Result<Response, ObservationError> {
        let Some(receipt) = self.receipt(spec)? else {
            return Ok(Response::default());
        };
        let Some(recorded) = &receipt.gateway else {
            return Ok(Response::default());
        };
        let statefulset = self.cluster(spec).get(&self.statefulset(spec)?).await?;
        let Some(statefulset) = statefulset else {
            // A recorded release whose StatefulSet is gone is not running.
            return Ok(Response {
                id: Some(recorded.clone()),
                running: Some(false),
            });
        };
        if statefulset.metadata.uid.as_deref() != Some(recorded.as_str()) {
            return Err(ObservationError::BindingMismatch);
        }
        let number = |pointer: &str| {
            statefulset
                .data
                .pointer(pointer)
                .and_then(serde_json::Value::as_i64)
        };
        let current = number("/status/observedGeneration") >= statefulset.metadata.generation;
        let running = current && number("/status/readyReplicas") == Some(1);
        Ok(Response {
            id: Some(recorded.clone()),
            running: Some(running),
        })
    }

    /// Create or repair the resource, then observe it.
    pub async fn ensure(
        &self,
        spec: &Spec,
        prior: Option<&str>,
    ) -> Result<Response, ObservationError> {
        match spec.kind.as_str() {
            STORAGE_KIND => {
                ensure_storage(&self.cluster(spec), &self.storage(spec)?).await?;
            }
            GATEWAY_KIND => {
                let mut receipt = self.receipt(spec)?.ok_or(ObservationError::Incomplete)?;
                if !receipt.storage_ready {
                    return Err(ObservationError::Incomplete);
                }
                gateway::install(&self.release(spec)?).await?;
                let statefulset = self
                    .cluster(spec)
                    .get(&self.statefulset(spec)?)
                    .await?
                    .ok_or(ObservationError::Incomplete)?;
                let uid = statefulset
                    .metadata
                    .uid
                    .ok_or(ObservationError::Incomplete)?;
                if receipt
                    .gateway
                    .as_ref()
                    .is_some_and(|recorded| *recorded != uid)
                {
                    return Err(ObservationError::BindingMismatch);
                }
                receipt.gateway = Some(uid);
                receipt.save(&self.state)?;
            }
            _ => return Err(ObservationError::Query),
        }
        self.read(spec, prior).await
    }

    /// Remove the gateway release. Storage is retained and never removed.
    pub async fn remove(&self, spec: &Spec, prior: Option<&str>) -> Result<(), ObservationError> {
        if spec.kind != GATEWAY_KIND {
            return Err(ObservationError::BindingMismatch);
        }
        let current = self.read(spec, prior).await?;
        if current.id.is_none() {
            return Ok(());
        }
        gateway::uninstall(&self.release(spec)?).await?;
        if self
            .cluster(spec)
            .get(&self.statefulset(spec)?)
            .await?
            .is_some()
        {
            return Err(ObservationError::Incomplete);
        }
        let mut receipt = self.receipt(spec)?.ok_or(ObservationError::Incomplete)?;
        receipt.gateway = None;
        receipt.save(&self.state)
    }
}
