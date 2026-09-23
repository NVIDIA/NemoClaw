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
        self.incompatibility([driver]).is_none()
    }

    /// Describe each failed compatibility check, or `None` when the gateway can serve every driver.
    pub fn incompatibility<'a>(
        &self,
        drivers: impl IntoIterator<Item = &'a str>,
    ) -> Option<String> {
        let required = crate::artifact_pins::OPENSHELL_VERSION;
        let mut reasons = Vec::new();
        // Gateway-reported values are escaped so they cannot add diagnostic lines.
        if self.gateway_version != required {
            reasons.push(format!(
                "gateway runs OpenShell {}, but this build requires {required}",
                self.gateway_version.escape_debug()
            ));
        }
        match self.compute_drivers.as_slice() {
            [names] => reasons.extend(
                drivers
                    .into_iter()
                    .filter(|driver| !names.contains(*driver))
                    .map(|driver| {
                        let observed = names
                            .iter()
                            .map(|name| name.escape_debug().to_string())
                            .collect::<Vec<_>>()
                            .join(" / ");
                        format!(
                            "gateway compute driver is {observed}, but runtime.provider is {driver}"
                        )
                    }),
            ),
            entries => reasons.push(format!(
                "gateway reports {} compute drivers, but exactly one is required",
                entries.len()
            )),
        }
        (!reasons.is_empty()).then(|| reasons.join("; "))
    }

    pub fn require(&self, driver: crate::config::ComputeDriver) -> Result<(), Error> {
        match self.incompatibility([driver.as_str()]) {
            Some(reason) => Err(Error::GatewayIncompatible(reason)),
            None => Ok(()),
        }
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

    #[test]
    fn gateway_incompatibility_names_each_failed_check() {
        let required = crate::artifact_pins::OPENSHELL_VERSION;
        let observed = |version: &str, drivers: &[&[&str]]| GatewayCapabilities {
            gateway_version: version.into(),
            compute_drivers: drivers
                .iter()
                .map(|names| names.iter().map(|name| name.to_string()).collect())
                .collect(),
        };
        assert_eq!(
            observed(required, &[&["docker"]]).incompatibility(["docker"]),
            None
        );
        assert_eq!(
            observed("0.0.1", &[&["docker"]]).incompatibility(["docker"]),
            Some(format!(
                "gateway runs OpenShell 0.0.1, but this build requires {required}"
            ))
        );
        assert_eq!(
            observed(required, &[&["podman", "selected"]]).incompatibility(["docker"]),
            Some(
                "gateway compute driver is podman / selected, but runtime.provider is docker"
                    .into()
            )
        );
        assert_eq!(
            observed(required, &[&["docker"], &["docker"]]).incompatibility(["docker"]),
            Some("gateway reports 2 compute drivers, but exactly one is required".into())
        );
        assert_eq!(
            observed("0.0.1", &[]).incompatibility(["docker"]),
            Some(format!(
                "gateway runs OpenShell 0.0.1, but this build requires {required}; \
                 gateway reports 0 compute drivers, but exactly one is required"
            ))
        );
        assert_eq!(
            observed("0.0.1", &[&["docker"]]).incompatibility(["docker", "podman"]),
            Some(format!(
                "gateway runs OpenShell 0.0.1, but this build requires {required}; \
                 gateway compute driver is docker, but runtime.provider is podman"
            ))
        );
        assert_eq!(
            observed("1.0\nforged", &[&["docker\u{7}"]]).incompatibility(["docker"]),
            Some(format!(
                "gateway runs OpenShell 1.0\\nforged, but this build requires {required}; \
                 gateway compute driver is docker\\u{{7}}, but runtime.provider is docker"
            ))
        );
        let error = observed(required, &[&["podman"]])
            .require(crate::config::ComputeDriver::Docker)
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "gateway is incompatible with this configuration: gateway compute driver is \
             podman, but runtime.provider is docker"
        );
    }
}
