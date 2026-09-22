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
mod diagnostics;
mod draft;
mod guided;
mod projection;

pub use answers::{
    AnswerOverrides, Answers, ApiChoice, HarnessChoice, InferenceChoice, RuntimeChoice,
};
pub use capabilities::{Capabilities, Scenario};
pub use diagnostics::{Diagnostic, Diagnostics};
pub use draft::{
    AuthoredDocument, CompletionBoundary, Draft, IdentityEdits, InferenceEdits, Review,
};
pub use guided::{EditableField, FieldValue, GuidedField};
pub use projection::Session;
