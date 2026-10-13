// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Advisories for agent routes whose managed model service has too little
//! context for the agent harness.

#[cfg(test)]
mod tests;

use crate::{
    config::{ConfigError, Document, InferenceTarget, Route},
    services::ServiceDefinition,
};
use serde_json::Value;

/// Smallest model context window the pinned Hermes Agent accepts
/// (`MINIMUM_CONTEXT_LENGTH` in its `agent/model_metadata.py`, at the
/// `HERMES_REVISION` in `image/fabric/Dockerfile`). Hermes reads the window from
/// the server, not from route settings.
const HERMES_MINIMUM_CONTEXT_TOKENS: i64 = 64_000;

/// Warnings for OpenClaw and Hermes routes to managed vLLM or Ollama services,
/// in sandbox and route order. Other harnesses and external endpoints get none.
pub(super) fn context_warnings(document: &Document) -> Result<Vec<String>, ConfigError> {
    let mut warnings = Vec::new();
    for sandbox in &document.spec.sandboxes {
        let hermes = match document.sandbox_harness(sandbox)?.kind.as_str() {
            "nvidia.fabric.openclaw" => false,
            "nvidia.fabric.hermes" => true,
            _ => continue,
        };
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
            if hermes {
                warnings.extend(subject.hermes());
            } else {
                warnings.extend(subject.openclaw());
            }
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

    fn openclaw(&self) -> Vec<String> {
        let Self {
            sandbox,
            route,
            service,
            context,
        } = self;
        let mut warnings = Vec::new();
        let metadata = route
            .overrides
            .settings
            .as_ref()
            .and_then(|settings| settings.get("model_metadata"));
        // The pinned OpenClaw adapter overlays model_metadata on its
        // defaults, including maxTokens. Invalid explicit values are
        // passed through, so they cannot be treated as omitted here.
        let positive_integer = |field, default| match metadata {
            None => Some(default),
            Some(Value::Object(metadata)) => match metadata.get(field) {
                None => Some(default),
                Some(value) => value.as_u64().filter(|value| *value > 0),
            },
            Some(_) => None,
        };
        let route_context = positive_integer("contextWindow", 32768);
        if let Some(route_context) = route_context
            && i128::from(route_context) > i128::from(*context)
        {
            warnings.push(format!(
                "OpenClaw sandbox {sandbox} route {} advertises contextWindow={route_context}, exceeding managed service {service} serving.contextTokens={context}; longer conversations can exceed the server limit. Set overrides.settings.model_metadata.contextWindow to {context} or less, or increase the service context and size model/GPU memory accordingly.",
                route.name
            ));
        }
        let (Some(route_context), Some(reply_tokens)) = (
            route_context,
            positive_integer(
                "maxTokens",
                u64::from(route.overrides.tuning.max_tokens.unwrap_or(4096)),
            ),
        ) else {
            warnings.push(format!(
                "OpenClaw sandbox {sandbox} route {} uses managed service {service} with serving.contextTokens={context}, but cannot assess its context budget: settings.model_metadata must be an object with positive integer contextWindow and maxTokens when present.",
                route.name
            ));
            return warnings;
        };
        let effective_context = i128::from(*context).min(i128::from(route_context));
        // A measured initial OpenClaw prompt used 19,947 tokens; this is
        // an advisory budget, not a universal adapter requirement.
        let required_context = 20_000 + i128::from(reply_tokens);
        if effective_context < required_context {
            warnings.push(format!(
                "OpenClaw sandbox {sandbox} route {} uses managed service {service} with serving.contextTokens={context} and settings.model_metadata.contextWindow={route_context}; allow at least {required_context} tokens for an initial prompt of about 20,000 tokens plus {reply_tokens} reply tokens. Consider 32768 or more as needed, align both limits, and size model/GPU memory for that context.",
                route.name
            ));
        }
        warnings
    }
}
