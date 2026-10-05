// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{Diagnostics, diagnostics::diagnostic};
use nemoclaw_sdk::{
    config::{ComputeDriver, Document, Gateway, HarnessKind},
    discovery::{DiscoveryRequest, ObservationStatus},
    discovery_session::DiscoveryObservations,
    fabric_capabilities::{FabricRequirements, Support, assess_image},
};

/// Inputs determining which target observations can constrain the current document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveryKey {
    /// Explicit engine for image inspection; never inferred for an external gateway.
    pub engine: String,
    /// Whether engine prerequisites and hardware describe a gateway we manage.
    pub managed_gateway: bool,
    pub compute_driver: ComputeDriver,
    pub image: String,
    pub harness: HarnessKind,
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

/// Read target dependencies from SDK-valid desired state.
pub fn discovery_key_for_document(document: &Document) -> Result<DiscoveryKey, Diagnostics> {
    let [sandbox] = document.spec.sandboxes.as_slice() else {
        return Err(diagnostic(
            "sandbox",
            "guided discovery requires one sandbox",
        ));
    };
    let harness = document
        .sandbox_harness(sandbox)
        .map_err(|error| diagnostic("harness", &error.to_string()))?
        .kind
        .clone();
    Ok(DiscoveryKey {
        engine: match &document.spec.gateway {
            Gateway::Managed(gateway) => gateway.engine.clone(),
            Gateway::External(gateway) => gateway.engine.clone(),
        },
        managed_gateway: document.spec.gateway.as_managed().is_some(),
        compute_driver: sandbox.runtime.provider,
        image: sandbox.image.ref_.clone(),
        harness,
    })
}

/// Evaluate target observations without rewriting desired state or the global menu.
/// An observation that was never made is unverified, as is a read that failed,
/// which is an unknown observation, until the caller asks again.
pub fn assess_target(
    document: &Document,
    observations: &DiscoveryObservations,
) -> Result<DiscoveryAssessment, Diagnostics> {
    let key = discovery_key_for_document(document)?;
    let engine_request = DiscoveryRequest {
        engine: key.engine.clone(),
        compute_driver: key.compute_driver,
    };
    let engine = observations
        .engine(&engine_request)
        .filter(|_| key.managed_gateway);
    let fabric = observations.fabric(&key.engine, &key.image);
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
    let fabric_supported = match fabric {
        Some(observed)
            if observed.image_id.as_ref().is_some_and(|id| !id.is_empty())
                && observed.status != ObservationStatus::Unavailable =>
        {
            let sandbox = &document.spec.sandboxes[0];
            let requirements = FabricRequirements::for_sandbox(document, sandbox)
                .map_err(|error| diagnostic("discovery", &error.to_string()))?;
            let capability = assess_image(
                observed.catalog.as_ref(),
                &requirements,
                &observed.image,
                &key.image,
                engine
                    .filter(|_| engine_available)
                    .and_then(|engine| engine.architecture.as_deref()),
                engine
                    .filter(|_| engine_available)
                    .and_then(|engine| engine.operating_system.as_deref()),
            );
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
        Some(observed) => {
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
        None => {
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
