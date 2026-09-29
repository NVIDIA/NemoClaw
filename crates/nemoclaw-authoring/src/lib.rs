// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Frontend-independent authoring of NemoClaw desired-state documents.
//!
//! A [`Draft`] owns the SDK's complete configuration [`nemoclaw_sdk::config::Document`].
//! Guided fields are a fallible view over curated presets, not a parallel schema.
//! Edits validate before replacing desired state, and generated YAML is checked by
//! the SDK parser. Credential references never require loading credential values.
//! Prompts, rendering, file I/O, and deployment execution belong to consumers.

mod answers;
mod capabilities;
mod delegation;
mod deployment;
mod diagnostics;
mod draft;
mod evidence;
mod facts;
mod graph;
mod guided;
mod journey_definition;
mod journey_state;
mod partial_document;
mod projection;

pub use answers::{
    AnswerOverrides, Answers, ApiChoice, HarnessChoice, ProviderPreset, RuntimeChoice,
};
pub use capabilities::Capabilities;
pub use diagnostics::{Diagnostic, Diagnostics};
pub use draft::{
    AuthoredDocument, CompletionBoundary, Draft, IdentityEdits, InferenceEdits, Review,
};
pub use evidence::{
    CompatibilityStatus, DiscoveryAssessment, DiscoveryEvidence, DiscoveryKey, DiscoveryQuery,
    discovery_key_for_document,
};
pub use facts::{
    AuthoringFacts, EndpointEvidence, GatewayEvidence, HardwareEvidence,
    inference_request_for_document,
};
pub use graph::{AnswerStatus, DependencyGraph};
pub use guided::{AnswerChange, EditableField, FieldValue, GuidedEdit, GuidedField};
pub use journey_definition::{
    JourneyDefinition, JourneyScope, JourneySelector, TargetPrerequisite,
};
pub use journey_state::{JourneyQuestion, JourneyQuestionReason, JourneyResolution, JourneyState};
pub use partial_document::{PartialAssessment, PartialDocument, PartialIssue, PartialIssueKind};
pub use projection::Session;

mod settings;
pub use settings::SettingQuestion;
