// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{ConfigError, HarnessKind, Route};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Optional inference routing performed inside the harness process.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum InferenceRouting {
    /// Route Hermes requests through the native NeMo Relay Switchyard plugin.
    Switchyard {
        /// Synthetic Switchyard model name, exposed as `switchyard/<routeId>`.
        #[serde(rename = "routeId")]
        route_id: String,
        /// Supported Switchyard routing algorithm and its named route bindings.
        algorithm: SwitchyardAlgorithm,
    },
}

/// Switchyard algorithms accepted by the V1 configuration contract.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum SwitchyardAlgorithm {
    /// Deterministic weighted selection among two or more named inference routes.
    WeightedRandom {
        /// Seed supplied to Switchyard's random router.
        seed: u64,
        /// Named target routes and their positive integer weights.
        #[schemars(length(min = 2, max = 32))]
        targets: Vec<SwitchyardWeightedTarget>,
    },
    /// Capability classifier choosing between weak and strong serving routes.
    LlmClassifier {
        /// Named route used for the classification request.
        #[serde(rename = "classifierRoute")]
        classifier_route: String,
        /// Named route used for lower-complexity requests.
        #[serde(rename = "weakRoute")]
        weak_route: String,
        /// Named route used for higher-complexity requests.
        #[serde(rename = "strongRoute")]
        strong_route: String,
        /// Initial classifier threshold, from zero through one.
        #[serde(rename = "baseThreshold")]
        #[schemars(with = "f64", range(min = 0, max = 1))]
        base_threshold: serde_json::Number,
        /// Positive threshold adjustment for each additional capability level.
        #[serde(rename = "thresholdStep")]
        #[schemars(with = "f64", range(min = 0, max = 1))]
        threshold_step: serde_json::Number,
    },
}

/// One weighted Switchyard target bound to a named inference route.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SwitchyardWeightedTarget {
    /// Named route whose provider connection remains managed by OpenShell.
    pub route_ref: String,
    /// Positive relative selection weight.
    #[schemars(range(min = 1, max = 1000000000))]
    pub weight: u32,
}

impl InferenceRouting {
    pub(crate) fn validate(
        &self,
        harness: Option<HarnessKind>,
        routes: &[Route],
    ) -> Result<(), ConfigError> {
        if harness.is_some_and(|kind| kind != HarnessKind::Hermes) {
            return Err(ConfigError::new(
                "Switchyard routing requires the Hermes harness",
            ));
        }
        let (route_id, algorithm) = match self {
            Self::Switchyard {
                route_id,
                algorithm,
            } => (route_id, algorithm),
        };
        if !super::validation::valid_name(route_id) {
            return Err(ConfigError::new("invalid Switchyard route ID"));
        }
        let names: BTreeSet<_> = routes.iter().map(|route| route.name.as_str()).collect();
        let refs = algorithm.route_refs()?;
        if refs.iter().any(|name| !names.contains(*name)) {
            return Err(ConfigError::new(
                "Switchyard routing references an unknown inference route",
            ));
        }
        Ok(())
    }

    pub(crate) fn route_refs(&self) -> Result<Vec<&str>, ConfigError> {
        match self {
            Self::Switchyard { algorithm, .. } => algorithm.route_refs(),
        }
    }
}

impl SwitchyardAlgorithm {
    fn route_refs(&self) -> Result<Vec<&str>, ConfigError> {
        let refs = match self {
            Self::WeightedRandom { targets, .. } => {
                if !(2..=32).contains(&targets.len())
                    || targets.iter().any(|target| target.weight == 0)
                {
                    return Err(ConfigError::new(
                        "weighted-random routing requires two to 32 positive weights",
                    ));
                }
                targets
                    .iter()
                    .map(|target| target.route_ref.as_str())
                    .collect()
            }
            Self::LlmClassifier {
                classifier_route,
                weak_route,
                strong_route,
                base_threshold,
                threshold_step,
            } => {
                let base = base_threshold.as_f64().unwrap_or(f64::NAN);
                let step = threshold_step.as_f64().unwrap_or(f64::NAN);
                if !(0.0..=1.0).contains(&base) || !(0.0 < step && step <= 1.0) {
                    return Err(ConfigError::new(
                        "classifier thresholds must be bounded and thresholdStep must be positive",
                    ));
                }
                vec![
                    classifier_route.as_str(),
                    weak_route.as_str(),
                    strong_route.as_str(),
                ]
            }
        };
        let unique: BTreeSet<_> = refs.iter().copied().collect();
        if unique.len() != refs.len() {
            return Err(ConfigError::new(
                "Switchyard routing roles require distinct inference routes",
            ));
        }
        Ok(refs)
    }
}
