// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Frontend-independent authoring of NemoClaw desired-state documents.
//!
//! A [`JourneyDefinition`] combines sparse desired-state values with question
//! guidance. Its [`JourneyState`] resolves applicable questions and produces a
//! validated SDK document when all required authoring decisions are complete.
//! Credential references never require loading credential values.
//! Prompts, rendering, file I/O, and deployment execution belong to consumers.

mod capabilities;
mod deployment;
mod diagnostics;
mod evidence;
mod facts;
mod identity;
mod journey_definition;
mod journey_state;
mod partial_document;
mod provider_presets;

pub use capabilities::Capabilities;
pub use diagnostics::{Diagnostic, Diagnostics};
pub use evidence::{
    CompatibilityStatus, DiscoveryAssessment, DiscoveryEvidence, DiscoveryKey, DiscoveryQuery,
    discovery_key_for_document,
};
pub use facts::{
    AuthoringFacts, EndpointEvidence, GatewayEvidence, HardwareEvidence,
    inference_request_for_document,
};
pub use identity::new_deployment_uid;
pub use journey_definition::{
    JourneyDefinition, JourneyScope, JourneySelector, TargetPrerequisite,
};
pub use journey_state::{JourneyQuestion, JourneyQuestionReason, JourneyResolution, JourneyState};
pub use partial_document::{PartialAssessment, PartialDocument, PartialIssue, PartialIssueKind};
pub use provider_presets::ProviderPreset;

mod settings;
