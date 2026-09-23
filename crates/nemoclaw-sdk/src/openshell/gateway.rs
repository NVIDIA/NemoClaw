// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{OpenShell, proto, remote_error};
use crate::{Error, ObservationError};
use std::{collections::BTreeSet, time::Duration};

/// Gateway metadata used by deployment checks and the provider data source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayCapabilities {
    pub gateway_version: String,
    /// Each entry contains the routing name and any driver-reported alias.
    pub compute_drivers: Vec<BTreeSet<String>>,
}

impl GatewayCapabilities {
    pub fn supports(&self, driver: &str) -> bool {
        self.gateway_version == crate::artifact_pins::OPENSHELL_VERSION
            && self.compute_drivers.len() == 1
            && self.compute_drivers[0].contains(driver)
    }

    pub fn require(&self, driver: crate::config::ComputeDriver) -> Result<(), Error> {
        if !self.supports(driver.as_str()) {
            return Err(Error::Conflict(
                "gateway version or compute driver does not satisfy the configuration",
            ));
        }
        Ok(())
    }
}

impl TryFrom<proto::GetGatewayInfoResponse> for GatewayCapabilities {
    type Error = ObservationError;

    fn try_from(info: proto::GetGatewayInfoResponse) -> Result<Self, Self::Error> {
        if info.gateway_version.is_empty() || info.compute_drivers.is_empty() {
            return Err(ObservationError::Incomplete);
        }
        let compute_drivers = info
            .compute_drivers
            .into_iter()
            .map(|driver| {
                let names: BTreeSet<_> = [
                    driver.name,
                    driver
                        .capabilities
                        .map(|capability| capability.driver_name)
                        .unwrap_or_default(),
                ]
                .into_iter()
                .filter(|name| !name.is_empty())
                .collect();
                if names.is_empty() {
                    Err(ObservationError::Incomplete)
                } else {
                    Ok(names)
                }
            })
            .collect::<Result<_, _>>()?;
        Ok(Self {
            gateway_version: info.gateway_version,
            compute_drivers,
        })
    }
}

impl OpenShell {
    /// Read version and driver metadata through the configured authenticated channel.
    /// A failed or incomplete observation is never an absent gateway.
    pub async fn gateway_capabilities(&self) -> Result<GatewayCapabilities, ObservationError> {
        let response = tokio::time::timeout(Duration::from_secs(30), async {
            self.client
                .raw_grpc()
                .get_gateway_info(self.request(proto::GetGatewayInfoRequest {}))
                .await
        })
        .await
        .map_err(|_| ObservationError::Transport)?
        .map_err(|error| remote_error(&error))?;
        response.into_inner().try_into()
    }

    pub async fn verify_gateway(&self, driver: crate::config::ComputeDriver) -> Result<(), Error> {
        self.gateway_capabilities().await?.require(driver)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_compatibility_preserves_driver_aliases_and_rejects_ambiguous_or_incomplete_metadata()
    {
        let driver = proto::ComputeDriverInfo {
            name: "selected".into(),
            capabilities: Some(proto::ComputeDriverCapabilities {
                driver_name: "podman".into(),
                ..Default::default()
            }),
        };
        let info = proto::GetGatewayInfoResponse {
            gateway_version: crate::artifact_pins::OPENSHELL_VERSION.into(),
            compute_drivers: vec![driver.clone()],
            ..Default::default()
        };
        let observed = GatewayCapabilities::try_from(info.clone()).unwrap();
        assert!(observed.supports("selected") && observed.supports("podman"));
        assert!(!observed.supports("docker"));
        let mut changed = info.clone();
        changed.gateway_version = "other".into();
        assert!(
            !GatewayCapabilities::try_from(changed)
                .unwrap()
                .supports("podman")
        );
        let mut changed = info.clone();
        changed.compute_drivers.push(driver);
        assert!(
            !GatewayCapabilities::try_from(changed)
                .unwrap()
                .supports("podman")
        );
        for incomplete in [
            proto::GetGatewayInfoResponse::default(),
            proto::GetGatewayInfoResponse {
                compute_drivers: vec![proto::ComputeDriverInfo::default()],
                ..info
            },
        ] {
            assert_eq!(
                GatewayCapabilities::try_from(incomplete),
                Err(ObservationError::Incomplete)
            );
        }
    }
}
