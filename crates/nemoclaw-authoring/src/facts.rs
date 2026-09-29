// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{Capabilities, Diagnostics, Draft, EditableField, FieldValue, GuidedField};
use nemoclaw_sdk::{
    config::{ComputeDriver, Document, Gateway, InferenceApi},
    discovery::GatewayObservation,
    discovery::ObservationStatus,
    hardware_discovery::HardwareObservation,
    inference_discovery::{CredentialObservation, EndpointObservation, EndpointRequest},
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
    pub fn retarget_document(
        &mut self,
        document: &Document,
        route: Option<&str>,
    ) -> Result<(), Diagnostics> {
        let request = inference_request_for_document(document, route)?;
        if self
            .endpoint
            .as_ref()
            .is_some_and(|evidence| evidence.request != request)
        {
            self.endpoint = None;
        }
        let key = crate::discovery_key_for_document(document)?;
        if self
            .hardware
            .as_ref()
            .is_some_and(|evidence| evidence.engine != key.engine)
        {
            self.hardware = None;
        }
        if self.gateway.as_ref().is_some_and(|evidence| {
            evidence.gateway != document.spec.gateway
                || evidence.compute_driver != key.compute_driver
        }) {
            self.gateway = None;
        }
        let references = document.credential_names();
        self.credentials
            .retain(|observation| references.contains(&observation.reference.as_str()));
        Ok(())
    }

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

/// Read the currently selected route's endpoint request from SDK-valid state.
pub fn inference_request_for_document(
    document: &Document,
    route_name: Option<&str>,
) -> Result<EndpointRequest, Diagnostics> {
    let [sandbox] = document.spec.sandboxes.as_slice() else {
        return Err(crate::diagnostics::diagnostic(
            "sandbox",
            "Inference discovery requires one sandbox.",
        ));
    };
    let inference = document
        .sandbox_inference(sandbox)
        .map_err(|error| crate::diagnostics::diagnostic("inference", &error.to_string()))?;
    let route = route_name
        .and_then(|name| inference.routes.iter().find(|route| route.name == name))
        .or_else(|| inference.routes.first())
        .ok_or_else(|| {
            crate::diagnostics::diagnostic("route", "Inference discovery requires a route.")
        })?;
    let provider = document
        .sandbox_route_provider(sandbox, route)
        .map_err(|error| crate::diagnostics::diagnostic("provider", &error.to_string()))?;
    let connection = document
        .provider_connection(provider)
        .map_err(|error| crate::diagnostics::diagnostic("provider", &error.to_string()))?;
    Ok(EndpointRequest {
        endpoint: connection.endpoint,
        api: provider.api.unwrap_or(InferenceApi::OpenaiCompletions),
        credential_env: connection.credential.map(|credential| credential.env),
    })
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
