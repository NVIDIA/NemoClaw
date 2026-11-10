// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The review's plain summary of a completed document. Every row reads the
//! SDK document the review saves, so the summary cannot disagree with it.

use super::labels;
use nemoclaw_authoring::{CompatibilityStatus, ProviderPreset};
use nemoclaw_sdk::{
    config::{
        DEFAULT_AGENT_IMAGE, Document, InferenceTarget, Integration, NamedSandbox, NetworkPolicy,
        SearchProvider,
    },
    discovery::{CredentialRequest, DiscoveryObservations, ObservationStatus},
};
use std::path::Path;

/// One labelled fact, with an optional status after it.
pub(super) struct Row {
    pub label: &'static str,
    pub value: String,
    pub status: Option<Status>,
    /// What to do about the status, on its own line under the value.
    pub detail: Option<String>,
}

pub(super) struct Status {
    pub text: String,
    /// Whether the person must act on it before plan can use the deployment.
    pub attention: bool,
}

/// What the review needs to state beside the document.
pub(super) struct Facts<'a> {
    pub observations: &'a DiscoveryObservations,
    /// The target's verdict, or `None` when the target was not read.
    pub target: Option<CompatibilityStatus>,
    pub output: Option<&'a Path>,
}

pub(super) fn rows(document: &Document, facts: &Facts<'_>) -> Vec<Row> {
    let mut rows = Vec::new();
    // Credentials shown in a row of their own, so the rest are listed once.
    let mut shown = Vec::<String>::new();
    for sandbox in document.sandboxes() {
        let harness = document
            .sandbox_harness(sandbox)
            .map(|harness| harness.kind.as_str().to_owned());
        rows.push(Row {
            label: "Agent",
            value: harness.map_or_else(
                |_| "unknown".into(),
                |kind| {
                    labels::field_value(
                        "/spec/sandboxes/*/harness/kind",
                        &serde_json::Value::String(kind),
                    )
                },
            ),
            status: None,
            detail: None,
        });
        let mut keys = Vec::new();
        if let Ok(inference) = document.sandbox_inference(sandbox) {
            let several = inference.routes.len() > 1;
            let default = inference.default_route().ok().map(|route| &route.name);
            for route in &inference.routes {
                let provider = document.sandbox_route_provider(sandbox, route).ok();
                let mut value = String::new();
                if several {
                    value.push_str(&route.name);
                    if default == Some(&route.name) {
                        value.push_str(" (default)");
                    }
                    value.push_str(": ");
                }
                value.push_str(&route.overrides.model);
                if let Some(source) = provider.and_then(provider_label) {
                    value.push_str(&format!(" · {source}"));
                }
                rows.push(Row {
                    label: "Model",
                    value,
                    status: None,
                    detail: None,
                });
                if let Some(credential) = provider.and_then(|provider| provider.credential.as_ref())
                    && !keys.contains(&credential.env)
                {
                    keys.push(credential.env.clone());
                }
            }
        }
        for key in keys {
            rows.push(credential_row("API key", &key, facts));
            shown.push(key);
        }
        let integrations = sandbox
            .integration_bindings(&document.spec.integrations)
            .unwrap_or_default();
        let mut search = false;
        let mut apis = false;
        for binding in &integrations {
            match binding.definition {
                Integration::WebSearch(definition) => {
                    search = true;
                    let mut row = credential_row("Search", &definition.credential.env, facts);
                    row.value = format!("{} · {}", search_label(definition.provider), row.value);
                    rows.push(row);
                    shown.push(definition.credential.env.clone());
                }
                Integration::Api(_) => apis = true,
            }
        }
        rows.push(Row {
            label: "Runs on",
            value: runs_on(document),
            status: None,
            detail: None,
        });
        rows.push(image_row(sandbox, facts.target));
        rows.push(Row {
            label: "Network",
            value: network(sandbox, search, apis),
            status: None,
            detail: None,
        });
    }
    for reference in document.credential_names() {
        if !shown.iter().any(|shown| shown == reference) {
            rows.push(credential_row("Credential", reference, facts));
        }
    }
    if let Some(output) = facts.output {
        rows.push(Row {
            label: "File",
            value: output.display().to_string(),
            status: None,
            detail: None,
        });
    }
    rows
}

/// The vendor preset whose endpoint the provider uses, else the endpoint's
/// host, else the deployment service that serves it.
fn provider_label(provider: &nemoclaw_sdk::config::InferenceProvider) -> Option<String> {
    match provider.target().ok()? {
        InferenceTarget::External { endpoint, .. } => Some(
            ProviderPreset::for_endpoint(endpoint)
                .map(|preset| preset.label().to_owned())
                .unwrap_or_else(|| host(endpoint)),
        ),
        InferenceTarget::Service { name } => Some(format!("{name} service")),
    }
}

