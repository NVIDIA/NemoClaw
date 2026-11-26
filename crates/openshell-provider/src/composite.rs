// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Resources that own an OpenShell provider profile and the registration that
//! imports it: `openshell_api` and `openshell_inference`.
//! They delegate to the profile and registration kinds. Missing profiles are
//! recreated in place; missing registrations replace the pair. Failed API
//! creates retain the established profile or registration binding for recovery.
use nemoclaw_backend::{Backend, Error, Mutation, ObservationError, Row};
use nemoclaw_openshell::api::{MCP_POLICY, REST_POLICY, Rules};
use nemoclaw_openshell::pairs::{api_rows, inference_provider_type, inference_rows};

use crate::credential::{self, CREDENTIAL_DIGEST};

pub(crate) const INFERENCE: &str = "inference";
pub(crate) const API: &str = "api";
pub(crate) const KINDS: [&str; 2] = [INFERENCE, API];
const PENDING_PROFILE: &str = "pending-profile:";
/// The profile half of a credential resource whose profile APF serves.
pub(crate) const APF_PROFILE: &str = "apf_provider_profile";

/// Whether APF's interceptor, not NemoClaw, owns the resource's profile.
fn apf_profile(row: &Row) -> bool {
    value(row, crate::POLICY_AUTHORITY) == "apf"
}

/// Check that APF's observed profile gives the sandbox its credential in the
/// variable NemoClaw tells the agent to read.
fn apf_credential(binding: &Row, observed: &Row) -> Result<(), ObservationError> {
    if value(observed, crate::profile::APF_CREDENTIAL_VARIABLE)
        != crate::profile::apf_credential_variable(binding)?
    {
        return Err(ObservationError::BindingMismatch);
    }
    Ok(())
}

fn value<'a>(row: &'a Row, field: &str) -> &'a str {
    row.get(field).map(String::as_str).unwrap_or_default()
}

fn rows(kind: &str, row: &Row) -> Result<(Row, Row), ObservationError> {
    match kind {
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

/// The registration fields an observation reports back to the resource. Its
/// credential variable isn't one: OpenShell keeps a provider's labels when it
/// updates the provider, so the registration's label names the variable it was
/// created with, and the resource keeps the variable its state records.
fn registration_fields(kind: &str) -> &'static [&'static str] {
    match kind {
        INFERENCE => &["endpoint", "credential_source"],
        API => &["endpoints_json"],
        _ => &[],
    }
}

/// An input the registration always sets, reported empty when it is missing so
/// the plan shows drift.
fn registration_marker(kind: &str) -> &'static str {
    match kind {
        INFERENCE => "endpoint",
        API => "endpoints_json",
        _ => "credential_env",
    }
}

const BINARIES: &str = "binaries must list the executables allowed to use the provider";
const INFERENCE_API: &str =
    "api must be openai-completions, openai-responses, or anthropic-messages";
const INFERENCE_SERVER: &str = "server must be the ref of an inference server's readiness read";

fn no_binaries(row: &Row) -> bool {
    value(row, "binaries_json").is_empty() || value(row, "binaries_json") == "[]"
}

