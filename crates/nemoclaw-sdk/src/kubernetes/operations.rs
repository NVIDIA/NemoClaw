// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Kubernetes preparation and observation around the native Helm release.
//!
//! Storage and authentication are prepared before Helm installs the release.
//! Gateway observation records its StatefulSet identity after installation.
//! The Helm provider owns release creation and removal.

use super::connection::{self, Connection};
use super::{
    AUTH_KIND, GATEWAY_KIND, STORAGE_KIND, Spec,
    auth::Development,
    cluster::{Cluster, Owned},
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
    /// Whether Kubernetes still holds a Helm release record. Only the
    /// authentication resource supplies this independent observation.
    pub release_present: Option<bool>,
}

/// Cluster access and local paths for one deployment's operations.
pub struct Operations {
    pub client: kube::Client,
    /// API server URL from the kubeconfig context.
    pub server: String,
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
        self.observe(spec, prior, false).await
    }

    /// Observe teardown progress. A recorded gateway may already be absent
    /// after Helm removal; every remaining identity must still match.
    pub async fn read_for_removal(
        &self,
        spec: &Spec,
        prior: Option<&str>,
    ) -> Result<Response, ObservationError> {
        self.observe(spec, prior, true).await
    }

    async fn observe(
        &self,
        spec: &Spec,
        prior: Option<&str>,
        removing: bool,
    ) -> Result<Response, ObservationError> {
        let response = match spec.kind.as_str() {
            STORAGE_KIND => self.read_storage(spec).await?,
            AUTH_KIND => self.read_auth(spec, removing).await?,
            GATEWAY_KIND => self.read_gateway(spec, true).await?,
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
            ..Response::default()
        })
    }

    async fn read_auth(&self, spec: &Spec, removing: bool) -> Result<Response, ObservationError> {
        let Some(receipt) = self.receipt(spec)? else {
            return Ok(Response::default());
        };
        if self.read_storage(spec).await?.running != Some(true) {
            return Err(ObservationError::Incomplete);
        }
        let cluster = self.cluster(spec);
        for owned in &receipt.issuer {
            // A successful delete can precede an interrupted receipt write.
            // Only teardown may accept confirmed absence; query failures and
            // existing objects with another identity still stop cleanup.
            if removing && cluster.get(owned).await?.is_none() {
                continue;
            }
            cluster.verify(owned).await?;
        }
        // Ordinary refresh must stop before Helm can recreate a missing
        // StatefulSet or change one with a substituted identity.
        self.read_gateway(spec, removing).await?;
        Ok(Response {
            id: receipt.issuer.first().map(|owned| owned.uid.clone()),
            running: (!receipt.issuer.is_empty()).then_some(receipt.issuer_ready),
            release_present: Some(self.release_present(spec).await?),
        })
    }

    async fn release_present(&self, spec: &Spec) -> Result<bool, ObservationError> {
        spec.validate().map_err(|_| ObservationError::Query)?;
        let secrets: kube::Api<k8s_openapi::api::core::v1::Secret> =
            kube::Api::namespaced(self.client.clone(), &self.target(spec)?.namespace);
        let selector = format!("owner=helm,name={}", spec.name);
        let records = secrets
            .list_metadata(&kube::api::ListParams::default().labels(&selector))
            .await
            .map_err(|error| match error {
                kube::Error::Api(status) => match status.code {
                    401 => ObservationError::Authentication,
                    403 => ObservationError::Permission,
                    _ => ObservationError::Query,
                },
                _ => ObservationError::Transport,
            })?;
        if records
            .metadata
            .continue_
            .as_ref()
            .is_some_and(|token| !token.is_empty())
        {
            return Err(ObservationError::Incomplete);
        }
        // The API must honor the exact selector. An incomplete or unexpected
        // response cannot establish release absence.
        for record in &records.items {
            let labels = record.metadata.labels.as_ref();
            if labels
                .and_then(|labels| labels.get("owner"))
                .map(String::as_str)
                != Some("helm")
                || labels.and_then(|labels| labels.get("name")) != Some(&spec.name)
            {
                return Err(ObservationError::Incomplete);
            }
        }
        Ok(!records.items.is_empty())
    }

    async fn read_gateway(
        &self,
        spec: &Spec,
        allow_absent: bool,
    ) -> Result<Response, ObservationError> {
        let Some(receipt) = self.receipt(spec)? else {
            return Ok(Response::default());
        };
        let Some(recorded) = &receipt.gateway else {
            return Ok(Response::default());
        };
        let statefulset = self.cluster(spec).get(&self.statefulset(spec)?).await?;
        let Some(statefulset) = statefulset else {
            if !allow_absent {
                return Err(ObservationError::BindingMismatch);
            }
            // A recorded release whose StatefulSet is gone is not running.
            return Ok(Response {
                id: Some(recorded.clone()),
                running: Some(false),
                ..Response::default()
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
            ..Response::default()
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
            AUTH_KIND => {
                let mut receipt = self.receipt(spec)?.ok_or(ObservationError::Incomplete)?;
                if self.read_storage(spec).await?.running != Some(true) {
                    return Err(ObservationError::Incomplete);
                }
                self.read(spec, prior).await?;
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
                receipt.issuer_ready = true;
                receipt.save(&self.state)?;
            }
            GATEWAY_KIND => {
                let mut receipt = self.receipt(spec)?.ok_or(ObservationError::Incomplete)?;
                if self.read_auth(spec, false).await?.running != Some(true) {
                    return Err(ObservationError::Incomplete);
                }
                self.read(spec, prior).await?;
                let statefulset = self
                    .cluster(spec)
                    .get(&self.statefulset(spec)?)
                    .await?
                    .ok_or(ObservationError::Incomplete)?;
                let annotations = statefulset.metadata.annotations.as_ref();
                let annotation = |key: &str| annotations.and_then(|values| values.get(key));
                if annotation("meta.helm.sh/release-name") != Some(&spec.name)
                    || annotation("meta.helm.sh/release-namespace")
                        != Some(&self.target(spec)?.namespace)
                    || statefulset
                        .metadata
                        .labels
                        .as_ref()
                        .and_then(|labels| labels.get("app.kubernetes.io/instance"))
                        != Some(&spec.name)
                {
                    return Err(ObservationError::BindingMismatch);
                }
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

    /// Validate the gateway before Helm removes it, or clean up its issuer
    /// after Helm confirms the release is absent. Storage is always retained.
    pub async fn remove(&self, spec: &Spec, prior: Option<&str>) -> Result<(), ObservationError> {
        if !matches!(spec.kind.as_str(), AUTH_KIND | GATEWAY_KIND) {
            return Err(ObservationError::BindingMismatch);
        }
        let current = self.read_for_removal(spec, prior).await?;
        if current.id.is_none() {
            if prior.is_some() {
                return Err(ObservationError::Incomplete);
            }
            return Ok(());
        }
        if spec.kind == GATEWAY_KIND {
            return Ok(());
        }
        if current.release_present != Some(false) {
            return Err(ObservationError::Incomplete);
        }
        let cluster = self.cluster(spec);
        if cluster.get(&self.statefulset(spec)?).await?.is_some() {
            return Err(ObservationError::Incomplete);
        }
        let mut receipt = self.receipt(spec)?.ok_or(ObservationError::Incomplete)?;
        receipt.gateway = None;
        receipt.issuer_ready = false;
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
