// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Advisories for Hermes routes whose managed model service has too little
//! context for Hermes.

#[cfg(test)]
mod tests;

use crate::{
    config::{ConfigError, Document, InferenceTarget, Route},
    services::ServiceDefinition,
};

/// Smallest model context window the pinned Hermes Agent accepts
/// (`MINIMUM_CONTEXT_LENGTH` in its `agent/model_metadata.py`, at the
/// `HERMES_REVISION` in `image/fabric/Dockerfile`). Hermes reads the window from
/// the server, not from route settings.
const HERMES_MINIMUM_CONTEXT_TOKENS: i64 = 64_000;

/// Warnings for Hermes routes to managed vLLM or Ollama services, in sandbox
/// and route order. Other harnesses and external endpoints get none.
pub(super) fn context_warnings(document: &Document) -> Result<Vec<String>, ConfigError> {
    let mut warnings = Vec::new();
    for sandbox in &document.spec.sandboxes {
        if document.sandbox_harness(sandbox)?.kind.as_str() != "nvidia.fabric.hermes" {
            continue;
        }
        let inference = document.scoped_inference(sandbox)?;
        for route in &inference.inference.routes {
            let provider = document.route_provider(route, &inference)?;
            let InferenceTarget::Service { name } = provider.definition.target()? else {
                continue;
            };
            let Some(context) = document
                .spec
                .services
                .get(name)
                .and_then(ServiceDefinition::context_tokens)
            else {
                continue;
            };
            let subject = Subject {
                sandbox: &sandbox.name,
                route,
                service: name,
                context,
            };
            warnings.extend(subject.hermes());
        }
    }
    Ok(warnings)
}

/// A sandbox route to a managed service with `context` tokens.
struct Subject<'a> {
    sandbox: &'a str,
    route: &'a Route,
    service: &'a str,
    context: i64,
}

impl Subject<'_> {
    fn hermes(&self) -> Option<String> {
        let Self {
            sandbox,
            route,
            service,
            context,
        } = self;
        (*context < HERMES_MINIMUM_CONTEXT_TOKENS).then(|| format!(
            "Hermes sandbox {sandbox} route {} uses managed service {service} with serving.contextTokens={context}; Hermes requires a model context window of at least {HERMES_MINIMUM_CONTEXT_TOKENS} tokens and can refuse to start or fail longer conversations below it. Set serving.contextTokens to {HERMES_MINIMUM_CONTEXT_TOKENS} or more on a model that supports that context, and size model/GPU memory for it.",
            route.name
        ))
    }
}
