// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Resources that own an OpenShell provider profile and the registration that
//! imports it: `openshell_api`, `openshell_web_search` and `openshell_inference`.
//! They delegate to the profile and registration kinds. Missing profiles are
//! recreated in place; missing registrations replace the pair. Failed API
//! creates retain the established profile or registration binding for recovery.
use nemoclaw_backend::{Backend, Error, Mutation, ObservationError, Row};
use nemoclaw_openshell::pairs::{
    api_rows, inference_provider_type, inference_rows, web_search_rows,
};
use nemoclaw_openshell::search::SearchProvider;

pub(crate) const WEB_SEARCH: &str = "web_search";
pub(crate) const INFERENCE: &str = "inference";
pub(crate) const API: &str = "api";
pub(crate) const KINDS: [&str; 3] = [WEB_SEARCH, INFERENCE, API];
const PENDING_PROFILE: &str = "pending-profile:";

fn value<'a>(row: &'a Row, field: &str) -> &'a str {
    row.get(field).map(String::as_str).unwrap_or_default()
}

fn rows(kind: &str, row: &Row) -> Result<(Row, Row), ObservationError> {
    match kind {
        WEB_SEARCH => web_search_rows(row),
        INFERENCE => inference_rows(row),
        API => {
            let (mut profile, mut registration) = api_rows(row);
            if let Some(id) = value(row, "id").strip_prefix(PENDING_PROFILE) {
                profile.insert("id".into(), id.into());
                registration.remove("id");
            }
            Some((profile, registration))
        }
        _ => None,
    }
    .ok_or(ObservationError::Query)
}

/// The registration fields an observation reports back to the resource.
fn registration_fields(kind: &str) -> &'static [&'static str] {
    match kind {
        INFERENCE => &["endpoint", "credential_env", "credential_source"],
        API => &["endpoint", "credential_env"],
        _ => &["credential_env"],
    }
}

/// An input the registration always sets, reported empty when it is missing so
/// the plan shows drift.
fn registration_marker(kind: &str) -> &'static str {
    match kind {
        INFERENCE | API => "endpoint",
        _ => "credential_env",
    }
}

/// Inputs plans require that the schema lists as optional, because an
/// observation reports them empty when their half of the pair is missing.
fn validate(kind: &str, desired: &Row) -> Result<(), Error> {
    if value(desired, "binaries_json").is_empty() || value(desired, "binaries_json") == "[]" {
        return Err(Error::Conflict(
            "binaries must list the executables allowed to use the provider",
        ));
    }
    match kind {
        API => {
            nemoclaw_openshell::api::definition(
                value(desired, "name"),
                value(desired, "endpoint"),
                value(desired, "auth_style"),
                value(desired, "header_name"),
            ).map_err(|_| Error::Conflict(
                "API credentials require an HTTP(S) endpoint and bearer or header authentication",
            ))?;
            if value(desired, "credential_env").is_empty() {
                return Err(Error::Conflict(
                    "credential_env must name the variable holding the API credential",
                ));
            }
        }
        WEB_SEARCH => {
            if SearchProvider::from_name(value(desired, "provider_type")).is_none() {
                return Err(Error::Conflict("provider_type must be brave or tavily"));
            }
            if value(desired, "credential_env").is_empty() {
                return Err(Error::Conflict(
                    "credential_env must name the variable that holds the search API key",
                ));
            }
        }
        _ => {
            if inference_provider_type(value(desired, "api")).is_none() {
                return Err(Error::Conflict(
                    "api must be openai-completions, openai-responses, or anthropic-messages",
                ));
            }
            if value(desired, "endpoint").is_empty() {
                return Err(Error::Conflict(
                    "server must be the ref of an inference server's readiness read",
                ));
            }
        }
    }
    Ok(())
}

/// Validate endpoint and authentication even when the workspace or gateway
/// depends on an object that OpenTofu has not created yet.
pub(crate) fn validate_api(
    known: &Row,
    unknown: &[&str],
) -> Result<(), std::borrow::Cow<'static, str>> {
    if [
        "name",
        "endpoint",
        "auth_style",
        "header_name",
        "credential_env",
        "binaries_json",
    ]
    .iter()
    .any(|field| unknown.contains(field))
    {
        return Ok(());
    }
    validate(API, known).map_err(|error| error.to_string().into())
}

pub(crate) async fn plan(
    backend: &(impl Backend + ?Sized),
    kind: &str,
    desired: &Row,
    prior: Option<&Row>,
) -> Result<(), Error> {
    validate(kind, desired)?;
    let (profile, registration) = rows(kind, desired)?;
    let prior = prior.map(|row| rows(kind, row)).transpose()?;
    backend
        .plan(
            "provider_profile",
            &profile,
            prior.as_ref().map(|(row, _)| row),
        )
        .await?;
    backend
        .plan(
            "provider",
            &registration,
            prior.as_ref().map(|(_, row)| row),
        )
        .await
}

