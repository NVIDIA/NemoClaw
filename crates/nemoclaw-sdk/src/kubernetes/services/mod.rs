// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Retained model storage and disposable inference workloads on the gateway cluster.

mod operations;
mod resources;
mod status;
use crate::{Error, config::ImagePullPolicy, services::KubernetesService};
use nemoclaw_runtime::RuntimeSpec;
pub use operations::{Operations, Response};
pub use resources::{compute_objects, storage_objects};
use serde::{Deserialize, Serialize};

pub const SERVICE_KIND: &str = "kubernetes_service";
pub const STORAGE_KIND: &str = "kubernetes_service_storage";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Spec {
    pub layout: u32,
    pub kind: String,
    pub name: String,
    pub owner: String,
    pub generation: String,
    pub gateway: super::Spec,
    pub image: String,
    pub image_pull_policy: Option<ImagePullPolicy>,
    pub runtime: RuntimeSpec,
    pub settings: KubernetesService,
    pub shared_memory_gib: u64,
    pub architecture: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StorageSpec {
    pub layout: u32,
    pub kind: String,
    pub name: String,
    pub owner: String,
    pub generation: String,
    pub gateway: super::Spec,
    pub storage_gib: u64,
    pub storage_class: Option<String>,
    pub authenticated: bool,
}

impl StorageSpec {
    pub fn validate(&self) -> Result<(), Error> {
        self.gateway.validate()?;
        if self.layout != 1
            || self.kind != STORAGE_KIND
            || self.owner != self.gateway.owner
            || !regex::Regex::new(r"^nc-[a-f0-9]{16}-model-[a-f0-9]{16}$")
                .unwrap()
                .is_match(&self.name)
            || !regex::Regex::new(r"^[a-f0-9]{32}$")
                .unwrap()
                .is_match(&self.generation)
            || self.storage_gib == 0
        {
            return Err(Error::Conflict(
                "invalid Kubernetes model storage specification",
            ));
        }
        Ok(())
    }
    pub fn namespace(&self) -> &str {
        &self
            .gateway
            .settings
            .kubernetes
            .as_ref()
            .expect("validated cluster target")
            .namespace
    }
    pub fn encode(&self) -> Result<String, Error> {
        self.validate()?;
        serde_json::to_string(self)
            .map_err(|_| Error::State("cannot encode model storage specification"))
    }
    pub fn decode(value: &str) -> Result<Self, Error> {
        let spec: Self = serde_json::from_str(value)
            .map_err(|_| Error::Conflict("invalid model storage specification"))?;
        spec.validate()?;
        Ok(spec)
    }
}

impl Spec {
    pub fn authenticated(&self) -> bool {
        matches!(&self.runtime, RuntimeSpec::Vllm(service) if service.authentication.is_some())
    }
    pub fn storage(&self) -> StorageSpec {
        StorageSpec {
            layout: self.layout,
            kind: STORAGE_KIND.into(),
            name: self.name.clone(),
            owner: self.owner.clone(),
            generation: self.generation.clone(),
            gateway: self.gateway.clone(),
            storage_gib: self.settings.storage_gib,
            storage_class: self.settings.storage_class.clone(),
            authenticated: self.authenticated(),
        }
    }
    pub fn namespace(&self) -> &str {
        &self
            .gateway
            .settings
            .kubernetes
            .as_ref()
            .expect("validated cluster target")
            .namespace
    }
    pub fn port(&self) -> i64 {
        match &self.runtime {
            RuntimeSpec::Vllm(service) => service.serving.port,
            RuntimeSpec::Ollama(service) => service.serving.port,
        }
    }
    pub fn endpoint(&self) -> String {
        format!(
            "http://{}.{}.svc:{}{}",
            self.name,
            self.namespace(),
            self.port(),
            "/v1"
        )
    }
    pub fn validate(&self) -> Result<(), Error> {
        self.storage().validate()?;
        self.settings.validate()?;
        let architecture = match &self.runtime {
            RuntimeSpec::Vllm(service) => service.architecture()?,
            RuntimeSpec::Ollama(service) => service.architecture()?,
        };
        if self.architecture != architecture {
            return Err(Error::Conflict(
                "workload architecture conflicts with the model runtime",
            ));
        }
        for (key, expected) in [
            ("kubernetes.io/os", "linux"),
            ("kubernetes.io/arch", self.architecture.as_str()),
        ] {
            if self
                .settings
                .node_selector
                .get(key)
                .is_some_and(|value| value != expected)
            {
                return Err(Error::Conflict(
                    "node selector conflicts with the model runtime architecture",
                ));
            }
        }
        if self.kind != SERVICE_KIND
            || !matches!(self.architecture.as_str(), "amd64" | "arm64")
            || self.shared_memory_gib == 0
            || !regex::Regex::new(crate::config::constraints::IMAGE)
                .unwrap()
                .is_match(&self.image)
        {
            return Err(Error::Conflict(
                "invalid Kubernetes model workload specification",
            ));
        }
        let text = serde_json::to_string(&self.runtime)
            .map_err(|_| Error::State("cannot encode model runtime"))?;
        RuntimeSpec::decode(&text)?;
        Ok(())
    }
    pub fn encode(&self) -> Result<String, Error> {
        self.validate()?;
        serde_json::to_string(self)
            .map_err(|_| Error::State("cannot encode model workload specification"))
    }
    pub fn decode(value: &str) -> Result<Self, Error> {
        let spec: Self = serde_json::from_str(value)
            .map_err(|_| Error::Conflict("invalid model workload specification"))?;
        spec.validate()?;
        Ok(spec)
    }
}
