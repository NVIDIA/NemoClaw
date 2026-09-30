// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Managed development gateway on an explicitly selected Kubernetes cluster.
//! Desired platform identity and operation-scoped connection custody.
//! Resource reconciliation belongs to the OpenTofu provider.

mod connection;
mod runner;
#[cfg(test)]
mod tests;

use crate::{Error, ObservationError, config::ManagedGateway};
pub use connection::{Connection, connection};
#[doc(hidden)]
pub use runner::invoke;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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

#[doc(hidden)]
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub id: Option<String>,
    pub running: Option<bool>,
    pub error: Option<String>,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
}
impl Response {
    pub fn error(&self) -> Option<ObservationError> {
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
}
