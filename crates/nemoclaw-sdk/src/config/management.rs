// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use serde::{Deserialize, Serialize};

/// Ownership of the inference server, separate from NemoClaw's owned routing registration.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Management {
    /// The deployment manages the declared service.
    Managed,
    /// The deployment uses the endpoint without managing its server.
    External,
}

/// NemoClaw uses this resource without managing its lifecycle or administrative configuration.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ExternalManagement {
    /// The resource is provided by its external owner.
    External,
}

/// NemoClaw manages this resource's lifecycle. Storage retention is independent of ownership.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ManagedManagement {
    /// The deployment creates and observes the resource using its existing lifecycle and retention policy.
    Managed,
}

/// Explicit ownership for a dependency whose creation settings remain on its parent. Only managed ownership is implemented.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ManagedResource {
    /// Managed ownership. Omit the enclosing object to keep the same behavior.
    pub management: ManagedManagement,
}

impl super::Gateway {
    pub(crate) fn runtime_settings(&self) -> Self {
        let mut settings = self.clone();
        settings.storage = None;
        settings.network = None;
        settings
    }
}
/// An existing container network on the selected engine. NemoClaw attaches its container but does not create or delete the network.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
pub enum NetworkReference {
    /// Existing network name; equivalent to management: external.
    Name(String),
    /// Explicit external network reference.
    External(ExternalNetwork),
}
/// Identify a network owned outside this deployment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ExternalNetwork {
    /// Optional external ownership declaration. Omission means external.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ExternalManagement")]
    pub management: Option<ExternalManagement>,
    /// Existing network name on the service Docker engine.
    pub name: String,
}
impl Default for NetworkReference {
    fn default() -> Self {
        Self::Name(String::new())
    }
}
impl NetworkReference {
    pub fn name(&self) -> &str {
        match self {
            Self::Name(name) => name,
            Self::External(network) => &network.name,
        }
    }
}
