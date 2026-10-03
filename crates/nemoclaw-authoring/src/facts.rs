// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::Diagnostics;
use nemoclaw_sdk::{
    config::{ComputeDriver, Document},
    discovery::{DiscoveryRequest, ObservationStatus},
    facts::{FactQuery, FactSheet},
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

/// Every read the journey needs about the target for an SDK-valid document.
///
/// The inputs come from the document the way planning derives them: the
/// endpoint request is the SDK's, and the engine, image, and gateway are the
/// ones the document names. An external gateway's engine only stores images,
/// so it is read for image metadata and is never probed as the gateway's
/// engine or hardware. Planning also reads the hardware of each managed
/// service's engine; onboarding does not until a decision consumes it.
pub fn fact_needs(
    document: &Document,
    route_name: Option<&str>,
) -> Result<Vec<FactQuery>, Diagnostics> {
    let key = crate::discovery_key_for_document(document)?;
    let mut needs = Vec::new();
    if key.managed_gateway && !key.engine.is_empty() {
        needs.push(FactQuery::Engine(DiscoveryRequest {
            engine: key.engine.clone(),
            compute_driver: key.compute_driver,
        }));
    }
    if !key.engine.is_empty() {
        needs.push(FactQuery::Fabric {
            engine: key.engine.clone(),
            image: key.image.clone(),
        });
    }
    if key.managed_gateway && !key.engine.is_empty() {
        needs.push(FactQuery::Hardware {
            engine: key.engine.clone(),
        });
    }
    if let Some(request) = inference_request_for_document(document, route_name)?
        .filter(|request| request.validate().is_ok())
    {
        needs.push(FactQuery::Endpoint(request));
    }
    needs.push(FactQuery::Gateway {
        gateway: document.spec.gateway.clone(),
        compute_drivers: vec![key.compute_driver],
    });
    needs.extend(
        document
            .credential_names()
            .into_iter()
            .map(|reference| FactQuery::Credential {
                reference: reference.into(),
            }),
    );
    Ok(needs)
}

/// The local engine socket for each runtime a journey can offer.
const LOCAL_ENGINES: [(&str, ComputeDriver, &str); 2] = [
    (
        "docker",
        ComputeDriver::Docker,
        "unix:///var/run/docker.sock",
    ),
    (
        "podman",
        ComputeDriver::Podman,
        "unix:///run/user/1000/podman/podman.sock",
    ),
];

/// The managed gateway engine that matches a runtime answer.
pub(crate) fn local_engine(runtime: &str) -> Option<&'static str> {
    LOCAL_ENGINES
        .iter()
        .find(|(name, ..)| *name == runtime)
        .map(|(.., engine)| *engine)
}

/// Reads that need no answers: which local engines can run sandboxes. They
/// are asked once, before the first question, so early choices can use them.
pub fn environment_needs() -> Vec<FactQuery> {
    LOCAL_ENGINES
        .iter()
        .map(|(_, compute_driver, engine)| {
            FactQuery::Engine(DiscoveryRequest {
                engine: (*engine).into(),
                compute_driver: *compute_driver,
            })
        })
        .collect()
}

/// The runtimes whose local engine the sheet shows as available.
pub(crate) fn reachable_runtimes(facts: &FactSheet) -> Vec<&'static str> {
    LOCAL_ENGINES
        .iter()
        .filter(|(_, compute_driver, engine)| {
            facts
                .engine(&DiscoveryRequest {
                    engine: (*engine).into(),
                    compute_driver: *compute_driver,
                })
                .is_some_and(|engine| engine.status == ObservationStatus::Available)
        })
        .map(|(name, ..)| *name)
        .collect()
}
