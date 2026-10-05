// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{Diagnostics, diagnostics::diagnostic};
use nemoclaw_sdk::{
    config::{Document, Gateway},
    discovery::ObservationStatus,
    discovery_session::{
        DiscoveryObservation, DiscoveryObservations, DiscoveryQuery, plan_queries,
    },
    fabric_capabilities::Support,
};

/// What a one-sandbox document's target is read through.
pub(crate) struct Target {
    /// Explicit engine for image inspection; never inferred for an external gateway.
    pub(crate) engine: String,
    /// Whether engine prerequisites and hardware describe a gateway we manage.
    pub(crate) managed_gateway: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompatibilityStatus {
    Unverified,
    Compatible,
    Conflict,
}

/// Compatibility applies to the packaged adapter and, for managed gateways,
/// the selected execution engine. External image stores do not establish the
/// gateway's platform, deployment readiness, or successful inference.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveryAssessment {
    pub status: CompatibilityStatus,
    pub reasons: Vec<String>,
}

/// Read the target from SDK-valid desired state.
pub(crate) fn target_of(document: &Document) -> Result<Target, Diagnostics> {
    let [_] = document.spec.sandboxes.as_slice() else {
        return Err(diagnostic(
            "sandbox",
            "guided discovery requires one sandbox",
        ));
    };
    Ok(Target {
        engine: match &document.spec.gateway {
            Gateway::Managed(gateway) => gateway.engine.clone(),
            Gateway::External(gateway) => gateway.engine.clone(),
        },
        managed_gateway: document.spec.gateway.as_managed().is_some(),
    })
}

/// Evaluate target observations without rewriting desired state or the global menu.
/// An observation that was never made is unverified, as is a read that failed,
/// which is an unknown observation, until the caller asks again.
pub fn assess_target(
    document: &Document,
    observations: &DiscoveryObservations,
) -> Result<DiscoveryAssessment, Diagnostics> {
    let key = target_of(document)?;
    // The plan's own reads, so a verdict is the plan's: a managed gateway's
    // engine, and the image judged against the sandbox's requirements.
    let mut engine = None;
    let mut fabric = None;
    for query in
        plan_queries(document).map_err(|error| diagnostic("discovery", &error.to_string()))?
    {
        match (&query, observations.get(&query)) {
            (DiscoveryQuery::Engine(_), Some(DiscoveryObservation::Engine(observed))) => {
                engine = Some(observed);
            }
            (DiscoveryQuery::Fabric { .. }, Some(DiscoveryObservation::Fabric(observed))) => {
                fabric = Some(observed);
            }
            _ => {}
        }
    }
    let mut reasons = Vec::new();
    let mut conflict = false;
    // An external gateway's engine only supplies image metadata. Do not
    // infer its execution platform or prerequisites from that image store.
    let engine_available = if !key.managed_gateway {
        if key.engine.is_empty() {
            reasons.push(
                "Set spec.gateway.engine to inspect the external gateway's sandbox image.".into(),
            );
            false
        } else {
            true
        }
    } else {
        match engine.map(|engine| engine.status) {
            Some(ObservationStatus::Available) => true,
            Some(ObservationStatus::Unavailable) => {
                conflict = true;
                reasons.push("The selected engine does not meet gateway prerequisites.".into());
                false
            }
            Some(ObservationStatus::Unknown) => {
                reasons.push("The selected engine remains unverified.".into());
                false
            }
            None => {
                reasons.push("The selected engine has not been observed.".into());
                false
            }
        }
    };
    // The provider judged a present image against the sandbox's requirements.
    let verdict = fabric
        .filter(|observed| {
            observed.image_id.as_ref().is_some_and(|id| !id.is_empty())
                && observed.status != ObservationStatus::Unavailable
        })
        .and_then(|observed| observed.compatibility.as_ref());
    let fabric_supported = match (fabric, verdict) {
        (_, Some(capability)) => {
            for check in &capability.checks {
                if check.status == Support::Unsupported {
                    conflict = true;
                }
                if check.status != Support::Supported {
                    reasons.push(format!("{}: {}.", check.requirement, check.reason));
                }
            }
            capability.status == Support::Supported
        }
        (Some(observed), None) => {
            reasons.push(
                if observed.status == ObservationStatus::Unavailable {
                    "The selected image is not present; its Fabric capabilities remain unverified."
                } else {
                    "The selected image's Fabric capabilities remain unverified."
                }
                .into(),
            );
            false
        }
        (None, _) => {
            reasons.push("The selected image's Fabric capabilities have not been observed.".into());
            false
        }
    };
    Ok(DiscoveryAssessment {
        status: if conflict {
            CompatibilityStatus::Conflict
        } else if engine_available && fabric_supported {
            CompatibilityStatus::Compatible
        } else {
            CompatibilityStatus::Unverified
        },
        reasons,
    })
}
