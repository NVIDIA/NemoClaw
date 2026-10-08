// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::ComputeDriver;
use nemoclaw_backend::{Error, ObservationError};
use openshell_sdk::raw::proto;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

mod pins {
    include!(concat!(env!("OUT_DIR"), "/pins.rs"));
}
/// The OpenShell version this build requires its gateway to run.
pub use pins::OPENSHELL_VERSION;

/// Gateway metadata used by deployment checks and the provider data source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
        let required = OPENSHELL_VERSION;
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
                            "gateway compute driver is {observed}, but spec.gateway.runtime.provider is {driver}"
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

    pub fn require(&self, driver: ComputeDriver) -> Result<(), Error> {
        match self.incompatibility([driver.openshell_driver().as_str()]) {
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
