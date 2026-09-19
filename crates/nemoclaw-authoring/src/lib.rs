// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Frontend-independent authoring of NemoClaw desired-state documents.
//!
//! Draft edits validate before replacing answers. Generated YAML is checked by
//! the SDK parser; credential references never require loading credential values.
//! Prompts, rendering, file I/O, and deployment execution belong to consumers.

mod answers;
mod capabilities;
mod diagnostics;
mod draft;
mod projection;

pub use answers::{
    AnswerOverrides, Answers, ApiChoice, HarnessChoice, InferenceChoice, RuntimeChoice,
};
pub use capabilities::{Capabilities, Scenario};
pub use diagnostics::{Diagnostic, Diagnostics};
pub use draft::{
    AuthoredDocument, CompletionBoundary, Draft, IdentityEdits, InferenceEdits, Review,
};
pub use projection::Session;

#[cfg(test)]
mod tests;
