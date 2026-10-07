// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Each create is recorded before the next mutation. PVC bindings outlive compute.
use super::{Spec, StorageSpec, compute_objects, storage_objects};
use crate::{
    ObservationError,
    kubernetes::{
        cluster::{Cluster, GENERATION_LABEL, Owned},
        gateway::Identity,
        receipt::{ClusterIdentity, Receipt as GatewayReceipt, private_directory},
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Response {
    pub id: Option<String>,
    pub running: Option<bool>,
}
pub struct Operations {
    pub client: kube::Client,
    pub server: String,
    pub state: PathBuf,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Receipt {
    storage: StorageSpec,
    cluster: ClusterIdentity,
    namespace_uid: String,
    volumes: Vec<Owned>,
    storage_ready: bool,
    compute: Vec<Owned>,
    specification: Option<Spec>,
    #[serde(default)]
    compute_bound: bool,
}

impl Operations {
    pub async fn endpoint_addresses(
        &self,
        spec: &StorageSpec,
        endpoint: &str,
    ) -> Result<Vec<std::net::IpAddr>, ObservationError> {
        let receipt = self.load(spec)?.ok_or(ObservationError::Incomplete)?;
        self.verify_storage(&receipt, true).await?;
        let compute = receipt
            .specification
            .as_ref()
            .ok_or(ObservationError::Incomplete)?;
        if compute.endpoint() != endpoint {
            return Err(ObservationError::BindingMismatch);
        }
        let service = receipt
            .compute
            .iter()
            .find(|owned| owned.kind == "Service")
            .ok_or(ObservationError::Incomplete)?;
        let observed = self.verify(spec, service).await?;
        let expected = compute_objects(compute, None)
            .into_iter()
            .find(|object| object["kind"] == "Service")
            .ok_or(ObservationError::Incomplete)?;
        for field in ["type", "selector", "ports"] {
            if observed.data["spec"][field] != expected["spec"][field] {
                return Err(ObservationError::BindingMismatch);
            }
        }
        let primary = observed
            .data
            .pointer("/spec/clusterIP")
            .and_then(Value::as_str)
            .ok_or(ObservationError::Incomplete)?;
        let texts: Vec<&str> = match observed
            .data
            .pointer("/spec/clusterIPs")
            .and_then(Value::as_array)
        {
            Some(values) => values
                .iter()
                .map(|value| value.as_str().ok_or(ObservationError::Incomplete))
                .collect::<Result<_, _>>()?,
            None => vec![primary],
        };
        if texts.is_empty() || texts.len() > 2 || texts[0] != primary {
            return Err(ObservationError::Incomplete);
        }
        texts
            .into_iter()
            .map(|text| {
                let address: std::net::IpAddr =
                    text.parse().map_err(|_| ObservationError::Incomplete)?;
                let link_local = match address {
                    std::net::IpAddr::V4(ip) => ip.is_link_local() || ip.is_broadcast(),
                    std::net::IpAddr::V6(ip) => {
                        ip.is_unicast_link_local() || ip.to_ipv4_mapped().is_some()
                    }
                };
                if address.is_unspecified()
                    || address.is_loopback()
                    || address.is_multicast()
                    || link_local
                {
                    return Err(ObservationError::BindingMismatch);
                }
                Ok(address)
            })
            .collect()
    }
    fn directory(&self, spec: &StorageSpec) -> PathBuf {
        self.state.join("services").join(&spec.name)
    }
    fn load(&self, spec: &StorageSpec) -> Result<Option<Receipt>, ObservationError> {
        spec.validate().map_err(|_| ObservationError::Query)?;
        let bytes = match std::fs::read(self.directory(spec).join("receipt.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(ObservationError::Incomplete),
        };
        let receipt: Receipt =
            serde_json::from_slice(&bytes).map_err(|_| ObservationError::Incomplete)?;
        if receipt.storage != *spec {
            return Err(ObservationError::BindingMismatch);
        }
        Ok(Some(receipt))
    }
    fn save(&self, receipt: &Receipt) -> Result<(), ObservationError> {
        let directory = self.directory(&receipt.storage);
        private_directory(&directory)?;
        crate::state::save_json(&directory.join("receipt.json"), receipt)
            .map_err(|_| ObservationError::Incomplete)
    }
    fn cluster(&self, spec: &StorageSpec) -> Cluster {
        Cluster::new(self.client.clone(), &spec.owner, &spec.generation)
    }

    /// Check authored class names without creating resources or requiring a new namespace.
    pub async fn preflight(
        &self,
        spec: &StorageSpec,
        runtime_class: Option<&str>,
    ) -> Result<(), ObservationError> {
        spec.validate().map_err(|_| ObservationError::Query)?;
        let cluster = self.cluster(spec);
        let existing = self.load(spec)?;
        if let Some(receipt) = &existing {
            self.verify_storage(receipt, false).await?;
        } else if GatewayReceipt::load(&self.state, &spec.owner, &spec.gateway.name)?
            .is_some_and(|receipt| receipt.storage_ready)
        {
            self.gateway(spec, false).await?;
        }
        let storage_class = if existing
            .as_ref()
            .is_some_and(|receipt| receipt.volumes.len() == storage_objects(spec).len())
        {
            None
        } else {
            spec.storage_class.as_deref()
        };
        for (api, kind, name) in [
            ("storage.k8s.io/v1", "StorageClass", storage_class),
            ("node.k8s.io/v1", "RuntimeClass", runtime_class),
        ] {
            if let Some(name) = name {
                let address = Owned {
                    api_version: api.into(),
                    kind: kind.into(),
                    namespace: String::new(),
                    name: name.into(),
                    uid: String::new(),
                };
                if cluster
                    .get(&address)
                    .await?
                    .and_then(|object| object.metadata.uid)
                    .is_none()
                {
                    return Err(ObservationError::Backend(
                        "the selected model StorageClass or RuntimeClass does not exist; resources retained",
                    ));
                }
            }
        }
        Ok(())
    }

    async fn gateway(
        &self,
        spec: &StorageSpec,
        require_identity: bool,
    ) -> Result<(ClusterIdentity, Owned, Option<Identity>), ObservationError> {
        let gateway = GatewayReceipt::load(&self.state, &spec.owner, &spec.gateway.name)?
            .ok_or(ObservationError::Incomplete)?;
        if !gateway.storage_ready {
            return Err(ObservationError::Incomplete);
        }
        let cluster = self.cluster(spec);
        let system = cluster
            .get(&Owned {
                api_version: "v1".into(),
                kind: "Namespace".into(),
                namespace: String::new(),
                name: "kube-system".into(),
                uid: String::new(),
            })
            .await?
            .and_then(|object| object.metadata.uid)
            .ok_or(ObservationError::Incomplete)?;
        let identity = ClusterIdentity {
            server: self.server.clone(),
            system_uid: system,
        };
        if gateway.cluster.as_ref() != Some(&identity) {
            return Err(ObservationError::BindingMismatch);
        }
        let namespace = gateway
            .objects
            .iter()
            .find(|object| {
                object.kind == "Namespace"
                    && object.name == spec.namespace()
                    && object.namespace.is_empty()
            })
            .ok_or(ObservationError::Incomplete)?
            .clone();
        let observed = cluster.verify(&namespace).await?;
        let openshift =
            spec.gateway.settings.runtime.provider == crate::config::ComputeDriver::OpenShift;
        if openshift {
            let current =
                Identity::from_annotations(&observed.metadata.annotations.unwrap_or_default());
            if (require_identity && gateway.namespace_identity.is_none())
                || (gateway.namespace_identity.is_some() && current != gateway.namespace_identity)
            {
                return Err(ObservationError::BindingMismatch);
            }
        }
        Ok((
            identity,
            namespace,
            if openshift {
                gateway.namespace_identity
            } else {
                None
            },
        ))
    }

    async fn verify(
        &self,
        spec: &StorageSpec,
        owned: &Owned,
    ) -> Result<kube::api::DynamicObject, ObservationError> {
        let object = self.cluster(spec).verify(owned).await?;
        if object
            .metadata
            .labels
            .as_ref()
            .and_then(|labels| labels.get(GENERATION_LABEL))
            != Some(&spec.generation)
        {
            return Err(ObservationError::BindingMismatch);
        }
        Ok(object)
    }
    async fn verify_storage(
        &self,
        receipt: &Receipt,
        complete: bool,
    ) -> Result<Option<Identity>, ObservationError> {
        let (cluster, namespace, identity) = self.gateway(&receipt.storage, true).await?;
        if cluster != receipt.cluster || namespace.uid != receipt.namespace_uid {
            return Err(ObservationError::BindingMismatch);
        }
        for volume in &receipt.volumes {
            self.verify(&receipt.storage, volume).await?;
        }
        if complete
            && (!receipt.storage_ready
                || receipt.volumes.len() != storage_objects(&receipt.storage).len())
        {
            return Err(ObservationError::Incomplete);
        }
        Ok(identity)
    }
    fn bound(response: Response, prior: Option<&str>) -> Result<Response, ObservationError> {
        if let Some(prior) = prior {
            match response.id.as_deref() {
                Some(id) if id == prior => {}
                Some(_) => return Err(ObservationError::BindingMismatch),
                None => return Err(ObservationError::Incomplete),
            }
        }
        Ok(response)
    }
    pub async fn read_storage(
        &self,
        spec: &StorageSpec,
        prior: Option<&str>,
    ) -> Result<Response, ObservationError> {
        let Some(receipt) = self.load(spec)? else {
            return Self::bound(Response::default(), prior);
        };
        self.verify_storage(&receipt, false).await?;
        Self::bound(
            Response {
                id: receipt.volumes.first().map(|owned| owned.uid.clone()),
                running: (!receipt.volumes.is_empty()).then_some(receipt.storage_ready),
            },
            prior,
        )
    }
    pub async fn ensure_storage(
        &self,
        spec: &StorageSpec,
        prior: Option<&str>,
    ) -> Result<Response, ObservationError> {
        self.preflight(spec, None).await?;
        self.read_storage(spec, prior).await?;
        let (cluster, namespace, _) = self.gateway(spec, true).await?;
        let mut receipt = self.load(spec)?.unwrap_or(Receipt {
            storage: spec.clone(),
            cluster,
            namespace_uid: namespace.uid,
            volumes: Vec::new(),
            storage_ready: false,
            compute: Vec::new(),
            specification: None,
            compute_bound: false,
        });
        self.save(&receipt)?;
        for object in storage_objects(spec) {
            let address = Owned::new(&object, "");
            if let Some(owned) = receipt
                .volumes
                .iter()
                .find(|owned| owned.name == address.name)
            {
                self.verify(spec, owned).await?;
            } else {
                receipt
                    .volumes
                    .push(self.cluster(spec).create(object).await?);
                self.save(&receipt)?;
            }
        }
        receipt.storage_ready = true;
        self.save(&receipt)?;
        self.read_storage(spec, prior).await
    }

    async fn observe(
        &self,
        spec: &Spec,
        prior: Option<&str>,
        removing: bool,
    ) -> Result<Response, ObservationError> {
        spec.validate().map_err(|_| ObservationError::Query)?;
        let Some(receipt) = self.load(&spec.storage())? else {
            return Self::bound(Response::default(), prior);
        };
        self.verify_storage(&receipt, true).await?;
        if !receipt.compute_bound && receipt.compute.is_empty() {
            return Ok(Response::default());
        }
        let cluster = self.cluster(&receipt.storage);
        let mut running = false;
        for owned in &receipt.compute {
            let Some(_) = cluster.get(owned).await? else {
                if removing || owned.kind == "Pod" {
                    continue;
                }
                return Err(ObservationError::BindingMismatch);
            };
            let object = self.verify(&receipt.storage, owned).await?;
            if owned.kind == "Pod" {
                Self::verify_pod(&receipt, &object)?;
            }
            if owned.kind == "Pod"
                && !removing
                && receipt.specification.as_ref() == Some(spec)
                && object.data.pointer("/status/phase").and_then(Value::as_str) == Some("Running")
            {
                let started = super::status::started(&object)?;
                let bytes = super::status::execute(
                    self.client.clone(),
                    spec.namespace(),
                    &owned.name,
                    false,
                )
                .await?;
                let after = self.verify(&receipt.storage, owned).await?;
                if super::status::started(&after)? != started {
                    return Err(ObservationError::BindingMismatch);
                }
                running = super::status::phase(
                    bytes.as_deref(),
                    started,
                    time::OffsetDateTime::now_utc(),
                )? == "ready";
            }
        }
        Self::bound(
            Response {
                id: receipt
                    .compute_bound
                    .then(|| Self::compute_id(&receipt))
                    .transpose()?,
                running: receipt.compute_bound.then_some(running),
            },
            prior,
        )
    }
    fn verify_pod(
        receipt: &Receipt,
        object: &kube::api::DynamicObject,
    ) -> Result<(), ObservationError> {
        let spec = receipt
            .specification
            .as_ref()
            .ok_or(ObservationError::Incomplete)?;
        let containers = object
            .data
            .pointer("/spec/containers")
            .and_then(Value::as_array)
            .ok_or(ObservationError::Incomplete)?;
        let runtime = containers
            .iter()
            .find(|container| container["name"] == "runtime")
            .ok_or(ObservationError::Incomplete)?;
        if runtime["image"].as_str() != Some(&spec.image)
            || runtime["command"] != serde_json::json!(["/usr/local/bin/nemoclaw-runtime"])
            || runtime["envFrom"][0]["configMapRef"]["name"].as_str() != Some(&spec.name)
        {
            return Err(ObservationError::BindingMismatch);
        }
        let volumes = object
            .data
            .pointer("/spec/volumes")
            .and_then(Value::as_array)
            .ok_or(ObservationError::Incomplete)?;
        let mounts = runtime["volumeMounts"]
            .as_array()
            .ok_or(ObservationError::Incomplete)?;
        for (name, suffix, path) in [
            ("models", "data", "/data"),
            ("credentials", "auth", "/credentials"),
        ] {
            if name == "credentials" && !receipt.storage.authenticated {
                continue;
            }
            let volume = volumes
                .iter()
                .find(|volume| volume["name"] == name)
                .ok_or(ObservationError::BindingMismatch)?;
            let mount = mounts
                .iter()
                .find(|mount| mount["mountPath"] == path)
                .ok_or(ObservationError::BindingMismatch)?;
            if volume["persistentVolumeClaim"]["claimName"] != format!("{}-{suffix}", spec.name)
                || mount["name"] != name
                || mount.get("subPath").is_some()
                || mount.get("subPathExpr").is_some()
                || mount["readOnly"] == true
                || volume["persistentVolumeClaim"]["readOnly"] == true
            {
                return Err(ObservationError::BindingMismatch);
            }
        }
        Ok(())
    }
    pub async fn read(
        &self,
        spec: &Spec,
        prior: Option<&str>,
    ) -> Result<Response, ObservationError> {
        self.observe(spec, prior, false).await
    }
    pub async fn read_for_removal(
        &self,
        spec: &Spec,
        prior: Option<&str>,
    ) -> Result<Response, ObservationError> {
        self.observe(spec, prior, true).await
    }
    pub async fn ensure(
        &self,
        spec: &Spec,
        prior: Option<&str>,
    ) -> Result<Response, ObservationError> {
        spec.validate().map_err(|_| ObservationError::Query)?;
        self.preflight(&spec.storage(), spec.settings.runtime_class_name.as_deref())
            .await?;
        let mut receipt = self
            .load(&spec.storage())?
            .ok_or(ObservationError::Incomplete)?;
        let identity = self.verify_storage(&receipt, true).await?;
        if let Some(recorded) = &receipt.specification {
            self.read_for_removal(recorded, prior).await?;
            if recorded.port() != spec.port() {
                return Err(ObservationError::Backend(
                    "changing the model serving port requires destroy and apply; storage retained",
                ));
            }
            if recorded != spec {
                self.clear_runtime(&mut receipt).await?;
            }
        } else if let Some(prior) = prior
            && prior != Self::compute_id(&receipt)?
        {
            return Err(ObservationError::BindingMismatch);
        }
        receipt.specification = Some(spec.clone());
        self.save(&receipt)?;
        for object in compute_objects(spec, identity) {
            let address = Owned::new(&object, "");
            let recorded = receipt
                .compute
                .iter()
                .position(|owned| owned.kind == address.kind && owned.name == address.name);
            if let Some(index) = recorded {
                let owned = receipt.compute[index].clone();
                let current = self.cluster(&receipt.storage).get(&owned).await?;
                let recreate = owned.kind == "Pod"
                    && (current.is_none()
                        || current
                            .as_ref()
                            .and_then(|object| object.data.pointer("/status/phase"))
                            .and_then(Value::as_str)
                            .is_some_and(|phase| matches!(phase, "Failed" | "Succeeded")));
                if !recreate {
                    self.verify(&receipt.storage, &owned).await?;
                    continue;
                }
                if current.is_some() {
                    self.verify(&receipt.storage, &owned).await?;
                    self.delete(&receipt.storage, &owned).await?;
                }
                receipt.compute.remove(index);
                self.save(&receipt)?;
            }
            receipt
                .compute
                .push(self.cluster(&receipt.storage).create(object).await?);
            receipt.compute_bound = true;
            self.save(&receipt)?;
        }
        self.read(spec, None).await
    }

    async fn delete(&self, spec: &StorageSpec, owned: &Owned) -> Result<(), ObservationError> {
        let cluster = self.cluster(spec);
        cluster.delete(owned).await?;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        while let Some(object) = cluster.get(owned).await? {
            if object.metadata.uid.as_deref() != Some(&owned.uid) {
                return Err(ObservationError::BindingMismatch);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(ObservationError::Incomplete);
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        Ok(())
    }
    fn compute_id(receipt: &Receipt) -> Result<String, ObservationError> {
        Ok(format!(
            "{}:{}",
            receipt
                .volumes
                .first()
                .ok_or(ObservationError::Incomplete)?
                .uid,
            receipt.storage.generation
        ))
    }
    async fn clear_runtime(&self, receipt: &mut Receipt) -> Result<(), ObservationError> {
        // Preserve the ClusterIP and its ingress policy: provider profiles bind that address.
        for kind in ["Pod", "ConfigMap"] {
            if let Some(index) = receipt.compute.iter().position(|owned| owned.kind == kind) {
                self.delete(&receipt.storage, &receipt.compute[index])
                    .await?;
                receipt.compute.remove(index);
                self.save(receipt)?;
            }
        }
        Ok(())
    }
    async fn clear_compute(&self, receipt: &mut Receipt) -> Result<(), ObservationError> {
        while let Some(owned) = receipt.compute.last().cloned() {
            self.delete(&receipt.storage, &owned).await?;
            receipt.compute.pop();
            self.save(receipt)?;
        }
        receipt.specification = None;
        receipt.compute_bound = false;
        self.save(receipt)
    }
    pub async fn remove(&self, spec: &Spec, prior: Option<&str>) -> Result<(), ObservationError> {
        self.read_for_removal(spec, prior).await?;
        let Some(mut receipt) = self.load(&spec.storage())? else {
            return Ok(());
        };
        self.clear_compute(&mut receipt).await
    }
    /// Explicit reconciliation recreates only missing or terminal disposable workloads.
    pub async fn recover(&self, spec: &Spec) -> Result<Response, ObservationError> {
        self.ensure(spec, None).await
    }

    pub async fn wait_ready(&self, spec: &Spec) -> Result<Response, ObservationError> {
        let seconds = match &spec.runtime {
            nemoclaw_runtime::RuntimeSpec::Vllm(service) => service.serving.startup_timeout_seconds,
            nemoclaw_runtime::RuntimeSpec::Ollama(service) => {
                service.serving.startup_timeout_seconds
            }
        };
        let wait = async {
            loop {
                let response = self.read(spec, None).await?;
                if response.running == Some(true) {
                    return Ok(response);
                }
                let receipt = self
                    .load(&spec.storage())?
                    .ok_or(ObservationError::Incomplete)?;
                let pod = receipt
                    .compute
                    .iter()
                    .find(|owned| owned.kind == "Pod")
                    .ok_or(ObservationError::Incomplete)?;
                let object = self.verify(&receipt.storage, pod).await?;
                if object
                    .data
                    .pointer("/status/phase")
                    .and_then(Value::as_str)
                    .is_some_and(|phase| matches!(phase, "Failed" | "Succeeded"))
                {
                    return Err(ObservationError::Backend(
                        "model runtime stopped before readiness; storage retained",
                    ));
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(seconds as u64), wait)
            .await
            .map_err(|_| {
                ObservationError::Backend("model runtime readiness timed out; storage retained")
            })?
    }

    pub async fn credential(&self, spec: &StorageSpec) -> Result<String, ObservationError> {
        if !spec.authenticated {
            return Err(ObservationError::BindingMismatch);
        }
        let receipt = self.load(spec)?.ok_or(ObservationError::Incomplete)?;
        self.verify_storage(&receipt, true).await?;
        let compute = receipt
            .specification
            .as_ref()
            .ok_or(ObservationError::Incomplete)?;
        if self.read(compute, None).await?.running != Some(true) {
            return Err(ObservationError::Incomplete);
        }
        let pod = receipt
            .compute
            .iter()
            .find(|owned| owned.kind == "Pod")
            .ok_or(ObservationError::Incomplete)?;
        Self::verify_pod(&receipt, &self.verify(spec, pod).await?)?;
        let bytes = super::status::execute(self.client.clone(), spec.namespace(), &pod.name, true)
            .await?
            .ok_or(ObservationError::Incomplete)?;
        Self::verify_pod(&receipt, &self.verify(spec, pod).await?)?;
        let key = String::from_utf8(bytes).map_err(|_| ObservationError::Incomplete)?;
        if key.len() != 64
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(ObservationError::Incomplete);
        }
        Ok(key)
    }
}
