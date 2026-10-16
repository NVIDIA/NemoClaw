// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Resources that own an OpenShell provider profile and the registration that
//! imports it: `openshell_web_search` and `openshell_inference`. They delegate
//! to the profile and registration kinds. When only one of the two exists,
//! after a failure between them or a deletion outside OpenTofu, the resource is
//! replaced: removal deletes what remains and creation recreates both.
use nemoclaw_backend::{Backend, Error, Mutation, ObservationError, Row};
use nemoclaw_openshell::pairs::{inference_provider_type, inference_rows, web_search_rows};
use nemoclaw_openshell::search::SearchProvider;

pub(crate) const WEB_SEARCH: &str = "web_search";
pub(crate) const INFERENCE: &str = "inference";
pub(crate) const KINDS: [&str; 2] = [WEB_SEARCH, INFERENCE];

fn value<'a>(row: &'a Row, field: &str) -> &'a str {
    row.get(field).map(String::as_str).unwrap_or_default()
}

fn rows(kind: &str, row: &Row) -> Result<(Row, Row), ObservationError> {
    match kind {
        WEB_SEARCH => web_search_rows(row),
        INFERENCE => inference_rows(row),
        _ => None,
    }
    .ok_or(ObservationError::Query)
}

/// The registration fields an observation reports back to the resource.
fn registration_fields(kind: &str) -> &'static [&'static str] {
    match kind {
        INFERENCE => &["endpoint", "credential_env", "credential_source"],
        _ => &["credential_env"],
    }
}

/// An input the registration always sets, reported empty when it is missing so
/// the plan shows drift.
fn registration_marker(kind: &str) -> &'static str {
    match kind {
        INFERENCE => "endpoint",
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
    let (profile, registration) = rows(kind, prior)?;
    let profile = backend.read("provider_profile", &profile, removing).await?;
    let registration = backend.read("provider", &registration, removing).await?;
    match (profile, registration) {
        (Some(profile), Some(registration)) => {
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
    if let (state, Some(error)) = backend
        .ensure("provider_profile", &profile)
        .await
        .into_parts()
    {
        // Record the identity when the profile may exist, so the next apply
        // replaces the resource instead of creating a conflicting one.
        return match state {
            Some(_) => Mutation::partial(desired.clone(), error),
            None => Mutation::failed(error),
        };
    }
    match backend.ensure("provider", &registration).await.into_parts() {
        (_, Some(error)) => Mutation::partial(desired.clone(), error),
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
