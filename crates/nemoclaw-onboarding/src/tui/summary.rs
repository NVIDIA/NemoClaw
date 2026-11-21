// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The review's plain summary of a completed document. Every row reads the
//! SDK document the review saves, so the summary cannot disagree with it.

use super::labels;
use nemoclaw_authoring::{BUILD_AGENT_IMAGES, CompatibilityStatus, ProviderPreset};
use nemoclaw_sdk::{
    config::{Document, InferenceTarget, Integration, NamedSandbox, NetworkPolicy},
    discovery::{
        CredentialRequest, DiscoveryObservations, DiscoveryQuery, ObservationStatus, plan_queries,
    },
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

impl Row {
    fn plain(label: &'static str, value: String) -> Self {
        Self {
            label,
            value,
            status: None,
            detail: None,
        }
    }
}

pub(super) struct Status {
    pub text: &'static str,
    /// Whether the person must act on it before plan can use the deployment.
    pub attention: bool,
}

impl Status {
    const fn fine(text: &'static str) -> Self {
        Self {
            text,
            attention: false,
        }
    }
    const fn attention(text: &'static str) -> Self {
        Self {
            text,
            attention: true,
        }
    }
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
        let agent = document.sandbox_harness(sandbox).map_or_else(
            |_| "unknown".into(),
            |harness| {
                labels::field_value(
                    "/spec/sandboxes/*/harness/kind",
                    &serde_json::Value::String(harness.kind.as_str().to_owned()),
                )
            },
        );
        rows.push(Row::plain("Agent", agent));
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
                rows.push(Row::plain("Model", value));
                if let Some(credential) = provider.and_then(|provider| provider.credential.as_ref())
                    && !keys.contains(&credential.env)
                {
                    keys.push(credential.env.clone());
                }
            }
        }
        for key in keys {
            rows.push(credential_row("API key", &key, facts.observations));
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
                    let reference = &definition.credential.env;
                    let mut row = credential_row("Search", reference, facts.observations);
                    let provider = labels::field_value(
                        "/spec/integrations/*/provider",
                        &serde_json::to_value(definition.provider).unwrap_or_default(),
                    );
                    row.value = format!("{provider} · {reference}");
                    rows.push(row);
                    shown.push(reference.clone());
                }
                Integration::Api(_) => apis = true,
            }
        }
        rows.push(Row::plain("Runs on", runs_on(document)));
        rows.push(image_row(
            sandbox,
            facts.target,
            image_absent(document, sandbox, facts.observations),
        ));
        rows.push(Row::plain("Network", network(sandbox, search, apis)));
    }
    for reference in document.credential_names() {
        if !shown.iter().any(|shown| shown == reference) {
            rows.push(credential_row("Credential", reference, facts.observations));
        }
    }
    if let Some(output) = facts.output {
        rows.push(Row::plain("File", output.display().to_string()));
    }
    rows
}

/// The vendor preset whose endpoint the provider uses, else the endpoint's
/// host, else the deployment service that serves it.
fn provider_label(provider: &nemoclaw_sdk::config::InferenceProvider) -> Option<String> {
    match provider.target().ok()? {
        InferenceTarget::External { endpoint, .. } => Some(
            ProviderPreset::for_endpoint(provider.provider, endpoint)
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
fn credential_row(
    label: &'static str,
    reference: &str,
    observations: &DiscoveryObservations,
) -> Row {
    let export = format!("export {reference}=...");
    let run = || format!("Run {export} before nemoclaw plan, or plan asks for it.");
    let observed = observations.get(&CredentialRequest {
        reference: reference.into(),
    });
    let (status, detail) = match observed.map(|credential| credential.status) {
        None => (None, None),
        Some(ObservationStatus::Available) => (Some(Status::fine("set")), None),
        // Only an unset key points at where to get a new one.
        Some(ObservationStatus::Unavailable) => (
            Some(Status::attention("not set (plan will ask for it)")),
            Some(
                ProviderPreset::for_credential_reference(reference)
                    .and_then(ProviderPreset::key_url)
                    .map_or_else(run, |url| {
                        format!("Get a key at {url}, then run {export} before nemoclaw plan.")
                    }),
            ),
        ),
        Some(ObservationStatus::Unknown) => (
            Some(Status::attention(
                "could not be read (plan will ask for it)",
            )),
            Some(run()),
        ),
    };
    Row {
        label,
        value: reference.to_owned(),
        status,
        detail,
    }
}

/// The runtime and where its gateway runs, without the engine socket. The
/// SDK accepts only a socket on this machine for a local managed gateway.
fn runs_on(document: &Document) -> String {
    let gateway = &document.spec.gateway;
    let runtime = labels::field_value(
        "/spec/gateway/target",
        &serde_json::Value::String(gateway.compute_driver().as_str().into()),
    );
    if gateway.as_kubernetes().is_some() {
        format!("{runtime} cluster, with a gateway NemoClaw manages")
    } else if gateway.as_local_managed().is_some() {
        format!("{runtime} on this machine")
    } else {
        format!(
            "{runtime} through the gateway at {}",
            host(&gateway.endpoint().unwrap_or_default())
        )
    }
}

/// Whether plan's read of the sandbox's image found that the engine doesn't hold it.
fn image_absent(
    document: &Document,
    sandbox: NamedSandbox<'_>,
    observations: &DiscoveryObservations,
) -> bool {
    plan_queries(document)
        .unwrap_or_default()
        .iter()
        .any(|query| match query {
            DiscoveryQuery::Fabric(request) if request.image == sandbox.image.ref_ => observations
                .get(request)
                .is_some_and(|observed| observed.status == ObservationStatus::Unavailable),
            _ => false,
        })
}

/// The image and the target's verdict on it and its engine. An image the
/// engine doesn't hold says where to get one, since apply can't start without it.
fn image_row(sandbox: NamedSandbox<'_>, target: Option<CompatibilityStatus>, absent: bool) -> Row {
    let image = &sandbox.image.ref_;
    let value = if image.is_empty() {
        "none".to_owned()
    } else {
        image.clone()
    };
    if absent && target != Some(CompatibilityStatus::Conflict) {
        return Row {
            status: Some(Status::attention("not present")),
            detail: Some(format!(
                "Apply pulls it from its registry; to build one instead, see {BUILD_AGENT_IMAGES}"
            )),
            ..Row::plain("Image", value)
        };
    }
    let status = match target {
        Some(CompatibilityStatus::Compatible) => Status::fine("compatible"),
        Some(CompatibilityStatus::Conflict) => Status::attention("conflict"),
        Some(CompatibilityStatus::Unverified) => Status::attention("not checked"),
        // Onboarding did not read the target, so there is nothing to act on.
        None => Status::fine("not checked"),
    };
    Row {
        status: Some(status),
        ..Row::plain("Image", value)
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
    let mut text = format!("Isolated: only the {}", listed(&endpoints, "endpoint"));
    let grants = sandbox
        .network
        .grants
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    if !grants.is_empty() {
        text.push_str(&format!(", and the {}", listed(&grants, "grant")));
    }
    text
}

/// `a endpoint`, `a and b endpoints`, `a, b and c endpoints`.
fn listed(items: &[&str], noun: &str) -> String {
    let plural = if items.len() > 1 { "s" } else { "" };
    let items = match items {
        [] => String::new(),
        [only] => (*only).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    };
    format!("{items} {noun}{plural}")
}
