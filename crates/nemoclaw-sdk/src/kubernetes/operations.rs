// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The operations the provider performs for the two Kubernetes resources.
//!
//! `kubernetes_storage` is the retained namespace and credential key;
//! `kubernetes_gateway` is the Helm release that uses them. Each operation
//! reports the resource's identity and whether it is running.

use super::connection::{self, Connection};
use super::{
    GATEWAY_KIND, STORAGE_KIND, Spec,
    auth::{Development, Material},
    cluster::{Cluster, Owned},
    gateway::{self, Release},
    issuer,
    receipt::Receipt,
    storage::{Storage, ensure_storage},
};
use crate::{Error, ObservationError};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The gateway container's gRPC port.
const GATEWAY_PORT: u16 = 8080;

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
        })
    }

    fn development(&self, spec: &Spec) -> Result<Development, ObservationError> {
        let target = self.target(spec)?;
        Ok(Development::new(
            self.state.join("auth"),
            &spec.name,
            &target.namespace,
            &spec.owner,
        ))
    }

    fn release(
        &self,
        spec: &Spec,
        material: Option<&Material>,
    ) -> Result<Release, ObservationError> {
        let target = self.target(spec)?;
        Ok(Release {
            oidc: material.map(|material| issuer::oidc_values(material, &spec.name, &spec.owner)),
            openshift: spec.settings.runtime.provider == crate::config::ComputeDriver::OpenShift,
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
                let material = self.development(spec)?.ensure()?;
                let namespace = self.target(spec)?.namespace.clone();
                let cluster = self.cluster(spec);
                for object in issuer::objects(&material, &spec.name, &namespace) {
                    let address = Owned::new(&object, "");
                    let recorded = receipt
                        .issuer
                        .iter()
                        .find(|owned| owned.kind == address.kind && owned.name == address.name)
                        .cloned();
                    match recorded {
                        Some(owned) => {
                            cluster.verify(&owned).await?;
                        }
                        None => {
                            receipt.issuer.push(cluster.create(object).await?);
                            receipt.save(&self.state)?;
                        }
                    }
                }
                gateway::install(&self.release(spec, Some(&material))?).await?;
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

    /// Open a connection to the running gateway for one command: forward
    /// the authored loopback port to the gateway pod, and supply its client
    /// certificate and a development token.
    pub async fn connect(&self, spec: &Spec) -> Result<Connection, Error> {
        let gateway = self.read(&spec.with_kind(GATEWAY_KIND), None).await?;
        if gateway.running != Some(true) {
            return Err(ObservationError::Backend(
                "the Kubernetes gateway is not running; apply it first",
            )
            .into());
        }
        let target = self.target(spec)?;
        let endpoint =
            url::Url::parse(&spec.settings.endpoint).map_err(|_| ObservationError::Query)?;
        let port = endpoint.port().ok_or(ObservationError::Query)?;
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .map_err(|_| {
                Error::Conflict("the managed Kubernetes loopback port is already in use")
            })?;
        let directory = self.state.join("client");
        super::receipt::private_directory(&directory)?;
        let secret = self
            .cluster(spec)
            .get(&Owned {
                api_version: "v1".into(),
                kind: "Secret".into(),
                namespace: target.namespace.clone(),
                name: format!("{}-client-tls", spec.name),
                uid: String::new(),
            })
            .await?
            .ok_or(ObservationError::Incomplete)?;
        let mut environment = std::collections::BTreeMap::new();
        for (key, name) in [
            ("ca.crt", super::CA_ENV),
            ("tls.crt", super::CERT_ENV),
            ("tls.key", super::KEY_ENV),
        ] {
            use base64::Engine;
            // A DynamicObject keeps the Secret's `data` map among its fields.
            let bytes = secret.data["data"]
                .get(key)
                .and_then(serde_json::Value::as_str)
                .and_then(|text| base64::engine::general_purpose::STANDARD.decode(text).ok())
                .ok_or(ObservationError::Incomplete)?;
            let path = directory.join(key);
            crate::state::atomic_write(&path, &bytes).map_err(|_| ObservationError::Incomplete)?;
            environment.insert(name.to_owned(), path.to_string_lossy().into_owned());
        }
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let token = self.development(spec)?.ensure()?.token(now);
        environment.insert(super::TOKEN_ENV.to_owned(), token);
        let pods: kube::Api<k8s_openapi::api::core::v1::Pod> =
            kube::Api::namespaced(self.client.clone(), &target.namespace);
        // The chart runs one gateway replica, named after the release.
        let pod = format!("{}-0", spec.name);
        let forward = connection::forward(listener, move || {
            let pods = pods.clone();
            let pod = pod.clone();
            async move {
                let mut forwarder = pods
                    .portforward(&pod, &[GATEWAY_PORT])
                    .await
                    .map_err(std::io::Error::other)?;
                forwarder
                    .take_stream(GATEWAY_PORT)
                    .ok_or_else(|| std::io::Error::other("no forwarded stream"))
            }
        });
        Ok(Connection::new(
            endpoint.as_str().trim_end_matches('/').to_owned(),
            environment,
            forward,
        ))
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
        gateway::uninstall(&self.release(spec, None)?).await?;
        let cluster = self.cluster(spec);
        if cluster.get(&self.statefulset(spec)?).await?.is_some() {
            return Err(ObservationError::Incomplete);
        }
        let mut receipt = self.receipt(spec)?.ok_or(ObservationError::Incomplete)?;
        receipt.gateway = None;
        receipt.save(&self.state)?;
        // The issuer goes with the release; its key material stays local.
        while let Some(owned) = receipt.issuer.last().cloned() {
            cluster.delete(&owned).await?;
            receipt.issuer.pop();
            receipt.save(&self.state)?;
        }
        Ok(())
    }
}
