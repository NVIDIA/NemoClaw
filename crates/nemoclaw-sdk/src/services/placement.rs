// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Placement and publication shared by managed model services.
use crate::config::{ConfigError, validation::require};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Execution host and Docker network for a remote model service.
pub struct ServicePlacement {
    /// SSH Docker endpoint used for an explicitly placed service.
    pub engine: String,
    /// Canonical private IPv4 /24 on the selected Docker engine.
    pub network_cidr: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// HTTP model publication must match the bind address, service port, and /v1 path.
pub struct ServicePublication {
    /// Private HTTP inference URL reachable by OpenShell.
    pub endpoint: String,
    /// Private host IPv4 address outside the service Docker subnet. Loopback is rejected.
    pub bind_address: String,
}

/// An explicit execution placement together with its model publication.
/// Construction checks the pair; validation checks network and port policy.
#[derive(Clone, Copy, Debug)]
pub struct PublishedPlacement<'a> {
    pub placement: &'a ServicePlacement,
    pub publication: &'a ServicePublication,
}
impl<'a> PublishedPlacement<'a> {
    pub fn from_parts(
        placement: Option<&'a ServicePlacement>,
        publication: Option<&'a ServicePublication>,
    ) -> Result<Option<Self>, ConfigError> {
        match (placement, publication) {
            (None, None) => Ok(None),
            (Some(placement), Some(publication)) => Ok(Some(Self {
                placement,
                publication,
            })),
            _ => Err(ConfigError::new(
                "service placement and publication must appear together",
            )),
        }
    }
    pub(crate) fn validate(self, port: i64) -> Result<(), ConfigError> {
        let network = self.placement.validate()?;
        self.publication.validate(&network, port)
    }
}

impl ServicePlacement {
    /// Validate the execution host and return its Docker network for publication checks.
    fn validate(&self) -> Result<ipnet::Ipv4Net, ConfigError> {
        require(
            self.engine.starts_with("ssh://"),
            "explicit service placement requires SSH Docker",
        )?;
        require(
            crate::docker::Engine::validate_endpoint(&self.engine).is_ok(),
            "invalid service engine",
        )?;

        let network: ipnet::Ipv4Net = self
            .network_cidr
            .parse()
            .map_err(|_| ConfigError::new("invalid service network"))?;
        let is_private_subnet = network.addr().is_private() && network.prefix_len() == 24;
        let is_network_address = network.addr() == network.network();
        require(
            is_private_subnet && is_network_address,
            "service network requires a private IPv4 /24",
        )?;
        Ok(network)
    }
}

impl ServicePublication {
    fn validate(&self, network: &ipnet::Ipv4Net, port: i64) -> Result<(), ConfigError> {
        crate::config::validate_endpoint(&self.endpoint, false)?;
        let endpoint = url::Url::parse(&self.endpoint)
            .map_err(|_| ConfigError::new("invalid service publication"))?;
        let bind_address: std::net::Ipv4Addr = self
            .bind_address
            .parse()
            .map_err(|_| ConfigError::new("invalid service bind address"))?;

        // Publish on the private execution host, outside the container subnet.
        let binds_private_host = bind_address.is_private()
            && !bind_address.is_loopback()
            && !network.contains(&bind_address);
        let matches_service_endpoint = endpoint.scheme() == "http"
            && endpoint.host_str() == Some(self.bind_address.as_str())
            && endpoint.port().map(i64::from) == Some(port)
            && endpoint.path() == "/v1";
        require(
            binds_private_host && matches_service_endpoint,
            "service publication must match its private bind address, serving port and /v1 path",
        )
    }
}
