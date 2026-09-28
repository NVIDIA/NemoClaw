// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Managed development gateway on an explicitly selected Kubernetes cluster.
//! Platform commands run through the same provider lifecycle as other backends.

mod connection;
mod runner;
#[cfg(test)]
mod tests;

use crate::{
    Error, ObservationError,
    backend::{Backend, Mutation, Row},
    config::ManagedGateway,
};
use async_trait::async_trait;
pub use connection::{Connection, connection};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

pub const STORAGE_KIND: &str = "kubernetes_storage";
pub const GATEWAY_KIND: &str = "kubernetes_gateway";
pub const STATE_ENV: &str = "NEMOCLAW_KUBERNETES_STATE";
pub const TOKEN_ENV: &str = "NEMOCLAW_MANAGED_K8S_TOKEN";
pub const CA_ENV: &str = "NEMOCLAW_MANAGED_K8S_CA";
pub const CERT_ENV: &str = "NEMOCLAW_MANAGED_K8S_CERT";
pub const KEY_ENV: &str = "NEMOCLAW_MANAGED_K8S_KEY";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Spec {
    pub layout: u32,
    pub kind: String,
    pub name: String,
    pub owner: String,
    pub generation: String,
    pub settings: ManagedGateway,
}

impl Spec {
    pub fn validate(&self) -> Result<(), Error> {
        if self.layout != 1
            || !matches!(self.kind.as_str(), STORAGE_KIND | GATEWAY_KIND)
            || !regex::Regex::new(r"^nc-[a-f0-9]{16}-gateway$")
                .unwrap()
                .is_match(&self.name)
            || !regex::Regex::new(r"^[a-f0-9-]{36}$")
                .unwrap()
                .is_match(&self.owner)
            || !regex::Regex::new(r"^[a-f0-9]{32}$")
                .unwrap()
                .is_match(&self.generation)
            || self.settings.kubernetes.is_none()
        {
            return Err(Error::Conflict(
                "invalid managed Kubernetes identity or layout",
            ));
        }
        self.settings.validate_managed()?;
        Ok(())
    }
    pub fn decode(value: &str) -> Result<Self, Error> {
        let spec: Self = serde_json::from_str(value)
            .map_err(|_| Error::Conflict("invalid managed Kubernetes specification"))?;
        spec.validate()?;
        Ok(spec)
    }
    pub fn encode(&self) -> Result<String, Error> {
        self.validate()?;
        serde_json::to_string(self)
            .map_err(|_| Error::State("cannot encode Kubernetes specification"))
    }
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    id: Option<String>,
    running: Option<bool>,
    error: Option<String>,
    #[serde(default)]
    environment: BTreeMap<String, String>,
}
impl Response {
    fn error(&self) -> Option<ObservationError> {
        self.error.as_deref().map(|code| match code {
            "binding" => ObservationError::BindingMismatch,
            "incomplete" => ObservationError::Incomplete,
            "auth" => ObservationError::Authentication,
            "transport" => ObservationError::Transport,
            "prerequisite" => ObservationError::Backend("Kubernetes prerequisites are missing or incompatible; resources retained"),
            "configuration" => ObservationError::Backend("managed Kubernetes configuration is invalid"),
            _ => ObservationError::Backend("managed Kubernetes operation failed; private diagnostics were suppressed and resources retained"),
        })
    }
    fn row(&self, spec: &Spec, source: &Row) -> Result<Option<Row>, ObservationError> {
        let Some(id) = &self.id else { return Ok(None) };
        if id.is_empty()
            || id.len() > 512
            || id
                .bytes()
                .any(|byte| !(byte.is_ascii_alphanumeric() || b"-_:/.".contains(&byte)))
        {
            return Err(ObservationError::Incomplete);
        }
        if let Some(prior) = source.get("id").filter(|id| !id.is_empty())
            && prior != id
        {
            return Err(ObservationError::BindingMismatch);
        }
        let mut row = Row::from([
            (
                "spec".into(),
                source
                    .get("spec")
                    .ok_or(ObservationError::Incomplete)?
                    .clone(),
            ),
            ("id".into(), id.clone()),
        ]);
        if matches!(spec.kind.as_str(), GATEWAY_KIND | STORAGE_KIND) {
            row.insert(
                "running".into(),
                self.running
                    .ok_or(ObservationError::Incomplete)?
                    .to_string(),
            );
        }
        Ok(Some(row))
    }

