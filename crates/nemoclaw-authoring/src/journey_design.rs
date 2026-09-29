// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Guidance for the expanded single-sandbox authoring journey.

use crate::{Capabilities, Diagnostics, JourneyDefinition, JourneyState, PartialDocument};

#[derive(Clone, Debug, Default)]
pub(crate) struct JourneyGuidance {
    pub(crate) ask_deployment: bool,
    pub(crate) ask_native: bool,
    pub(crate) ask_adapter: bool,
    pub(crate) ask_route_models: bool,
    pub(crate) ask_inference_api: bool,
}

/// A sparse deployment seed with guidance for every currently supported
/// question source. The original bounded `JourneyDefinition` remains intact.
#[derive(Clone, Debug)]
pub struct JourneyDesign {
    definition: JourneyDefinition,
    guidance: JourneyGuidance,
}

impl JourneyDesign {
    pub fn new(id: impl Into<String>, base: PartialDocument) -> Self {
        Self {
            definition: JourneyDefinition::new(id, base),
            guidance: JourneyGuidance::default(),
        }
    }

    pub fn ask(mut self, fields: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.definition = self.definition.ask(fields);
        self
    }

    pub fn omit(mut self, fields: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.definition = self.definition.omit(fields);
        self
    }

    pub fn ask_deployment_fields(mut self) -> Self {
        self.guidance.ask_deployment = true;
        self
    }

    pub fn ask_native_fields(mut self) -> Self {
        self.guidance.ask_native = true;
        self
    }

    pub fn ask_adapter_fields(mut self) -> Self {
        self.guidance.ask_adapter = true;
        self
    }

    pub fn ask_route_models(mut self) -> Self {
        self.guidance.ask_route_models = true;
        self
    }

    pub fn ask_inference_api(mut self) -> Self {
        self.guidance.ask_inference_api = true;
        self
    }

    pub fn start(&self, capabilities: &Capabilities) -> Result<JourneyState, Diagnostics> {
        Ok(self
            .definition
            .start(capabilities)?
            .with_guidance(self.guidance.clone()))
    }
}
