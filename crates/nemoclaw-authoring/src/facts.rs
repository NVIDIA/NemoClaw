// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{Capabilities, Diagnostics, Draft, EditableField, FieldValue, GuidedField};
use nemoclaw_sdk::{
    config::{ComputeDriver, Gateway},
    discovery::ObservationStatus,
    hardware_discovery::HardwareObservation,
    inference_discovery::{CredentialObservation, EndpointObservation, EndpointRequest},
    openshell::GatewayObservation,
};

#[derive(Clone, Debug)]
pub struct EndpointEvidence {
    pub request: EndpointRequest,
    pub observation: EndpointObservation,
}
#[derive(Clone, Debug)]
pub struct HardwareEvidence {
    pub engine: String,
    pub observation: HardwareObservation,
}

#[derive(Clone, Debug)]
pub struct GatewayEvidence {
    pub gateway: Gateway,
    pub compute_driver: ComputeDriver,
    pub observation: GatewayObservation,
}

/// Additional evidence is advisory for offline authoring and never replaces
/// accepted intent. Credentials contain availability and references, not values.
#[derive(Clone, Debug, Default)]
pub struct AuthoringFacts {
    pub endpoint: Option<EndpointEvidence>,
    pub hardware: Option<HardwareEvidence>,
    pub gateway: Option<GatewayEvidence>,
    pub credentials: Vec<CredentialObservation>,
}

impl AuthoringFacts {
    /// Keep facts whose dependency keys still match the current document.
    pub fn retarget(
        &mut self,
        draft: &Draft,
        capabilities: &Capabilities,
    ) -> Result<(), Diagnostics> {
        let request = draft.inference_request(capabilities)?;
        if self
            .endpoint
            .as_ref()
            .is_some_and(|evidence| evidence.request != request)
        {
            self.endpoint = None;
        }
        let key = draft.discovery_key()?;
        if self
            .hardware
            .as_ref()
            .is_some_and(|evidence| evidence.engine != key.engine)
        {
            self.hardware = None;
        }
        if self.gateway.as_ref().is_some_and(|evidence| {
            evidence.gateway != draft.document().spec.gateway
                || evidence.compute_driver != key.compute_driver
        }) {
            self.gateway = None;
        }
        let references = draft.document().credential_names();
        self.credentials
            .retain(|observation| references.contains(&observation.reference.as_str()));
        Ok(())
    }
}

impl Draft {
    pub fn inference_request(
        &self,
        capabilities: &Capabilities,
    ) -> Result<EndpointRequest, Diagnostics> {
        let answers = self.guided_answers(capabilities)?;
        let connection = self
            .document()
            .provider_connection(self.provider()?)
            .map_err(|error| crate::diagnostics::diagnostic("provider", &error.to_string()))?;
        Ok(EndpointRequest {
            endpoint: connection.endpoint,
            api: answers.api,
            credential_env: connection.credential.map(|credential| credential.env),
        })
    }

    /// Advertised endpoint models supplement curated suggestions, without
    /// becoming an allowlist or proving generation/tool/streaming compatibility.
    pub fn guided_fields_with_facts(
        &self,
        capabilities: &Capabilities,
        facts: &AuthoringFacts,
    ) -> Result<Vec<GuidedField>, Diagnostics> {
        let mut fields = self.guided_fields(capabilities)?;
        let request = self.inference_request(capabilities)?;
        if let Some(evidence) = facts.endpoint.as_ref().filter(|evidence| {
            evidence.request == request
                && evidence.observation.status == ObservationStatus::Available
        }) && let Some(model) = fields
            .iter_mut()
            .find(|field| field.id() == EditableField::Model)
        {
            for identifier in &evidence.observation.models {
                if !identifier.is_empty()
                    && identifier.len() <= 512
                    && !identifier.chars().any(char::is_control)
                {
                    let value = FieldValue::Model(identifier.clone());
                    if !model.choices.contains(&value) {
                        model.choices.push(value);
                    }
                }
            }
        }
        Ok(fields)
    }
}
