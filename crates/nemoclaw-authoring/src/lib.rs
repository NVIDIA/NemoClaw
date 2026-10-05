// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Frontend-independent authoring of NemoClaw desired-state documents.
//!
//! A [`JourneyDefinition`] combines sparse desired-state values with question
//! guidance. A [`JourneyState`] owns authored values, accepted decisions, and
//! journey position. Its read-only resolver derives current questions and
//! produces a validated SDK document when authoring decisions are complete.
//! Credential references never require loading credential values.
//! Prompts, rendering, file I/O, and deployment execution belong to consumers.

mod capabilities;
mod deployment;
mod diagnostics;
mod discovery_queries;
mod identity;
mod journey_definition;
mod journey_state;
mod journey_tree;
mod local_runtimes;
mod partial_document;
mod provider_presets;
mod target_assessment;

pub use capabilities::Capabilities;
pub use diagnostics::{Diagnostic, Diagnostics};
pub use discovery_queries::{discovery_queries, inference_request_for_document};
pub use identity::new_deployment_uid;
pub use journey_definition::{
    JourneyDefinition, JourneyScope, JourneySelector, TargetPrerequisite,
};
pub use journey_state::{
    DecisionStatus, JourneyQuestion, JourneyQuestionKind, JourneyQuestionReason, JourneyResolution,
    JourneyState,
};
pub use local_runtimes::environment_queries;
pub use partial_document::{PartialAssessment, PartialDocument, PartialIssue, PartialIssueKind};
pub use provider_presets::ProviderPreset;
pub use target_assessment::{CompatibilityStatus, DiscoveryAssessment, assess_target};

mod fingerprint;
mod sdk_schema;
mod settings;