/// `https://hosted.example:8443/v1` reads as `hosted.example:8443`.
fn host(endpoint: &str) -> String {
    url::Url::parse(endpoint)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?.to_owned();
            Some(match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host,
            })
        })
        .unwrap_or_else(|| endpoint.to_owned())
}

/// The credential reference and whether this environment has it. A reference
/// onboarding did not check has no status.
fn credential_row(label: &'static str, reference: &str, facts: &Facts<'_>) -> Row {
    let observed = facts.observations.get(&CredentialRequest {
        reference: reference.into(),
    });
    let export = format!("export {reference}=...");
    let run = || format!("Run {export} before nemoclaw plan, or plan asks for it.");
    Row {
        label,
        value: reference.to_owned(),
        // A key that could not be read may be set, so only an unset one
        // points at where to get a new key.
        detail: observed.and_then(|credential| match credential.status {
            ObservationStatus::Available => None,
            ObservationStatus::Unavailable => Some(
                ProviderPreset::for_credential_reference(reference)
                    .and_then(ProviderPreset::key_url)
                    .map_or_else(run, |url| {
                        format!("Get a key at {url}, then run {export} before nemoclaw plan.")
                    }),
            ),
            ObservationStatus::Unknown => Some(run()),
        }),
        status: observed.map(|credential| match credential.status {
            ObservationStatus::Available => Status {
                text: "set".into(),
                attention: false,
            },
            ObservationStatus::Unavailable => Status {
                text: "not set (plan will ask for it)".into(),
                attention: true,
            },
            ObservationStatus::Unknown => Status {
                text: "could not be read (plan will ask for it)".into(),
                attention: true,
            },
        }),
    }
}

fn search_label(provider: SearchProvider) -> &'static str {
    match provider {
        SearchProvider::Brave => "Brave",
        SearchProvider::Tavily => "Tavily",
    }
}

/// The runtime and where its gateway runs, without the engine socket.
fn runs_on(document: &Document) -> String {
    let gateway = &document.spec.gateway;
    let runtime = labels::field_value(
        "/spec/gateway/runtime/provider",
        &serde_json::to_value(gateway.runtime().provider).unwrap_or_default(),
    );
    match gateway.as_managed() {
        Some(_) if gateway.as_kubernetes().is_some() => {
            format!("{runtime} cluster, with a gateway NemoClaw manages")
        }
        Some(managed) if local_engine(&managed.engine) => format!("{runtime} on this machine"),
        Some(managed) => format!("{runtime} at {}", host(&managed.engine)),
        None => format!(
            "{runtime} through the gateway at {}",
            host(gateway.endpoint())
        ),
    }
}

/// A socket on this machine, or no engine, which selects the runtime's
/// default socket here.
fn local_engine(engine: &str) -> bool {
    engine.is_empty() || engine.starts_with("unix://") || engine.starts_with("npipe://")
}

/// The image and the target's verdict on it and its engine.
fn image_row(sandbox: NamedSandbox<'_>, target: Option<CompatibilityStatus>) -> Row {
    let image = &sandbox.image.ref_;
    let value = if image == DEFAULT_AGENT_IMAGE {
        "default image".to_owned()
    } else if image.is_empty() {
        "none".to_owned()
    } else {
        image.clone()
    };
    let status = match target {
        Some(CompatibilityStatus::Compatible) => Status {
            text: "compatible".into(),
            attention: false,
        },
        Some(CompatibilityStatus::Conflict) => Status {
            text: "conflict".into(),
            attention: true,
        },
        Some(CompatibilityStatus::Unverified) => Status {
            text: "not checked".into(),
            attention: true,
        },
        // Onboarding did not read the target, so there is nothing to act on.
        None => Status {
            text: "not checked".into(),
            attention: false,
        },
    };
    Row {
        label: "Image",
        value,
        status: Some(status),
        detail: None,
    }
}

/// What the agent can reach. The isolated preset adds grants for the model,
/// search, and API endpoints the document declares, and the named grants;
/// an explicit policy states everything itself.
fn network(sandbox: NamedSandbox<'_>, search: bool, apis: bool) -> String {
    if let NetworkPolicy::Explicit(_) = sandbox.network.policy {
        return "Explicit policy from the configuration file".into();
    }
    let endpoints = std::iter::once("model")
        .chain(search.then_some("search"))
        .chain(apis.then_some("API"))
        .collect::<Vec<_>>();
    let mut text = format!(
        "Isolated: only the {} endpoint{}",
        join(&endpoints),
        if endpoints.len() > 1 { "s" } else { "" }
    );
    let grants = sandbox
        .network
        .grants
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    if !grants.is_empty() {
        text.push_str(&format!(
            ", and the {} grant{}",
            join(&grants),
            if grants.len() > 1 { "s" } else { "" }
        ));
    }
    text
}

/// `a`, `a and b`, `a, b and c`.
fn join(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [only] => (*only).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}
