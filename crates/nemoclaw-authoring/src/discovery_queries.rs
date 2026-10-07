// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::Diagnostics;
use nemoclaw_sdk::{
    config::Document,
    discovery::{CredentialRequest, DiscoveryQuery, plan_queries},
    inference_discovery::EndpointRequest,
};

/// Read the currently selected route's endpoint request from SDK-valid state.
/// A route backed by a managed service has no external catalog to read, and
/// the SDK leaves its readiness to the service owner, so it returns `None`.
pub fn inference_request_for_document(
    document: &Document,
    route_name: Option<&str>,
) -> Result<Option<EndpointRequest>, Diagnostics> {
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
    EndpointRequest::for_external_provider(provider)
        .map_err(|error| crate::diagnostics::diagnostic("provider", &error.to_string()))
}

/// Every query the journey asks about the target for an SDK-valid document:
/// the SDK's `plan_queries`, so onboarding and planning ask the same questions,
/// less what onboarding does not ask yet, plus the credential checks.
///
/// Three exclusions are deliberate. Only the selected route's inference
/// catalog is read. Hardware is read only for the managed gateway's engine,
/// not for each managed service's, until a decision consumes it. And an
/// unresolved engine has nowhere to read an image from, so there is no image
/// read; the TUI never targets a local daemon for it, and the assessment
/// reports the missing engine instead.
pub fn discovery_queries(
    document: &Document,
    route_name: Option<&str>,
) -> Result<Vec<DiscoveryQuery>, Diagnostics> {
    let key = crate::target_assessment::target_of(document)?;
    let selected = inference_request_for_document(document, route_name)?;
    let mut queries: Vec<DiscoveryQuery> = plan_queries(document)
        .map_err(|error| crate::diagnostics::diagnostic("discovery", &error.to_string()))?
        .into_iter()
        .filter(|query| match query {
            DiscoveryQuery::Inference(request) => selected.as_ref() == Some(request),
            DiscoveryQuery::Hardware(request) => {
                key.managed_gateway && !request.engine.is_empty() && request.engine == key.engine
            }
            DiscoveryQuery::Engine(request) => !request.engine.is_empty(),
            DiscoveryQuery::Fabric(request) => !request.engine.is_empty(),
            DiscoveryQuery::Gateway(_) | DiscoveryQuery::Credential(_) => true,
        })
        .collect();
    queries.extend(document.credential_names().into_iter().map(|reference| {
        DiscoveryQuery::Credential(CredentialRequest {
            reference: reference.into(),
        })
    }));
    Ok(queries)
}
