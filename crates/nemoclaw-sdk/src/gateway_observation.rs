// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{ObservationError, discovery::ObservationStatus};
use serde::{Deserialize, Serialize};

pub use nemoclaw_openshell::GatewayCapabilities;

/// Typed metadata shared by onboarding and planning. A read failure remains
/// unknown; provider lifecycle reads still fail rather than publishing it as absence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GatewayObservation {
    pub status: ObservationStatus,
    pub reason: Option<String>,
    pub source: String,
    pub capabilities: Option<GatewayCapabilities>,
    pub compatible: Option<bool>,
}
impl GatewayObservation {
    /// A read that could not be made, recorded as unknown rather than absent.
    pub fn unknown(reason: &str) -> Self {
        Self {
            status: ObservationStatus::Unknown,
            reason: Some(reason.into()),
            source: "openshell_gateway_info".into(),
            capabilities: None,
            compatible: None,
        }
    }

    pub fn from_result(
        result: Result<GatewayCapabilities, ObservationError>,
        required: &[crate::config::ComputeDriver],
    ) -> Self {
        match result {
            Ok(capabilities) => {
                let incompatibility = capabilities.incompatibility(
                    required
                        .iter()
                        .map(|driver| driver.openshell_driver().as_str()),
                );
                let compatible = !required.is_empty() && incompatibility.is_none();
                Self {
                    status: if compatible {
                        ObservationStatus::Available
                    } else {
                        ObservationStatus::Unavailable
                    },
                    reason: (!compatible).then(|| {
                        incompatibility.unwrap_or_else(|| {
                            "the configuration requires no compute driver".into()
                        })
                    }),
                    source: "openshell_gateway_info".into(),
                    capabilities: Some(capabilities),
                    compatible: Some(compatible),
                }
            }
            Err(error) => Self {
                status: ObservationStatus::Unknown,
                reason: Some(error.to_string()),
                source: "openshell_gateway_info".into(),
                capabilities: None,
                compatible: None,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openshell_core::proto;
    use std::collections::BTreeSet;

    #[test]
    fn openshift_uses_kubernetes_capabilities_without_weakening_driver_or_version_checks() {
        let driver = crate::config::ComputeDriver::OpenShift;
        let mut capabilities = GatewayCapabilities {
            gateway_version: nemoclaw_openshell::OPENSHELL_VERSION.into(),
            compute_drivers: vec![BTreeSet::from(["kubernetes".into()])],
        };
        capabilities.require(driver).unwrap();
        assert_eq!(
            GatewayObservation::from_result(Ok(capabilities.clone()), &[driver]).compatible,
            Some(true)
        );
        capabilities.compute_drivers = vec![BTreeSet::from(["docker".into()])];
        assert!(capabilities.require(driver).is_err());
        capabilities.compute_drivers = vec![BTreeSet::from(["openshift".into()])];
        assert!(capabilities.require(driver).is_err());
        capabilities.compute_drivers = vec![BTreeSet::from(["kubernetes".into()])];
        capabilities.gateway_version = "0.0.0".into();
        assert!(capabilities.require(driver).is_err());
    }

    #[test]
    fn kubernetes_gateway_requires_the_pinned_version_and_matching_driver() {
        let driver = "kubernetes".parse().unwrap();
        let mut capabilities = GatewayCapabilities {
            gateway_version: nemoclaw_openshell::OPENSHELL_VERSION.into(),
            compute_drivers: vec![BTreeSet::from(["kubernetes".into()])],
        };
        capabilities.require(driver).unwrap();
        assert!(
            capabilities
                .require(crate::config::ComputeDriver::Docker)
                .is_err()
        );
        capabilities.gateway_version = "other".into();
        assert!(capabilities.require(driver).is_err());
        capabilities.gateway_version = nemoclaw_openshell::OPENSHELL_VERSION.into();
        capabilities.compute_drivers = vec![BTreeSet::from(["docker".into()])];
        assert!(capabilities.require(driver).is_err());
    }

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
            gateway_version: nemoclaw_openshell::OPENSHELL_VERSION.into(),
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
        let required = nemoclaw_openshell::OPENSHELL_VERSION;
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
                "gateway compute driver is podman / selected, but spec.gateway.runtime.provider is docker"
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
                 gateway compute driver is docker, but spec.gateway.runtime.provider is podman"
            ))
        );
        assert_eq!(
            observed("1.0\nforged", &[&["docker\u{7}"]]).incompatibility(["docker"]),
            Some(format!(
                "gateway runs OpenShell 1.0\\nforged, but this build requires {required}; \
                 gateway compute driver is docker\\u{{7}}, but spec.gateway.runtime.provider is docker"
            ))
        );
        let error = observed(required, &[&["podman"]])
            .require(crate::config::ComputeDriver::Docker)
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "gateway is incompatible with this configuration: gateway compute driver is \
             podman, but spec.gateway.runtime.provider is docker"
        );
    }
}

#[cfg(test)]
mod discovery_tests {
    use super::*;
    use std::collections::BTreeSet;
    #[test]
    fn typed_gateway_observation_roundtrips_without_turning_failure_into_absence() {
        let required = [crate::config::ComputeDriver::Docker];
        let capabilities = GatewayCapabilities {
            gateway_version: nemoclaw_openshell::OPENSHELL_VERSION.into(),
            compute_drivers: vec![BTreeSet::from(["docker".into()])],
        };
        let observation = GatewayObservation::from_result(Ok(capabilities.clone()), &required);
        assert_eq!(observation.status, ObservationStatus::Available);
        assert_eq!(observation.compatible, Some(true));
        assert_eq!(
            serde_json::from_str::<GatewayObservation>(
                &serde_json::to_string(&observation).unwrap()
            )
            .unwrap(),
            observation
        );
        let mismatch = GatewayObservation::from_result(
            Ok(capabilities),
            &[crate::config::ComputeDriver::Podman],
        );
        assert_eq!(mismatch.status, ObservationStatus::Unavailable);
        assert_eq!(
            mismatch.reason.as_deref(),
            Some("gateway compute driver is docker, but spec.gateway.runtime.provider is podman")
        );
        let old_version = GatewayObservation::from_result(
            Ok(GatewayCapabilities {
                gateway_version: "0.0.1".into(),
                compute_drivers: vec![BTreeSet::from(["docker".into()])],
            }),
            &[
                crate::config::ComputeDriver::Docker,
                crate::config::ComputeDriver::Podman,
            ],
        );
        assert_eq!(
            old_version.reason,
            Some(format!(
                "gateway runs OpenShell 0.0.1, but this build requires {}; gateway compute \
                 driver is docker, but spec.gateway.runtime.provider is podman",
                nemoclaw_openshell::OPENSHELL_VERSION
            ))
        );
        let unknown = GatewayObservation::from_result(Err(ObservationError::Transport), &required);
        assert_eq!(unknown.status, ObservationStatus::Unknown);
        assert!(unknown.capabilities.is_none());
        assert!(unknown.compatible.is_none());
    }
}