pub(crate) async fn read(
    backend: &(impl Backend + ?Sized),
    kind: &str,
    prior: &Row,
    removing: bool,
) -> Result<Option<Row>, ObservationError> {
    let (profile_binding, registration_binding) = rows(kind, prior)?;
    let profile = backend
        .read("provider_profile", &profile_binding, removing)
        .await?;
    let registration = backend
        .read("provider", &registration_binding, removing)
        .await?;
    if kind == API {
        for (binding, observed) in [
            (&profile_binding, &profile),
            (&registration_binding, &registration),
        ] {
            if let Some(observed) = observed {
                super::verify_identity(binding, observed)?;
            }
        }
    }
    if kind == API && value(prior, "id").starts_with(PENDING_PROFILE) {
        if profile.is_none() && registration.is_none() {
            return Ok(None);
        }
        if profile.is_none() {
            return Err(ObservationError::BindingMismatch);
        }
        // OpenTofu taints failed creates. Keep the profile's physical binding
        // until replacement can remove the verified partial pair.
        return Ok(Some(prior.clone()));
    }
    match (profile, registration) {
        (Some(profile), Some(registration)) => {
            if kind == API && value(&profile, "endpoint") != value(&registration, "endpoint") {
                return Err(ObservationError::BindingMismatch);
            }
            // Both halves must be the same incarnation; the resource reports
            // its registration's identity so OpenTofu checks it.
            if ["owner", "generation"]
                .iter()
                .any(|field| value(&profile, field) != value(&registration, field))
            {
                return Err(ObservationError::BindingMismatch);
            }
            let mut observed = prior.clone();
            for field in ["owner", "generation"] {
                observed.insert(field.into(), value(&registration, field).into());
            }
            observed.insert(
                "binaries_json".into(),
                value(&profile, "binaries_json").into(),
            );
            if kind == API {
                for field in ["auth_style", "header_name"] {
                    observed.insert(field.into(), value(&profile, field).into());
                }
            }
            for field in registration_fields(kind).iter().chain(&["id"]) {
                observed.insert((*field).into(), value(&registration, field).into());
            }
            Ok(Some(observed))
        }
        (None, None) => Ok(None),
        // Half of the pair exists. Report the missing half's inputs as empty,
        // so the plan shows drift and replaces the resource; while removing,
        // report it unchanged so removal deletes what remains.
        _ if removing => Ok(Some(prior.clone())),
        (profile, _) => {
            let mut observed = prior.clone();
            let missing = if profile.is_none() {
                "binaries_json"
            } else {
                registration_marker(kind)
            };
            observed.insert(missing.into(), String::new());
            Ok(Some(observed))
        }
    }
}

pub(crate) async fn ensure(
    backend: &(impl Backend + ?Sized),
    kind: &str,
    desired: &Row,
) -> Mutation {
    let (profile, registration) = match rows(kind, desired) {
        Ok(rows) => rows,
        Err(error) => return Mutation::failed(error),
    };
    let (profile_state, profile_error) = backend
        .ensure("provider_profile", &profile)
        .await
        .into_parts();
    let partial = |registration: Option<Row>, error| {
        let mut state = desired.clone();
        if kind == API && value(&state, "id").is_empty() {
            if let Some(id) = registration.as_ref().and_then(|row| row.get("id")) {
                state.insert("id".into(), id.clone());
            } else if let Some(id) = profile_state.as_ref().and_then(|row| row.get("id")) {
                state.insert("id".into(), format!("{PENDING_PROFILE}{id}"));
            }
        }
        Mutation::partial(state, error)
    };
    if let Some(error) = profile_error {
        // Record the identity when the profile may exist, so the next apply
        // replaces the resource instead of creating a conflicting one.
        return match profile_state {
            Some(_) => partial(None, error),
            None => Mutation::failed(error),
        };
    }
    match backend.ensure("provider", &registration).await.into_parts() {
        (state, Some(error)) => partial(state, error),
        (Some(established), None) => {
            let mut state = desired.clone();
            state.insert("id".into(), value(&established, "id").into());
            Mutation::complete(state)
        }
        (None, None) => Mutation::failed(ObservationError::Incomplete),
    }
}

pub(crate) async fn remove(
    backend: &(impl Backend + ?Sized),
    kind: &str,
    prior: &Row,
    destroying: bool,
) -> Result<(), ObservationError> {
    if kind == API && value(prior, "id").starts_with(PENDING_PROFILE) {
        read(backend, kind, prior, true).await?;
    }
    let (profile, registration) = rows(kind, prior)?;
    // Registration first: the API refuses to delete a profile a registration
    // still imports. Each half is deleted through its observed row, which
    // carries the ID it is bound to.
    for (half, row) in [("provider", registration), ("provider_profile", profile)] {
        if let Some(observed) = backend.read(half, &row, true).await? {
            let mut bound = row;
            bound.extend(observed);
            backend.remove(half, &bound, destroying).await?;
        }
    }
    Ok(())
}