    fn mutation(&self, spec: &Spec, source: &Row) -> Mutation {
        match self.row(spec, source) {
            Err(error) => Mutation::failed(error),
            Ok(None) => Mutation::failed(self.error().unwrap_or(ObservationError::Incomplete)),
            Ok(Some(mut row)) => {
                // A provider error during create taints OpenTofu state, making
                // retry impossible for retained resources. Preserve the known
                // identity as an incomplete observation instead: the compiled
                // postcondition fails and blocks dependent resources, while a
                // subsequent apply can reconcile this same binding in place.
                if self.error().is_some() {
                    row.insert("running".into(), "false".into());
                }
                Mutation::complete(row)
            }
        }
    }
}

#[derive(Default)]
pub struct KubernetesBackend;

fn bound_id(row: &Row) -> Option<&String> {
    row.get("id").filter(|id| !id.is_empty())
}
impl KubernetesBackend {
    pub fn new() -> Self {
        Self
    }
    pub fn supports(kind: &str) -> bool {
        matches!(kind, STORAGE_KIND | GATEWAY_KIND)
    }
    async fn call(
        &self,
        action: &str,
        kind: &str,
        row: &Row,
    ) -> Result<(Spec, Response), ObservationError> {
        let spec = Spec::decode(row.get("spec").ok_or(ObservationError::Incomplete)?)
            .map_err(|_| ObservationError::Query)?;
        if spec.kind != kind {
            return Err(ObservationError::BindingMismatch);
        }
        let directory = std::env::var_os(STATE_ENV)
            .map(PathBuf::from)
            .ok_or(ObservationError::Incomplete)?;
        let response = runner::invoke(
            action,
            &spec,
            &directory,
            bound_id(row),
            &BTreeMap::new(),
            &crate::CancellationToken::new(),
        )
        .await?;
        Ok((spec, response))
    }
}

#[async_trait]
impl Backend for KubernetesBackend {
    async fn plan(&self, kind: &str, desired: &Row, prior: Option<&Row>) -> Result<(), Error> {
        if let Some(prior) = prior
            && prior.get("spec") != desired.get("spec")
        {
            return Err(Error::Conflict(
                "managed Kubernetes target or identity changed; resources retained",
            ));
        }
        let mut row = desired.clone();
        if let Some(id) = prior.and_then(|prior| prior.get("id")) {
            row.insert("id".into(), id.clone());
        }
        let (_, response) = self.call("plan", kind, &row).await?;
        if let Some(error) = response.error() {
            return Err(error.into());
        }
        Ok(())
    }
    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        _removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        let (spec, response) = self.call("read", kind, prior).await?;
        if let Some(error) = response.error() {
            return Err(error);
        }
        // Retained identity never becomes absent from an incomplete response.
        let row = response.row(&spec, prior)?;
        if row.is_none() && kind == STORAGE_KIND {
            return Err(ObservationError::Incomplete);
        }
        Ok(row)
    }
    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
        match self.call("ensure", kind, desired).await {
            Err(error) => Mutation::failed(error),
            Ok((spec, response)) => response.mutation(&spec, desired),
        }
    }
    async fn remove(
        &self,
        kind: &str,
        prior: &Row,
        destroying: bool,
    ) -> Result<(), ObservationError> {
        if kind == STORAGE_KIND || !destroying {
            return Err(ObservationError::BindingMismatch);
        }
        let (_, response) = self.call("remove", kind, prior).await?;
        response.error().map_or(Ok(()), Err)
    }
}