/// Inputs plans require that the schema lists as optional, because an
/// observation reports them empty when their half of the pair is missing.
fn validate(kind: &str, desired: &Row) -> Result<(), Error> {
    if no_binaries(desired) {
        return Err(Error::Conflict(BINARIES));
    }
    match kind {
        API => {
            nemoclaw_openshell::api::endpoints(value(desired, "endpoints_json"))
                .and_then(|endpoints| {
                    nemoclaw_openshell::api::definition(
                        value(desired, "name"),
                        &endpoints,
                        value(desired, "auth_style"),
                        value(desired, "header_name"),
                        Rules::from_fields(value(desired, MCP_POLICY), value(desired, REST_POLICY))?,
                        value(desired, "sandbox_env"),
                    )
                })
                .map_err(|_| Error::Conflict(
                "API credentials require one or more valid HTTP(S) endpoints and an authentication style. Set at most one of mcp and rest, each with exactly one endpoint: mcp needs a canonical endpoint path and rules with at most one tool selector each; rest needs an endpoint without a path and rules that each name a method and a path",
            ))?;
            if value(desired, "credential_env").is_empty() {
                return Err(Error::Conflict(
                    "credential_env must name the variable holding the API credential",
                ));
            }
            if apf_profile(desired)
                && [MCP_POLICY, REST_POLICY]
                    .iter()
                    .any(|policy| !value(desired, policy).is_empty())
            {
                return Err(Error::Conflict(
                    "an API whose profile APF serves must not set an mcp or rest policy: APF's profile sets the endpoint's rules",
                ));
            }
        }
        _ => {
            if inference_provider_type(value(desired, "api")).is_none() {
                return Err(Error::Conflict(INFERENCE_API));
            }
            if value(desired, "endpoint").is_empty() {
                return Err(Error::Conflict(INFERENCE_SERVER));
            }
        }
    }
    Ok(())
}

/// Validate endpoint and authentication even when the workspace or gateway
/// depends on an object that OpenTofu has not created yet.
pub(crate) fn validate_api(known: &Row, unknown: &[&str]) -> Result<(), nemoclaw_tofu::InputError> {
    if [
        "name",
        "endpoints_json",
        "sandbox_env",
        "auth_style",
        "header_name",
        "credential_env",
        "binaries_json",
        MCP_POLICY,
        REST_POLICY,
        crate::POLICY_AUTHORITY,
    ]
    .iter()
    .any(|field| unknown.contains(field))
    {
        return Ok(());
    }
    validate(API, known).map_err(|error| error.to_string().into())
}

