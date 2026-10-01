// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::Diagnostics;
use nemoclaw_sdk::{
    config::{ComputeDriver, Document, Gateway, InferenceApi},
    discovery::GatewayObservation,
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
