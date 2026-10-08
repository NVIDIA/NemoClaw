// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Each create is recorded before the next mutation. PVC bindings outlive compute.
use super::{Spec, StorageSpec, compute_objects, storage_objects};
use crate::{
    ObservationError,
    kubernetes::{
        cluster::{Cluster, GENERATION_LABEL, OWNER_LABEL, Owned},
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending: Option<Owned>,
}

impl Operations {
    fn mismatch(owned: &Owned, field: &'static str) -> ObservationError {
        ObservationError::KubernetesObjectMismatch {
            kind: owned.kind.clone(),
            namespace: owned.namespace.clone(),
            name: owned.name.clone(),
            field,
        }
    }

    fn compute_mismatch(receipt: &Receipt, kind: &str, field: &'static str) -> ObservationError {
        Self::mismatch(
            &Owned {
                api_version: String::new(),
                kind: kind.into(),
                namespace: receipt.storage.namespace().into(),
                name: receipt.storage.name.clone(),
                uid: String::new(),
            },
            field,
        )
    }

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
            return Err(Self::compute_mismatch(&receipt, "Service", "endpoint"));
        }
        let service = receipt
            .compute
            .iter()
            .find(|owned| owned.kind == "Service")
            .ok_or(ObservationError::Incomplete)?;
        let observed = self.verify(spec, service).await?;
        Self::verify_compute_spec(&receipt, &observed)?;
        self.verify_endpoints(&receipt, service).await?;
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
                if !super::service_address_allowed(&address) {
                    return Err(Self::mismatch(service, "spec.clusterIPs"));
                }
                Ok(address)
            })
            .collect()
    }

    async fn verify_endpoints(
        &self,
        receipt: &Receipt,
        service: &Owned,
    ) -> Result<(), ObservationError> {
        use k8s_openapi::api::discovery::v1::EndpointSlice;
        let pod = receipt
            .compute
            .iter()
            .find(|owned| owned.kind == "Pod")
            .ok_or(ObservationError::Incomplete)?;
        let slices =
            kube::Api::<EndpointSlice>::namespaced(self.client.clone(), &service.namespace)
                .list(
                    &kube::api::ListParams::default()
                        .labels(&format!("kubernetes.io/service-name={}", service.name)),
                )
                .await
                .map_err(|error| match error {
                    kube::Error::Api(status) if status.code == 401 => {
                        ObservationError::Authentication
                    }
                    kube::Error::Api(status) if status.code == 403 => ObservationError::Permission,
                    kube::Error::Api(_) => ObservationError::Query,
                    _ => ObservationError::Transport,
                })?;
        for slice in slices {
            for endpoint in slice.endpoints.unwrap_or_default() {
                if endpoint
                    .conditions
                    .as_ref()
                    .and_then(|conditions| conditions.ready)
                    == Some(false)
                {
                    continue;
                }
                if !endpoint.target_ref.as_ref().is_some_and(|target| {
                    target.kind.as_deref() == Some("Pod")
                        && target.namespace.as_deref() == Some(&pod.namespace)
                        && target.name.as_deref() == Some(&pod.name)
                        && target.uid.as_deref() == Some(&pod.uid)
                }) {
                    return Err(Self::mismatch(
                        &Owned {
                            api_version: "discovery.k8s.io/v1".into(),
                            kind: "EndpointSlice".into(),
                            namespace: service.namespace.clone(),
                            name: slice.metadata.name.clone().unwrap_or_default(),
                            uid: String::new(),
                        },
                        "endpoints.targetRef",
                    ));
                }
            }
        }
        Ok(())
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

    async fn settle_pending(&self, receipt: &mut Receipt) -> Result<(), ObservationError> {
        if let Some(pending) = &receipt.pending {
            if self.cluster(&receipt.storage).get(pending).await?.is_some() {
                return Err(ObservationError::UnrecordedResource {
                    kind: pending.kind.clone(),
                    namespace: pending.namespace.clone(),
                    name: pending.name.clone(),
                });
            }
            receipt.pending = None;
            self.save(receipt)?;
        }
        Ok(())
    }

    async fn create_recorded(
        &self,
        receipt: &mut Receipt,
        object: Value,
        volume: bool,
    ) -> Result<(), ObservationError> {
        let cluster = self.cluster(&receipt.storage);
        let address = Owned::new(&object, "");
        if cluster.get(&address).await?.is_some() {
            return Err(Self::mismatch(&address, "receipt binding"));
        }
        receipt.pending = Some(address);
        self.save(receipt)?;
        let owned = match cluster.create_model(object).await {
            Ok(owned) => owned,
            Err(error) => {
                // Keep the pending address unless an authoritative read proves no object exists.
                let _ = self.settle_pending(receipt).await;
                return Err(error);
            }
        };
        if volume {
            receipt.volumes.push(owned);
        } else {
            receipt.compute.push(owned);
            receipt.compute_bound = true;
        }
        receipt.pending = None;
        self.save(receipt)
    }

    fn verify_compute_spec(
        receipt: &Receipt,
        object: &kube::api::DynamicObject,
    ) -> Result<(), ObservationError> {
        let kind = object
            .types
            .as_ref()
            .map(|types| types.kind.as_str())
            .ok_or(ObservationError::Incomplete)?;
        let fields: &[(&str, &str)] = match kind {
            "Service" => &[
                ("type", "spec.type"),
                ("selector", "spec.selector"),
                ("ports", "spec.ports"),
            ],
            "NetworkPolicy" => &[
                ("podSelector", "spec.podSelector"),
                ("policyTypes", "spec.policyTypes"),
                ("ingress", "spec.ingress"),
            ],
            "ConfigMap" => &[],
            _ => return Ok(()),
        };
        let spec = receipt
            .specification
            .as_ref()
            .ok_or(ObservationError::Incomplete)?;
        let expected = compute_objects(spec, None)
            .into_iter()
            .find(|value| value["kind"] == kind)
            .ok_or(ObservationError::Incomplete)?;
        for (field, diagnostic) in fields {
            if object.data["spec"][field] != expected["spec"][field] {
                return Err(Self::compute_mismatch(receipt, kind, diagnostic));
            }
        }
        let extra = match kind {
            "Service" => "externalIPs",
            "NetworkPolicy" => "egress",
            _ => "",
        };
        if !extra.is_empty()
            && object.data["spec"].get(extra).is_some_and(|value| {
                !value.is_null() && value.as_array().is_none_or(|values| !values.is_empty())
            })
        {
            return Err(Self::compute_mismatch(
                receipt,
                kind,
                if kind == "Service" {
                    "spec.externalIPs"
                } else {
                    "spec.egress"
                },
            ));
        }
        if kind == "ConfigMap" {
            if object.data["data"] != expected["data"] {
                return Err(Self::compute_mismatch(receipt, kind, "data"));
            }
            if object.data["immutable"] != true {
                return Err(Self::compute_mismatch(receipt, kind, "immutable"));
            }
        }
        Ok(())
    }

    pub async fn preflight_workload(&self, spec: &Spec) -> Result<(), ObservationError> {
        spec.validate().map_err(|_| ObservationError::Query)?;
        self.preflight(&spec.storage(), spec.settings.runtime_class_name.as_deref())
            .await?;
        let receipt = self.load(&spec.storage())?;
        let identity = match &receipt {
            Some(receipt) => self.verify_storage(receipt, false).await?,
            None if GatewayReceipt::load(&self.state, &spec.owner, &spec.gateway.name)?
                .is_some_and(|receipt| receipt.storage_ready) =>
            {
                self.gateway(&spec.storage(), true).await?.2
            }
            None => None,
        };
        let desired = compute_objects(spec, identity);
        self.dry_run_missing(&spec.storage(), desired.clone())
            .await?;
        if let Some(receipt) = &receipt
            && receipt
                .specification
                .as_ref()
                .is_some_and(|recorded| compute_objects(recorded, identity) != desired)
        {
            // CREATE admission cannot use a live object's name. Validate only
            // the replacements, under unique names, before deleting runtime
            // objects. This can conservatively reject at full namespace quota:
            // dry-run cannot simulate the old Pod's deletion without mutation.
            for mut object in desired
                .into_iter()
                .filter(|object| matches!(object["kind"].as_str(), Some("Pod" | "ConfigMap")))
            {
                let address = Owned::new(&object, "");
                if self
                    .cluster(&receipt.storage)
                    .get(&address)
                    .await?
                    .is_none()
                {
                    continue;
                }
                let owned = receipt
                    .compute
                    .iter()
                    .find(|owned| owned.kind == address.kind && owned.name == address.name)
                    .ok_or_else(|| Self::mismatch(&address, "receipt binding"))?;
                let observed = self.verify(&receipt.storage, owned).await?;
                if owned.kind == "Pod" {
                    Self::verify_pod(receipt, &observed)?;
                } else {
                    Self::verify_compute_spec(receipt, &observed)?;
                }
                let mut suffix = [0u8; 6];
                getrandom::fill(&mut suffix).map_err(|_| ObservationError::Incomplete)?;
                let suffix: String = suffix.iter().map(|byte| format!("{byte:02x}")).collect();
                object["metadata"]["name"] = format!("{}-check-{suffix}", address.name).into();
                self.cluster(&receipt.storage).dry_run(object).await?;
            }
        }
        Ok(())
    }

    async fn dry_run_missing(
        &self,
        spec: &StorageSpec,
        objects: Vec<Value>,
    ) -> Result<(), ObservationError> {
        let cluster = self.cluster(spec);
        // The gateway creates this namespace later on a deployment's first plan.
        let namespace = Owned {
            api_version: "v1".into(),
            kind: "Namespace".into(),
            namespace: String::new(),
            name: spec.namespace().into(),
            uid: String::new(),
        };
        if cluster.get(&namespace).await?.is_none() {
            return Ok(());
        }
        for object in objects {
            if cluster.get(&Owned::new(&object, "")).await?.is_none() {
                cluster.dry_run(object).await?;
            }
        }
        Ok(())
    }

    async fn preflight_access(&self, spec: &StorageSpec) -> Result<(), ObservationError> {
        use k8s_openapi::api::authorization::v1::SelfSubjectAccessReview;
        let reviews = kube::Api::<SelfSubjectAccessReview>::all(self.client.clone());
        for (verb, group, resource, subresource) in [
            ("create", "", "pods", ""),
            ("create", "", "persistentvolumeclaims", ""),
            ("create", "", "configmaps", ""),
            ("create", "", "services", ""),
            ("create", "networking.k8s.io", "networkpolicies", ""),
            ("create", "", "pods", "exec"),
            ("list", "discovery.k8s.io", "endpointslices", ""),
        ] {
            let review = serde_json::from_value(serde_json::json!({"apiVersion":"authorization.k8s.io/v1","kind":"SelfSubjectAccessReview","spec":{"resourceAttributes":{"namespace":spec.namespace(),"verb":verb,"group":group,"resource":resource,"subresource":subresource}}})).map_err(|_| ObservationError::Query)?;
            let response = reviews
                .create(&kube::api::PostParams::default(), &review)
                .await
                .map_err(|error| match error {
                    kube::Error::Api(status) if status.code == 401 => {
                        ObservationError::Authentication
                    }
                    kube::Error::Api(status) if status.code == 403 => ObservationError::Permission,
                    _ => ObservationError::Query,
                })?;
            if !response.status.is_some_and(|status| status.allowed) {
                return Err(ObservationError::Permission);
            }
        }
        Ok(())
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
                    return Err(ObservationError::Backend(if kind == "StorageClass" {
                        "kubernetes.storageClass names a missing StorageClass; create it or select an existing class"
                    } else {
                        "kubernetes.runtimeClassName names a missing RuntimeClass; create it or select an existing class"
                    }));
                }
            }
        }
        self.preflight_access(spec).await?;
        self.dry_run_missing(spec, storage_objects(spec)).await
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
            return Err(Self::mismatch(
                &Owned {
                    api_version: "v1".into(),
                    kind: "Namespace".into(),
                    namespace: String::new(),
                    name: "kube-system".into(),
                    uid: String::new(),
                },
                "cluster identity",
            ));
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
        let observed = self.verify_identity(spec, &namespace).await?;
        let openshift =
            spec.gateway.settings.runtime.provider == crate::config::ComputeDriver::OpenShift;
        if openshift {
            let current =
                Identity::from_annotations(&observed.metadata.annotations.unwrap_or_default());
            if (require_identity && gateway.namespace_identity.is_none())
                || (gateway.namespace_identity.is_some() && current != gateway.namespace_identity)
            {
                return Err(Self::mismatch(
                    &namespace,
                    "metadata.annotations[openshift.io identity]",
                ));
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
        let object = self.verify_identity(spec, owned).await?;
        if object
            .metadata
            .labels
            .as_ref()
            .and_then(|labels| labels.get(GENERATION_LABEL))
            != Some(&spec.generation)
        {
            return Err(Self::mismatch(
                owned,
                "metadata.labels[nemoclaw.nvidia.com/generation]",
            ));
        }
        Ok(object)
    }
    async fn verify_identity(
        &self,
        spec: &StorageSpec,
        owned: &Owned,
    ) -> Result<kube::api::DynamicObject, ObservationError> {
        let object = self
            .cluster(spec)
            .get(owned)
            .await?
            .ok_or_else(|| Self::mismatch(owned, "object presence"))?;
        if object.metadata.uid.as_deref() != Some(&owned.uid) {
            return Err(Self::mismatch(owned, "metadata.uid"));
        }
        if object
            .metadata
            .labels
            .as_ref()
            .and_then(|labels| labels.get(OWNER_LABEL))
            != Some(&spec.owner)
        {
            return Err(Self::mismatch(
                owned,
                "metadata.labels[nemoclaw.nvidia.com/uid]",
            ));
        }
        Ok(object)
    }
    async fn verify_storage(
        &self,
        receipt: &Receipt,
        complete: bool,
    ) -> Result<Option<Identity>, ObservationError> {
        let (cluster, namespace, identity) = self.gateway(&receipt.storage, true).await?;
        if cluster != receipt.cluster {
            return Err(Self::mismatch(&namespace, "cluster identity"));
        }
        if namespace.uid != receipt.namespace_uid {
            return Err(Self::mismatch(&namespace, "metadata.uid"));
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
            pending: None,
        });
        self.settle_pending(&mut receipt).await?;
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
                self.create_recorded(&mut receipt, object, true).await?;
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
        executor: &dyn super::PodExec,
    ) -> Result<Response, ObservationError> {
        spec.validate().map_err(|_| ObservationError::Query)?;
        let Some(receipt) = self.load(&spec.storage())? else {
            return Self::bound(Response::default(), prior);
        };
        self.verify_storage(&receipt, true).await?;
        let compute_bound = receipt.compute_bound
            || !receipt.compute.is_empty()
            || receipt
                .pending
                .as_ref()
                .is_some_and(|pending| pending.kind != "PersistentVolumeClaim");
        if !compute_bound {
            return Ok(Response::default());
        }
        let cluster = self.cluster(&receipt.storage);
        let mut running = false;
        for owned in &receipt.compute {
            let Some(_) = cluster.get(owned).await? else {
                if removing || owned.kind == "Pod" {
                    continue;
                }
                return Err(Self::mismatch(owned, "object presence"));
            };
            let object = self.verify(&receipt.storage, owned).await?;
            if !removing {
                Self::verify_compute_spec(&receipt, &object)?;
            }
            if owned.kind == "Pod" {
                Self::verify_pod(&receipt, &object)?;
            }
            if owned.kind == "Pod"
                && !removing
                && receipt.specification.as_ref() == Some(spec)
                && object.data.pointer("/status/phase").and_then(Value::as_str) == Some("Running")
            {
                let started = super::status::started(&object)?;
                let bytes = executor
                    .read_file(spec.namespace(), &owned.name, super::RuntimeFile::Status)
                    .await?;
                self.verify_storage(&receipt, true).await?;
                let after = self.verify(&receipt.storage, owned).await?;
                Self::verify_pod(&receipt, &after)?;
                if super::status::started(&after)? != started {
                    return Err(Self::mismatch(
                        owned,
                        "status.containerStatuses[runtime].state.running.startedAt",
                    ));
                }
                running = super::status::phase(bytes.as_deref(), started)? == "ready";
            }
        }
        Self::bound(
            Response {
                id: compute_bound
                    .then(|| Self::compute_id(&receipt))
                    .transpose()?,
                running: compute_bound.then_some(running),
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
        if runtime["image"].as_str() != Some(&spec.image) {
            return Err(Self::compute_mismatch(
                receipt,
                "Pod",
                "spec.containers[runtime].image",
            ));
        }
        if runtime["command"] != serde_json::json!(["/usr/local/bin/nemoclaw-runtime"]) {
            return Err(Self::compute_mismatch(
                receipt,
                "Pod",
                "spec.containers[runtime].command",
            ));
        }
        if runtime["envFrom"][0]["configMapRef"]["name"].as_str() != Some(&spec.name) {
            return Err(Self::compute_mismatch(
                receipt,
                "Pod",
                "spec.containers[runtime].envFrom[0].configMapRef.name",
            ));
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
                .ok_or_else(|| Self::compute_mismatch(receipt, "Pod", "spec.volumes"))?;
            let mount = mounts
                .iter()
                .find(|mount| mount["mountPath"] == path)
                .ok_or_else(|| {
                    Self::compute_mismatch(receipt, "Pod", "spec.containers[runtime].volumeMounts")
                })?;
            let mismatches = [
                (
                    volume["persistentVolumeClaim"]["claimName"]
                        != format!("{}-{suffix}", spec.name),
                    "spec.volumes.persistentVolumeClaim.claimName",
                ),
                (
                    mount["name"] != name,
                    "spec.containers[runtime].volumeMounts.name",
                ),
                (
                    mount.get("subPath").is_some(),
                    "spec.containers[runtime].volumeMounts.subPath",
                ),
                (
                    mount.get("subPathExpr").is_some(),
                    "spec.containers[runtime].volumeMounts.subPathExpr",
                ),
                (
                    mount["readOnly"] == true,
                    "spec.containers[runtime].volumeMounts.readOnly",
                ),
                (
                    volume["persistentVolumeClaim"]["readOnly"] == true,
                    "spec.volumes.persistentVolumeClaim.readOnly",
                ),
            ];
            if let Some((_, field)) = mismatches.into_iter().find(|(changed, _)| *changed) {
                return Err(Self::compute_mismatch(receipt, "Pod", field));
            }
        }
        Ok(())
    }
    pub async fn read(
        &self,
        spec: &Spec,
        prior: Option<&str>,
    ) -> Result<Response, ObservationError> {
        self.read_with_exec(
            spec,
            prior,
            &super::status::KubernetesExec(self.client.clone()),
        )
        .await
    }
    pub async fn read_with_exec(
        &self,
        spec: &Spec,
        prior: Option<&str>,
        executor: &dyn super::PodExec,
    ) -> Result<Response, ObservationError> {
        self.observe(spec, prior, false, executor).await
    }
    pub async fn read_for_removal(
        &self,
        spec: &Spec,
        prior: Option<&str>,
    ) -> Result<Response, ObservationError> {
        self.observe(
            spec,
            prior,
            true,
            &super::status::KubernetesExec(self.client.clone()),
        )
        .await
    }
    pub async fn ensure(
        &self,
        spec: &Spec,
        prior: Option<&str>,
    ) -> Result<Response, ObservationError> {
        spec.validate().map_err(|_| ObservationError::Query)?;
        self.preflight_workload(spec).await?;
        let mut receipt = self
            .load(&spec.storage())?
            .ok_or(ObservationError::Incomplete)?;
        let identity = self.verify_storage(&receipt, true).await?;
        self.settle_pending(&mut receipt).await?;
        if let Some(recorded) = &receipt.specification
            && (receipt.compute_bound || !receipt.compute.is_empty())
        {
            self.read_for_removal(recorded, prior).await?;
            // Validate retained network objects before stopping a workload for replacement.
            for owned in &receipt.compute {
                if matches!(owned.kind.as_str(), "Service" | "NetworkPolicy") {
                    let object = self.verify(&receipt.storage, owned).await?;
                    Self::verify_compute_spec(&receipt, &object)?;
                }
            }
            if recorded.port() != spec.port() {
                return Err(ObservationError::Backend(
                    "changing the model serving port requires whole-deployment destroy and apply; destroy deletes sandbox files and conversation history but retains model and credential PVCs",
                ));
            }
            if compute_objects(recorded, identity) != compute_objects(spec, identity) {
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
                let recreate = (matches!(owned.kind.as_str(), "Pod" | "ConfigMap")
                    && current.is_none())
                    || (owned.kind == "Pod"
                        && current
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
            self.create_recorded(&mut receipt, object, false).await?;
        }
        self.read(spec, None).await
    }

    async fn delete(&self, spec: &StorageSpec, owned: &Owned) -> Result<(), ObservationError> {
        let cluster = self.cluster(spec);
        let grace = if owned.kind == "Pod" {
            cluster
                .get(owned)
                .await?
                .and_then(|object| {
                    object
                        .data
                        .pointer("/spec/terminationGracePeriodSeconds")
                        .and_then(Value::as_u64)
                })
                .unwrap_or(60)
        } else {
            0
        };
        cluster.delete(owned).await.map_err(|error| match error {
            ObservationError::BindingMismatch => Self::mismatch(owned, "metadata.uid"),
            error => error,
        })?;
        let deadline =
            tokio::time::Instant::now() + std::time::Duration::from_secs(grace.saturating_add(30));
        while let Some(object) = cluster.get(owned).await? {
            if object.metadata.uid.as_deref() != Some(&owned.uid) {
                return Err(Self::mismatch(owned, "metadata.uid"));
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
        self.settle_pending(&mut receipt).await?;
        self.clear_compute(&mut receipt).await
    }
    /// Explicit reconciliation recreates only missing or terminal disposable workloads.
    pub async fn recover(&self, spec: &Spec) -> Result<Response, ObservationError> {
        self.ensure(spec, None).await
    }

    pub async fn wait_ready(&self, spec: &Spec) -> Result<Response, ObservationError> {
        self.wait_ready_with_exec(spec, &super::status::KubernetesExec(self.client.clone()))
            .await
    }

    pub async fn wait_ready_with_exec(
        &self,
        spec: &Spec,
        executor: &dyn super::PodExec,
    ) -> Result<Response, ObservationError> {
        // The runtime applies startupTimeoutSeconds during model loading. Download
        // and preparation retain the same overall readiness budget as Docker.
        super::readiness::wait(|| async {
            let receipt = self
                .load(&spec.storage())?
                .ok_or(ObservationError::Incomplete)?;
            self.verify_storage(&receipt, true).await?;
            let pod = receipt
                .compute
                .iter()
                .find(|owned| owned.kind == "Pod")
                .ok_or(ObservationError::Incomplete)?;
            let object = self.verify(&receipt.storage, pod).await?;
            Self::verify_pod(&receipt, &object)?;
            if let Some(error) = super::status::terminal(&object) {
                return Err(error);
            }
            self.read_with_exec(spec, None, executor).await
        })
        .await
    }

    pub async fn credential(&self, spec: &StorageSpec) -> Result<String, ObservationError> {
        self.credential_with_exec(spec, &super::status::KubernetesExec(self.client.clone()))
            .await
    }

    pub async fn credential_with_exec(
        &self,
        spec: &StorageSpec,
        executor: &dyn super::PodExec,
    ) -> Result<String, ObservationError> {
        if !spec.authenticated {
            return Err(ObservationError::BindingMismatch);
        }
        let receipt = self.load(spec)?.ok_or(ObservationError::Incomplete)?;
        self.verify_storage(&receipt, true).await?;
        let compute = receipt
            .specification
            .as_ref()
            .ok_or(ObservationError::Incomplete)?;
        if self.read_with_exec(compute, None, executor).await?.running != Some(true) {
            return Err(ObservationError::Incomplete);
        }
        let pod = receipt
            .compute
            .iter()
            .find(|owned| owned.kind == "Pod")
            .ok_or(ObservationError::Incomplete)?;
        let before = self.verify(spec, pod).await?;
        Self::verify_pod(&receipt, &before)?;
        let started = super::status::started(&before)?;
        let bytes = executor
            .read_file(spec.namespace(), &pod.name, super::RuntimeFile::Credential)
            .await?
            .ok_or(ObservationError::Incomplete)?;
        self.verify_storage(&receipt, true).await?;
        let after = self.verify(spec, pod).await?;
        Self::verify_pod(&receipt, &after)?;
        if super::status::started(&after)? != started {
            return Err(Self::mismatch(
                pod,
                "status.containerStatuses[runtime].state.running.startedAt",
            ));
        }
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