/// Check an inference registration's inputs while planning, even while its
/// workspace, owner, generation, or gateway are still to be created or
/// generated, naming the attribute each rejection concerns.
pub(crate) fn validate_inference(
    known: &Row,
    unknown: &[&str],
) -> Result<(), nemoclaw_tofu::InputError> {
    use nemoclaw_tofu::InputError;
    let checked = |field| !unknown.contains(&field);
    if checked("binaries_json") && no_binaries(known) {
        return Err(InputError::at("binaries_json", BINARIES));
    }
    if checked("api") && inference_provider_type(value(known, "api")).is_none() {
        return Err(InputError::at("api", INFERENCE_API));
    }
    if checked("endpoint") && value(known, "endpoint").is_empty() {
        return Err(InputError::at("endpoint", INFERENCE_SERVER));
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
    let (profile_binding, registration_binding) = rows(kind, prior)?;
    let apf = apf_profile(prior);
    let profile_kind = if apf { APF_PROFILE } else { "provider_profile" };
    let profile = backend
        .read(profile_kind, &profile_binding, removing)
        .await?;
    let registration = backend
        .read("provider", &registration_binding, removing)
        .await?;
    if apf
        && !removing
        && let Some(observed) = &profile
    {
        apf_credential(&profile_binding, observed)?;
    }
    if kind == API {
        // APF's profile carries no NemoClaw identity.
        let halves = [
            (&profile_binding, &profile),
            (&registration_binding, &registration),
        ];
        for (binding, observed) in halves.into_iter().skip(usize::from(apf)) {
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
            if kind == API
                && !apf
                && ["endpoints_json", "sandbox_env"]
                    .iter()
                    .any(|field| value(&profile, field) != value(&registration, field))
            {
                return Err(ObservationError::BindingMismatch);
            }
            // Both halves must be the same incarnation; the resource reports
            // its registration's identity so OpenTofu checks it. APF's
            // profile carries no NemoClaw identity, and its executables and
            // credential delivery are APF's to choose.
            if !apf
                && ["owner", "generation"]
                    .iter()
                    .any(|field| value(&profile, field) != value(&registration, field))
            {
                return Err(ObservationError::BindingMismatch);
            }
            let mut observed = prior.clone();
            for field in ["owner", "generation"] {
                observed.insert(field.into(), value(&registration, field).into());
            }
            if !apf {
                observed.insert(
                    "binaries_json".into(),
                    value(&profile, "binaries_json").into(),
                );
                if kind == API {
                    for field in [
                        "auth_style",
                        "header_name",
                        "sandbox_env",
                        MCP_POLICY,
                        REST_POLICY,
                    ] {
                        observed.insert(field.into(), value(&profile, field).into());
                    }
                }
            }
            for field in registration_fields(kind).iter().chain(&["id"]) {
                observed.insert((*field).into(), value(&registration, field).into());
            }
            // OpenShell can't report the value a registration holds. One
            // recorded before NemoClaw kept digests is taken to hold the value
            // its variable holds now: its first observation that can read the
            // variable records that value's digest, without registering the
            // value again or replacing the sandboxes that attach it.
            if !removing
                && value(&observed, CREDENTIAL_DIGEST).is_empty()
                && credential::from_variable(&observed)
                && let Some(current) = credential::current(value(&observed, "credential_env"))
            {
                observed.insert(CREDENTIAL_DIGEST.into(), credential::digest(&current)?);
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
    let fallback = value(desired, CREDENTIAL_DIGEST);
    let register = credential::from_variable(desired).then_some(fallback);
    establish(backend, kind, desired, register).await
}

/// Update the pair. The plan leaves the credential digest unknown, so it
/// differs from the prior one, when the registration must hold the value its
/// variable holds now; the update then registers that value again, even under
/// the same variable, and records its digest. A failed update keeps the prior
/// digest, so the next plan tries again.
pub(crate) async fn update(
    backend: &(impl Backend + ?Sized),
    kind: &str,
    desired: &Row,
    prior: &Row,
) -> Mutation {
    let changed = [CREDENTIAL_DIGEST, "credential_env"]
        .iter()
        .any(|field| value(desired, field) != value(prior, field));
    let register =
        (credential::from_variable(desired) && changed).then(|| value(prior, CREDENTIAL_DIGEST));
    establish(backend, kind, desired, register).await
}

/// Ensure the pair. With `register`, the registration takes the value its
/// variable holds now and the resource records that value's digest, or the
/// digest `register` holds when the registration fails.
async fn establish(
    backend: &(impl Backend + ?Sized),
    kind: &str,
    desired: &Row,
    register: Option<&str>,
) -> Mutation {
    let (profile, mut registration) = match rows(kind, desired) {
        Ok(rows) => rows,
        Err(error) => return Mutation::failed(error),
    };
    let mut desired = desired.clone();
    if let Some(fallback) = register {
        registration.insert(credential::REGISTER.into(), "true".into());
        desired.insert(CREDENTIAL_DIGEST.into(), fallback.into());
    }
    let desired = &desired;
    let (profile_state, profile_error) = if apf_profile(desired) {
        // APF serves the profile; NemoClaw adopts it and never imports one.
        let adopted = backend
            .read(APF_PROFILE, &profile, false)
            .await
            .and_then(|observed| observed.ok_or(ObservationError::Incomplete))
            .and_then(|observed| apf_credential(&profile, &observed));
        if let Err(error) = adopted {
            return Mutation::failed(error);
        }
        (None, None)
    } else {
        backend
            .ensure("provider_profile", &profile)
            .await
            .into_parts()
    };
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
            if register.is_some() {
                // The registration records the digest of the value it took.
                match established
                    .get(CREDENTIAL_DIGEST)
                    .filter(|digest| !digest.is_empty())
                {
                    Some(digest) => {
                        state.insert(CREDENTIAL_DIGEST.into(), digest.clone());
                    }
                    None => return Mutation::partial(state, ObservationError::Incomplete),
                }
            }
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
    // APF's profile is not NemoClaw's to delete.
    let halves = if apf_profile(prior) { 1 } else { 2 };
    for (half, row) in [("provider", registration), ("provider_profile", profile)]
        .into_iter()
        .take(halves)
    {
        if let Some(observed) = backend.read(half, &row, true).await? {
            let mut bound = row;
            bound.extend(observed);
            backend.remove(half, &bound, destroying).await?;
        }
    }
    Ok(())
}
