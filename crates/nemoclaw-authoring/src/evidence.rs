// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{Diagnostics, Draft, diagnostics::diagnostic};
use nemoclaw_sdk::{
    config::{ComputeDriver, HarnessKind},
    discovery::{EngineObservation, FabricObservation, ObservationStatus},
    fabric_capabilities::{FabricRequirements, Support, assess_image},
};

/// Inputs determining which target facts can constrain the current document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveryKey {
    pub engine: String,
    pub compute_driver: ComputeDriver,
    pub image: String,
    pub harness: HarnessKind,
}

/// Observations retain their query inputs rather than becoming global choices.
#[derive(Clone, Debug)]
pub struct DiscoveryEvidence {
    pub key: DiscoveryKey,
    pub engine: Option<EngineObservation>,
    pub fabric: Option<FabricObservation>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompatibilityStatus {
    Unverified,
    Compatible,
    Conflict,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiscoveryQuery {
    Engine,
    Fabric,
}

/// Compatibility applies only to the selected engine and packaged adapter.
/// It does not establish deployment readiness or successful inference.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveryAssessment {
    pub status: CompatibilityStatus,
    pub reasons: Vec<String>,
    pub pending: Vec<DiscoveryQuery>,
}

impl Draft {
    pub fn discovery_key(&self) -> Result<DiscoveryKey, Diagnostics> {
        let document = self.document();
        let gateway = document.spec.gateway.as_managed().ok_or_else(|| {
            diagnostic(
                "gateway",
                "guided discovery requires a managed gateway target",
            )
        })?;
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
            engine: gateway.engine.clone(),
            compute_driver: sandbox.runtime.provider,
            image: sandbox.image.ref_.clone(),
            harness,
        })
    }
}

impl DiscoveryEvidence {
    /// Invalidate only facts whose query inputs changed. Changing harness merely
    /// re-evaluates the existing image catalog against the new requirement.
    pub fn retarget(&mut self, key: DiscoveryKey) {
        if self.key.engine != key.engine || self.key.compute_driver != key.compute_driver {
            self.engine = None;
        }
        if self.key.engine != key.engine || self.key.image != key.image {
            self.fabric = None;
        }
        self.key = key;
    }

    /// Evaluate target facts without rewriting desired state or the global menu.
    /// Pending contains only dependency-ready reads. A completed unknown result
    /// remains unknown until the caller explicitly refreshes it.
    pub fn assessment(&self, draft: &Draft) -> Result<DiscoveryAssessment, Diagnostics> {
        let key = draft.discovery_key()?;
        let engine = self.engine.as_ref().filter(|_| {
            self.key.engine == key.engine && self.key.compute_driver == key.compute_driver
        });
        let fabric = self
            .fabric
            .as_ref()
            .filter(|_| self.key.engine == key.engine && self.key.image == key.image);
        let mut reasons = Vec::new();
        let mut pending = Vec::new();
        let mut conflict = false;
        let engine_available = match engine.map(|engine| engine.status) {
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
                pending.push(DiscoveryQuery::Engine);
                reasons.push("The selected engine has not been observed.".into());
                false
            }
        };
        let fabric_supported = match fabric {
            Some(observed)
                if observed.image_id.as_ref().is_some_and(|id| !id.is_empty())
                    && observed.status != ObservationStatus::Unavailable =>
            {
                let sandbox = &draft.document().spec.sandboxes[0];
                let requirements = FabricRequirements::for_sandbox(draft.document(), sandbox)
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
                reasons.push(if observed.status == ObservationStatus::Unavailable {
                    "The selected image is not present; its Fabric capabilities remain unverified."
                } else {
                    "The selected image's Fabric capabilities remain unverified."
                }.into());
                false
            }
            None => {
                if engine_available {
                    pending.push(DiscoveryQuery::Fabric);
                }
                reasons.push(
                    "The selected image's Fabric capabilities have not been observed.".into(),
                );
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
            pending,
        })
    }
}
