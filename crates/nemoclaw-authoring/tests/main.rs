// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Authoring integration tests, linked into one binary.
//! Each file is a module; shared helpers are declared once here.

#[path = "deployment_identity.rs"]
mod deployment_identity;
#[path = "deployment_journey.rs"]
mod deployment_journey;
#[path = "discovery_queries.rs"]
mod discovery_queries;
#[path = "environment_observations.rs"]
mod environment_observations;
#[path = "journey_authoring_boundaries.rs"]
mod journey_authoring_boundaries;
#[path = "journey_decision_status.rs"]
mod journey_decision_status;
#[path = "journey_edits.rs"]
mod journey_edits;
#[path = "journey_guidance.rs"]
mod journey_guidance;
#[path = "journey_resolution.rs"]
mod journey_resolution;
#[path = "journey_tree_preview.rs"]
mod journey_tree_preview;
#[path = "onboarding_journey_presets.rs"]
mod onboarding_journey_presets;
#[path = "partial_documents.rs"]
mod partial_documents;
#[path = "target_assessment.rs"]
mod target_assessment;
#[path = "target_prerequisites.rs"]
mod target_prerequisites;
#[path = "unsupported_onboarding_journeys.rs"]
mod unsupported_onboarding_journeys;
